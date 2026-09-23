import { cueAt, type CaptionCue, type CaptionTrack } from "@nexus/audio";

import { fillRect, parseColour, type Canvas, type Rect } from "./canvas.js";
import type { FontSet } from "./font.js";
import { drawTextRun, LINE_HEIGHT_FACTOR } from "./text-raster.js";
import { IDENTITY } from "./transform.js";

/**
 * Burning the caption track in.
 *
 * The captions were derived in Phase 10 — wrapped lines, non-overlapping
 * windows, held long enough to read — so this module is deliberately dumb: for a
 * given moment it asks the track which cue is on screen and draws that cue's
 * lines. It never re-wraps, re-times or re-orders anything, which is what keeps
 * one definition of "what the subtitle says" in the system.
 *
 * The band behind the text exists because captions have to survive whatever is
 * underneath them; it is drawn with the same rasteriser as everything else, so it
 * is exactly as deterministic as the frame.
 */

export interface CaptionStyle {
  /** Font size in *output* pixels (the render's own scale, not the plan's). */
  readonly fontPx: number;
  readonly marginPx: number;
  readonly bandOpacity: number;
  readonly ink: string;
  readonly band: string;
  readonly safeWidthRatio: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontPx: 22,
  marginPx: 24,
  bandOpacity: 0.72,
  ink: "#f6f4ee",
  band: "#0b0f14",
  safeWidthRatio: 0.9,
};

export interface CaptionDraw {
  readonly cueId: string;
  readonly lines: readonly string[];
  readonly band: Rect;
}

/** The cue on screen at `timeMs`, or `undefined` in a gap. */
export function activeCue(track: CaptionTrack, timeMs: number): CaptionCue | undefined {
  const cue = cueAt(track, Math.round(timeMs));
  return cue ?? undefined;
}

/** Draw the caption that is on screen at `timeMs`. Returns what it drew. */
export function drawCaption(
  canvas: Canvas,
  track: CaptionTrack,
  timeMs: number,
  fonts: FontSet,
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
): CaptionDraw | undefined {
  const cue = activeCue(track, timeMs);
  if (cue === undefined) return undefined;
  const lines = cue.lines.map((line) => line.text);
  if (lines.length === 0) return undefined;
  // An estimated cue (the voice stage could not measure that clip) still gets
  // drawn — the words are right even when the window is approximate — but the
  // caller records the fact from the caption track, not from here.
  const lineHeight = Math.round(style.fontPx * LINE_HEIGHT_FACTOR);
  const paddingY = Math.round(style.fontPx * 0.45);
  const paddingX = Math.round(style.fontPx * 0.7);
  const widest = Math.max(
    ...lines.map((line) => line.length * style.fontPx * 0.62),
    style.fontPx * 2,
  );
  const width = Math.min(canvas.width * style.safeWidthRatio, widest + paddingX * 2);
  const height = lines.length * lineHeight + paddingY * 2;
  const band: Rect = {
    x: Math.round((canvas.width - width) / 2),
    y: Math.round(canvas.height - style.marginPx - height),
    width: Math.round(width),
    height: Math.round(height),
  };
  fillRect(canvas, band, parseColour(style.band), {
    alpha: style.bandOpacity,
    radius: Math.round(style.fontPx * 0.35),
  });
  lines.forEach((line, index) => {
    drawTextRun(
      canvas,
      {
        text: line,
        x: band.x + band.width / 2,
        baselineY: band.y + paddingY + index * lineHeight + style.fontPx * 0.8,
        fontSizePx: style.fontPx,
        weight: 600,
        italic: false,
        anchor: "middle",
        colour: style.ink,
        alpha: 1,
      },
      { fonts, matrix: IDENTITY },
    );
  });
  return { cueId: cue.id, lines, band };
}
