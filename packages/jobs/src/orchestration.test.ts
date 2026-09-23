import {
  Db,
  migrate,
  Repo,
  type ArtifactKind,
  type EpisodeRow,
  type PipelineJobRow,
} from "@nexus/db";
import { beforeEach, describe, expect, it } from "vitest";

import { PermanentError, RetryableError } from "./errors.js";
import { sha256Hex } from "./fingerprint.js";
import { resolveGate, retryFailedJob } from "./gates.js";
import { createTaskRegistry } from "./registry.js";
import { runJob } from "./runner.js";
import { LONG_FORM_PIPELINE, SHORTS_PIPELINE, type StageDef } from "./stages.js";
import { getJobStatus } from "./status.js";
import type { RunnerDeps, Task } from "./types.js";

const LONG_STAGES = LONG_FORM_PIPELINE.stages.map((s) => s.key);

interface FailPlan {
  remaining: number;
  kind: "retryable" | "permanent";
}

interface Harness {
  readonly db: Db;
  readonly repo: Repo;
  readonly deps: RunnerDeps;
  readonly executions: Map<string, number>;
  readonly fails: Map<string, FailPlan>;
  readonly waits: Map<string, string>;
  readonly crashAt: { stage?: string };
  aborter: AbortController;
  /** Replace the signal after a simulated crash (the "next worker process"). */
  resetSignal(): void;
  episode: EpisodeRow;
  job: PipelineJobRow;
  createEpisode(topic?: string): EpisodeRow;
  createJob(options?: {
    pipeline?: string;
    steps?: readonly string[];
    episode?: EpisodeRow;
    episodeId?: string;
    idempotencyKey?: string;
    maxAttempts?: number;
  }): PipelineJobRow;
  run(jobId?: string): Promise<Awaited<ReturnType<typeof runJob>>>;
  /** Claim (when the job is PENDING) and run — what a worker's tick does. */
  claimAndRun(jobId?: string, owner?: string): Promise<Awaited<ReturnType<typeof runJob>>>;
  runToSettled(jobId?: string): Promise<Awaited<ReturnType<typeof runJob>>[]>;
  executionsOf(stageKey: string): number;
  totalExecutions(): number;
}

/** A task that records executions, can be scripted to fail/wait, and emits artifacts. */
function makeTask(stage: StageDef, harness: () => Harness): Task {
  return {
    stageKey: stage.key,
    async execute(ctx) {
      const h = harness();
      h.executions.set(stage.key, h.executionsOf(stage.key) + 1);
      ctx.log("task.note", `task ${stage.key} started`);

      const plan = h.fails.get(stage.key);
      if (plan && plan.remaining > 0) {
        plan.remaining -= 1;
        throw plan.kind === "retryable"
          ? new RetryableError(`${stage.key} flaked (provider 503)`)
          : new PermanentError(`${stage.key} cannot proceed (bad input)`);
      }
      const gate = h.waits.get(stage.key);
      if (gate) {
        h.waits.delete(stage.key);
        return { waiting: gate, waitingReason: `${stage.key} needs a human decision` };
      }
      if (h.crashAt.stage === stage.key) {
        // Simulate the worker being killed: stop the run *between* stages and
        // leave the job leased to a worker that will never come back.
        h.crashAt.stage = undefined;
        h.aborter.abort();
      }
      const artifacts = stage.produces.map((kind: ArtifactKind) => {
        const hash = sha256Hex(`${stage.key}:${ctx.fingerprint}:${kind}`);
        h.repo.registerArtifact({ hash, kind, bytes: 256, meta: { durationSec: 1 } });
        return { hash, kind, role: kind };
      });
      return { output: { stage: stage.key, fingerprint: ctx.fingerprint }, artifacts };
    },
  };
}

function makeHarness(options: { params?: Record<string, unknown> } = {}): Harness {
  const db = Db.memory();
  migrate(db);
  const repo = new Repo(db);
  const executions = new Map<string, number>();
  const fails = new Map<string, FailPlan>();
  const waits = new Map<string, string>();
  const crashAt: { stage?: string } = {};
  let aborter = new AbortController();

  // Tasks need a reference to the harness they belong to; the slot is filled
  // once the harness object below exists (the closures only run later).
  const slot: { current?: Harness } = {};
  const registry = createTaskRegistry([
    ...LONG_FORM_PIPELINE.stages.map((stage) => makeTask(stage, () => slot.current!)),
    ...SHORTS_PIPELINE.stages.map((stage) => makeTask(stage, () => slot.current!)),
  ]);

  const project = repo.createProject({ name: "Test Channel", slug: "test-channel" });

  const deps: RunnerDeps = {
    repo,
    tasks: registry,
    workerId: "worker-1",
    leaseMs: 60_000,
    heartbeatIntervalMs: 5,
    params: options.params ?? { llm: "fake", tts: "fake" },
    random: () => 0.5,
    signal: aborter.signal,
  };

  const createEpisode = (topic = "Why the sky is blue"): EpisodeRow =>
    repo.createEpisode({ projectId: project.id, topic, outline: ["intro", "physics"] });

  const createJob: Harness["createJob"] = (jobOptions = {}) => {
    const episode =
      jobOptions.episode ?? repo.requireEpisode(jobOptions.episodeId ?? harness.episode.id);
    const pipeline = jobOptions.pipeline ?? "longform_v1";
    const stages =
      jobOptions.steps ??
      (pipeline === "shorts_v1" ? SHORTS_PIPELINE.stages.map((s) => s.key) : LONG_STAGES);
    return repo.createJob({
      episodeId: episode.id,
      pipeline,
      steps: stages,
      ...(jobOptions.idempotencyKey !== undefined
        ? { idempotencyKey: jobOptions.idempotencyKey }
        : {}),
      ...(jobOptions.maxAttempts !== undefined ? { maxAttempts: jobOptions.maxAttempts } : {}),
    }).job;
  };

  const episode = createEpisode();

  const harness: Harness = {
    db,
    repo,
    deps,
    executions,
    fails,
    waits,
    crashAt,
    get aborter() {
      return aborter;
    },
    resetSignal() {
      aborter = new AbortController();
      (deps as { signal: AbortSignal }).signal = aborter.signal;
    },
    episode,
    job: undefined as unknown as PipelineJobRow,
    createEpisode,
    createJob,
    executionsOf: (stageKey) => executions.get(stageKey) ?? 0,
    totalExecutions: () => [...executions.values()].reduce((a, b) => a + b, 0),
    async run(jobId) {
      return runJob(deps, jobId ?? harness.job.id);
    },
    async claimAndRun(jobId, owner = "worker-1") {
      const id = jobId ?? harness.job.id;
      if (repo.requireJob(id).state === "PENDING") repo.claimJob({ owner, leaseMs: 60_000 });
      return runJob(deps, id);
    },
    async runToSettled(jobId) {
      const outcomes: Awaited<ReturnType<typeof runJob>>[] = [];
      for (let i = 0; i < 12; i++) {
        const job = repo.requireJob(jobId ?? harness.job.id);
        if (job.next_attempt_at !== null) {
          // Simulate the backoff elapsing without waiting for the wall clock.
          db.run("UPDATE pipeline_jobs SET next_attempt_at = NULL WHERE id = ?;", [job.id]);
        }
        const outcome = await harness.claimAndRun(jobId, `worker-${i + 1}`);
        outcomes.push(outcome);
        if (outcome.status !== "retrying") break;
      }
      return outcomes;
    },
  };
  harness.job = harness.createJob();
  slot.current = harness;
  return harness;
}

/** Claim the job the way a worker does (the runner assumes a claim happened). */
function claim(h: Harness, owner = "worker-1"): PipelineJobRow {
  return h.repo.claimJob({ owner, leaseMs: 60_000 })!;
}

describe("orchestration — happy path and job status", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("runs every stage in order, ending PUBLISHED with immutable timestamps", async () => {
    claim(h);
    const outcome = await h.run();
    // The pipeline stops at the mandatory approval gate before publishing.
    expect(outcome).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });

    resolveGate(h.repo, h.job.id, { decision: "approved", notes: "ship it" });
    const final = await h.claimAndRun();
    expect(final).toMatchObject({ status: "completed" });

    const steps = h.repo.listJobSteps(h.job.id);
    expect(steps.every((step) => step.state === "DONE")).toBe(true);
    expect(steps.every((step) => step.input_hash !== null)).toBe(true);
    expect(steps.every((step) => step.started_at !== null && step.finished_at !== null)).toBe(true);
    expect(steps.map((step) => step.step_key)).toEqual(LONG_STAGES);
    expect(h.repo.requireJob(h.job.id).state).toBe("DONE");
    expect(h.repo.requireEpisode(h.episode.id).state).toBe("PUBLISHED");
  });

  it("stops at the gate without executing the gated stage, and costs nothing while parked", async () => {
    claim(h);
    await h.run();
    const parked = h.repo.requireJob(h.job.id);
    expect(parked.state).toBe("WAITING_GATE");
    expect(parked.waiting_gate).toBe("FINAL_APPROVAL");
    expect(parked.lease_owner).toBeNull(); // parked jobs hold no lease
    expect(h.repo.requireStep(h.job.id, "approval").state).toBe("WAITING");
    expect(h.executionsOf("publish")).toBe(0);
    expect(h.repo.requireEpisode(h.episode.id).state).toBe("APPROVAL");

    // A second claim attempt finds nothing to do: gates are untimed states.
    expect(h.repo.claimJob({ owner: "worker-2", leaseMs: 1_000 })).toBeUndefined();
  });

  it("exposes the requested vocabulary through the status view", async () => {
    claim(h);
    await h.run();
    const status = getJobStatus(h.repo, h.job.id);
    expect(status.status).toBe("WAITING_GATE");
    expect(status.waitingGate).toBe("FINAL_APPROVAL");
    expect(status.currentStage?.stateLabel).toBe("AWAITING_APPROVAL");

    const labels = Object.fromEntries(status.steps.map((step) => [step.key, step.stateLabel]));
    expect(labels).toMatchObject({
      idea: "IDEA_COMPLETE",
      research: "RESEARCH_COMPLETE",
      fact_check: "FACT_CHECK_COMPLETE",
      script: "SCRIPT_COMPLETE",
      plan: "PLAN_COMPLETE",
      source_media: "MEDIA_COMPLETE",
      voice: "VOICE_COMPLETE",
      captions: "CAPTIONS_COMPLETE",
      animate: "ANIMATION_COMPLETE",
      render: "RENDER_COMPLETE",
      qa: "QA_COMPLETE",
      approval: "AWAITING_APPROVAL",
      publish: "PUBLISHING_PENDING",
    });
    expect(status.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(status.logs.length).toBeGreaterThan(5);
    expect(status.logs.every((log) => log.created_at.length === 24)).toBe(true);
  });

  it("records artifacts per stage and exposes them as references, not blobs", async () => {
    claim(h);
    await h.run();
    const render = h.repo.getJobStep(h.job.id, "render")!;
    const artifacts = h.repo.stepArtifacts(h.job.id, "render");
    expect(artifacts.map((a) => a.kind).sort()).toEqual(["thumbnail", "video"]);
    expect(render.artifacts).toContain(artifacts[0]!.hash);
    // The bytes live in the CAS index (hashes), and the DB row is metadata only.
    for (const artifact of artifacts) {
      expect(h.repo.getArtifact(artifact.hash)?.kind).toBe(artifact.kind);
    }
  });

  it("refuses to checkpoint an artifact nobody registered", async () => {
    const bogus: Task = {
      stageKey: "idea",
      execute: async () => ({ artifacts: [{ hash: "f".repeat(64), kind: "video", role: "x" }] }),
    };
    const registry = createTaskRegistry([
      bogus,
      ...LONG_FORM_PIPELINE.stages
        .filter((stage) => stage.key !== "idea")
        .map((stage) => makeTask(stage, () => h)),
    ]);
    claim(h);
    await expect(runJob({ ...h.deps, tasks: registry }, h.job.id)).rejects.toThrow(
      /not registered/,
    );
    // The job is not silently marked done with a phantom artifact.
    expect(h.repo.getJobStep(h.job.id, "idea")?.state).toBe("PENDING");
  });
});

describe("orchestration — resume, duplicate execution and completed-stage reuse", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("skips completed stages when the runner is invoked again (duplicate execution)", async () => {
    claim(h);
    await h.run();
    const renderExecutions = h.executionsOf("render");
    const total = h.totalExecutions();

    // Same job, second pass: everything already DONE is skipped, nothing re-runs.
    const again = await h.run();
    expect(again).toMatchObject({ status: "waiting" });
    expect(h.executionsOf("render")).toBe(renderExecutions);
    expect(h.totalExecutions()).toBe(total);

    const skipped = h.repo
      .listJobLogs(h.job.id)
      .filter((log) => log.event === "stage.skipped.completed");
    expect(skipped.map((log) => log.step_key)).toContain("render");
  });

  it("never re-executes a finished job", async () => {
    claim(h);
    await h.run();
    resolveGate(h.repo, h.job.id, { decision: "approved" });
    await h.claimAndRun(undefined, "worker-2");
    const total = h.totalExecutions();

    const outcome = await runJob(h.deps, h.job.id);
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(h.totalExecutions()).toBe(total);
  });

  it("resumes mid-pipeline after a worker is killed (expired lease, RUNNING stage)", async () => {
    claim(h, "worker-1");
    // Kill the worker as soon as 'research' finishes, i.e. between stages.
    h.crashAt.stage = "research";
    const crashed = await h.run();
    expect(crashed).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("shutting down"),
    });

    // The dead worker's job is still RUNNING and leased by worker-1.
    const abandoned = h.repo.requireJob(h.job.id);
    expect(abandoned.state).toBe("RUNNING");
    expect(abandoned.lease_owner).toBe("worker-1");
    expect(h.repo.claimJob({ owner: "worker-2", leaseMs: 60_000 })).toBeUndefined(); // lease is live

    // Time passes: the lease expires and a new worker reclaims the job.
    h.db.run(
      "UPDATE pipeline_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?;",
      [h.job.id],
    );
    const reclaimed = h.repo.claimJob({ owner: "worker-2", leaseMs: 60_000 })!;
    expect(reclaimed.lease_owner).toBe("worker-2");
    expect(reclaimed.attempt).toBe(2);

    const ideaExecutions = h.executionsOf("idea");
    const researchExecutions = h.executionsOf("research");
    h.resetSignal(); // the resumed run happens in a fresh worker process
    await runJob({ ...h.deps, workerId: "worker-2" }, h.job.id);

    // Work already done is not redone; work not yet done continues.
    expect(h.executionsOf("idea")).toBe(ideaExecutions);
    expect(h.executionsOf("research")).toBe(researchExecutions);
    expect(h.executionsOf("script")).toBe(1);
    expect(h.repo.requireStep(h.job.id, "research").state).toBe("DONE");
  });

  it("re-runs only from an interrupted stage onwards (a RUNNING stage is retried)", async () => {
    claim(h);
    await h.run();
    // Simulate a crash in the middle of the 'voice' stage: it is left RUNNING.
    h.repo.startStep(h.job.id, "voice");
    h.db.run("UPDATE pipeline_jobs SET state = 'PENDING', lease_owner = NULL WHERE id = ?;", [
      h.job.id,
    ]);

    const before = {
      script: h.executionsOf("script"),
      voice: h.executionsOf("voice"),
      publish: h.executionsOf("publish"),
    };
    await h.claimAndRun(undefined, "worker-2");
    expect(h.executionsOf("script")).toBe(before.script); // earlier stage untouched
    expect(h.executionsOf("voice")).toBe(before.voice + 1); // interrupted stage retried
    expect(h.executionsOf("publish")).toBe(before.publish);
  });

  it("reuses an identical completed stage instead of executing it again", async () => {
    claim(h);
    await h.run();
    const firstRunExecutions = h.totalExecutions();
    const firstJobId = h.job.id;

    // A second episode with the same content in the same project: the pipeline
    // is re-created, but the work is already done.
    const second = h.createEpisode();
    const secondJob = h.createJob({ episode: second });
    claim(h);
    const outcome = await runJob(h.deps, secondJob.id);

    expect(outcome).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    expect(h.totalExecutions()).toBe(firstRunExecutions); // nothing re-executed
    const reused = h.repo.listJobSteps(secondJob.id).filter((s) => s.reused_from_job_id !== null);
    expect(reused.map((s) => s.step_key)).toEqual(LONG_STAGES.slice(0, -2)); // everything before the gate
    expect(reused.every((s) => s.reused_from_job_id === firstJobId)).toBe(true);
    // The episode advances on adopted work exactly as on executed work.
    expect(h.repo.requireEpisode(second.id).state).toBe("APPROVAL");

    // …and the reuse is auditable, not silent.
    expect(h.repo.listJobLogs(secondJob.id).some((l) => l.event === "stage.reused")).toBe(true);
    const audit = h.repo.listAudit().filter((row) => row.action === "stage.reused");
    expect(audit.length).toBeGreaterThan(0);
  });

  it("reuses across episodes for the gated stage too, once the gate is approved", async () => {
    claim(h);
    await h.run();
    resolveGate(h.repo, h.job.id, { decision: "approved" });
    await h.claimAndRun(undefined, "worker-2");
    const total = h.totalExecutions();

    const second = h.createEpisode();
    const secondJob = h.createJob({ episode: second });
    claim(h, "worker-3");
    await h.run(secondJob.id);
    expect(h.repo.requireJob(secondJob.id).state).toBe("WAITING_GATE");

    resolveGate(h.repo, secondJob.id, { decision: "approved" });
    const final = await h.claimAndRun(secondJob.id, "worker-4");
    expect(final).toMatchObject({ status: "completed" });
    expect(h.totalExecutions()).toBe(total); // publish reused, not re-run
    expect(h.repo.getJobStep(secondJob.id, "publish")?.reused_from_job_id).toBe(h.job.id);
    expect(h.repo.requireEpisode(second.id).state).toBe("PUBLISHED"); // fully reused episode is published
  });

  it("refuses a reusable artifact whose bytes are gone and re-executes instead", async () => {
    const h2 = makeHarness();
    claim(h2);
    await h2.run();
    const beforeRender = h2.executionsOf("render");

    const missing = new Set<string>();
    const second = h2.createEpisode();
    const secondJob = h2.createJob({ episode: second });
    claim(h2, "worker-2");
    await runJob(
      { ...h2.deps, workerId: "worker-2", artifactExists: (hash) => !missing.has(hash) },
      secondJob.id,
    );
    expect(h2.executionsOf("render")).toBe(beforeRender); // reused while bytes exist

    // Now the CAS loses one artifact the render stage produced.
    const renderStep = h2.repo.requireStep(secondJob.id, "render");
    for (const artifact of h2.repo.stepArtifacts(secondJob.id, "render"))
      missing.add(artifact.hash);
    expect(renderStep.reused_from_job_id).not.toBeNull();

    const third = h2.createEpisode();
    const thirdJob = h2.createJob({ episode: third });
    claim(h2, "worker-3");
    await runJob(
      { ...h2.deps, workerId: "worker-3", artifactExists: (hash) => !missing.has(hash) },
      thirdJob.id,
    );
    expect(h2.executionsOf("render")).toBe(beforeRender + 1); // re-executed, not falsely reused
    const rejected = h2.repo
      .listJobLogs(thirdJob.id)
      .filter((l) => l.event === "stage.reuse.rejected");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]!.message).toMatch(/missing from the store/);
  });

  it("re-executes a stage whose upstream content changed, and invalidates downstream", async () => {
    claim(h);
    await h.run();
    expect(h.repo.requireStep(h.job.id, "qa").state).toBe("DONE");

    // Someone edits the script: 'script' is invalidated together with everything after it.
    h.repo.invalidateFromStep(h.job.id, "script");
    h.db.run("UPDATE pipeline_jobs SET state = 'PENDING', lease_owner = NULL WHERE id = ?;", [
      h.job.id,
    ]);
    const ideaExecutions = h.executionsOf("idea");
    await h.claimAndRun(undefined, "worker-2");

    expect(h.executionsOf("idea")).toBe(ideaExecutions); // untouched upstream of the change
    const status = getJobStatus(h.repo, h.job.id);
    const byKey = Object.fromEntries(status.steps.map((s) => [s.key, s.stateLabel]));
    expect(byKey.idea).toBe("IDEA_COMPLETE");
    expect(byKey.script).toBe("SCRIPT_COMPLETE");
    expect(byKey.qa).toBe("QA_COMPLETE");
  });
});

describe("orchestration — retry, failure and recovery", () => {
  it("schedules a retry after a retryable failure and succeeds on the next attempt", async () => {
    const h = makeHarness();
    h.fails.set("script", { remaining: 1, kind: "retryable" });
    claim(h);

    const first = await h.run();
    expect(first).toMatchObject({ status: "retrying", stepKey: "script" });
    const parked = h.repo.requireJob(h.job.id);
    expect(parked.state).toBe("PENDING");
    expect(parked.error_kind).toBe("retryable");
    expect(parked.failure_step).toBe("script");
    expect(parked.next_attempt_at).not.toBeNull();
    expect(parked.lease_owner).toBeNull();

    // The backoff is respected: the job is not claimable yet…
    expect(h.repo.claimJob({ owner: "worker-2", leaseMs: 60_000 })).toBeUndefined();
    // …and the status view tells the operator why.
    expect(getJobStatus(h.repo, h.job.id).status).toBe("RETRYING");

    // A backoff in the future is still scheduled work, not a stuck job: once
    // the delay elapses the same stage retries and the pipeline continues.
    h.db.run("UPDATE pipeline_jobs SET next_attempt_at = NULL WHERE id = ?;", [h.job.id]);
    claim(h, "worker-2");
    const second = await h.run();
    expect(second).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    expect(h.executionsOf("script")).toBe(2);
    expect(h.repo.requireStep(h.job.id, "script").attempt).toBe(2);
    expect(h.executionsOf("idea")).toBe(1); // earlier work was not repeated
    expect(h.repo.listJobLogs(h.job.id).some((l) => l.event === "job.retry_scheduled")).toBe(true);
  });

  it("fails a job permanently on a permanent error, without retrying", async () => {
    const h = makeHarness();
    h.fails.set("voice", { remaining: 99, kind: "permanent" });
    claim(h);
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent", stepKey: "voice" });
    const job = h.repo.requireJob(h.job.id);
    expect(job.state).toBe("FAILED");
    expect(job.error_kind).toBe("permanent");
    expect(job.failure_step).toBe("voice");
    expect(job.next_attempt_at).toBeNull();
    expect(h.repo.requireEpisode(h.episode.id).state).toBe("FAILED");
    expect(h.repo.requireEpisode(h.episode.id).error).toMatch(/bad input/);
    expect(h.repo.requireStep(h.job.id, "voice").state).toBe("FAILED");
    // Nothing was claimed again, and the pipeline never reached the gate.
    expect(h.executionsOf("voice")).toBe(1);
    expect(h.executionsOf("qa")).toBe(0);
  });

  it("fails `exhausted` once the retry ceiling is reached", async () => {
    const h = makeHarness();
    h.fails.set("research", { remaining: 99, kind: "retryable" });
    claim(h);
    const outcomes = await h.runToSettled();

    expect(outcomes.at(-1)).toMatchObject({ status: "failed", errorKind: "exhausted" });
    expect(h.executionsOf("research")).toBe(3); // max_attempts default
    const job = h.repo.requireJob(h.job.id);
    expect(job.state).toBe("FAILED");
    expect(job.error_kind).toBe("exhausted");
    expect(job.attempt).toBe(3);
    expect(h.repo.requireEpisode(h.episode.id).state).toBe("FAILED");
  });

  it("honours a stage-level retry ceiling override", async () => {
    const h = makeHarness();
    // 'plan' is capped at 2 attempts regardless of the job's ceiling.
    const planStage = LONG_FORM_PIPELINE.stages.find((s) => s.key === "plan")!;
    const original = planStage.maxAttempts;
    (planStage as { maxAttempts?: number }).maxAttempts = 2;
    try {
      h.fails.set("plan", { remaining: 99, kind: "retryable" });
      claim(h);
      await h.runToSettled();
      expect(h.executionsOf("plan")).toBe(2);
      expect(h.repo.requireJob(h.job.id).error_kind).toBe("exhausted");
    } finally {
      if (original === undefined) delete (planStage as { maxAttempts?: number }).maxAttempts;
      else (planStage as { maxAttempts?: number }).maxAttempts = original;
    }
  });

  it("recovers a FAILED job at the failing stage via operator retry", async () => {
    const h = makeHarness();
    h.fails.set("render", { remaining: 1, kind: "permanent" });
    claim(h);
    await h.run();
    expect(h.repo.requireJob(h.job.id).state).toBe("FAILED");
    const ideasBefore = h.executionsOf("idea");
    const voiceBefore = h.executionsOf("voice");

    // The operator fixes the cause and retries: the job re-enters at 'render'.
    retryFailedJob(h.repo, h.job.id);
    expect(h.repo.requireJob(h.job.id).state).toBe("PENDING");
    claim(h, "worker-2");
    const resumed = await h.run();

    expect(resumed).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    expect(h.executionsOf("render")).toBe(2); // retried
    expect(h.executionsOf("idea")).toBe(ideasBefore); // not redone
    expect(h.executionsOf("voice")).toBe(voiceBefore);
    expect(h.repo.listJobLogs(h.job.id).some((l) => l.event === "job.retry_requested")).toBe(true);
  });

  it("parks a job when a task reports it cannot proceed without a human (quota / review)", async () => {
    const h = makeHarness();
    h.waits.set("fact_check", "FACT_REVIEW");
    claim(h);
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "waiting", gate: "FACT_REVIEW" });
    expect(h.repo.requireJob(h.job.id).waiting_gate).toBe("FACT_REVIEW");
    expect(h.repo.requireStep(h.job.id, "fact_check").state).toBe("WAITING");
    expect(h.executionsOf("script")).toBe(0); // nothing downstream ran

    resolveGate(h.repo, h.job.id, { decision: "approved", notes: "claims verified by hand" });
    claim(h, "worker-2");
    const resumed = await h.run();
    expect(resumed).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    expect(h.executionsOf("script")).toBe(1);
  });
});

describe("orchestration — gates bound to content (AD-08)", () => {
  it("invalidates an approval when the content it approved has changed", async () => {
    const h = makeHarness();
    claim(h);
    await h.run();
    resolveGate(h.repo, h.job.id, { decision: "approved" });
    // Content changes after the approval: a provider swap alters every fingerprint.
    const changed = makeHarnessParams(h, { llm: "groq/llama-3.1-8b" });

    claim(h, "worker-2");
    const after = await runJob(changed, h.job.id);
    expect(after).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    expect(h.repo.requireJob(h.job.id).state).toBe("WAITING_GATE");
    // …and the stages whose configuration changed were re-executed.
    expect(h.executionsOf("script")).toBe(2);
  });

  it("refuses an approval whose fingerprint does not match the parked content", async () => {
    const h = makeHarness();
    claim(h);
    await h.run();
    expect(() =>
      resolveGate(h.repo, h.job.id, { decision: "approved", fingerprint: "0".repeat(64) }),
    ).toThrow(/does not match the parked content/);
  });

  it("cancels the job on rejection and moves the episode to NEEDS_CHANGES", async () => {
    const h = makeHarness();
    claim(h);
    await h.run();
    resolveGate(h.repo, h.job.id, { decision: "rejected", notes: "voice sounds wrong" });

    expect(h.repo.requireJob(h.job.id).state).toBe("CANCELED");
    expect(h.repo.requireJob(h.job.id).error).toMatch(/voice sounds wrong/);
    expect(h.repo.requireEpisode(h.episode.id).state).toBe("NEEDS_CHANGES");
    expect(h.repo.getJobStep(h.job.id, "approval")?.state).toBe("FAILED");
    expect(h.repo.claimJob({ owner: "worker-2", leaseMs: 1_000 })).toBeUndefined();
  });

  it("rewinds a needs_changes decision to the target stage and re-runs from there", async () => {
    const h = makeHarness();
    claim(h);
    await h.run();
    const before = {
      plan: h.executionsOf("plan"),
      voice: h.executionsOf("voice"),
      render: h.executionsOf("render"),
    };

    const result = resolveGate(h.repo, h.job.id, {
      decision: "needs_changes",
      targetStage: "voice",
      notes: "re-record the second paragraph",
    });
    expect(result.invalidatedStages).toEqual([
      "voice",
      "captions",
      "animate",
      "render",
      "qa",
      "approval",
      "publish",
    ]);
    expect(h.repo.requireJob(h.job.id).state).toBe("PENDING");

    claim(h, "worker-2");
    const resumed = await h.run();
    expect(resumed).toMatchObject({ status: "waiting", gate: "FINAL_APPROVAL" });
    expect(h.executionsOf("plan")).toBe(before.plan); // upstream untouched
    expect(h.executionsOf("voice")).toBe(before.voice + 1);
    expect(h.executionsOf("render")).toBe(before.render + 1);
    expect(h.repo.requireStep(h.job.id, "voice").reused_from_job_id).toBeNull();
  });

  it("refuses a needs_changes decision without a valid target stage", async () => {
    const h = makeHarness();
    claim(h);
    await h.run();
    expect(() => resolveGate(h.repo, h.job.id, { decision: "needs_changes" })).toThrow(
      /targetStage/,
    );
    expect(() =>
      resolveGate(h.repo, h.job.id, { decision: "needs_changes", targetStage: "nope" }),
    ).toThrow(/no stage 'nope'/);
  });

  it("refuses to resolve a gate on a job that is not waiting", () => {
    const h = makeHarness();
    expect(() => resolveGate(h.repo, h.job.id, { decision: "approved" })).toThrow(
      /not waiting at a gate/,
    );
  });
});

describe("orchestration — idempotency and multi-pipeline", () => {
  it("collapses duplicate submissions onto one job (idempotency key)", () => {
    const h = makeHarness();
    const first = h.createJob({ idempotencyKey: "episode-1:longform_v1" });
    const second = h.createJob({ idempotencyKey: "episode-1:longform_v1" });
    expect(second.id).toBe(first.id);
    expect(h.repo.listJobs(h.episode.id)).toHaveLength(2); // the harness default + this one
    expect(h.repo.listJobSteps(first.id)).toHaveLength(LONG_STAGES.length); // steps not duplicated
  });

  it("runs the shorts pipeline through its own states and gate", async () => {
    const h = makeHarness();
    // A short episode must belong to a long-form parent.
    claim(h);
    await h.run();
    resolveGate(h.repo, h.job.id, { decision: "approved" });
    await h.claimAndRun(undefined, "worker-2");

    const short = h.repo.createEpisode({
      projectId: h.episode.project_id,
      topic: "Sky in 30 seconds",
      kind: "short",
      parentEpisodeId: h.episode.id,
    });
    const job = h.createJob({ episode: short, pipeline: "shorts_v1" });
    claim(h, "worker-shorts");
    const outcome = await runJob({ ...h.deps, workerId: "worker-shorts" }, job.id);

    expect(outcome).toMatchObject({ status: "waiting", gate: "SHORT_APPROVAL" });
    const labels = getJobStatus(h.repo, job.id).steps.map((s) => s.stateLabel);
    expect(labels).toEqual([
      "CANDIDATES_FOUND",
      "SELECTION_COMPLETE",
      "REWRITE_COMPLETE",
      "LAYOUT_COMPLETE",
      "RENDER_COMPLETE",
      "QA_COMPLETE",
      "AWAITING_APPROVAL",
      "PUBLISHING_PENDING",
    ]);
    expect(h.repo.requireEpisode(short.id).state).toBe("APPROVAL");

    resolveGate(h.repo, job.id, { decision: "approved" });
    claim(h, "worker-shorts");
    const done = await runJob({ ...h.deps, workerId: "worker-shorts" }, job.id);
    expect(done).toMatchObject({ status: "completed" });
    expect(h.repo.requireEpisode(short.id).state).toBe("PUBLISHED");
  });

  it("fails a job loudly when the pipeline declares a stage the worker cannot run", async () => {
    const h = makeHarness();
    const job = h.createJob();
    claim(h);
    const partial = createTaskRegistry([{ stageKey: "idea", execute: async () => ({}) }]);
    await expect(runJob({ ...h.deps, tasks: partial }, job.id)).rejects.toThrow(
      /No task registered for longform_v1 stage\(s\)/,
    );
  });
});

/** Same harness, different cache-affecting params (simulates a provider swap). */
function makeHarnessParams(h: Harness, params: Record<string, unknown>): RunnerDeps {
  return { ...h.deps, params };
}
