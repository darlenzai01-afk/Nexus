import { Db, migrate, Repo, type ArtifactRef } from "@nexus/db";
import { beforeEach, describe, expect, it } from "vitest";

import { silentLogger } from "./logger.js";
import { createTaskRegistry } from "./registry.js";
import { LONG_FORM_PIPELINE, SHORTS_PIPELINE } from "./stages.js";
import { getJobStatus } from "./status.js";
import type { Task } from "./types.js";
import { Worker } from "./worker.js";

const LONG_STAGES = LONG_FORM_PIPELINE.stages.map((s) => s.key);

interface Setup {
  readonly db: Db;
  readonly repo: Repo;
  readonly executions: Map<string, number>;
  readonly registry: ReturnType<typeof createTaskRegistry>;
  readonly projectId: string;
  episodeId: string;
  newWorker(overrides?: Partial<ConstructorParameters<typeof Worker>[0]>): Worker;
  newJob(topic?: string): string;
  gate: { block?: string; release?: () => void };
}

function setup(): Setup {
  const db = Db.memory();
  migrate(db);
  const repo = new Repo(db);
  const executions = new Map<string, number>();
  const gate: { block?: string; release?: () => void } = {};

  const taskFor = (stageKey: string): Task => ({
    stageKey,
    async execute() {
      executions.set(stageKey, (executions.get(stageKey) ?? 0) + 1);
      if (gate.block === stageKey) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return { output: { stage: stageKey }, artifacts: [] as ArtifactRef[] };
    },
  });

  const registry = createTaskRegistry([
    ...LONG_STAGES.map(taskFor),
    ...SHORTS_PIPELINE.stages.map((s) => taskFor(s.key)),
  ]);

  const projectId = repo.createProject({ name: "W", slug: "w" }).id;
  const episodeId = repo.createEpisode({ projectId, topic: "Worker test" }).id;

  return {
    db,
    repo,
    executions,
    registry,
    projectId,
    episodeId,
    gate,
    newWorker(overrides = {}) {
      return new Worker({
        repo,
        tasks: registry,
        workerId: "worker-1",
        leaseMs: 200,
        pollIntervalMs: 5,
        logger: silentLogger,
        ...overrides,
      });
    },
    newJob(topic) {
      const episode = topic
        ? repo.createEpisode({ projectId, topic })
        : repo.requireEpisode(episodeId);
      return repo.createJob({ episodeId: episode.id, pipeline: "longform_v1", steps: LONG_STAGES })
        .job.id;
    },
  };
}

describe("Worker", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it("claims and runs one job per tick, stopping at the approval gate", async () => {
    const jobId = s.newJob();
    const worker = s.newWorker();
    const outcome = await worker.tick();

    expect(outcome).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    const job = s.repo.requireJob(jobId);
    expect(job.attempt).toBe(1); // the claim happened
    expect(job.heartbeat_at).not.toBeNull(); // last known alive, even after parking
    // A parked job holds no lease: gates are untimed states that cost nothing.
    expect(job.lease_owner).toBeNull();
    expect(job.lease_expires_at).toBeNull();
    expect(executionsFor(s, "publish")).toBe(0);
  });

  it("returns no outcome when there is nothing to claim", async () => {
    const worker = s.newWorker();
    expect(await worker.tick()).toBeUndefined();
    const jobId = s.newJob();
    await s.repo.cancelJob(jobId);
    expect(await worker.tick()).toBeUndefined();
  });

  it("drains the whole queue and reports what happened", async () => {
    s.newJob("First");
    s.newJob("Second");
    const worker = s.newWorker();
    const summary = await worker.drain();

    expect(summary).toMatchObject({ claimed: 2, waiting: 2, completed: 0, failed: 0 });
    expect(s.repo.listJobs().filter((job) => job.state === "WAITING_GATE")).toHaveLength(2);
    // Draining again finds nothing: the queue is genuinely empty.
    expect(await worker.drain()).toMatchObject({ claimed: 0 });
  });

  it("resumes a crashed worker's job once the lease expires", async () => {
    const jobId = s.newJob();
    // Worker A claims the job and dies mid-stage.
    const workerA = s.newWorker({ workerId: "worker-a" });
    await workerA.tick(); // parks at the gate: lease released on park
    s.db.run(
      "UPDATE pipeline_jobs SET state = 'RUNNING', lease_owner = 'worker-a', lease_expires_at = ? WHERE id = ?;",
      ["2000-01-01T00:00:00.000Z", jobId],
    );

    const workerB = s.newWorker({ workerId: "worker-b" });
    const outcome = await workerB.tick();
    expect(outcome).toMatchObject({ status: "waiting" });
    const job = s.repo.requireJob(jobId);
    expect(job.attempt).toBe(2); // reclaimed by worker-b
    // Stages already completed by worker A were not repeated.
    const counts = Object.fromEntries(s.executions);
    expect(counts.idea).toBe(1);
    expect(counts.render).toBe(1);
  });

  it("start/stop runs the loop and shuts down gracefully mid-job", async () => {
    s.newJob();
    const worker = s.newWorker({ workerId: "worker-loop", leaseMs: 60_000 });
    s.gate.block = "render";
    worker.start();
    expect(worker.running).toBe(true);

    // Wait until the loop is actually inside the render task.
    await waitFor(() => s.gate.release !== undefined);

    const stopping = worker.stop();
    s.gate.release?.();
    await stopping;

    expect(worker.running).toBe(false);
    // The in-flight stage finished and was checkpointed; the runner then
    // stopped *between* stages, leaving the job leased for a later resume
    // (never half-written).
    const job = s.repo.listJobs()[0]!;
    expect(s.repo.requireStep(job.id, "render").state).toBe("DONE");
    expect(job.state).toBe("RUNNING");
    expect(job.lease_owner).toBe("worker-loop");

    // A later worker finishes the job once the lease expires.
    s.db.run(
      "UPDATE pipeline_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?;",
      [job.id],
    );
    await s.newWorker({ workerId: "worker-next" }).tick();
    expect(s.repo.requireJob(job.id).state).toBe("WAITING_GATE");
    expect(s.repo.requireJob(job.id).waiting_gate).toBe("FINAL_APPROVAL");
  });

  it("leaves abandoned work for the next worker when stopped between stages", async () => {
    s.newJob();
    const worker = s.newWorker({ workerId: "worker-q", leaseMs: 60_000 });
    s.gate.block = "plan";
    worker.start();
    await waitFor(() => s.gate.release !== undefined);
    // Abort while the job is mid-flight, then let the blocked task finish:
    // the runner stops between stages and the job stays leased to this worker.
    const stopping = worker.stop();
    s.gate.block = undefined;
    s.gate.release?.();
    await stopping;

    const job = s.repo.listJobs()[0]!;
    expect(job.lease_owner).toBe("worker-q");
    expect(["RUNNING", "WAITING_GATE"]).toContain(job.state);

    // Lease expiry makes it claimable again, and the checkpoints survive.
    s.db.run(
      "UPDATE pipeline_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?;",
      [job.id],
    );
    const other = s.newWorker({ workerId: "worker-z" });
    await other.tick();
    const resumed = s.repo.requireJob(job.id);
    expect(resumed.state).toBe("WAITING_GATE");
    expect(resumed.attempt).toBe(2);
    expect(s.repo.requireStep(job.id, "plan").state).toBe("DONE");
    expect(executionsFor(s, "idea")).toBe(1); // nothing redone
  });

  it("gives up waiting for a task that ignores the abort signal (bounded shutdown)", async () => {
    s.newJob();
    // A task that hangs forever and never checks its abort signal.
    const worker = s.newWorker({ workerId: "worker-hung", leaseMs: 60_000, stopTimeoutMs: 40 });
    s.gate.block = "voice";
    worker.start();
    await waitFor(() => s.gate.release !== undefined);

    const started = Date.now();
    await worker.stop({ timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(1_000); // shutdown was not blocked
    expect(worker.running).toBe(false);

    // The job is still leased, and its work is recoverable by another worker.
    const job = s.repo.listJobs()[0]!;
    expect(job.lease_owner).toBe("worker-hung");
    s.gate.block = undefined;
    s.gate.release?.();
  });

  it("fails a job loudly when the pipeline wiring is broken, instead of leaking a leased job", async () => {
    const jobId = s.repo.createJob({
      episodeId: s.episodeId,
      pipeline: "mystery_v9",
      steps: ["whatever"],
    }).job.id;
    const worker = s.newWorker();

    await expect(worker.tick()).rejects.toThrow(/Unknown pipeline 'mystery_v9'/);
    const job = s.repo.requireJob(jobId);
    expect(job.state).toBe("FAILED");
    expect(job.error_kind).toBe("permanent");
    expect(job.error).toMatch(/orchestration error/);
    expect(job.lease_owner).toBeNull();
    expect(s.repo.listJobLogs(jobId).some((log) => log.event === "job.orchestration_error")).toBe(
      true,
    );
  });

  it("gives each worker a distinct identity and respects the drain cap", async () => {
    for (let i = 0; i < 3; i++) s.newJob(`Episode ${i}`);
    const worker = s.newWorker({ maxJobsPerDrain: 2 });
    const summary = await worker.drain();
    expect(summary.claimed).toBe(2);
    expect(worker.id).toMatch(/^worker-1$/);
    expect(s.repo.listJobsByState(["PENDING"])).toHaveLength(1);
    expect(getJobStatus(s.repo, s.repo.listJobsByState(["PENDING"])[0]!.id).status).toBe("PENDING");
  });
});

function executionsFor(s: Setup, stageKey: string): number {
  return s.executions.get(stageKey) ?? 0;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
