import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAudioTrack, loadCaptionTrack } from "@nexus/audio";
import { Db, Repo, migrate } from "@nexus/db";
import { MemoryBlobStore } from "@nexus/providers";
import { persistSceneManifest } from "@nexus/scenes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFFmpegRunner, resolveFFmpegPath, type FFmpegRunner } from "./ffmpeg.js";
import {
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  findFont,
  loadFontFile,
  type FontSet,
} from "./font.js";
import { fixtureAudio, fixtureManifest, fixtureRenderConfig, fixtureStage } from "./fixtures.js";
import { readMp4 } from "./mp4.js";
import { renderVideo, type RenderPipelineInput, type RenderPipelineResult } from "./pipeline.js";
import { frameFile } from "./workdir.js";
import type { RenderConfig } from "./schema.js";

/**
 * The render smoke test: a real FFmpeg binary, a real scene plan, a real MP4.
 *
 * Everything upstream of the encoder in this repository is tested without a
 * browser and without installing anything — but "the pipeline produced a video"
 * is only true if something actually encoded one. So this test shells out to the
 * FFmpeg on this machine (or the one `NEXUS_FFMPEG_PATH` names), renders the
 * trimmed demonstration scene end to end, and then *reads the file back* with the
 * pipeline's own MP4 parser: duration, frame count, codec, audio track, and the
 * fast-start flag the captions and the CDN both depend on.
 *
 * When no FFmpeg is available the test skips rather than fails — a laptop without
 * FFmpeg should not look like a broken renderer — and it says so loudly, because
 * a skipped smoke test is a gap, not a pass.
 */

/** Where the smoke test looks when nothing is configured: same rule as the runner. */
function smokeBinary(): string | undefined {
  const configured = process.env["NEXUS_FFMPEG_PATH"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const guessed = resolveFFmpegPath(configured);
  if (guessed === undefined || guessed === "ffmpeg") return undefined; // let the runner try PATH below
  return guessed;
}

const BINARY = smokeBinary();
const runner: FFmpegRunner | undefined =
  BINARY === undefined
    ? undefined
    : (() => {
        try {
          return createFFmpegRunner({ binary: BINARY, timeoutMs: 120_000 });
        } catch {
          return undefined;
        }
      })();

const runnerRef: { value: FFmpegRunner | undefined } = { value: runner };

beforeAll(() => {
  if (runnerRef.value !== undefined) return;
  // `ffmpeg` may still be on PATH even when no usual location holds a binary.
  try {
    runnerRef.value = createFFmpegRunner({ binary: "ffmpeg", timeoutMs: 30_000 });
  } catch (error) {
    console.warn(
      `[render smoke] skipping: no FFmpeg binary is available (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}, 120_000);

const workRoot = mkdtempSync(path.join(tmpdir(), "nexus-smoke-"));
afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

/** The exact input the `render` stage builds, at a size that fits in a CI run. */
async function smokeInput(config: Partial<RenderConfig> = {}): Promise<{
  input: RenderPipelineInput;
  storage: MemoryBlobStore;
  config: RenderConfig;
  manifestHash: string;
}> {
  const storage = new MemoryBlobStore();
  const db = Db.memory();
  migrate(db);
  const repo = new Repo(db);
  const manifest = fixtureManifest({ seconds: 2, width: 480, height: 270 });
  const persisted = persistSceneManifest({ storage, repo }, manifest);
  const audio = await fixtureAudio(storage, repo, manifest);
  const resolved = fixtureRenderConfig({ width: 480, height: 270, ...config });

  const regularFile = findFont(DEFAULT_FONT_CANDIDATES);
  const boldFile = findFont(DEFAULT_BOLD_FONT_CANDIDATES);
  const loaded: FontSet | undefined =
    regularFile !== undefined && existsSync(regularFile)
      ? {
          regular: loadFontFile(regularFile),
          ...(boldFile !== undefined && existsSync(boldFile)
            ? { bold: loadFontFile(boldFile) }
            : {}),
        }
      : undefined;

  return {
    storage,
    config: resolved,
    manifestHash: persisted.hash,
    input: {
      manifest,
      manifestHash: persisted.hash,
      config: resolved,
      characterStage: fixtureStage(),
      audioTrack: loadAudioTrack(storage, audio.trackHash),
      audioTrackHash: audio.trackHash,
      captionTrack: loadCaptionTrack(storage, audio.captionTrackHash),
      captionTrackHash: audio.captionTrackHash,
      ...(loaded !== undefined ? { fonts: loaded } : {}),
      now: "2024-05-01T00:00:00.000Z",
    },
  };
}

function render(
  prepared: Awaited<ReturnType<typeof smokeInput>>,
  ffmpeg: FFmpegRunner,
  workRootOverride?: string,
): RenderPipelineResult {
  return renderVideo(prepared.input, {
    ffmpeg,
    storage: prepared.storage,
    workRoot: workRootOverride ?? workRoot,
  });
}

describe("render smoke test", () => {
  it("encodes a real MP4 with the real binary, and reads it back", async () => {
    if (runnerRef.value === undefined) {
      console.warn("[render smoke] skipped: no FFmpeg");
      return;
    }
    const prepared = await smokeInput();
    const started = Date.now();
    const result = render(prepared, runnerRef.value);
    const elapsed = Date.now() - started;

    // A real file on disk, not a placeholder.
    expect(existsSync(result.video.file)).toBe(true);
    const bytes = statSync(result.video.file).size;
    expect(bytes).toBeGreaterThan(2_000);
    expect(bytes).toBe(result.video.bytes);

    // The pipeline's own parser reads back what the encoder wrote.
    const info = readMp4(result.video.file);
    expect(info.fastStart).toBe(true); // moov before mdat: it streams
    expect(info.video?.codec).toBe("avc1");
    expect(info.video?.width).toBe(480);
    expect(info.video?.height).toBe(270);
    expect(info.video?.frameCount).toBe(60);
    expect(info.durationSec).toBeCloseTo(2, 1);
    expect(info.audio?.codec).toBe("mp4a");
    expect(info.audio?.sampleRate).toBe(48_000);
    expect(info.brands).toContain("isom");

    // The metadata agrees with the file and records the tool that made it.
    const { metadata } = result;
    expect(metadata.output).toMatchObject({
      container: "mp4",
      width: 480,
      height: 270,
      fps: 30,
      frameCount: 60,
      hasAudio: true,
      fastStart: true,
    });
    expect(metadata.output.bytes).toBe(bytes);
    expect(metadata.toolchain.ffmpegVersion).toBe(runnerRef.value.version);
    expect(metadata.toolchain.ffmpegPath).toBe(runnerRef.value.path);
    // The bold face is a real face, not a synthetic outline: the render's own
    // evidence says which file it emboldened from.
    expect(metadata.toolchain.boldFont?.name).toMatch(/Bold/u);
    expect(metadata.toolchain.font?.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(metadata.deterministic).toBe(true);
    expect(metadata.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(metadata.totals.captionsBurned).toBeGreaterThan(0);
    expect(metadata.manifestHash).toBe(prepared.manifestHash);

    // The frames on disk are real PNGs of the configured size.
    if (existsSync(frameFile(result.work, 0))) {
      const frame = frameFile(result.work, 0);
      expect(statSync(frame).size).toBeGreaterThan(1_000);
    }
    expect(elapsed).toBeGreaterThan(0);
    console.log(
      `[render smoke] ${bytes} bytes, ${metadata.totals.frames} frames, ` +
        `${metadata.segments.length} segments, ${(elapsed / 1000).toFixed(1)}s wall clock`,
    );
  }, 600_000);

  it("renders the same bytes again by adopting what it already has", async () => {
    if (runnerRef.value === undefined) {
      console.warn("[render smoke] skipped: no FFmpeg");
      return;
    }
    const prepared = await smokeInput();
    const work = mkdtempSync(path.join(tmpdir(), "nexus-smoke-resume-"));
    try {
      let calls = 0;
      const counting: FFmpegRunner = {
        ...runnerRef.value,
        run: (command) => {
          calls += 1;
          return runnerRef.value!.run(command);
        },
      };
      const first = render(prepared, counting, work);
      expect(calls).toBeGreaterThan(0);
      const firstCalls = calls;

      const second = render(prepared, counting, work);
      expect(second.video.hash).toBe(first.video.hash);
      expect(second.metadata.totals.framesReused).toBe(60);
      expect(second.metadata.totals.framesRendered).toBe(0);
      expect(second.metadata.resumed).toBe(true);
      // Only the final mux runs again: every segment was adopted.
      expect(calls - firstCalls).toBeLessThanOrEqual(1);
      expect(second.metadata.totals.segmentsReused).toBe(second.metadata.segments.length);
      expect(second.metadata.totals.ffmpegCalls).toBeLessThanOrEqual(1);
      expect(
        second.events.some(
          (event) => event.event === "render.started" && event.data?.["resumed"] === true,
        ),
      ).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 600_000);
});
