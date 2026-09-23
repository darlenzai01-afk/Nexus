import { beforeEach, describe, expect, it } from "vitest";

import { Db, MIGRATIONS, migrate } from "./index.js";
import { ConflictError, NotFoundError, Repo, ValidationError } from "./repo.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/**
 * Repo-level tests for the Phase 3 orchestration primitives: idempotent job
 * creation, retry bookkeeping, stage checkpoints with artifact references,
 * reuse lookups, gates and the append-only job log.
 */
describe("orchestration persistence", () => {
  let db: Db;
  let repo: Repo;
  let episodeId: string;
  const steps = ["idea", "research", "script"] as const;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    episodeId = repo.createEpisode({
      projectId: repo.createProject({ name: "P", slug: "p" }).id,
      topic: "Orchestration",
    }).id;
  });

  const newJob = (idempotencyKey?: string, maxAttempts?: number) =>
    repo.createJob({
      episodeId,
      pipeline: "longform_v1",
      steps,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    }).job;

  it("applies migration 0002 additively on top of 0001", () => {
    const columns = db
      .all<{ name: string; notnull: number }>(
        `SELECT name, "notnull" FROM pragma_table_info('pipeline_jobs');`,
      )
      .map((c) => c.name);
    for (const column of [
      "idempotency_key",
      "max_attempts",
      "next_attempt_at",
      "heartbeat_at",
      "error_kind",
      "failure_step",
    ]) {
      expect(columns, `pipeline_jobs.${column}`).toContain(column);
    }
    const stepColumns = db
      .all<{ name: string }>("SELECT name FROM pragma_table_info('pipeline_job_steps');")
      .map((c) => c.name);
    for (const column of ["artifacts", "reused_from_job_id", "reused_from_step_key"]) {
      expect(stepColumns, `pipeline_job_steps.${column}`).toContain(column);
    }
    expect(MIGRATIONS.map((m) => m.id)).toEqual([
      "0001_domain_foundation",
      "0002_job_orchestration",
    ]);
    // The retry ceiling got a sane default for rows created by the older schema.
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_jobs;")?.n).toBe(0);
    expect(newJob().max_attempts).toBe(3);
  });

  it("collapses duplicate job submissions onto one job (idempotency key)", () => {
    const first = newJob("episode:longform_v1");
    const second = newJob("episode:longform_v1");
    expect(second.id).toBe(first.id);
    expect(repo.listJobs(episodeId)).toHaveLength(1);
    expect(repo.listJobSteps(first.id)).toHaveLength(steps.length);
    expect(repo.findJobByIdempotencyKey("episode:longform_v1")?.id).toBe(first.id);
    // Distinct keys stay distinct.
    expect(newJob("episode:longform_v1:retry").id).not.toBe(first.id);
    expect(() => newJob("")).toThrow(ValidationError);
    expect(() => newJob(undefined, 0)).toThrow(ValidationError);
  });

  it("enforces the unique idempotency index at the database level too", () => {
    newJob("dup");
    expect(() =>
      db.run(
        `INSERT INTO pipeline_jobs (id, episode_id, pipeline, state, attempt, created_at, updated_at, idempotency_key, max_attempts)
         VALUES ('x', ?, 'longform_v1', 'PENDING', 0, 't', 't', 'dup', 3);`,
        [episodeId],
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("claims only jobs whose retry backoff has elapsed, and stamps the heartbeat", () => {
    const job = newJob();
    repo.logJob({ jobId: job.id, event: "seed" });
    repo.claimJob({ owner: "w1", leaseMs: 60_000 });
    expect(repo.requireJob(job.id).heartbeat_at).not.toBeNull();

    repo.requeueJob(job.id, { delayMs: 60_000, error: "provider flaked", failureStep: "research" });
    const backlogged = repo.requireJob(job.id);
    expect(backlogged.state).toBe("PENDING");
    expect(backlogged.error_kind).toBe("retryable");
    expect(backlogged.failure_step).toBe("research");
    expect(backlogged.lease_owner).toBeNull();
    expect(backlogged.next_attempt_at! > new Date().toISOString()).toBe(true);
    expect(repo.claimJob({ owner: "w2", leaseMs: 1_000 })).toBeUndefined(); // still backing off

    // Time passes (simulated): the job becomes claimable again.
    db.run("UPDATE pipeline_jobs SET next_attempt_at = NULL WHERE id = ?;", [job.id]);
    const reclaimed = repo.claimJob({ owner: "w2", leaseMs: 1_000 });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempt).toBe(2);

    repo.renewLease(job.id, "w2", 5_000);
    expect(repo.requireJob(job.id).heartbeat_at).not.toBeNull();
    expect(() => repo.renewLease(job.id, "someone-else", 5_000)).toThrow(ConflictError);
  });

  it("records terminal failures and cancellations with their cause", () => {
    const job = newJob();
    const failed = repo.failJob(job.id, {
      error: "LLM returned invalid JSON",
      errorKind: "permanent",
      failureStep: "script",
    });
    expect(failed).toMatchObject({
      state: "FAILED",
      error_kind: "permanent",
      failure_step: "script",
    });
    expect(failed.next_attempt_at).toBeNull();
    expect(failed.lease_owner).toBeNull();
    expect(() => repo.failJob(job.id, { error: "", errorKind: "permanent" })).toThrow(
      ValidationError,
    );
    expect(() => repo.failJob(job.id, { error: "x", errorKind: "nope" as never })).toThrow(
      ValidationError,
    );

    const other = newJob();
    const canceled = repo.cancelJob(other.id, "operator changed their mind");
    expect(canceled).toMatchObject({ state: "CANCELED", error_kind: "canceled" });
    expect(canceled.error).toMatch(/changed their mind/);
  });

  it("checkpoints a stage with artifact references and reuse provenance", () => {
    const job = newJob();
    repo.registerArtifact({ hash: SHA_A, kind: "script", bytes: 100 });
    repo.registerArtifact({ hash: SHA_B, kind: "audio", bytes: 200 });

    const step = repo.checkpointStep(job.id, "research", {
      inputHash: "f".repeat(64),
      output: { sources: 2 },
      artifacts: [
        { hash: SHA_A, kind: "script", role: "outline" },
        { hash: SHA_B, kind: "audio", role: "narration" },
      ],
      reusedFrom: { jobId: "job-parent", stepKey: "research" },
    });
    expect(step.state).toBe("DONE");
    expect(step.reused_from_job_id).toBe("job-parent");
    expect(repo.stepArtifacts(job.id, "research")).toHaveLength(2);
    expect(repo.isStepSatisfied(job.id, "research", "f".repeat(64))).toBe(true);
    expect(repo.isStepSatisfied(job.id, "research", "0".repeat(64))).toBe(false);

    // An artifact the system does not know about cannot be claimed.
    expect(() =>
      repo.checkpointStep(job.id, "script", {
        inputHash: "g".repeat(64),
        artifacts: [{ hash: "c".repeat(64), kind: "video", role: "master" }],
      }),
    ).toThrow(/not registered/);
    expect(repo.getJobStep(job.id, "script")?.state).toBe("PENDING"); // unchanged

    // Invalidation clears the fingerprint, the references and the provenance.
    repo.invalidateFromStep(job.id, "research");
    const reset = repo.requireStep(job.id, "research");
    expect(reset).toMatchObject({
      state: "PENDING",
      input_hash: null,
      artifacts: "[]",
      reused_from_job_id: null,
    });
  });

  it("finds a completed stage run by fingerprint, ignoring the current and cancelled jobs", () => {
    const source = newJob();
    repo.registerArtifact({ hash: SHA_A, kind: "script", bytes: 10 });
    const fingerprint = "1".repeat(64);
    repo.checkpointStep(source.id, "script", {
      inputHash: fingerprint,
      output: { version: 1 },
      artifacts: [{ hash: SHA_A, kind: "script", role: "doc" }],
    });
    repo.setJobState(source.id, "DONE");

    const target = newJob();
    const found = repo.findCompletedStageRun(fingerprint, "script", target.id);
    expect(found).toMatchObject({ jobId: source.id, stepKey: "script" });
    expect(found?.artifacts).toHaveLength(1);
    expect(repo.findCompletedStageRun(fingerprint, "script", source.id)).toBeUndefined(); // itself
    expect(repo.findCompletedStageRun(fingerprint, "voice", target.id)).toBeUndefined(); // other stage
    expect(repo.findCompletedStageRun("2".repeat(64), "script", target.id)).toBeUndefined();

    // A canceled job does not donate artifacts.
    repo.cancelJob(source.id);
    expect(repo.findCompletedStageRun(fingerprint, "script", target.id)).toBeUndefined();

    // With no exclusion the canceled source is still ineligible: canceled jobs
    // never donate artifacts, whoever asks.
    expect(repo.findCompletedStageRun(fingerprint, "script", undefined)).toBeUndefined();
  });

  it("parks a stage at a gate with the fingerprint of the gated content", () => {
    const job = newJob();
    repo.claimJob({ owner: "w1", leaseMs: 60_000 });
    const fingerprint = "3".repeat(64);
    const step = repo.waitStep(job.id, "research", { gate: "FACT_REVIEW", fingerprint });
    expect(step.state).toBe("WAITING");
    expect(step.input_hash).toBe(fingerprint);
    expect(step.started_at).not.toBeNull();

    const parked = repo.setJobState(job.id, "WAITING_GATE", { gate: "FACT_REVIEW" });
    expect(parked.waiting_gate).toBe("FACT_REVIEW");
    expect(parked.lease_owner).toBeNull();

    expect(() => repo.waitStep(job.id, "research", { gate: "", fingerprint })).toThrow(
      ValidationError,
    );
    expect(() => repo.waitStep(job.id, "research", { gate: "G", fingerprint: "nope" })).toThrow(
      ValidationError,
    );
    expect(() => repo.waitStep(job.id, "nope", { gate: "G", fingerprint })).toThrow(NotFoundError);
  });

  it("keeps an append-only job log in chronological order", () => {
    const job = newJob();
    repo.logJob({ jobId: job.id, event: "job.created" });
    repo.logJob({
      jobId: job.id,
      stepKey: "idea",
      event: "stage.started",
      message: "go",
      data: { a: 1 },
    });
    repo.logJob({
      jobId: job.id,
      stepKey: "idea",
      level: "warn",
      event: "stage.retry",
      message: "again",
    });

    const logs = repo.listJobLogs(job.id);
    expect(logs.map((log) => log.event)).toEqual(["job.created", "stage.started", "stage.retry"]);
    expect(logs[1]).toMatchObject({ step_key: "idea", level: "info", data: '{"a":1}' });
    expect(logs[1]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(logs.every((log) => log.created_at.length === 24)).toBe(true);

    expect(repo.listJobLogs(job.id, { limit: 1 }).map((l) => l.event)).toEqual(["stage.retry"]);
    expect(repo.listJobLogs(job.id, { afterId: logs[0]!.id }).map((l) => l.event)).toEqual([
      "stage.started",
      "stage.retry",
    ]);
    expect(() => repo.logJob({ jobId: job.id, event: "" })).toThrow(ValidationError);
    expect(() => repo.logJob({ jobId: "missing", event: "x" })).toThrow(NotFoundError);
    expect(() => repo.listJobLogs(job.id, { limit: 0 })).toThrow(ValidationError);

    // Logs cascade with their job: no orphans.
    repo.cancelJob(job.id);
    db.run("DELETE FROM pipeline_jobs WHERE id = ?;", [job.id]);
    expect(repo.listJobLogs(job.id)).toHaveLength(0);
  });

  it("tracks the job input fingerprint and lists jobs by state", () => {
    const job = newJob();
    const updated = repo.setJobInputFingerprint(job.id, "ab".repeat(32));
    expect(updated.input_fingerprint).toBe("ab".repeat(32));
    expect(() => repo.setJobInputFingerprint(job.id, " ")).toThrow(ValidationError);

    expect(repo.listJobsByState(["PENDING"]).map((j) => j.id)).toEqual([job.id]);
    repo.setJobState(job.id, "RUNNING");
    expect(repo.listJobsByState(["PENDING"])).toHaveLength(0);
    expect(repo.listJobsByState(["RUNNING"]).map((j) => j.id)).toEqual([job.id]);
    expect(repo.listJobsByState([])).toEqual([]);
    expect(() => repo.listJobsByState(["NOPE" as never])).toThrow(ValidationError);
  });
});
