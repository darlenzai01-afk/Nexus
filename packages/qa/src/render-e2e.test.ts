import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAudioTrack, loadCaptionTrack } from "@nexus/audio";
import { CharacterLibrary } from "@nexus/characters";
import { createCharacterStage } from "@nexus/render";
import {
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  RenderMetadataSchema,
  createFFmpegRunner,
  findFont,
  loadFontFile,
  renderVideo,
  resolveRenderConfig,
  type FontSet,
  type RenderMetadata,
} from "@nexus/video";
import { afterAll, describe, expect, it } from "vitest";

import { assertPublishable, runQA } from "./engine.js";
import { QABlockedError } from "./errors.js";
import { qaFixture, type QAFixture } from "./fixtures.js";

/**
 * QA against a real render: the one test that runs the whole chain.
 *
 * Everything else in this package breaks one document at a time. This file proves
 * the other direction: a plan, a script, a research package, a narration track and
 * a *real* render of that plan produce a QA report with no errors — so a green
 * verdict is something an episode can actually earn, rather than a state no input
 * reaches — and then that breaking one thing turns the same episode into a refusal.
 *
 * The render is small (the rasteriser is the same code at any size) but it is the
 * pipeline: real frames, real x264, real muxing, and the file is read back by the
 * video check. The suite skips — loudly — when no FFmpeg is installed.
 */

const ffmpegPath = resolveBinary();
const workRoot = mkdtempSync(path.join(tmpdir(), "nexus-qa-render-"));
const suite = ffmpegPath === undefined ? describe.skip : describe;

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function resolveBinary(): string | undefined {
  const configured = process.env["NEXUS_FFMPEG_PATH"]?.trim();
  if (
    configured !== undefined &&
    configured !== "" &&
    configured.includes("/") &&
    !existsSync(configured)
  ) {
    return undefined;
  }
  // A bare "ffmpeg" (or a configured path that exists) is only worth running if the
  // binary actually answers: prove it with a `-version` probe, like the render
  // smoke test does, so a machine without FFmpeg skips instead of failing.
  try {
    createFFmpegRunner({
      binary: configured !== undefined && configured !== "" ? configured : "ffmpeg",
      timeoutMs: 30_000,
    });
    return configured !== undefined && configured !== "" ? configured : "ffmpeg";
  } catch {
    return undefined;
  }
}

function fontsOf(): FontSet | undefined {
  const regular = findFont(DEFAULT_FONT_CANDIDATES);
  if (regular === undefined || !existsSync(regular)) return undefined;
  const bold = findFont(DEFAULT_BOLD_FONT_CANDIDATES);
  return bold !== undefined && existsSync(bold)
    ? { regular: loadFontFile(regular), bold: loadFontFile(bold) }
    : { regular: loadFontFile(regular) };
}

interface Rendered {
  readonly file: string;
  readonly metadata: RenderMetadata;
  readonly metadataHash: string;
}

/** Render the fixture plan for real, and store the video's bytes and metadata. */
function renderFixture(fixture: QAFixture): Rendered {
  const config = resolveRenderConfig({
    width: 640,
    height: 360,
    fps: 30,
    segmentFrames: 20,
    measureLoudness: false,
    threads: 1,
  });
  const fonts = fontsOf();
  const result = renderVideo(
    {
      manifest: fixture.manifest,
      manifestHash: fixture.manifestHash,
      config,
      characterStage: createCharacterStage(CharacterLibrary.load()),
      audioTrack: loadAudioTrack(fixture.storage, fixture.audio.hash),
      audioTrackHash: fixture.audio.hash,
      captionTrack: loadCaptionTrack(fixture.storage, fixture.captions.hash),
      captionTrackHash: fixture.captions.hash,
      ...(fonts !== undefined ? { fonts } : {}),
      now: "2024-05-01T00:00:00.000Z",
    },
    { ffmpeg: createFFmpegRunner({ binary: ffmpegPath! }), storage: fixture.storage, workRoot },
  );
  const metadata = RenderMetadataSchema.parse(result.metadata);
  const stored = fixture.storage.put(new TextEncoder().encode(JSON.stringify(metadata, null, 2)));
  return { file: result.video.file, metadata, metadataHash: stored.hash };
}

function checkStatus(
  report: { checks: readonly { id: string; status: string }[] },
  id: string,
): string {
  return report.checks.find((check) => check.id === id)?.status ?? "(missing)";
}

suite("QA against a real render", () => {
  it("passes an episode that renders, with the video actually checked", async () => {
    const fixture = await qaFixture();
    const rendered = renderFixture(fixture);
    const report = runQA(
      {
        ...fixture.evidence,
        video: { path: rendered.file },
        render: { doc: rendered.metadata, hash: rendered.metadataHash },
      },
      fixture.deps,
    );

    // Nothing to block: the render is the plan, the audio is the plan, and the
    // script says only what the research package supports.
    expect(report.counts.errors).toBe(0);
    expect(report.publishable).toBe(true);
    expect(() => assertPublishable(report)).not.toThrow();
    expect(checkStatus(report, "video.output")).toBe("ok");
    expect(checkStatus(report, "content.script")).toBe("ok");
    expect(checkStatus(report, "visual.frames")).toBe("ok");
    expect(checkStatus(report, "audio.track")).toBe("ok");
    // QA ran against a render, not inside a job, so the job check says so
    // instead of staying silent: skipped, with a warning, not an error.
    expect(checkStatus(report, "pipeline.state")).toBe("skipped");
    expect(report.findings.map((finding) => finding.code)).toEqual(["qa_evidence_missing"]);
    expect(report.verdict).toBe("pass_with_warnings");
    expect(report.counts.skipped).toBe(1);
    expect(rendered.metadata.output.frameCount).toBeGreaterThan(0);
    expect(rendered.metadata.output.bytes).toBeGreaterThan(0);
  }, 600_000);

  it("refuses publication when the script claims more than the evidence clears", async () => {
    const fixture = await qaFixture();
    const rendered = renderFixture(fixture);
    const broken = fixture.with({
      script: {
        doc: {
          ...fixture.script.doc,
          claims: [
            {
              ...fixture.script.doc.claims[0]!,
              status: "unverified",
              certainty: "uncertain",
              mayStateAsFact: false,
            },
          ],
        },
        hash: fixture.script.hash,
      },
      video: { path: rendered.file },
      render: { doc: rendered.metadata, hash: rendered.metadataHash },
    });
    const report = runQA(broken, fixture.deps);

    expect(report.publishable).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(report.blocking).toContain("content_claim_unsupported");
    // The picture is still fine: the refusal comes from the claims alone.
    expect(checkStatus(report, "video.output")).toBe("ok");
    let blocked: unknown;
    try {
      assertPublishable(report);
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(QABlockedError);
    expect((blocked as QABlockedError).report.findings.length).toBe(report.findings.length);
  }, 600_000);

  it("refuses publication when the file no longer matches the render", async () => {
    const fixture = await qaFixture();
    const rendered = renderFixture(fixture);
    const bytes = readFileSync(rendered.file);
    const truncated = path.join(workRoot, "truncated.mp4");
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const report = runQA(
      {
        ...fixture.evidence,
        video: { path: truncated },
        render: { doc: rendered.metadata, hash: rendered.metadataHash },
      },
      fixture.deps,
    );

    expect(report.publishable).toBe(false);
    expect(report.blocking).toContain("video_corrupted");
    expect(checkStatus(report, "video.output")).toBe("findings");
    expect(() => assertPublishable(report)).toThrow(QABlockedError);
  }, 600_000);
});
