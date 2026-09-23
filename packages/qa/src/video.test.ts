import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseMp4, syntheticMp4, type RenderMetadata } from "@nexus/video";
import { vi, afterAll, beforeAll, describe, expect, it } from "vitest";

// The first fixture build renders a real (scripted-FFmpeg) file, which costs a
// few seconds — and more on a loaded machine. The 5 s defaults are for unit tests,
// not for the tests that wait on a render.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { qaFixture, type QAFixture, type RenderedFixture } from "./fixtures.js";
import { DEFAULT_QA_SETTINGS } from "./settings.js";
import { checkVideo } from "./video.js";

/**
 * Video QA: the file, read back and compared with what the render said about it.
 *
 * The renders here are real — the pipeline rasterises frames and builds a container
 * — and only the encoder is the scripted double, so the container, its duration, its
 * frame count and its tracks are the real things the checks read. Each case then
 * changes one thing: a truncated file, a container that disagrees with its metadata,
 * a video rendered from a different plan.
 */

const workRoot = mkdtempSync(path.join(tmpdir(), "nexus-qa-video-"));
let fixture: QAFixture;
let rendered: RenderedFixture;
let silent: RenderedFixture;

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

beforeAll(async () => {
  fixture = await qaFixture();
  rendered = fixture.render({ width: 192, height: 108 });
  silent = fixture.render({ width: 192, height: 108, audio: false, captions: false });
}, 600_000);

function check(
  video: { path?: string; hash?: string } | undefined,
  render?: { doc: RenderMetadata; hash: string },
  manifest = fixture.manifest,
) {
  const result = checkVideo(
    fixture.with({
      manifest,
      ...(video === undefined ? { video: undefined } : { video }),
      ...(render === undefined ? { render: undefined } : { render }),
    }),
    fixture.deps,
    DEFAULT_QA_SETTINGS,
  );
  return { result, codes: result.findings.map((finding) => finding.code) };
}

function metadata(patch: (doc: RenderMetadata) => RenderMetadata): {
  doc: RenderMetadata;
  hash: string;
} {
  return { doc: patch(rendered.metadata), hash: rendered.metadataHash };
}

describe("video checks", () => {
  it("passes a rendered file", () => {
    const { result, codes } = check(
      { path: rendered.file },
      { doc: rendered.metadata, hash: rendered.metadataHash },
    );
    expect(codes).toEqual([]);
    expect(result.report.examined).toBeGreaterThan(5);
    expect(result.report.note).toContain("192x108");
  });

  it("passes the same file read from the store by hash", () => {
    const { codes } = check(
      { hash: rendered.videoHash },
      { doc: rendered.metadata, hash: rendered.metadataHash },
    );
    expect(codes).toEqual([]);
  });

  it("reports that there is no video to publish", () => {
    const { codes } = check(undefined, { doc: rendered.metadata, hash: rendered.metadataHash });
    expect(codes).toEqual(["video_invalid_output"]);
  });

  it("reports a hash whose bytes are gone", () => {
    const { result } = check(
      { hash: "e".repeat(64) },
      { doc: rendered.metadata, hash: rendered.metadataHash },
    );
    expect(result.findings[0]?.message).toContain("is not in the store");
  });

  it("reports a file that is no longer on disk", () => {
    const { result } = check(
      { path: path.join(workRoot, "gone.mp4") },
      { doc: rendered.metadata, hash: rendered.metadataHash },
    );
    expect(result.findings[0]?.message).toContain("cannot be read");
  });

  it("reports a file far too small to be a video", () => {
    const tiny = path.join(workRoot, "tiny.mp4");
    writeFileSync(tiny, new Uint8Array(64));
    const { result } = check(
      { path: tiny },
      { doc: rendered.metadata, hash: rendered.metadataHash },
    );
    expect(result.findings[0]?.code).toBe("video_corrupted");
    expect(result.findings[0]?.message).toContain("below the");
  });

  it("reports bytes that are not a container at all", () => {
    const junk = path.join(workRoot, "junk.mp4");
    writeFileSync(junk, new Uint8Array(4_096).fill(0x5a));
    const { codes } = check(
      { path: junk },
      { doc: rendered.metadata, hash: rendered.metadataHash },
    );
    expect(codes).toContain("video_corrupted");
  });

  it("reports a file cut in half", () => {
    const bytes = readFileSync(rendered.file);
    const cut = path.join(workRoot, "cut.mp4");
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const { codes } = check({ path: cut }, { doc: rendered.metadata, hash: rendered.metadataHash });
    expect(codes).toContain("video_corrupted");
  });

  it("reports a container that disagrees with the render about its size", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({ ...doc, output: { ...doc.output, width: 1_280, height: 720 } })),
    );
    const finding = result.findings.find((entry) => entry.code === "video_resolution_mismatch");
    expect(finding?.evidence.width).toBe(192);
    expect(finding?.evidence.height).toBe(108);
  });

  it("reports a container that runs a different length than the render recorded", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({
        ...doc,
        output: { ...doc.output, durationSec: doc.output.durationSec + 3 },
      })),
    );
    expect(result.findings.map((entry) => entry.code)).toContain("video_duration_mismatch");
  });

  it("reports a container that runs a different length than the plan", () => {
    const manifest = {
      ...fixture.manifest,
      totalDurationSec: fixture.manifest.totalDurationSec + 6,
    } as typeof fixture.manifest;
    const { result } = check(
      { path: rendered.file },
      { doc: rendered.metadata, hash: rendered.metadataHash },
      manifest,
    );
    const finding = result.findings.find(
      (entry) => entry.code === "video_duration_mismatch" && entry.evidence.planSec !== undefined,
    );
    expect(finding).toBeDefined();
  });

  it("reports a file whose size is not what the render recorded", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({ ...doc, output: { ...doc.output, bytes: doc.output.bytes + 1_000 } })),
    );
    expect(
      result.findings.some(
        (entry) =>
          entry.code === "video_corrupted" &&
          entry.message.includes("bytes but the render recorded"),
      ),
    ).toBe(true);
  });

  it("reports a frame count that disagrees with the render", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({
        ...doc,
        output: { ...doc.output, frameCount: doc.output.frameCount + 12 },
      })),
    );
    expect(
      result.findings.some(
        (entry) =>
          entry.code === "video_corrupted" &&
          entry.message.includes("frames but the render recorded"),
      ),
    ).toBe(true);
  });

  it("reports narration the container does not have", () => {
    const { result } = check(
      { path: silent.file },
      {
        doc: { ...silent.metadata, output: { ...silent.metadata.output, hasAudio: true } },
        hash: rendered.metadataHash,
      },
    );
    expect(
      result.findings.some(
        (entry) => entry.code === "video_corrupted" && entry.message.includes("no audio track"),
      ),
    ).toBe(true);
  });

  it("reports a file that dropped the episode's captions", () => {
    const { result } = check(
      { path: silent.file },
      { doc: silent.metadata, hash: rendered.metadataHash },
    );
    expect(result.findings.map((entry) => entry.code)).toContain("video_captions_missing");
  });

  it("reports captions from a different track", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({ ...doc, captionTrackHash: "c".repeat(64) })),
    );
    expect(result.findings.map((entry) => entry.code)).toContain("video_captions_missing");
  });

  it("reports narration from a different track", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({ ...doc, audioTrackHash: "d".repeat(64) })),
    );
    expect(
      result.findings.some(
        (entry) =>
          entry.code === "video_invalid_output" && entry.message.includes("muxed with narration"),
      ),
    ).toBe(true);
  });

  it("reports a file rendered from a different plan", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({ ...doc, manifestHash: "b".repeat(64) })),
    );
    expect(
      result.findings.some(
        (entry) =>
          entry.code === "video_invalid_output" && entry.message.includes("was rendered from plan"),
      ),
    ).toBe(true);
  });

  it("reports the render's own hard issues", () => {
    const { result } = check(
      { path: rendered.file },
      metadata((doc) => ({
        ...doc,
        issues: [
          ...doc.issues,
          {
            code: "ffmpeg_failed",
            severity: "error",
            message: "x264 died on segment 3",
            segment: 3,
          },
        ],
      })),
    );
    const finding = result.findings.find((entry) => entry.code === "video_encoding_failure");
    expect(finding?.subject).toBe("segment 3");
  });

  it("warns when a player would have to download the whole file first", () => {
    // A container shaped like the render's, but with its index at the end — what a
    // renderer that skipped faststart would leave behind.
    const output = rendered.metadata.output;
    const bytes = syntheticMp4({
      width: output.width,
      height: output.height,
      fps: output.fps,
      frames: output.frameCount,
      fastStart: false,
      audio: {
        codec: output.audioCodec,
        sampleRate: 48_000,
        channels: 1,
        durationSec: output.durationSec,
      },
    });
    const file = path.join(workRoot, "unstreamable.mp4");
    writeFileSync(file, bytes);
    expect(parseMp4(bytes).fastStart).toBe(false);

    const { result } = check(
      { path: file },
      {
        doc: { ...rendered.metadata, output: { ...output, bytes: bytes.length } },
        hash: rendered.metadataHash,
      },
    );
    const finding = result.findings.find((entry) => entry.code === "video_not_streamable");
    expect(finding?.severity).toBe("warning");
    expect(result.findings.some((entry) => entry.severity === "error")).toBe(false);
  });

  it("says so when there is no render metadata to compare against", () => {
    // A plan whose own resolution is the proxy the file was rendered at, so the file
    // can be judged against the plan alone — which is the fallback when the render's
    // metadata is missing.
    const manifest = {
      ...fixture.manifest,
      resolution: { width: 192, height: 108 },
    } as typeof fixture.manifest;
    const { result, codes } = check({ path: rendered.file }, undefined, manifest);
    expect(codes).toEqual(["qa_evidence_missing"]);
    expect(result.report.note).toContain("192x108");
  });
});
