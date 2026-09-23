/**
 * Resource-efficiency regression tests (Phase 19, free-tier optimization).
 *
 * The brief: maximum automation with minimum AI/API/cloud usage. These tests
 * pin the reuse guarantees that make that true — measured, not assumed, by
 * counting *paid* provider calls (ledger rows with units > 0; cache hits log
 * units = 0) across whole pipeline runs with the real orchestrator, mock
 * providers and scripted FFmpeg. No network, no keys, nothing published.
 *
 * Findings and their fixes are documented in
 * `docs/operations/free-tier-optimization.md` (FO-1…).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPipelineWorker, DASHBOARD_STEPS, openRuntime, type Runtime } from "@nexus/app";
import { createScriptedFFmpeg } from "@nexus/video";
import { loadEnv } from "@nexus/config";
import { migrate } from "@nexus/db";
import { resolveGate } from "@nexus/jobs";
import type { PipelineJobRow } from "@nexus/db";
import {
  FAKE_VOICES,
  MemoryBlobStore,
  type ProviderResult,
  type SynthesisResult,
} from "@nexus/providers";
import { castingFor, synthesizeNarration, MemorySegmentCache } from "@nexus/audio";
import { planFixture, QA_SECTION_ROLES } from "@nexus/qa";
import { SceneManifestSchema } from "@nexus/scenes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Paid calls so far: ledger rows that represent a real (uncached) provider call. */
function paidCalls(runtime: Runtime): number {
  return runtime.repo
    .listProviderCalls(100_000)
    .filter((row) => row.units > 0 && row.status === "ok").length;
}

/** Drive the worker until the job parks at a gate or settles. */
async function settle(
  runtime: Runtime,
  worker: ReturnType<typeof createPipelineWorker>,
  jobId: string,
): Promise<PipelineJobRow> {
  for (let round = 0; round < 90; round += 1) {
    const job = runtime.repo.requireJob(jobId);
    if (job.state === "WAITING_GATE" || ["DONE", "FAILED", "CANCELED"].includes(job.state)) {
      return job;
    }
    await worker.worker.drain();
  }
  throw new Error("the run never settled");
}

/** Approve every gate until the run completes. */
async function walkToReady(
  runtime: Runtime,
  worker: ReturnType<typeof createPipelineWorker>,
  jobId: string,
): Promise<PipelineJobRow> {
  for (let gate = 0; gate < 4; gate += 1) {
    const job = await settle(runtime, worker, jobId);
    if (job.state === "DONE") return job;
    if (job.state !== "WAITING_GATE") throw new Error(`unexpected state ${job.state}`);
    resolveGate(runtime.repo, jobId, { decision: "approved", gate: job.waiting_gate! });
  }
  throw new Error("the run never reached DONE");
}

describe("whole-pipeline reuse (paid-call ledger)", () => {
  let dataDir: string;
  let runtime: Runtime;
  let worker: ReturnType<typeof createPipelineWorker>;

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "nexus-resource-"));
    const config = loadEnv({
      env: {
        NEXUS_ENV: "test",
        NEXUS_DATA_DIR: dataDir,
        NEXUS_LLM_PROVIDER: "fake",
        NEXUS_RESEARCH_PROVIDER: "fake",
        NEXUS_TTS_PROVIDER: "fake",
        NEXUS_RENDER_WIDTH: "192",
        NEXUS_RENDER_HEIGHT: "108",
        NEXUS_RENDER_FPS: "10",
        NEXUS_RENDER_WORK_DIR: path.join(dataDir, "render"),
        NEXUS_QA_DURATION_TOLERANCE_SEC: "15",
      },
    });
    runtime = openRuntime(config);
    migrate(runtime.db);
    worker = createPipelineWorker(config, {
      runtime,
      ffmpeg: createScriptedFFmpeg({ width: 192, height: 108, fps: 10 }),
      pollIntervalMs: 20,
    });
  });

  afterAll(() => {
    runtime.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function newRun(episodeId: string): PipelineJobRow {
    return runtime.repo.createJob({
      episodeId,
      pipeline: "longform_v1",
      steps: [...DASHBOARD_STEPS],
    }).job;
  }

  it("FO-1: a needs-changes rewind that changes nothing upstream pays zero provider calls", async () => {
    // The expensive real-world trap: an operator rewinds a finished-but-parked
    // run ("tweak the ending"), and a naive implementation re-pays the WHOLE
    // production. Identical inputs must adopt or cache-hit their way through.
    const project = runtime.repo.createProject({ name: "reuse", slug: "reuse" });
    const episode = runtime.repo.createEpisode({
      projectId: project.id,
      topic: "Why canal locks hold water",
    });

    const job1 = newRun(episode.id);
    const factGate = await settle(runtime, worker, job1.id);
    expect(factGate.state).toBe("WAITING_GATE");
    resolveGate(runtime.repo, job1.id, { decision: "approved", gate: factGate.waiting_gate! });

    const finalGate = await settle(runtime, worker, job1.id);
    expect(finalGate.state).toBe("WAITING_GATE");
    const paidRun1 = paidCalls(runtime);
    expect(paidRun1).toBeGreaterThan(0); // the first production really did pay

    // Rewind to the script stage (operator asks for a tweak upstream of the
    // gate) and let the run walk itself back to the gate.
    resolveGate(runtime.repo, job1.id, {
      decision: "needs_changes",
      targetStage: "script",
    });
    const rewound = await settle(runtime, worker, job1.id);
    expect(rewound.state).toBe("WAITING_GATE");

    const paidRewind = paidCalls(runtime) - paidRun1;
    expect(paidRewind, "identical upstream inputs must not be re-paid").toBe(0);

    // Finish the run: every rewound stage completed again, from cache.
    resolveGate(runtime.repo, job1.id, { decision: "approved", gate: rewound.waiting_gate! });
    const done1 = await settle(runtime, worker, job1.id);
    expect(done1.state).toBe("DONE");
    expect(runtime.repo.getJobStep(job1.id, "voice")?.state).toBe("DONE");
    expect(runtime.repo.getJobStep(job1.id, "render")?.state).toBe("DONE");
  }, 180_000);

  it("FO-2: a second episode on the same topic pays zero provider calls", async () => {
    const project = runtime.repo.createProject({ name: "reuse2", slug: "reuse2" });
    const episodeB = runtime.repo.createEpisode({
      projectId: project.id,
      topic: "Why canal locks hold water",
    });
    const before = paidCalls(runtime);

    const job = newRun(episodeB.id);
    const done = await walkToReady(runtime, worker, job.id);
    expect(done.state).toBe("DONE");

    expect(
      paidCalls(runtime) - before,
      "same-topic research/script/voice must come from cache",
    ).toBe(0);
  }, 180_000);

  it("FO-3: a different topic is genuinely new work — it pays, bounded, and completes", async () => {
    const project = runtime.repo.createProject({ name: "fresh", slug: "fresh" });
    const episodeC = runtime.repo.createEpisode({
      projectId: project.id,
      topic: "How do solar sails steer a probe",
    });
    const before = paidCalls(runtime);

    const job = newRun(episodeC.id);
    const done = await walkToReady(runtime, worker, job.id);
    expect(done.state).toBe("DONE");
    expect(paidCalls(runtime) - before).toBeGreaterThan(0);
  }, 180_000);
});

describe("TTS segment granularity (paid-call counting)", () => {
  /** A minimal deterministic TTS answer (a real WAV envelope) for the probe. */
  function fakeSynthResult(store: MemoryBlobStore): ProviderResult<SynthesisResult> {
    const seconds = 1;
    const sampleRate = 8_000;
    const dataBytes = seconds * sampleRate * 2;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataBytes, 40);
    const bytes = new Uint8Array(Buffer.concat([header, Buffer.alloc(dataBytes)]));
    // The bytes must live in the CAS under their real hash — a cache entry
    // naming absent bytes is (by design) treated as stale.
    const stored = store.put(bytes);
    return {
      value: {
        audio: {
          hash: stored.hash,
          bytes: bytes.length,
          mime: "audio/wav",
          durationMs: seconds * 1000,
        },
        characters: 9,
      },
      provider: "counting-tts",
      operation: "tts.synthesize",
      cached: false,
      attempts: 1,
      durationMs: 0,
      usage: { units: 9, unit: "characters" },
    };
  }

  it("FO-4: changing one narration line re-synthesizes only that line", async () => {
    const storage = new MemoryBlobStore();
    const cache = new MemorySegmentCache();

    const draft = planFixture({ sections: QA_SECTION_ROLES, width: 320, height: 180 });
    const manifest = SceneManifestSchema.parse(draft);
    const casting = castingFor(manifest, { language: "en", sampleRate: 8_000, rate: 1 });

    let synthCalls = 0;
    const countingTts = {
      // The cast names a real fake voice; the adapter must offer it.
      voices: () => FAKE_VOICES,
      synthesize: async () => {
        synthCalls += 1;
        return fakeSynthResult(storage);
      },
    };

    const deps = (now: string) => ({
      tts: countingTts,
      storage,
      clock: (() => new Date(now)) as never,
      tuning: { baseDelayMs: 1, factor: 1, maxDelayMs: 2 },
      cache,
    });

    const first = await synthesizeNarration(
      { manifest, manifestHash: "a".repeat(64), casting, now: "2024-05-01T12:00:00.000Z" },
      deps("2024-05-01T12:00:00.000Z"),
    );
    const lines = first.track.segments.length;
    expect(lines).toBeGreaterThan(0);
    const baseline = synthCalls;
    expect(baseline).toBe(lines); // exactly one call per line: no probes, no duplicates

    // Change ONE scene's spoken text; keep every other scene identical.
    const changed = structuredClone(manifest);
    const lastScene = changed.scenes[changed.scenes.length - 1]!;
    expect(lastScene.narration).toBeDefined();
    lastScene.narration!.text = `${lastScene.narration!.text} Truly.`;
    const changedCasting = castingFor(changed, { language: "en", sampleRate: 8_000, rate: 1 });

    const second = await synthesizeNarration(
      {
        manifest: changed,
        manifestHash: "b".repeat(64),
        casting: changedCasting,
        now: "2024-05-01T12:00:01.000Z",
      },
      deps("2024-05-01T12:00:01.000Z"),
    );
    expect(second.track.segments.length).toBeGreaterThan(0);
    expect(synthCalls - baseline, "only the changed line may be re-synthesized").toBe(1);
  }, 60_000);
});
