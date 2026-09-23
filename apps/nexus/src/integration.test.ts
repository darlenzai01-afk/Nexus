import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv, type AppConfig } from "@nexus/config";
import { migrate, type PipelineJobRow, type Repo } from "@nexus/db";
import { loadQAReport } from "@nexus/qa";
import { loadSceneManifest } from "@nexus/scenes";
import { loadScriptDoc } from "@nexus/script";
import { loadAudioTrack } from "@nexus/audio";
import { createScriptedFFmpeg, type FFmpegRunner } from "@nexus/video";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { DASHBOARD_PIPELINE } from "./pipeline.js";
import { SHORTS_DASHBOARD_PIPELINE } from "./shorts-pipeline.js";
import { openRuntime, type Runtime } from "./runtime.js";
import type { PipelineDef } from "@nexus/jobs";
import { createPipelineWorker, type PipelineWorker } from "./worker.js";

/**
 * The complete end-to-end integration test: both Nexus Forge workflows, over
 * the real orchestrator, real engines and mock providers (fake LLM/research/
 * TTS, scripted FFmpeg — no network, no keys, nothing published).
 *
 *   TOPIC → RESEARCH → SCRIPT → SCENE PLAN → MEDIA → VOICE → ANIMATION →
 *   RENDER → QA → HUMAN APPROVAL
 *
 *   LONG VIDEO → TRANSCRIPT/TIMELINE → SHORT ANALYSIS → CANDIDATES →
 *   VERTICAL LAYOUT → RENDER → QA → HUMAN APPROVAL
 *
 * It must PROVE, from durable state (never from mocks): state transitions,
 * artifact creation, artifact reuse, failure recovery, QA blocking, approval
 * gating, and short generation.
 */

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const LONG_FFMPEG = createScriptedFFmpeg({ width: 192, height: 108, fps: 10 });
const SHORT_FFMPEG = createScriptedFFmpeg({ width: 1080, height: 1920, fps: 10 });

interface Stack {
  readonly config: AppConfig;
  readonly dataDir: string;
  readonly runtime: Runtime;
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly repo: Repo;
  worker(options?: { ffmpeg?: FFmpegRunner; shortFfmpeg?: FFmpegRunner }): PipelineWorker;
  close(): void;
}

/** One self-contained dashboard over a data directory (created or reused). */
async function start(
  env: Record<string, string> = {},
  options: { dataDir?: string } = {},
): Promise<Stack> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), "nexus-e2e-"));
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
      ...env,
    },
  });
  const runtime = openRuntime(config);
  migrate(runtime.db);
  const app = await buildApp(config, { repo: runtime.repo, storage: runtime.storage });
  return {
    config,
    dataDir,
    runtime,
    app,
    repo: runtime.repo,
    worker: (workerOptions = {}) =>
      createPipelineWorker(config, {
        runtime,
        ffmpeg: workerOptions.ffmpeg ?? LONG_FFMPEG,
        shortFfmpeg: workerOptions.shortFfmpeg ?? SHORT_FFMPEG,
        pollIntervalMs: 20,
      }),
    close: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

async function createEpisode(s: Stack, topic: string): Promise<string> {
  const response = await s.app.inject({
    method: "POST",
    url: "/episodes",
    payload: new URLSearchParams({ topic }).toString(),
    headers: FORM,
  });
  expect(response.statusCode).toBe(303);
  return (response.headers.location as string).replace("/episodes/", "").split("?")[0]!;
}

async function post(s: Stack, url: string, fields: Record<string, string> = {}): Promise<string> {
  const response = await s.app.inject({
    method: "POST",
    url,
    payload: new URLSearchParams(fields).toString(),
    headers: FORM,
  });
  expect(response.statusCode).toBe(303);
  return response.headers.location as string;
}

/** The observed episode states, in order — the transition record. */
class StateLog {
  private readonly seen: string[] = [];
  record(state: string): void {
    if (this.seen.at(-1) !== state) this.seen.push(state);
  }
  get states(): readonly string[] {
    return this.seen;
  }
  /** Every entry of `expected` appears in order (others may interleave). */
  expectSequence(expected: readonly string[]): void {
    let cursor = 0;
    for (const state of this.seen) {
      if (state === expected[cursor]) cursor += 1;
    }
    expect(cursor, `observed ${this.seen.join(" → ")}`).toBe(expected.length);
  }
}

/**
 * Drain the worker until the episode/job reaches `predicate`, recording the
 * episode's state after every round. One drain = one claim/dispatch round, so
 * the sampler sees the intermediate states a watcher would.
 */
async function runUntil(
  s: Stack,
  worker: PipelineWorker,
  episodeId: string,
  predicate: (job: PipelineJobRow, episodeState: string) => boolean,
  log: StateLog,
  deadlineMs = 120_000,
): Promise<PipelineJobRow> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const job = s.repo.listJobs(episodeId).at(-1)!;
    const episode = s.repo.requireEpisode(episodeId);
    log.record(episode.state);
    if (predicate(job, episode.state)) return job;
    await worker.worker.drain();
  }
  const job = s.repo.listJobs(episodeId).at(-1)!;
  const failure = job.failure_step
    ? `step ${job.failure_step} (attempt ${job.attempt}) error: ` +
      (s.repo.requireStep(job.id, job.failure_step).error ?? "none")
    : `gate ${job.waiting_gate ?? "?"}`;
  const tail = s.repo
    .listJobLogs(job.id, { limit: 6 })
    .map((log) => `[${log.event}] ${log.message}`)
    .join(" | ");
  throw new Error(
    `the run never settled (job ${job.state}; ${failure}; episode ` +
      `${s.repo.requireEpisode(episodeId).state}); last logs: ${tail}`,
  );
}

/**
 * The episode-state path the pipeline actually took, from durable evidence:
 * each completed stage's start/finish states, in stage order — plus a guard
 * that no transition was rejected (the runner warns and skips those).
 */
function expectEpisodePath(
  s: Stack,
  pipeline: PipelineDef,
  jobId: string,
  expected: readonly string[],
): void {
  const states: string[] = [];
  for (const stage of pipeline.stages) {
    const step = stepOf(s, jobId, stage.key);
    expect(step.state, `stage ${stage.key} completed`).toBe("DONE");
    states.push(stage.episodeStateOnStart, stage.episodeStateOnComplete);
  }
  const deduped = states.filter((state, index) => index === 0 || states[index - 1] !== state);
  expect(deduped).toEqual(expected);
  const rejected = s.repo
    .listJobLogs(jobId, { limit: 1000 })
    .filter((log) => log.event === "episode.transition.rejected");
  expect(rejected.map((log) => log.message)).toEqual([]);
}

function stepOf(s: Stack, jobId: string, key: string) {
  const step = s.repo.getJobStep(jobId, key);
  expect(step, `step ${key} of job ${jobId}`).toBeDefined();
  return step!;
}

/** Every artifact a step registered has real bytes in the CAS. */
function expectArtifactsExist(
  s: Stack,
  jobId: string,
  key: string,
): { hash: string; kind: string; role: string }[] {
  const step = stepOf(s, jobId, key);
  const artifacts = JSON.parse(step.artifacts === "" ? "[]" : step.artifacts) as {
    hash: string;
    kind: string;
    role: string;
  }[];
  expect(artifacts.length, `step ${key} registered artifacts`).toBeGreaterThan(0);
  for (const artifact of artifacts) {
    const bytes = s.runtime.storage.read(artifact.hash);
    expect(bytes.byteLength, `artifact ${artifact.hash.slice(0, 10)}… of ${key}`).toBeGreaterThan(
      0,
    );
  }
  return artifacts;
}

describe("the complete end-to-end integration", () => {
  it(
    "carries a topic through research→script→plan→media→voice→animation→render→QA→approval, " +
      "then cuts the approved video into an approved 9:16 short",
    { timeout: 900_000 },
    async () => {
      const s = await start();
      try {
        const workerA = s.worker();
        const longStates = new StateLog();

        // ── TOPIC ───────────────────────────────────────────────────────────
        const episodeId = await createEpisode(s, "Why the Kira bridge hums at dusk");
        expect(s.repo.requireEpisode(episodeId).state).toBe("QUEUED");
        longStates.record("QUEUED");

        // ── start the long-form pipeline ────────────────────────────────────
        expect(await post(s, `/episodes/${episodeId}/start`)).not.toContain("error=");

        // ── RESEARCH … fact gate: APPROVAL GATING, part 1 ───────────────────
        let job = await runUntil(
          s,
          workerA,
          episodeId,
          (entry) => entry.state === "WAITING_GATE",
          longStates,
        );
        expect(job.waiting_gate).toBe("FACT_REVIEW");
        // While parked, nothing downstream has run: the script step is not done.
        expect(stepOf(s, job.id, "research").state).toBe("DONE");
        expect(stepOf(s, job.id, "script").state).not.toBe("DONE");
        expect(
          await post(s, `/jobs/${job.id}/approve`, { notes: "research looks sound" }),
        ).not.toContain("error=");

        // ── SCRIPT → SCENE PLAN → MEDIA → VOICE → ANIMATION → RENDER → QA ──
        job = await runUntil(
          s,
          workerA,
          episodeId,
          (entry) => entry.state === "WAITING_GATE",
          longStates,
        );
        expect(job.waiting_gate).toBe("FINAL_APPROVAL");
        expect(stepOf(s, job.id, "qa").state).toBe("DONE");

        // ── FAILURE RECOVERY: the worker dies before the decision; the
        // operator approves anyway; a RESTARTED worker finishes the job. ────
        await workerA.stop();
        const videoBefore = expectArtifactsExist(s, job.id, "render").find(
          (artifact) => artifact.kind === "video",
        )!;
        expect(await post(s, `/jobs/${job.id}/approve`, { notes: "ship it" })).not.toContain(
          "error=",
        );
        const workerB = s.worker();
        job = await runUntil(s, workerB, episodeId, (entry) => entry.state === "DONE", longStates);
        await workerB.stop();
        expect(s.repo.requireEpisode(episodeId).state).toBe("READY");
        // The crash changed nothing about the completed work: same video.
        const videoAfter = expectArtifactsExist(s, job.id, "render").find(
          (artifact) => artifact.kind === "video",
        )!;
        expect(videoAfter.hash).toBe(videoBefore.hash);

        // ── STATE TRANSITIONS (long form): the durable stage-by-stage path,
        // with no transition rejected along the way ─────────────────────────
        expectEpisodePath(s, DASHBOARD_PIPELINE, job.id, [
          "QUEUED",
          "RESEARCHING",
          "FACT_CHECKING",
          "SCRIPTING",
          "SCENE_PLANNING",
          "MEDIA_GATHERING",
          "VOICE_SYNTHESIS",
          "CAPTIONING",
          "COMPOSITING",
          "RENDERING",
          "QA",
          "APPROVAL",
          "READY",
        ]);
        // The sampled log must contain the final parking state (it persists
        // while the job waits, so the sampler sees it).
        expect(longStates.states).toContain("APPROVAL");

        // ── ARTIFACT CREATION: every stage's artifacts, bytes and all ───────
        const kindsOf = (key: string): string[] =>
          expectArtifactsExist(s, job.id, key).map((artifact) => artifact.kind);
        expect(kindsOf("research")).toContain("document");
        expect(kindsOf("script")).toContain("script");
        expect(kindsOf("plan")).toContain("scene_graph");
        expect(kindsOf("source_media")).toContain("scene_graph");
        expect(kindsOf("voice")).toContain("audio");
        expect(kindsOf("captions")).toContain("captions");
        expect(kindsOf("render")).toEqual(expect.arrayContaining(["video", "thumbnail"]));
        expect(kindsOf("qa")).toContain("qa_report");
        // The QA report reads back and clears the episode for publication.
        const qaStep = stepOf(s, job.id, "qa");
        const qaReportHash = (JSON.parse(qaStep.output ?? "{}") as { reportHash: string })
          .reportHash;
        const report = loadQAReport(s.runtime.storage, qaReportHash);
        expect(report.publishable).toBe(true);
        // The plan is the media-resolved 16:9 manifest.
        const mediaHash = (
          JSON.parse(stepOf(s, job.id, "source_media").output ?? "{}") as { manifestHash: string }
        ).manifestHash;
        const longManifest = loadSceneManifest(s.runtime.storage, mediaHash);
        expect(longManifest.aspect).toBe("16:9");
        const parentTrackHash = (
          JSON.parse(stepOf(s, job.id, "render").output ?? "{}") as { audioTrackHash: string }
        ).audioTrackHash;
        const parentTrack = loadAudioTrack(s.runtime.storage, parentTrackHash);

        // ── ARTIFACT REUSE: a second run adopts every stage ────────────────
        expect(await post(s, `/episodes/${episodeId}/start`)).not.toContain("error=");
        const workerC = s.worker();
        const job2 = s.repo.listJobs(episodeId).at(-1)!;
        expect(job2.id).not.toBe(job.id);
        const reused = await runUntil(
          s,
          workerC,
          episodeId,
          (entry) => entry.state === "DONE",
          new StateLog(),
        );
        await workerC.stop();
        expect(reused.id).toBe(job2.id);
        for (const key of [
          "idea",
          "research",
          "script",
          "plan",
          "source_media",
          "animate",
          "voice",
          "captions",
          "render",
          "qa",
        ]) {
          const step = stepOf(s, job2.id, key);
          expect(step.state, `run-2 step ${key}`).toBe("DONE");
          expect(step.reused_from_job_id, `run-2 step ${key} adopted from run 1`).toBe(job.id);
        }
        const run2Video = expectArtifactsExist(s, job2.id, "render").find(
          (artifact) => artifact.kind === "video",
        )!;
        expect(run2Video.hash).toBe(videoAfter.hash);

        // ── SHORT GENERATION: the approved video becomes a 9:16 short ──────
        const shortId = (await post(s, `/episodes/${episodeId}/shorts`))
          .replace("/episodes/", "")
          .split("?")[0]!;
        const child = s.repo.requireEpisode(shortId);
        expect(child.kind).toBe("short");
        expect(child.parent_episode_id).toBe(episodeId);
        // A finished parent is required — and it is one.
        expect(await post(s, `/episodes/${shortId}/start`)).not.toContain("error=");

        const workerD = s.worker();
        const shortStates = new StateLog();
        const shortJob = await runUntil(
          s,
          workerD,
          shortId,
          (entry) => entry.state === "WAITING_GATE",
          shortStates,
        );
        expect(shortJob.waiting_gate).toBe("SHORT_APPROVAL");

        // TRANSCRIPT/TIMELINE + CANDIDATES.
        const transcript = expectArtifactsExist(s, shortJob.id, "short_analyze").find(
          (artifact) => artifact.role === "short_transcript",
        )!;
        const timeline = JSON.parse(
          new TextDecoder().decode(s.runtime.storage.read(transcript.hash)),
        ) as { windows: unknown[]; totals: { words: number } };
        expect(timeline.windows.length).toBe(longManifest.scenes.length);
        const planArtifact = expectArtifactsExist(s, shortJob.id, "short_select").find(
          (artifact) => artifact.role === "shorts_plan",
        )!;
        const plan = JSON.parse(
          new TextDecoder().decode(s.runtime.storage.read(planArtifact.hash)),
        ) as {
          candidates: {
            id: string;
            durationSec: number;
            arcSections: string[];
            sceneIds: string[];
          }[];
          setAside: { reason: string }[];
        };
        expect(plan.candidates.length).toBeGreaterThan(0);
        expect(plan.setAside.every((entry) => entry.reason.includes("arc"))).toBe(true);

        // The short's OWN script: a complete arc, claims carried over.
        const scriptArtifact = expectArtifactsExist(s, shortJob.id, "short_rewrite").find(
          (artifact) => artifact.kind === "script",
        )!;
        const shortScript = loadScriptDoc(s.runtime.storage, scriptArtifact.hash);
        const roles = shortScript.sections.map((section) => section.role);
        expect(roles.filter((role) => role === "hook")).toHaveLength(1);
        expect(roles.filter((role) => role === "introduction")).toHaveLength(1);
        expect(roles.filter((role) => role === "narrative").length).toBeGreaterThanOrEqual(2);
        expect(roles.filter((role) => role === "conclusion")).toHaveLength(1);
        expect(shortScript.claims.length).toBeGreaterThan(0);
        expect(shortScript.provenance.deterministicSteps).toContain("shorts.rewrite");

        // VERTICAL LAYOUT: a real 9:16 manifest bound to the short's script,
        // with the parent's audio bytes re-based (never re-synthesised).
        const layoutOutputs = JSON.parse(stepOf(s, shortJob.id, "short_layout").output ?? "{}") as {
          manifestHash: string;
          trackHash: string;
          audioHashes: string[];
          canvas: { width: number; height: number };
        };
        const verticalManifest = loadSceneManifest(s.runtime.storage, layoutOutputs.manifestHash);
        expect(verticalManifest.aspect).toBe("9:16");
        expect(verticalManifest.resolution).toEqual({ width: 1080, height: 1920 });
        expect(verticalManifest.scriptHash).toBe(scriptArtifact.hash);
        expect(verticalManifest.scenes.length).toBe(plan.candidates[0]!.sceneIds.length);
        const shortTrack = loadAudioTrack(s.runtime.storage, layoutOutputs.trackHash);
        const parentAudioHashes = new Set(
          parentTrack.segments.map((segment) => segment.audio.hash),
        );
        const shortAudioHashes = shortTrack.segments.map((segment) => segment.audio.hash);
        expect(shortAudioHashes.length).toBeGreaterThan(0);
        for (const hash of shortAudioHashes) {
          expect(
            parentAudioHashes.has(hash),
            `audio ${hash.slice(0, 10)}… re-used from the parent`,
          ).toBe(true);
        }
        expect(layoutOutputs.audioHashes).toEqual([...new Set(shortAudioHashes)]);

        // RENDER (9:16) + QA on the short.
        const shortRenderOutput = JSON.parse(
          stepOf(s, shortJob.id, "short_render").output ?? "{}",
        ) as { width: number; height: number; videoHash: string };
        expect(shortRenderOutput.width).toBe(1080);
        expect(shortRenderOutput.height).toBe(1920);
        expectArtifactsExist(s, shortJob.id, "short_render");
        const shortQaHash = (
          JSON.parse(stepOf(s, shortJob.id, "short_qa").output ?? "{}") as { reportHash: string }
        ).reportHash;
        const shortReport = loadQAReport(s.runtime.storage, shortQaHash);
        expect(shortReport.publishable).toBe(true);
        expect(shortReport.verdict).not.toBe("fail");

        // APPROVAL GATING, part 2: the short waits for the human, then lands.
        expect(s.repo.requireEpisode(shortId).state).toBe("APPROVAL");
        expect(await post(s, `/jobs/${shortJob.id}/approve`, { notes: "good cut" })).not.toContain(
          "error=",
        );
        await runUntil(s, workerD, shortId, (entry) => entry.state === "DONE", shortStates);
        await workerD.stop();
        expect(s.repo.requireEpisode(shortId).state).toBe("READY");
        // The sampler saw the parking state too: approval gating held the
        // short at APPROVAL until the human decided.
        expect(shortStates.states).toContain("APPROVAL");
        // The shorts state path, from the same durable evidence — the last
        // stage's APPROVAL landing only after the human approved it.
        expectEpisodePath(s, SHORTS_DASHBOARD_PIPELINE, shortJob.id, [
          "QUEUED",
          "SCENE_PLANNING",
          "SCRIPTING",
          "COMPOSITING",
          "RENDERING",
          "QA",
          "APPROVAL",
          "READY",
        ]);
        // Publishing was never wired into either run: no upload jobs exist.
        for (const entry of [...s.repo.listJobs(episodeId), ...s.repo.listJobs(shortId)]) {
          expect(entry.pipeline).not.toBe("longform_v1_publish");
          const keys = s.repo.listJobSteps(entry.id).map((step) => step.step_key);
          expect(keys).not.toContain("publish");
          expect(keys).not.toContain("short_publish");
        }
      } finally {
        s.runtime.db.close();
        s.close();
      }
    },
  );

  it(
    "blocks on failed QA, then recovers: a new run resumes at the failed stage, and the fixed rule completes",
    { timeout: 900_000 },
    async () => {
      const s = await start({ NEXUS_QA_MIN_FONT_PX: "140" });
      try {
        const worker = s.worker();
        const states = new StateLog();
        const episodeId = await createEpisode(s, "Blocked: type too small everywhere");
        expect(await post(s, `/episodes/${episodeId}/start`)).not.toContain("error=");
        // Drive the walk, approving every human gate, until the run settles.
        const settle = async (stack: Stack, pool: PipelineWorker): Promise<PipelineJobRow> => {
          let entry = await runUntil(
            stack,
            pool,
            episodeId,
            (job) => ["WAITING_GATE", "FAILED", "DONE"].includes(job.state),
            states,
          );
          while (entry.state === "WAITING_GATE") {
            expect(await post(stack, `/jobs/${entry.id}/approve`)).not.toContain("error=");
            entry = await runUntil(
              stack,
              pool,
              episodeId,
              (job) => ["WAITING_GATE", "FAILED", "DONE"].includes(job.state),
              states,
            );
          }
          return entry;
        };
        const job = await settle(s, worker);

        // ── QA BLOCKING: the run failed at qa, evidence attached ────────────
        expect(job.state).toBe("FAILED");
        expect(job.failure_step).toBe("qa");
        expect(s.repo.requireEpisode(episodeId).state).toBe("FAILED");
        const qaStep = stepOf(s, job.id, "qa");
        expect(qaStep.state).toBe("FAILED");
        const blockedReportRef = (
          JSON.parse(qaStep.artifacts) as { hash: string; role: string }[]
        ).find((artifact) => artifact.role === "qa_report")!;
        const blockedReport = loadQAReport(s.runtime.storage, blockedReportRef.hash);
        expect(blockedReport.verdict).toBe("fail");
        expect(blockedReport.publishable).toBe(false);
        // Nothing downstream of QA ran: the approval stage never completed.
        expect(stepOf(s, job.id, "approval").state).not.toBe("DONE");

        // ── RECOVERY, part 1: a NEW RUN resumes AT the failed stage — the
        // completed stages are adopted (same inputs, no re-execution). ──────
        expect(await post(s, `/episodes/${episodeId}/start`)).not.toContain("error=");
        const job2 = s.repo.listJobs(episodeId).at(-1)!;
        expect(job2.id).not.toBe(job.id);
        const failed2 = await settle(s, worker);
        expect(failed2.id).toBe(job2.id);
        expect(failed2.failure_step).toBe("qa");
        const renderRun2 = stepOf(s, job2.id, "render");
        expect(renderRun2.state).toBe("DONE");
        expect(renderRun2.reused_from_job_id, "render adopted from run 1").toBe(job.id);
        expect(renderRun2.artifacts).toBe(stepOf(s, job.id, "render").artifacts);
        // QA itself re-ran and blocked again — the rule, not the pipeline.
        expect(stepOf(s, job2.id, "qa").reused_from_job_id).toBeNull();
        await worker.stop();

        // ── RECOVERY, part 2: the operator relaxes the QA rule; a RESTARTED
        // worker over the SAME data directory finishes the episode. ─────────
        const reopened = await start({}, { dataDir: s.dataDir });
        try {
          const worker2 = reopened.worker();
          const started = await reopened.app.inject({
            method: "POST",
            url: `/episodes/${episodeId}/start`,
            headers: FORM,
            payload: "",
          });
          expect(started.statusCode).toBe(303);
          // The changed QA settings invalidate the QA stage: this run
          // re-executes the pipeline rather than adopting the blocked run.
          const job3 = await settle(reopened, worker2);
          expect(job3.state).toBe("DONE");
          expect(reopened.repo.requireEpisode(episodeId).state).toBe("READY");
          const reportHash = (
            JSON.parse(stepOf(reopened, job3.id, "qa").output ?? "{}") as { reportHash: string }
          ).reportHash;
          expect(reportHash).not.toBe(blockedReportRef.hash);
          expect(loadQAReport(reopened.runtime.storage, reportHash).publishable).toBe(true);
          await worker2.stop();
        } finally {
          reopened.runtime.db.close();
        }
      } finally {
        s.runtime.db.close();
        s.close();
      }
    },
  );
});
