import type { ArtifactRef, EpisodeRow, PipelineJobRow, Repo, CompletedStageRun } from "@nexus/db";

import type { Logger } from "./logger.js";
import type { PipelineDef, StageDef } from "./stages.js";

/**
 * The worker/task abstraction. A `Task` is the *only* thing a stage knows how
 * to do: read its inputs, do the work, declare its artifacts. Tasks never
 * touch job state, leases, retries or logs — the runner owns all of that — so
 * a task is trivially unit-testable and cannot corrupt the orchestration.
 */
export interface TaskContext {
  readonly job: PipelineJobRow;
  readonly episode: EpisodeRow;
  readonly stage: StageDef;
  readonly pipeline: PipelineDef;
  /** Content the stage consumes: episode content, upstream outputs, params. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Outputs of the stages completed so far in this job, keyed by stage key. */
  readonly upstream: Readonly<Record<string, unknown>>;
  /** Stage fingerprint — the idempotency key of this exact unit of work. */
  readonly fingerprint: string;
  /** Aborted when the worker is shutting down; long tasks should honour it. */
  readonly signal: AbortSignal;
  /** Appends to the job log (`step_key` is filled in automatically). */
  readonly log: (event: string, message?: string, data?: Record<string, unknown>) => void;
}

/**
 * What a task returns.
 *
 * - `output` — JSON-serializable summary, persisted on the step and fed to
 *   downstream stages' inputs.
 * - `artifacts` — references to registered artifacts (`artifacts` table hash +
 *   kind). Every referenced artifact must be registered before the stage is
 *   checkpointed; the runner refuses unregistered hashes.
 * - `waiting` — the task is not done and cannot proceed without a human or an
 *   external event (unsupported claims → FACT_REVIEW, quota exhausted →
 *   QUOTA). The job parks at that gate and costs nothing until it is resolved.
 */
export interface TaskResult {
  readonly output?: unknown;
  readonly artifacts?: readonly ArtifactRef[];
  readonly waiting?: string;
  /** Human-readable reason shown in the job log and status view. */
  readonly waitingReason?: string;
}

export interface Task {
  /** Must equal the stage key it implements. */
  readonly stageKey: string;
  execute(ctx: TaskContext): Promise<TaskResult | void>;
  /**
   * Optional guard called before a previously completed run is adopted
   * (artifact reuse). A task that knows how to verify a reusable output
   * (e.g. "the WAV parses") should reject it by throwing; the runner then
   * executes the stage normally.
   */
  validateReuse?(ctx: TaskContext, run: CompletedStageRun): Promise<void> | void;
}

/** Registry of task implementations for the stages this worker can run. */
export interface TaskRegistry {
  register(task: Task): TaskRegistry;
  get(stageKey: string): Task | undefined;
  has(stageKey: string): boolean;
  stageKeys(): string[];
  /**
   * Fail fast at startup when a pipeline declares a stage this worker cannot
   * execute — a missing handler discovered mid-run would strand a job.
   */
  assertCovers(pipeline: PipelineDef): void;
}

export interface RunnerDeps {
  readonly repo: Repo;
  readonly tasks: TaskRegistry;
  readonly workerId: string;
  /** Lease length; the runner heartbeats at a third of it while running. */
  readonly leaseMs: number;
  /**
   * Cache-affecting configuration (provider ids, template versions, render
   * settings). Part of every stage fingerprint, so switching providers
   * invalidates the stages they produced.
   */
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * Optional CAS probe. When provided, a reusable artifact whose bytes have
   * disappeared is refused and the stage re-executes — the guard against
   * "reuse" of a hash nobody can read.
   */
  readonly artifactExists?: (hash: string) => boolean;
  readonly logger?: Logger;
  readonly heartbeatIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Injectable randomness for deterministic backoff in tests. */
  readonly random?: () => number;
}

export type RunJobOutcome =
  | { readonly status: "completed"; readonly jobId: string }
  | { readonly status: "waiting"; readonly jobId: string; readonly gate: string }
  | {
      readonly status: "retrying";
      readonly jobId: string;
      readonly stepKey: string;
      readonly attempt: number;
      readonly nextAttemptAt: string;
    }
  | {
      readonly status: "failed";
      readonly jobId: string;
      readonly error: string;
      readonly errorKind: "permanent" | "exhausted";
      readonly stepKey: string;
    }
  | { readonly status: "canceled"; readonly jobId: string }
  | { readonly status: "skipped"; readonly jobId: string; readonly reason: string };
