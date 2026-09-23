import type { Repo } from "@nexus/db";

import { errorMessage } from "./errors.js";
import { consoleLogger, type Logger } from "./logger.js";
import { runJob } from "./runner.js";
import type { TaskRegistry } from "./types.js";

/**
 * The worker: a claim loop around the runner.
 *
 * It is deliberately small, because all the durable behaviour lives in the DB
 * (leases, attempts, checkpoints). The worker only decides *when* to act:
 * claim the oldest runnable job, run it, stop when asked. Every property that
 * matters for correctness — one worker per job, resumption after a crash,
 * no duplicate stage execution — is enforced by data, not by this loop being
 * alive at the right moment.
 */

export interface WorkerOptions {
  readonly repo: Repo;
  readonly tasks: TaskRegistry;
  /** Unique per process/thread; used for lease ownership. */
  readonly workerId?: string;
  /** Lease length (ms). Long stages are heartbeated at a third of this. */
  readonly leaseMs?: number;
  /** Idle poll interval (ms). */
  readonly pollIntervalMs?: number;
  /**
   * How long `stop()` waits for an in-flight task before giving up (ms).
   * A task that ignores its abort signal must never block shutdown: the job
   * keeps its lease, the lease expires, and another worker resumes it.
   */
  readonly stopTimeoutMs?: number;
  /** Stop claiming after this many jobs in one `drain()`. */
  readonly maxJobsPerDrain?: number;
  /** Optional CAS probe used to validate reusable artifacts. */
  readonly artifactExists?: (hash: string) => boolean;
  /** Cache-affecting configuration; part of every stage fingerprint. */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
  /** Injectable sleep, for tests that should not wait for wall-clock time. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface DrainSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly waiting: number;
  readonly retrying: number;
  readonly failed: number;
  readonly canceled: number;
  readonly skipped: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class Worker {
  readonly id: string;
  readonly #options: WorkerOptions;
  readonly #log: Logger;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort = new AbortController();
  #running = false;
  #loop: Promise<void> | undefined;
  #currentJobId: string | undefined;

  constructor(options: WorkerOptions) {
    this.#options = options;
    this.id = options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.#log = options.logger ?? consoleLogger;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The job currently being executed, if any (used by graceful shutdown). */
  get currentJobId(): string | undefined {
    return this.#currentJobId;
  }

  /**
   * Claim and run at most one job. Returns `undefined` when the queue is empty
   * or every remaining job is parked/backed off.
   */
  async tick(): Promise<
    ReturnType<typeof runJob> extends Promise<infer R> ? R | undefined : never
  > {
    const { repo } = this.#options;
    const job = repo.claimJob({ owner: this.id, leaseMs: this.#leaseMs });
    if (!job) return undefined;

    this.#currentJobId = job.id;
    try {
      const outcome = await runJob(
        {
          repo,
          tasks: this.#options.tasks,
          artifactExists: this.#options.artifactExists,
          params: this.#options.params,
          logger: this.#log,
          workerId: this.id,
          leaseMs: this.#leaseMs,
          signal: this.#abort.signal,
        },
        job.id,
      );
      return outcome;
    } catch (error) {
      // The runner handles stage failures; reaching here means the
      // orchestration wiring itself threw (unknown pipeline, missing task).
      // Fail the job loudly instead of leaving it leased to a dead worker.
      const message = errorMessage(error);
      repo.failJob(job.id, {
        error: `orchestration error: ${message}`,
        errorKind: "permanent",
        failureStep: job.failure_step ?? undefined,
      });
      repo.logJob({
        jobId: job.id,
        level: "error",
        event: "job.orchestration_error",
        message,
      });
      this.#log({
        level: "error",
        event: "job.orchestration_error",
        jobId: job.id,
        error: message,
      });
      throw error;
    } finally {
      this.#currentJobId = undefined;
    }
  }

  /** Run until nothing is claimable (or the per-drain cap is reached). */
  async drain(): Promise<DrainSummary> {
    const summary = {
      claimed: 0,
      completed: 0,
      waiting: 0,
      retrying: 0,
      failed: 0,
      canceled: 0,
      skipped: 0,
    };
    const cap = this.#options.maxJobsPerDrain ?? 25;
    for (let i = 0; i < cap; i++) {
      const outcome = await this.tick();
      if (!outcome) break;
      summary.claimed += 1;
      summary[outcome.status] += 1;
    }
    return summary;
  }

  /** Start the background claim loop (idempotent). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#log({ level: "info", event: "worker.started", workerId: this.id });
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      let outcome: Awaited<ReturnType<Worker["tick"]>>;
      try {
        outcome = await this.tick();
      } catch (error) {
        this.#log({ level: "error", event: "worker.tick_failed", error: errorMessage(error) });
        await this.#sleep(this.#pollMs, this.#abort.signal);
        continue;
      }
      if (!outcome) await this.#sleep(this.#pollMs, this.#abort.signal);
    }
  }

  /**
   * Stop the loop and wait (bounded) for the in-flight job to finish.
   *
   * The abort signal asks the running task to stop; the runner itself always
   * stops *between* stages, so whatever was checkpointed stays valid. If a
   * task ignores the signal, the wait is abandoned after `stopTimeoutMs` —
   * the job keeps its lease, the lease expires, and another worker resumes it.
   * Shutdown therefore never depends on a task being well-behaved.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#abort.abort();
    const timeoutMs = options.timeoutMs ?? this.#options.stopTimeoutMs ?? 10_000;
    const loop = this.#loop ?? Promise.resolve();
    let timedOut = false;
    await Promise.race([
      loop.then(() => undefined),
      this.#sleep(timeoutMs, new AbortController().signal).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut) {
      this.#log({
        level: "warn",
        event: "worker.stop_timeout",
        workerId: this.id,
        timeoutMs,
        note: "in-flight task ignored the abort signal; its lease will expire and another worker will resume the job",
      });
    }
    this.#loop = undefined;
    this.#log({ level: "info", event: "worker.stopped", workerId: this.id, timedOut });
  }

  get #leaseMs(): number {
    return this.#options.leaseMs ?? 60_000;
  }

  get #pollMs(): number {
    const poll = this.#options.pollIntervalMs ?? 1_000;
    return Math.max(1, poll);
  }
}

export function createWorker(options: WorkerOptions): Worker {
  return new Worker(options);
}
