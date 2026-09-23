import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import type { CaptionTrack } from "@nexus/audio";
import { hashInputs } from "@nexus/providers";
import type { ComposedVideo } from "@nexus/render";

import type { RenderConfig } from "./schema.js";

/**
 * Render segments: the unit of work, of reuse and of resumption.
 *
 * A segment is a contiguous run of frames (one scene's worth, or a slice of one)
 * that is rasterised and encoded on its own. Splitting the render this way is what
 * makes every requirement in the brief fall out of one mechanism:
 *
 * - **resumability** — the journal records a segment only after its file exists
 *   and matches its hash, so a killed process loses at most the segment in flight;
 * - **artifact reuse** — a segment's key is a hash over everything that decides
 *   its pixels (the frames, the captions in its window, the fonts, the encoder
 *   settings), so an unchanged segment is adopted instead of re-rendered;
 * - **clear failure information** — a failure names the segment it happened in,
 *   and the segments that already succeeded stay on disk.
 *
 * Segments also keep the frames/encode split visible: a segment whose video is
 * missing but whose PNGs are all still present re-encodes without re-rasterising,
 * which is the difference between seconds and minutes on a long episode.
 */

export interface SegmentPlan {
  readonly index: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly frameCount: number;
  readonly startSec: number;
  readonly endSec: number;
  /** Hash of everything that decides this segment's pixels and bytes. */
  readonly key: string;
  /** Digest of the frames in this range (from the compositor). */
  readonly frameDigest: string;
}

export function planSegments(
  composed: ComposedVideo,
  config: RenderConfig,
  options: {
    readonly renderKey: string;
    readonly captionTrack?: CaptionTrack | undefined;
    readonly fontHash?: string | undefined;
  },
): SegmentPlan[] {
  const plans: SegmentPlan[] = [];
  const total = composed.frameCount;
  for (let start = 0; start < total; start += config.segmentFrames) {
    const last = Math.min(total, start + config.segmentFrames) - 1;
    const firstFrame = start;
    const lastFrame = last;
    const frameCount = lastFrame - firstFrame + 1;
    const startSec = firstFrame / composed.fps;
    const endSec = (lastFrame + 1) / composed.fps;
    const frameDigest = digestOfFrames(composed, firstFrame, lastFrame);
    const captionSlice =
      options.captionTrack === undefined
        ? "none"
        : hashInputs({
            kind: "video.render.captions",
            cues: options.captionTrack.cues
              .filter((cue) => cue.endMs > startSec * 1000 && cue.startMs < endSec * 1000)
              .map((cue) => [cue.id, cue.startMs, cue.endMs, cue.lines.map((line) => line.text)]),
          });
    plans.push({
      index: plans.length,
      firstFrame,
      lastFrame,
      frameCount,
      startSec,
      endSec,
      frameDigest,
      key: hashInputs({
        kind: "video.render.segment",
        version: 1,
        renderKey: options.renderKey,
        index: plans.length,
        firstFrame,
        lastFrame,
        frameDigest,
        captionSlice,
        fontHash: options.fontHash ?? "none",
        config: {
          width: config.width,
          height: config.height,
          fps: config.fps,
          videoCodec: config.videoCodec,
          crf: config.crf,
          preset: config.preset,
          pixFmt: config.pixFmt,
          threads: config.threads,
          captions: config.captions,
          captionFontPx: config.captionFontPx,
          captionMarginPx: config.captionMarginPx,
          captionBandOpacity: config.captionBandOpacity,
        },
      }),
    });
  }
  return plans;
}

/** A digest over one range of composed frames, without rasterising anything. */
export function digestOfFrames(
  composed: ComposedVideo,
  firstFrame: number,
  lastFrame: number,
): string {
  const hash = createHash("sha256");
  hash.update(`frames:${firstFrame}:${lastFrame}:${composed.fps}\n`);
  let count = 0;
  for (const scene of composed.scenes) {
    for (const frame of scene.frames) {
      if (frame.index < firstFrame || frame.index > lastFrame) continue;
      hash.update(`${frame.index}:${frame.sceneId}:`);
      for (const element of frame.elements) {
        hash.update(
          `${element.kind}#${element.id}@${element.z}:${format(element.transform.x)},${format(element.transform.y)},` +
            `${format(element.transform.scale)},${format(element.transform.rotationDeg)},${format(element.opacity)},` +
            `${element.reveal.mode}:${format(element.reveal.amount)};`,
        );
        if (element.kind === "text") {
          hash.update(`text:${element.lines.join("|")}:${element.revealChars};`);
        }
        if (element.kind === "character") {
          hash.update(`figure:${element.pose}:${element.expression}:${element.gesture};`);
        }
      }
      hash.update("\n");
      count += 1;
    }
  }
  hash.update(`count:${count}\n`);
  return hash.digest("hex");
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "nan";
}

/** A file's sha256 and size: how reuse decides whether a file is still the one. */
export function fileDigest(file: string): { readonly hash: string; readonly bytes: number } {
  const bytes = statSync(file).size;
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return { hash: hash.digest("hex"), bytes };
}

export function fileExists(file: string): boolean {
  return existsSync(file);
}

export function fileBytes(file: string): number {
  return statSync(file).size;
}
