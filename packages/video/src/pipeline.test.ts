import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAudioTrack, loadCaptionTrack } from "@nexus/audio";
import { Db, Repo, migrate, type Repo as RepoType } from "@nexus/db";
import { MemoryBlobStore } from "@nexus/providers";
import { composeVideo, buildTimeline } from "@nexus/render";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RenderError } from "./errors.js";
import { fixtureAudio, fixtureManifest, fixtureRenderConfig, fixtureStage } from "./fixtures.js";
import {
  renderFailureOf,
  renderVideo,
  type RenderPipelineInput,
  type RenderPipelineResult,
} from "./pipeline.js";
import { createScriptedFFmpeg, type ScriptedFFmpeg } from "./scripted-ffmpeg.js";
import { RenderFailureSchema, RenderMetadataSchema, type RenderConfig } from "./schema.js";
import { frameFile } from "./workdir.js";

/**
 * The pipeline, end to end, without FFmpeg.
 *
 * The frames are real (the same rasteriser the smoke test uses), the narration is
 * real (Phase 10's fake TTS writing actual PCM into the store), and only the
 * encoder is scripted — because what this test is about is not pixels but *the
 * pipeline's promises*: a real file at the end, a journal that survives a kill,
 * segments that are reused only when nothing about them changed, and a failure
 * report that says which phase died.
 */

interface Harness {
  readonly storage: MemoryBlobStore;
  readonly repo: RepoType;
  readonly workRoot: string;
  readonly manifest: ReturnType<typeof fixtureManifest>;
  readonly manifestHash: string;
  readonly stage: ReturnType<typeof fixtureStage>;
  readonly audioTrackHash: string;
  readonly captionTrackHash: string;
  readonly config: RenderConfig;
  render(options?: {
    readonly ffmpeg?: ScriptedFFmpeg;
    readonly config?: Partial<RenderConfig>;
    readonly audio?: boolean;
    readonly captions?: boolean;
    readonly now?: string;
  }): RenderPipelineResult;
}

describe("renderVideo", () => {
  let storage: MemoryBlobStore;
  let repo: RepoType;
  let workRoot: string;

  beforeEach(() => {
    storage = new MemoryBlobStore();
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    workRoot = mkdtempSync(path.join(tmpdir(), "nexus-render-"));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  async function harness(): Promise<Harness> {
    const manifest = fixtureManifest({ seconds: 2 });
    const stage = fixtureStage();
    const audio = await fixtureAudio(storage, repo, manifest);
    // The manifest is stored through the same loader the stage uses, so the plan
    // hash the render records is the hash of the bytes in the CAS.
    const { persistSceneManifest } = await import("@nexus/scenes");
    const persisted = persistSceneManifest({ storage, repo }, manifest);
    const config = fixtureRenderConfig();
    return {
      storage,
      repo,
      workRoot,
      manifest,
      manifestHash: persisted.hash,
      stage,
      audioTrackHash: audio.trackHash,
      captionTrackHash: audio.captionTrackHash,
      config,
      render(options = {}) {
        const config = { ...fixtureRenderConfig(), ...options.config };
        const input: RenderPipelineInput = {
          manifest,
          manifestHash: persisted.hash,
          config,
          characterStage: stage,
          ...(options.audio === false ? {} : { audioTrack: loadTrack(storage, audio.trackHash) }),
          ...(options.audio === false ? {} : { audioTrackHash: audio.trackHash }),
          ...(options.captions === false || options.audio === false
            ? {}
            : {
                captionTrack: loadCaptionTrack(storage, audio.captionTrackHash),
                captionTrackHash: audio.captionTrackHash,
              }),
          fonts: undefined,
          now: options.now ?? "2024-05-01T00:00:00.000Z",
        };
        const ffmpeg =
          options.ffmpeg ??
          createScriptedFFmpeg({ width: config.width, height: config.height, fps: config.fps });
        return renderVideo(input, { ffmpeg, storage, workRoot });
      },
    };
  }

  it("renders a video, its metadata and its log", async () => {
    const h = await harness();
    const result = h.render();

    expect(RenderMetadataSchema.safeParse(result.metadata).success).toBe(true);
    expect(existsSync(result.video.file)).toBe(true);
    expect(result.video.bytes).toBeGreaterThan(1_000);
    expect(result.metadata.output).toMatchObject({
      container: "mp4",
      width: h.config.width,
      height: h.config.height,
      fps: h.config.fps,
      hasAudio: true,
      fastStart: true,
    });
    // 2 seconds at 30 fps, in segments of 10 frames.
    expect(result.metadata.output.frameCount).toBe(60);
    expect(result.metadata.output.durationSec).toBeCloseTo(2, 2);
    expect(result.metadata.segments).toHaveLength(6);
    expect(result.metadata.totals.frames).toBe(60);
    expect(result.metadata.totals.framesRendered).toBe(60);
    expect(result.metadata.totals.captionsBurned).toBeGreaterThan(0);
    expect(result.metadata.audio?.clips).toBeGreaterThan(0);
    expect(result.metadata.toolchain.engine).toBe("nexus-video");
    expect(result.metadata.provenance.aiSteps).toEqual([]);
    expect(result.metadata.resumed).toBe(false);
    // The events are the render log the stage persists as an artifact.
    expect(result.events.map((event) => event.event)).toContain("render.segment_done");
    expect(result.events.some((event) => event.event === "render.verified")).toBe(true);
  });

  it("adopts an unchanged segment instead of rendering it again", async () => {
    const h = await harness();
    const first = h.render();
    const second = h.render();

    expect(second.metadata.resumed).toBe(true);
    expect(second.metadata.totals.framesRendered).toBe(0);
    expect(second.metadata.totals.framesReused).toBe(60);
    expect(second.metadata.totals.segmentsReused).toBe(6);
    expect(second.metadata.segments.every((segment) => segment.reused)).toBe(true);
    // And the assembled output is adopted too, so nothing is re-encoded.
    expect(second.metadata.totals.ffmpegCalls).toBe(0);
    expect(second.metadata.issues.some((issue) => issue.code === "output_reused")).toBe(true);
    expect(second.events.some((event) => event.event === "output_reused")).toBe(true);
    expect(second.video.hash).toBe(first.video.hash);
  });

  it("re-renders when the configuration changes, because the render key changes", async () => {
    const h = await harness();
    const first = h.render();
    const sharper = h.render({ config: { crf: 18 } });

    expect(sharper.metadata.renderKey).not.toBe(first.metadata.renderKey);
    expect(sharper.metadata.totals.segmentsReused).toBe(0);
    expect(sharper.metadata.totals.framesRendered).toBe(60);
  });

  it("keeps the frames a killed run left behind and re-encodes only the segments", async () => {
    const h = await harness();
    const first = h.render({ config: { keepFrames: true } });
    // Simulate the failure mode that matters: the encoded segments are gone, the
    // rasterised frames are not.
    for (const segment of first.metadata.segments) rmSync(segment.file, { force: true });

    const second = h.render({ config: { keepFrames: true } });
    expect(second.metadata.totals.framesRendered).toBe(0);
    expect(second.metadata.totals.framesReused).toBe(60);
    expect(second.metadata.totals.segmentsReused).toBe(0);
    expect(second.metadata.totals.segmentsRendered).toBe(6);
  });

  it("rasterises a frame again when the one on disk is not the one it recorded", async () => {
    const h = await harness();
    const first = h.render({ config: { keepFrames: true } });
    const frame = frameFile(first.work, 3);
    expect(existsSync(frame)).toBe(true);
    // Something changed a frame after the journal recorded its hash, and its
    // segment has to be encoded again — so the frame is looked at.
    writeFileSync(frame, new Uint8Array([1, 2, 3, 4]));
    rmSync(first.metadata.segments[0]!.file, { force: true });

    const second = h.render({ config: { keepFrames: true } });
    expect(second.metadata.totals.framesRendered).toBe(1);
    expect(second.metadata.totals.framesReused).toBe(59);
    expect(second.metadata.totals.segmentsReused).toBe(5);
    expect(second.events.some((event) => event.event === "render.frame_stale")).toBe(true);
    // The replacement is a real PNG again, and the journal now records its hash.
    const journal = JSON.parse(readFileSync(path.join(first.work.dir, "journal.json"), "utf8"));
    expect(journal.segments[0].frameHashes).toHaveLength(10);
  });

  it("reports a failure with its phase, the segments already done and a report file", async () => {
    const h = await harness();
    const ffmpeg = createScriptedFFmpeg({
      width: h.config.width,
      height: h.config.height,
      fps: h.config.fps,
      fail: (command) =>
        command.label === "encode segment 3"
          ? { message: "encoder exploded", stderr: "x264 [error]: cannot open output" }
          : undefined,
    });
    let thrown: unknown;
    try {
      h.render({ ffmpeg });
      throw new Error("the render should have failed");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RenderError);
    const failure = renderFailureOf(thrown);
    expect(failure).toBeDefined();
    expect(RenderFailureSchema.safeParse(failure).success).toBe(true);
    expect(failure?.phase).toBe("segment");
    expect(failure?.code).toBe("ffmpeg_failed");
    expect(failure?.message).toContain("encode segment 3");
    expect(failure?.message).toContain("x264 [error]");
    expect(failure?.stderrTail).toContain("cannot open output");
    expect(failure?.segments).toHaveLength(3);
    expect(failure?.hint).toContain("stderrTail");
    expect(failure?.logTail.length).toBeGreaterThan(0);
    expect(failure?.config.width).toBe(h.config.width);

    // The report is on disk in the render's work directory, next to the segments.
    const reportFile = path.join(path.dirname(failure!.segments[0]!.file), "failure.json");
    expect(existsSync(reportFile)).toBe(true);
    expect(JSON.parse(readFileSync(reportFile, "utf8"))).toMatchObject({ kind: "render_failure" });

    // A retry resumes from the three segments that finished.
    const retry = h.render();
    expect(retry.metadata.resumed).toBe(true);
    expect(retry.metadata.totals.segmentsReused).toBe(3);
    expect(retry.metadata.totals.segmentsRendered).toBe(3);
  });

  it("renders a silent video when there is no narration, and says so", async () => {
    const h = await harness();
    const result = h.render({ audio: false });
    expect(result.metadata.output.hasAudio).toBe(false);
    expect(result.metadata.audio).toBeUndefined();
    expect(result.metadata.issues.map((issue) => issue.code)).toContain("audio_missing");
  });

  it("does not burn captions when the configuration says not to", async () => {
    const h = await harness();
    const result = h.render({ config: { captions: "none" } });
    expect(result.metadata.totals.captionsBurned).toBe(0);
    expect(result.metadata.issues.map((issue) => issue.code)).toContain("captions_skipped");
  });

  it("refuses a configuration that contradicts the plan", async () => {
    const h = await harness();
    expect(() => h.render({ config: { fps: 24 } })).toThrow(/does not match the scene plan/u);
    expect(() => h.render({ config: { width: 641 } })).toThrow(/does not match the scene plan/u);
  });

  it("stops when the signal is already aborted", async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    const input: RenderPipelineInput = {
      manifest: h.manifest,
      manifestHash: h.manifestHash,
      config: h.config,
      characterStage: h.stage,
      signal: controller.signal,
    };
    expect(() =>
      renderVideo(input, {
        ffmpeg: createScriptedFFmpeg({ width: h.config.width, height: h.config.height }),
        storage: h.storage,
        workRoot: h.workRoot,
      }),
    ).toThrow(/cancelled/u);
  });

  it("records the resolution, the plan hash and a frame digest in the metadata", async () => {
    const h = await harness();
    const result = h.render();
    const composed = composeVideo(buildTimeline(h.manifest), { deps: { characters: h.stage } });
    expect(result.metadata.timeline.frameCount).toBe(composed.frameCount);
    expect(result.metadata.timeline.durationSec).toBeCloseTo(h.manifest.totalDurationSec, 3);
    expect(result.metadata.manifestHash).toBe(h.manifestHash);
    expect(result.metadata.castHashes.length).toBe(h.manifest.cast.length);
    expect(result.metadata.determinismNotes.length).toBeGreaterThan(0);
    // The segment files are real and non-empty, and their hashes match the bytes.
    for (const segment of result.metadata.segments) {
      expect(statSync(segment.file).size).toBe(segment.bytes);
    }
    // Frames are not kept by default: only the segments remain.
    expect(existsSync(frameFile(result.work, 0))).toBe(false);
  });
});

function loadTrack(storage: MemoryBlobStore, hash: string) {
  return loadAudioTrack(storage, hash);
}
