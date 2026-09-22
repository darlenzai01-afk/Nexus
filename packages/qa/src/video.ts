import { HARD_RENDER_ISSUE_CODES, parseMp4 } from "@nexus/video";

import { readBytes, type QADeps, type QAEvidence } from "./evidence.js";
import { checkResult, finding, round2, type CheckResult } from "./findings.js";
import type { QASettings } from "./schema.js";

/**
 * Video QA: the deliverable itself.
 *
 * Everything upstream can be perfect and the file can still be wrong — an encoder
 * that wrote half a moov, a mux that dropped the audio track, a container whose
 * duration disagrees with the plan, a file the render metadata describes but
 * which no longer exists on disk. So this check opens the *bytes* and reads the
 * container back with the pipeline's own parser, then compares what it finds with
 * what the render claimed:
 *
 * - **invalid output** — no video, no readable container, no video track;
 * - **resolution** — the track's size against the plan's;
 * - **duration** — the container's duration against the render metadata (which was
 *   measured at render time) and against the plan;
 * - **encoding failure** — the render metadata's own hard issues, and the failure
 *   report if one was written;
 * - **corruption** — a file smaller than a video, a byte count that is not the one
 *   the metadata recorded, a frame count that disagrees, a truncated box tree.
 */

export function checkVideo(evidence: QAEvidence, deps: QADeps, settings: QASettings): CheckResult {
  const findings = [];
  let examined = 0;
  const { render, video, manifest } = evidence;

  if (render !== undefined) {
    // The render's own record of what went wrong is evidence in its own right.
    for (const issue of render.doc.issues) {
      // The render's own classification decides: a hard code or an error severity.
      if (issue.severity !== "error" && !HARD_RENDER_ISSUE_CODES.includes(issue.code)) continue;
      examined += 1;
      findings.push(
        finding(
          "video_encoding_failure",
          issue.segment === undefined ? "render" : `segment ${issue.segment}`,
          `the render reported ${issue.code}: ${issue.message}`,
          { code: issue.code, segment: issue.segment ?? null },
          "fix the cause and render again; the metadata is the record",
        ),
      );
    }
  }

  if (video === undefined || (video.path === undefined && video.hash === undefined)) {
    findings.push(
      finding(
        "video_invalid_output",
        "episode",
        "no video file was supplied, so there is nothing to publish",
        {},
        "run the render stage first",
      ),
    );
    return checkResult("video.output", "video", examined, findings);
  }

  let bytes: Uint8Array;
  let source: string;
  try {
    if (video.path !== undefined) {
      bytes = readBytes(deps, video.path);
      source = video.path;
    } else {
      if (!deps.storage.has(video.hash!))
        throw new Error(`hash ${video.hash!.slice(0, 12)}… is not in the store`);
      bytes = deps.storage.read(video.hash!);
      source = `cas:${video.hash!.slice(0, 12)}`;
    }
  } catch (error) {
    findings.push(
      finding(
        "video_invalid_output",
        "episode",
        `the video cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        { source: video.path ?? video.hash ?? "" },
        "render the episode again",
      ),
    );
    return checkResult("video.output", "video", examined, findings);
  }

  examined += 1;
  if (bytes.byteLength < settings.minVideoBytes) {
    findings.push(
      finding(
        "video_corrupted",
        "output",
        `the video is ${bytes.byteLength} bytes, below the ${settings.minVideoBytes}-byte floor for a real file`,
        { bytes: bytes.byteLength, minBytes: settings.minVideoBytes },
        "render the episode again",
      ),
    );
    return checkResult("video.output", "video", examined, findings);
  }

  let info;
  try {
    info = parseMp4(bytes);
  } catch (error) {
    findings.push(
      finding(
        "video_corrupted",
        "output",
        `the file is not a readable MP4: ${error instanceof Error ? error.message : String(error)}`,
        { bytes: bytes.byteLength, source },
        "render the episode again; the container is truncated or malformed",
      ),
    );
    return checkResult("video.output", "video", examined, findings);
  }

  examined += 1;
  if (info.video === undefined) {
    findings.push(
      finding(
        "video_invalid_output",
        "output",
        "the container has no video track",
        {
          audio: info.audio !== undefined,
          durationSec: round2(info.durationSec),
          brands: info.brands.join("/"),
        },
        "render the episode again",
      ),
    );
  }

  // ── Resolution: the track against the plan ───────────────────────────────
  const planWidth = manifest.resolution.width;
  const planHeight = manifest.resolution.height;
  const expectedWidth = render?.doc.output.width ?? planWidth;
  const expectedHeight = render?.doc.output.height ?? planHeight;
  if (info.video !== undefined) {
    examined += 1;
    if (info.video.width !== expectedWidth || info.video.height !== expectedHeight) {
      findings.push(
        finding(
          "video_resolution_mismatch",
          "output",
          `the video is ${info.video.width}x${info.video.height} but the render was configured for ` +
            `${expectedWidth}x${expectedHeight} (plan ${planWidth}x${planHeight})`,
          {
            width: info.video.width,
            height: info.video.height,
            expectedWidth,
            expectedHeight,
            planWidth,
            planHeight,
          },
          "re-render at the configured size",
        ),
      );
    }
  }

  // ── Duration and corruption, against the render's own record ─────────────
  if (render !== undefined) {
    const claimed = render.doc.output;
    examined += 1;
    if (Math.abs(info.durationSec - claimed.durationSec) > settings.videoToleranceSec) {
      findings.push(
        finding(
          "video_duration_mismatch",
          "output",
          `the container runs ${round2(info.durationSec)}s but the render recorded ${round2(claimed.durationSec)}s ` +
            `(tolerance ${settings.videoToleranceSec}s)`,
          {
            containerSec: round2(info.durationSec),
            recordedSec: round2(claimed.durationSec),
            toleranceSec: settings.videoToleranceSec,
          },
          "re-render; the file and its metadata disagree",
        ),
      );
    }
    examined += 1;
    if (bytes.byteLength !== claimed.bytes) {
      findings.push(
        finding(
          "video_corrupted",
          "output",
          `the file is ${bytes.byteLength} bytes but the render recorded ${claimed.bytes}`,
          { bytes: bytes.byteLength, recordedBytes: claimed.bytes },
          "the file changed after it was written; render again",
        ),
      );
    }
    if (info.video !== undefined && info.video.frameCount !== claimed.frameCount) {
      findings.push(
        finding(
          "video_corrupted",
          "output",
          `the video track holds ${info.video.frameCount} frames but the render recorded ${claimed.frameCount}`,
          { frames: info.video.frameCount, recordedFrames: claimed.frameCount },
          "render the episode again",
        ),
      );
    }
    examined += 1;
    if (claimed.hasAudio && info.audio === undefined) {
      findings.push(
        finding(
          "video_corrupted",
          "output",
          "the render recorded narration audio but the container has no audio track",
          { recordedHasAudio: true, audioTrack: false },
          "re-run the mux step",
        ),
      );
    }
  } else {
    findings.push(
      finding(
        "qa_evidence_missing",
        "render",
        "no render metadata was supplied, so the output was not checked against its own record",
        {},
        "run QA after the render stage",
      ),
    );
  }

  if (render !== undefined) {
    examined += 1;
    if (render.doc.manifestHash !== evidence.manifestHash) {
      findings.push(
        finding(
          "video_invalid_output",
          "output",
          `the file was rendered from plan ${render.doc.manifestHash.slice(0, 12)}… but QA is reviewing ` +
            `${evidence.manifestHash.slice(0, 12)}…`,
          {
            renderedPlan: render.doc.manifestHash.slice(0, 12),
            manifestHash: evidence.manifestHash.slice(0, 12),
          },
          "re-render the current plan; this file is of a different episode",
        ),
      );
    }
  }

  // ── The tracks the file was muxed with ───────────────────────────────────
  if (render !== undefined) {
    if (evidence.captions !== undefined) {
      examined += 1;
      if (render.doc.captionTrackHash === undefined) {
        findings.push(
          finding(
            "video_captions_missing",
            "output",
            "the episode has a caption track but the render recorded no captions, so the delivered file " +
              "shows none",
            { captionTrackHash: evidence.captions.hash.slice(0, 12), rendered: null },
            "re-run the render stage; it was handed the caption track and did not burn it in",
          ),
        );
      } else if (render.doc.captionTrackHash !== evidence.captions.hash) {
        findings.push(
          finding(
            "video_captions_missing",
            "output",
            `the file carries captions from a different track (${render.doc.captionTrackHash.slice(0, 12)}…) ` +
              `than the one QA was given (${evidence.captions.hash.slice(0, 12)}…)`,
            {
              renderedHash: render.doc.captionTrackHash.slice(0, 12),
              captionsHash: evidence.captions.hash.slice(0, 12),
            },
            "render the episode again from the current caption track",
          ),
        );
      }
    }
    if (evidence.audio !== undefined && render.doc.audioTrackHash !== undefined) {
      examined += 1;
      if (render.doc.audioTrackHash !== evidence.audio.hash) {
        findings.push(
          finding(
            "video_invalid_output",
            "output",
            `the file was muxed with narration ${render.doc.audioTrackHash.slice(0, 12)}… but QA was given ` +
              `${evidence.audio.hash.slice(0, 12)}…`,
            {
              renderedHash: render.doc.audioTrackHash.slice(0, 12),
              audioHash: evidence.audio.hash.slice(0, 12),
            },
            "render the episode again from the current narration",
          ),
        );
      }
    }
  }

  // The plan's own duration is the last word on how long the episode should be.
  if (info.durationSec > 0) {
    examined += 1;
    if (
      Math.abs(info.durationSec - manifest.totalDurationSec) >
      Math.max(settings.videoToleranceSec, 0.5)
    ) {
      findings.push(
        finding(
          "video_duration_mismatch",
          "output",
          `the finished video runs ${round2(info.durationSec)}s against a ${round2(manifest.totalDurationSec)}s plan`,
          { containerSec: round2(info.durationSec), planSec: round2(manifest.totalDurationSec) },
          "the plan and the render disagree about the episode's length",
        ),
      );
    }
  }

  examined += 1;
  if (!info.fastStart) {
    findings.push(
      finding(
        "video_not_streamable",
        "output",
        "the moov atom is after the media data, so a player must download the whole file before it starts",
        { fastStart: false },
        "render with -movflags +faststart",
      ),
    );
  }

  const note =
    info.video === undefined
      ? "no video track"
      : `${info.video.codec} ${info.video.width}x${info.video.height}`;
  return checkResult("video.output", "video", examined, findings, note);
}
