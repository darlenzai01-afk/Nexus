import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Db, migrate, Repo, type ArtifactRef } from "@nexus/db";
import {
  LONG_FORM_PIPELINE,
  Worker,
  createTaskRegistry,
  getJobStatus,
  resolveGate,
  silentLogger,
  type Task,
} from "@nexus/jobs";
import { CasStore } from "@nexus/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end orchestration over a real, file-backed database and a real
 * content-addressed store. Nothing here is mocked except the stage work
 * itself (there are no providers yet): what is under test is durability —
 * a second "process" opening the same files must find its work where it was
 * left, must not redo it, and must be able to finish it.
 */

const LONG_STAGES = LONG_FORM_PIPELINE.stages.map((s) => s.key);

describe("orchestration (file-backed, cross-process)", () => {
  let dir: string;
  let dbPath: string;
  let casRoot: string;
  let db: Db;
  let repo: Repo;
  let cas: CasStore;
  let executions: Map<string, number>;

  const openProcess = (): { db: Db; repo: Repo } => {
    const processDb = Db.open(dbPath);
    migrate(processDb);
    return { db: processDb, repo: new Repo(processDb) };
  };

  /** Stage work: put real bytes in the CAS and register the artifact row. */
  const registryFor = (processRepo: Repo, processCas: CasStore) => {
    const taskFor = (stageKey: string, produces: readonly ArtifactRef["kind"][]): Task => ({
      stageKey,
      async execute(ctx) {
        executions.set(stageKey, (executions.get(stageKey) ?? 0) + 1);
        const artifacts: ArtifactRef[] = produces.map((kind) => {
          const blob = processCas.put(
            new TextEncoder().encode(`${stageKey}|${ctx.fingerprint}|${kind}`),
          );
          processRepo.registerArtifact({
            hash: blob.hash,
            kind,
            bytes: blob.bytes,
            meta: { generatedBy: { provider: "integration-test" } },
          });
          return { hash: blob.hash, kind, role: kind };
        });
        return { output: { stage: stageKey, artifacts: artifacts.length }, artifacts };
      },
    });
    return createTaskRegistry(
      LONG_FORM_PIPELINE.stages.map((stage) => taskFor(stage.key, stage.produces)),
    );
  };

  const workerFor = (processRepo: Repo, processCas: CasStore, id: string): Worker =>
    new Worker({
      repo: processRepo,
      tasks: registryFor(processRepo, processCas),
      workerId: id,
      leaseMs: 30_000,
      pollIntervalMs: 5,
      logger: silentLogger,
      artifactExists: (hash) => processCas.has(hash),
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nexus-orchestration-"));
    dbPath = path.join(dir, "nexus.sqlite");
    casRoot = path.join(dir, "cas");
    cas = new CasStore(casRoot);
    executions = new Map();
    const first = openProcess();
    db = first.db;
    repo = first.repo;
  });

  afterEach(() => {
    try {
      db.close(); // tests that simulate a restart close the process themselves
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const seedEpisode = (topic: string): string => {
    const project =
      repo.listProjects()[0] ?? repo.createProject({ name: "Channel", slug: "channel" });
    return repo.createEpisode({ projectId: project.id, topic, outline: ["intro", "detail"] }).id;
  };

  const createJob = (episodeId: string, idempotencyKey?: string): string =>
    repo.createJob({
      episodeId,
      pipeline: "longform_v1",
      steps: LONG_STAGES,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    }).job.id;

  it("survives a restart: a second process resumes at the gate and publishes without redoing work", async () => {
    const episodeId = seedEpisode("Why the sky is blue");
    const jobId = createJob(episodeId);

    // ── Process 1: run until the mandatory approval gate.
    const summary = await workerFor(repo, cas, "process-1").drain();
    expect(summary).toMatchObject({ claimed: 1, waiting: 1 });
    expect(repo.requireJob(jobId).state).toBe("WAITING_GATE");
    const afterFirstRun = new Map(executions);
    const artifactsBefore = repo.raw<{ n: number }>("SELECT COUNT(*) AS n FROM artifacts;")[0]!.n;
    expect(artifactsBefore).toBeGreaterThan(0);
    db.close();

    // ── Process 2: a different process, same files.
    const second = openProcess();
    const status = getJobStatus(second.repo, jobId);
    expect(status.waitingGate).toBe("FINAL_APPROVAL");
    expect(status.steps.map((s) => s.stateLabel)).toContain("AWAITING_APPROVAL");
    expect(status.logs.some((log) => log.event === "gate.waiting")).toBe(true);
    expect(second.repo.listJobSteps(jobId).filter((s) => s.state === "DONE")).toHaveLength(
      LONG_STAGES.length - 2,
    );

    resolveGate(second.repo, jobId, { decision: "approved", notes: "approved after restart" });
    const worker2 = new Worker({
      repo: second.repo,
      tasks: registryFor(second.repo, cas),
      workerId: "process-2",
      leaseMs: 30_000,
      logger: silentLogger,
      artifactExists: (hash) => cas.has(hash),
    });
    const finished = await worker2.drain();
    expect(finished).toMatchObject({ claimed: 1, completed: 1 });
    expect(second.repo.requireJob(jobId).state).toBe("DONE");
    expect(second.repo.requireEpisode(episodeId).state).toBe("PUBLISHED");

    // Nothing before the gate was re-executed in the second process.
    for (const stage of LONG_STAGES.slice(0, -2)) {
      expect(executions.get(stage), `${stage} was re-executed`).toBe(afterFirstRun.get(stage) ?? 0);
    }
    expect(executions.get("publish")).toBe(1);
    second.db.close();
  });

  it("reuses every completed stage across episodes and jobs, including through a restart", async () => {
    const firstEpisode = seedEpisode("Identical topic");
    const firstJob = createJob(firstEpisode, "topic:identical:v1");
    await workerFor(repo, cas, "process-1").drain();
    resolveGate(repo, firstJob, { decision: "approved" });
    await workerFor(repo, cas, "process-1").drain();
    expect(repo.requireJob(firstJob).state).toBe("DONE");
    const executionsAfterFirst = new Map(executions);
    const blobsAfterFirst = cas.list();

    // ── The same request submitted twice collapses onto one job.
    const duplicate = repo.createJob({
      episodeId: firstEpisode,
      pipeline: "longform_v1",
      steps: LONG_STAGES,
      idempotencyKey: "topic:identical:v1",
    }).job;
    expect(duplicate.id).toBe(firstJob);

    // ── A second episode with the same content: everything is reused.
    const secondEpisode = seedEpisode("Identical topic");
    const secondJob = createJob(secondEpisode);
    const worker2 = workerFor(repo, cas, "process-2");
    await worker2.drain();
    resolveGate(repo, secondJob, { decision: "approved" });
    await worker2.drain();

    expect(repo.requireJob(secondJob).state).toBe("DONE");
    // Reuse must move the episode forward too: artifacts exist, so the episode
    // is as far along as they say (a fully reused episode is PUBLISHED).
    expect(repo.requireEpisode(secondEpisode).state).toBe("PUBLISHED");
    for (const [stage, count] of executionsAfterFirst) {
      expect(executions.get(stage), `${stage} re-executed instead of reused`).toBe(count);
    }
    const adopted = repo.listJobSteps(secondJob).filter((s) => s.reused_from_job_id !== null);
    // Everything except the approval stage: a gate is a human decision per
    // episode, so it is never "reused" — but it binds to the same fingerprint.
    const reusableStages = LONG_STAGES.filter((key) => key !== "approval");
    expect(adopted.map((s) => s.step_key)).toEqual(reusableStages);
    expect(adopted.every((s) => s.reused_from_job_id === firstJob)).toBe(true);
    expect(repo.requireStep(secondJob, "approval").state).toBe("DONE");
    expect(repo.requireStep(secondJob, "approval").reused_from_job_id).toBeNull();
    // Content-addressed storage meant no new bytes were written at all.
    expect(cas.list()).toEqual(blobsAfterFirst);
    expect(repo.listAudit().filter((row) => row.action === "stage.reused").length).toBeGreaterThan(
      0,
    );
  });

  it("re-running a finished episode is satisfied from artifacts and never corrupts the terminal state", async () => {
    const episodeId = seedEpisode("Re-published episode");
    const first = createJob(episodeId);
    const worker = workerFor(repo, cas, "process-1");
    await worker.drain();
    resolveGate(repo, first, { decision: "approved" });
    await worker.drain();
    expect(repo.requireEpisode(episodeId).state).toBe("PUBLISHED");
    const executionsAfterFirst = new Map(executions);

    // A second run of the same episode: every stage is adopted, and because the
    // earlier approval is bound to the *same episode and content fingerprint*
    // the gate does not re-ask — it is honoured, not bypassed.
    const second = createJob(episodeId);
    const secondSummary = await worker.drain();

    expect(secondSummary).toMatchObject({ completed: 1, waiting: 0 });
    expect(repo.requireJob(second).state).toBe("DONE");
    expect(repo.requireEpisode(episodeId).state).toBe("PUBLISHED"); // terminal, uncorrupted
    expect(executions).toEqual(executionsAfterFirst); // zero executions, all reused
    expect(repo.requireStep(second, "publish").reused_from_job_id).toBe(first);
    expect(repo.requireStep(second, "approval").reused_from_job_id).toBeNull(); // the gate was resolved, not copied
    expect(repo.listJobLogs(second).some((log) => log.event === "gate.approved")).toBe(true);
    const rejected = repo
      .listJobLogs(second)
      .filter((log) => log.event === "episode.transition.rejected");
    expect(rejected.length).toBeGreaterThan(0); // refused loudly, not silently
  });

  it("re-executes a stage when its artifact bytes have vanished from the store", async () => {
    const episodeId = seedEpisode("Vanishing artifacts");
    const jobId = createJob(episodeId);
    await workerFor(repo, cas, "process-1").drain();
    const renderExecutions = executions.get("render") ?? 0;

    const secondEpisode = seedEpisode("Vanishing artifacts");
    const secondJob = createJob(secondEpisode);
    const worker = workerFor(repo, cas, "process-2");
    await worker.drain(); // reuse works while the bytes are present
    expect(executions.get("render")).toBe(renderExecutions);

    // A third episode, but the render output is gone from the store.
    const casualty = repo.stepArtifacts(secondJob, "render")[0]!;
    rmSync(cas.pathFor(casualty.hash));
    expect(cas.has(casualty.hash)).toBe(false);

    const thirdEpisode = seedEpisode("Vanishing artifacts");
    const thirdJob = createJob(thirdEpisode);
    await workerFor(repo, cas, "process-3").drain();

    expect(executions.get("render")).toBe(renderExecutions + 1); // re-rendered, not phantom-reused
    expect(repo.requireStep(thirdJob, "render").reused_from_job_id).toBeNull();
    expect(repo.listJobLogs(thirdJob).some((log) => log.event === "stage.reuse.rejected")).toBe(
      true,
    );
    expect(repo.requireJob(jobId).state).toBe("WAITING_GATE"); // earlier job untouched
  });

  it("keeps one job per claim and one lease per job across concurrent workers", async () => {
    const episodeId = seedEpisode("Contention");
    const jobId = createJob(episodeId);
    const workerA = workerFor(repo, cas, "worker-a");
    const workerB = workerFor(repo, cas, "worker-b");

    // A live lease is respected: while worker-a holds the job, worker-b finds
    // nothing to claim.
    const held = repo.claimJob({ owner: "worker-a", leaseMs: 30_000 })!;
    expect(held.lease_owner).toBe("worker-a");
    expect(await workerB.tick()).toBeUndefined();
    expect(repo.requireJob(jobId).attempt).toBe(1);

    // Two workers racing the same queue produce exactly one claim.
    repo.requeueJob(jobId, { error: "operator requeue", failureStep: "idea" });
    repo.setJobState(jobId, "PENDING");
    const outcomes = await Promise.all([workerA.tick(), workerB.tick()]);
    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
    const claimed = repo.requireJob(jobId);
    expect(claimed.attempt).toBe(2);
    expect(claimed.state).toBe("WAITING_GATE"); // the winning worker ran to the gate
    expect(claimed.heartbeat_at).not.toBeNull();
  });
});
