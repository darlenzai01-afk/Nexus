import { visibleLines } from "@nexus/render";
import type { TextElement } from "@nexus/render";

import {
  fillPath,
  fillRect,
  parseColour,
  strokePolyline,
  type Canvas,
  type Point,
  type Rect,
} from "./canvas.js";
import { BOLD_WEIGHT, fontForWeight, type FontSet } from "./font.js";
import { contourToPolygon } from "./ttf.js";
import { applyMatrix, type Matrix } from "./transform.js";

/** Device-space scale of a matrix (uniform-ish; used to size curve flattening). */
function scaleOf(matrix: Matrix): number {
  return Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
}

/**
 * Text, drawn from outline to pixel.
 *
 * The layout rules are the ones Phase 9's SVG writer uses — the same visible-line
 * rule for a typing reveal, the same line height, the same first-baseline formula,
 * the same highlight band, the same smaller, dimmer attribution line. Keeping them
 * identical is what makes the SVG a faithful preview of the video rather than a
 * second opinion about it.
 *
 * Glyphs are filled through the same anti-aliased path rasteriser as everything
 * else, which is why a caption at 640×360 and a caption at 1920×1080 look like the
 * same type at two sizes rather than two different renderings.
 */

/** Line height multiplier and attribution scale — Phase 9's `svg.ts` uses these. */
export const LINE_HEIGHT_FACTOR = 1.25;
export const ATTRIBUTION_SCALE = 0.72;
/** Synthetic italic slant (the tangent of the shear angle) with no italic face. */
export const ITALIC_SLANT = 0.21;
/** Synthetic emboldening, as a fraction of the font size, with no bold face. */
export const SYNTHETIC_BOLD = 0.03;
/** Colour Phase 9 draws attributions and panel captions in (`look.caption`). */
export const CAPTION_INK = "#9fb0bd";

export interface TextRun {
  readonly text: string;
  /** Left edge, or centre, of the run in element space. */
  readonly x: number;
  /** Baseline of the run in element space. */
  readonly baselineY: number;
  readonly fontSizePx: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly anchor: "start" | "middle";
  readonly colour: string;
  readonly alpha?: number;
}

export interface RunContext {
  readonly fonts: FontSet;
  /** Element space → device space. */
  readonly matrix: Matrix;
  readonly clip?: Rect | undefined;
}

/** Advance width of a run in element-space pixels. */
export function measureRun(fonts: FontSet, run: TextRun): number {
  const font = fontForWeight(fonts, run.weight);
  const scale = run.fontSizePx / font.font.metrics.unitsPerEm;
  let width = 0;
  for (const character of run.text) {
    const code = character.codePointAt(0) ?? 32;
    width += font.font.advanceWidth(font.font.glyphIndex(code)) * scale;
  }
  return width;
}

/** Where a run starts, after the anchor rule. */
export function runOrigin(fonts: FontSet, run: TextRun): number {
  return run.anchor === "middle" ? run.x - measureRun(fonts, run) / 2 : run.x;
}

/** Draw one run of text. Unmapped characters fall back to `.notdef`, as a font would. */
export function drawTextRun(canvas: Canvas, run: TextRun, context: RunContext): number {
  if (run.text === "" || run.alpha === 0) return 0;
  const font = fontForWeight(context.fonts, run.weight);
  const colour = parseColour(run.colour);
  const alpha = run.alpha ?? 1;
  const scale = run.fontSizePx / font.font.metrics.unitsPerEm;
  const deviceSize = run.fontSizePx * scaleOf(context.matrix);
  const slant = run.italic ? ITALIC_SLANT : 0;
  const embolden =
    run.weight >= BOLD_WEIGHT && context.fonts.bold === undefined
      ? SYNTHETIC_BOLD * run.fontSizePx
      : 0;
  let pen = runOrigin(context.fonts, run);
  let glyphs = 0;

  for (const character of run.text) {
    const code = character.codePointAt(0) ?? 32;
    const glyphIndex = font.font.glyphIndex(code);
    const origin = pen;
    const project = (point: Point): Point => {
      const deviceX = point.x * scale + origin;
      const deviceY = run.baselineY - point.y * scale;
      return applyMatrix(context.matrix, {
        x: deviceX + slant * (run.baselineY - deviceY),
        y: deviceY,
      });
    };
    for (const outline of font.font.contours(glyphIndex)) {
      // A glyph drawn 18 px tall does not need the same curve resolution as one
      // drawn 200 px tall; the flattening is chosen from the device size so small
      // type stays cheap without going visibly faceted.
      const contour = contourToPolygon(outline, deviceSize < 24 ? 3 : deviceSize < 48 ? 5 : 8).map(
        project,
      );
      if (contour.length < 3) continue;
      fillPath(canvas, [contour], colour, { alpha, clip: context.clip });
      if (embolden > 0) {
        const first = contour[0];
        strokePolyline(
          canvas,
          first === undefined ? contour : [...contour, first],
          colour,
          embolden,
          { alpha, clip: context.clip },
        );
      }
    }
    pen += font.font.advanceWidth(glyphIndex) * scale;
    glyphs += 1;
  }
  return glyphs;
}

export interface TextElementDraw {
  /** The lines drawn, including the attribution line. */
  readonly lines: readonly string[];
  readonly lineHeight: number;
  readonly firstBaselineY: number;
}

/**
 * Draw a frame's on-screen text element exactly as Phase 9's SVG writer lays it
 * out: centred in its box, no wrapping decision left to the renderer (the box and
 * the lines were decided upstream), and a highlight band behind it when the scene
 * asked for one.
 */
export function drawTextElement(
  canvas: Canvas,
  element: TextElement,
  context: RunContext,
): TextElementDraw {
  const lines = visibleLines(element.lines, element.revealChars);
  const attribution = element.attribution === "" ? [] : [element.attribution];
  const block = [...lines, ...attribution];
  const lineHeight = Math.round(element.style.fontSizePx * LINE_HEIGHT_FACTOR);
  const firstBaselineY =
    element.rect.height / 2 -
    ((block.length - 1) * lineHeight) / 2 +
    element.style.fontSizePx * 0.35;
  const alpha = element.opacity;
  const anchor = element.style.align === "center" ? "middle" : "start";
  const x = element.style.align === "center" ? element.rect.width / 2 : 0;

  if (element.highlight > 0) {
    fillRect(
      canvas,
      {
        x: -12,
        y: firstBaselineY - element.style.fontSizePx * 1.05,
        width: element.rect.width + 24,
        height: block.length * lineHeight + element.style.fontSizePx * 0.6,
      },
      parseColour("#e0a33c"),
      { alpha: 0.18 * element.highlight * alpha, clip: context.clip },
    );
  }

  lines.forEach((line, index) => {
    drawTextRun(
      canvas,
      {
        text: line,
        x,
        baselineY: firstBaselineY + index * lineHeight,
        fontSizePx: element.style.fontSizePx,
        weight: element.style.weight,
        italic: element.style.italic,
        anchor,
        colour: element.style.colour,
        alpha,
      },
      context,
    );
  });
  attribution.forEach((line, index) => {
    drawTextRun(
      canvas,
      {
        text: line,
        x,
        baselineY: firstBaselineY + (lines.length + index) * lineHeight,
        fontSizePx: element.style.fontSizePx * ATTRIBUTION_SCALE,
        weight: element.style.weight,
        italic: element.style.italic,
        anchor,
        colour: CAPTION_INK,
        alpha,
      },
      context,
    );
  });

  return { lines: block, lineHeight, firstBaselineY };
}
