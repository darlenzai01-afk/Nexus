import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv } from "@nexus/config";
import { migrate } from "@nexus/db";
import { resolveGate } from "@nexus/jobs";
import { DASHBOARD_STEPS, createPipelineWorker, openRuntime, type Runtime } from "@nexus/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration test for the worker entrypoint's wiring: the real task registry
 * (domain engines + dashboard glue) claims and executes a job against a shared
 * data directory, parks it at the pipeline's first human gate, and honours the
 * gate decision — approve ends the run canceled-free, reject cancels it. The
 * full happy path with scripted FFmpeg lives in apps/nexus/src/app.test.ts;
 * here we prove the worker role composes and the gates bind, without needing a
 * renderer at all.
 */
describe("nexus worker (integration)", () => {
  let dataDir: string;
  let runtime: Runtime;
  let drain: () => Promise<unknown>;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "nexus-worker-"));
    const config = loadEnv({
      env: {
        NEXUS_ENV: "test",
        NEXUS_DATA_DIR: dataDir,
        NEXUS_LOG_LEVEL: "silent",
        NEXUS_LLM_PROVIDER: "fake",
        NEXUS_RESEARCH_PROVIDER: "fake",
        NEXUS_TTS_PROVIDER: "fake",
      },
    });
    runtime = openRuntime(config);
    migrate(runtime.db);
    const worker = createPipelineWorker(config, { runtime, pollIntervalMs: 20 });
    drain = () => worker.worker.drain();
  });

  afterAll(async () => {
    runtime.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs a real pipeline to its first human gate, then honours the decision", async () => {
    const { repo } = runtime;
    const project = repo.createProject({ name: "Integration", slug: "integration" });
    const episode = repo.createEpisode({ projectId: project.id, topic: "Why canal locks hold" });
    const { job } = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: DASHBOARD_STEPS,
    });

    // The worker walks the live stages until something needs a human.
    for (let round = 0; round < 120; round += 1) {
      const state = repo.requireJob(job.id).state;
      if (
        state === "WAITING_GATE" ||
        state === "DONE" ||
        state === "FAILED" ||
        state === "CANCELED"
      )
        break;
      await drain();
    }
    const parked = repo.requireJob(job.id);
    expect(parked.state).toBe("WAITING_GATE");
    expect(parked.waiting_gate).toBe("FACT_REVIEW");

    // The research stage really ran: the episode has a research package.
    const researchStep = repo.listJobSteps(job.id).find((step) => step.step_key === "research");
    expect(researchStep?.state).toBe("DONE");

    // A rejection at the gate cancels the run and flags the episode.
    resolveGate(repo, job.id, {
      decision: "rejected",
      reviewedBy: "integration-test",
      notes: "the fake sources are not usable",
    });
    const canceled = repo.requireJob(job.id);
    expect(canceled.state).toBe("CANCELED");
    expect(repo.requireEpisode(episode.id).state).toBe("NEEDS_CHANGES");
  });
});
