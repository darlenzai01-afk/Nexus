import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCaptionTrack, loadAudioTrack } from "@nexus/audio";
import {
  Db,
  Repo,
  migrate,
  type ArtifactRef,
  type EpisodeRow,
  type PipelineJobRow,
  type Repo as RepoType,
} from "@nexus/db";
import {
  PermanentError,
  RetryableError,
  createTaskRegistry,
  runJob,
  type RunnerDeps,
  type Task,
  type TaskContext,
} from "@nexus/jobs";
import { MemoryBlobStore } from "@nexus/providers";
import { persistSceneManifest, type SceneManifest } from "@nexus/scenes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createScriptedFFmpeg, type ScriptedFFmpeg } from "./scripted-ffmpeg.js";
import { METADATA_ARTIFACT_KIND, loadRenderMetadata } from "./persist.js";
import { createRenderTask } from "./task.js";
import { fixtureAudio, fixtureManifest, fixtureRenderConfig } from "./fixtures.js";
import type { RenderFailure } from "./schema.js";

/**
 * The `render` stage inside the real job runner: real SQLite, real repository,
 * real lease and step machinery.
 *
 * The only double is FFmpeg (scripted, see `scripted-ffmpeg.ts`), plus the three
 * upstream stages stubbed down to their contract — each published a document and
 * said where it is. What this test is about is the *hand-off*: the stage reads
 * what the earlier stages produced, renders, registers the right artifacts,
 * refuses to adopt a video for a different plan, and leaves a failure report
 * behind when it cannot finish.
 */

interface Harness {
  readonly repo: RepoType;
  readonly storage: MemoryBlobStore;
  readonly job: PipelineJobRow;
  readonly episode: EpisodeRow;
  readonly manifestHash: string;
  readonly workRoot: string;
  run(ffmpeg?: ScriptedFFmpeg): Promise<Awaited<ReturnType<typeof runJob>>>;
  stepArtifacts(step?: string): readonly ArtifactRef[];
}

describe("render stage task", () => {
  let repo: RepoType;
  let storage: MemoryBlobStore;
  let workRoot: string;
  let manifest: SceneManifest;
  let config: ReturnType<typeof fixtureRenderConfig>;

  beforeEach(() => {
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    storage = new MemoryBlobStore();
    workRoot = mkdtempSync(path.join(tmpdir(), "nexus-task-"));
    manifest = fixtureManifest({ seconds: 2 });
    config = fixtureRenderConfig({ segmentFrames: 11 });
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  async function harness(
    options: { readonly steps?: readonly string[]; readonly config?: Partial<typeof config> } = {},
  ): Promise<Harness> {
    const persisted = persistSceneManifest({ storage, repo }, manifest);
    const audio = await fixtureAudio(storage, repo, manifest);
    const captions = buildCaptionTrack(loadAudioTrack(storage, audio.trackHash));
    const renderConfig = { ...config, ...options.config };

    const upstream = (stageKey: string, output: Record<string, unknown>): Task => ({
      stageKey,
      execute: async () => ({ output }),
    });
    const stages: Task[] = [
      upstream("plan", { manifestHash: persisted.hash, workingTitle: manifest.workingTitle }),
      upstream("voice", { trackHash: audio.trackHash, segments: audio.clips }),
      upstream("captions", { trackHash: audio.captionTrackHash, cues: captions.cues.length }),
    ];

    const project = repo.createProject({
      name: "Channel",
      slug: `channel-${Math.random().toString(36).slice(2, 8)}`,
    });
    const episode = repo.createEpisode({
      projectId: project.id,
      topic: "The Kira bridge",
      outline: ["intro", "traffic"],
    });
    repo.setEpisodeState(episode.id, "RENDERING", null);
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: [...(options.steps ?? ["plan", "voice", "captions", "render"])],
    }).job;

    return {
      repo,
      storage,
      job,
      episode,
      manifestHash: persisted.hash,
      workRoot,
      stepArtifacts: (step = "render") =>
        JSON.parse(repo.getJobStep(job.id, step)?.artifacts ?? "[]") as ArtifactRef[],
      async run(ffmpeg?: ScriptedFFmpeg) {
        const task = createRenderTask({
          storage,
          repo,
          workRoot,
          config: renderConfig,
          ffmpeg:
            ffmpeg ??
            createScriptedFFmpeg({ width: config.width, height: config.height, fps: config.fps }),
        });
        const deps: RunnerDeps = {
          repo,
          tasks: createTaskRegistry([...stages, task]),
          workerId: "worker-1",
          leaseMs: 60_000,
          heartbeatIntervalMs: 5,
          params: {},
          random: () => 0.5,
          signal: new AbortController().signal,
        };
        repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
        return runJob(deps, job.id);
      },
    };
  }

  it("renders the plan the earlier stages published and registers the deliverable", async () => {
    const h = await harness();
    expect(await h.run()).toMatchObject({ status: "completed" });

    const artifacts = h.stepArtifacts();
    const kinds = artifacts.map((artifact) => artifact.kind);
    expect(kinds).toContain("video");
    expect(kinds).toContain("thumbnail");
    expect(kinds).toContain(METADATA_ARTIFACT_KIND);
    expect(kinds).toContain("document");
    expect(kinds).toContain("audio");

    const output = JSON.parse(h.repo.getJobStep(h.job.id, "render")?.output ?? "{}") as {
      readonly [key: string]: unknown;
    };
    expect(output).toMatchObject({
      manifestHash: h.manifestHash,
      container: "mp4",
      width: config.width,
      height: config.height,
      fps: config.fps,
      hasAudio: true,
      resumed: false,
      frames: 60,
    });
    expect(output.quality).toMatchObject({ ok: true, hardIssues: 0 });

    // The metadata artifact is the video's evidence, and the video bytes are real.
    const metadataRef = artifacts.find((artifact) => artifact.kind === METADATA_ARTIFACT_KIND);
    expect(metadataRef).toBeDefined();
    const metadata = loadRenderMetadata(h.storage, metadataRef!.hash);
    expect(metadata.manifestHash).toBe(h.manifestHash);
    expect(metadata.audioTrackHash).toBeDefined();
    expect(metadata.captionTrackHash).toBeDefined();
    expect(metadata.output.bytes).toBeGreaterThan(1_000);
    expect(metadata.provenance.aiSteps).toEqual([]);

    const videoRef = artifacts.find((artifact) => artifact.kind === "video");
    expect(h.storage.read(videoRef!.hash).byteLength).toBe(metadata.output.bytes);
  });

  it("hard-fails the step when the pipeline reports a hard issue", async () => {
    const h = await harness();
    const failing = createScriptedFFmpeg({
      width: config.width,
      height: config.height,
      fps: config.fps,
      fail: (command) =>
        command.label.startsWith("encode segment")
          ? {
              message: "no space left on device",
              stderr: "av_interleaved_write_frame(): No space left on device",
            }
          : undefined,
    });
    const outcome = await h.run(failing);
    expect(outcome.status).toBe("failed");

    const row = h.repo.getJobStep(h.job.id, "render");
    expect(row?.state).toBe("FAILED");
    // The step is failed permanently, not retried: bad encoder settings will fail
    // the same way a minute from now, and the retry budget is better spent on the
    // stages that can succeed.
    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent", stepKey: "render" });
    // The error names the artifact that explains it, and that artifact is the
    // failure report — not a log line somebody has to go digging for.
    const hashes = [...(row?.error ?? "").matchAll(/[0-9a-f]{64}/gu)].map((match) => match[0]);
    expect(hashes.length).toBeGreaterThan(0);
    expect(h.storage.has(hashes[0]!)).toBe(true);
    const report = JSON.parse(
      new TextDecoder().decode(h.storage.read(hashes[0]!)),
    ) as RenderFailure;
    expect(report).toMatchObject({
      kind: "render_failure",
      phase: "segment",
      code: "ffmpeg_failed",
    });
    expect(report.stderrTail).toContain("No space left");
    expect(report.hint.length).toBeGreaterThan(0);
    expect(report.resumed).toBe(false);
    expect(report.renderKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses to adopt a video rendered from a different plan", async () => {
    const h = await harness();
    expect(await h.run()).toMatchObject({ status: "completed" });
    const ref = h.stepArtifacts().find((artifact) => artifact.kind === METADATA_ARTIFACT_KIND)!;
    const task = createRenderTask({ storage: h.storage, repo: h.repo, workRoot, config });
    const differentPlan = {
      upstream: { plan: { manifestHash: "9".repeat(64) } },
      inputs: { job: { params: {} } },
    } as unknown as TaskContext;

    expect(() =>
      task.validateReuse?.(differentPlan, {
        jobId: h.job.id,
        stepKey: "render",
        output: null,
        artifacts: [ref],
        finishedAt: null,
      }),
    ).toThrow(PermanentError);

    // The same plan is adopted, which is what artifact reuse means.
    const samePlan = {
      upstream: { plan: { manifestHash: h.manifestHash } },
      inputs: { job: { params: {} } },
    } as unknown as TaskContext;
    expect(() =>
      task.validateReuse?.(samePlan, {
        jobId: h.job.id,
        stepKey: "render",
        output: null,
        artifacts: [ref],
        finishedAt: null,
      }),
    ).not.toThrow();
  });

  it("refuses to adopt a render that reported hard failures", async () => {
    const h = await harness();
    expect(await h.run()).toMatchObject({ status: "completed" });
    const ref = h.stepArtifacts().find((artifact) => artifact.kind === METADATA_ARTIFACT_KIND)!;
    const metadata = loadRenderMetadata(h.storage, ref.hash);
    // Simulate the case the guard exists for: the metadata says the render was
    // not clean, so the video must not be adopted just because it exists.
    const dirty = {
      ...metadata,
      issues: [
        ...metadata.issues,
        { code: "ffmpeg_failed" as const, severity: "error" as const, message: "boom" },
      ],
    };
    const dirtyArtifact = h.storage.put(new TextEncoder().encode(JSON.stringify(dirty)));
    h.repo.registerArtifact({
      hash: dirtyArtifact.hash,
      kind: "metadata",
      bytes: dirtyArtifact.bytes,
    });

    const task = createRenderTask({ storage: h.storage, repo: h.repo, workRoot, config });
    const ctx = {
      upstream: { plan: { manifestHash: h.manifestHash } },
      inputs: { job: { params: {} } },
    } as unknown as TaskContext;
    expect(() =>
      task.validateReuse?.(ctx, {
        jobId: h.job.id,
        stepKey: "render",
        output: null,
        artifacts: [
          { hash: dirtyArtifact.hash, kind: METADATA_ARTIFACT_KIND, role: "render_metadata" },
        ],
        finishedAt: null,
      }),
    ).toThrow(/hard failures/u);
  });

  it("fails retryably when no FFmpeg binary can be found", async () => {
    const persisted = persistSceneManifest({ storage, repo }, manifest);
    const task = createRenderTask({
      storage,
      repo,
      workRoot,
      config: { ...config, ffmpegPath: "/nonexistent/ffmpeg-binary" },
    });
    const ctx = {
      upstream: { plan: { manifestHash: persisted.hash } },
      inputs: { job: { params: {} } },
      log: () => undefined,
      signal: new AbortController().signal,
    } as unknown as TaskContext;

    await expect(task.execute(ctx)).rejects.toThrow(RetryableError);
    await expect(task.execute(ctx)).rejects.toThrow(/no FFmpeg binary is available/u);
  });

  it("names the artifact roles the rest of the system looks for", async () => {
    const h = await harness();
    expect(await h.run()).toMatchObject({ status: "completed" });
    const roles = h.stepArtifacts().map((artifact) => artifact.role);
    expect(roles).toContain("video_master");
    expect(roles).toContain("render_metadata");
    expect(roles).toContain("render_log");
    expect(roles).toContain("render_thumbnail");
    expect(roles).toContain("narration_track");
  });
});
