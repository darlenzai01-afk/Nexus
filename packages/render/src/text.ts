import type {
  SceneText,
  SceneTextKind,
  SceneTextPosition,
  SceneAnimationEvent,
} from "@nexus/scenes";

import { clamp, clamp01, lerp, round } from "./numbers.js";
import type { Look, Rect, Size, TextStyle } from "./types.js";

/**
 * On-screen text.
 *
 * The manifest gives the words, where they sit, how many lines they may take and
 * where they came from; the compositor decides the type size, wraps the words into
 * the box and applies whatever the scene's animation events ask of them
 * (`type_on` reveals characters, `count_up` animates a number, `highlight` marks
 * the card).
 *
 * Wrapping cannot be exact without the font file, so the engine documents its
 * approximation: an average glyph is `0.55 × fontSize` wide. A line that still
 * does not fit shrinks the type in `TEXT_SHRINK_STEPS` before anything is cut, and
 * a card that runs out of lines is truncated at `maxLines` with an ellipsis *and*
 * a `text_overflow` diagnostic — never silently.
 */

export const TEXT_STYLE: Readonly<
  Record<
    SceneTextKind,
    { readonly sizeFactor: number; readonly weight: number; readonly italic: boolean }
  >
> = {
  title: { sizeFactor: 0.085, weight: 700, italic: false },
  claim: { sizeFactor: 0.05, weight: 600, italic: false },
  quote: { sizeFactor: 0.045, weight: 500, italic: true },
  number: { sizeFactor: 0.125, weight: 800, italic: false },
  label: { sizeFactor: 0.038, weight: 600, italic: false },
  callout: { sizeFactor: 0.042, weight: 600, italic: false },
};

/** Where each position puts the text box, as fractions of the frame. */
export const TEXT_BOX: Readonly<Record<SceneTextPosition, Rect>> = {
  lower_third: { x: 0.14, y: 0.72, width: 0.72, height: 0.16 },
  upper_third: { x: 0.14, y: 0.12, width: 0.72, height: 0.16 },
  center: { x: 0.16, y: 0.4, width: 0.68, height: 0.2 },
  corner: { x: 0.52, y: 0.78, width: 0.34, height: 0.12 },
  full_screen: { x: 0.1, y: 0.3, width: 0.8, height: 0.4 },
};

/** Average glyph width, as a fraction of the type size (see the module note). */
export const GLYPH_WIDTH_FACTOR = 0.55;

/** Type sizes the wrapper tries, in order, before it truncates. */
export const TEXT_SHRINK_STEPS: readonly number[] = [1, 0.9, 0.8, 0.7, 0.6];

export function textRect(text: SceneText, resolution: Size): Rect {
  const box = TEXT_BOX[text.position];
  return {
    x: round(box.x * resolution.width),
    y: round(box.y * resolution.height),
    width: round(box.width * resolution.width),
    height: round(box.height * resolution.height),
  };
}

/** The frame centre of a scene's text, for the camera to aim at. */
export function textCentreY(text: SceneText, resolution: Size): number {
  const rect = textRect(text, resolution);
  return round((rect.y + rect.height / 2) / resolution.height);
}

export function textStyle(kind: SceneTextKind, sizePx: number, look: Look): TextStyle {
  const style = TEXT_STYLE[kind];
  return {
    fontSizePx: round(sizePx),
    weight: style.weight,
    italic: style.italic,
    align: "left",
    colour: look.ink,
  };
}

export interface WrappedText {
  readonly lines: readonly string[];
  readonly fontSizePx: number;
  /** True when the words did not fit even at the smallest size. */
  readonly overflow: boolean;
}

function wrapAt(value: string, charsPerLine: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = (): void => {
    if (line !== "") lines.push(line);
    line = "";
  };
  for (const word of value.split(/\s+/u).filter((part) => part !== "")) {
    let rest = word;
    // A single word longer than the line is hard-split rather than allowed to run.
    while (rest.length > charsPerLine) {
      push();
      lines.push(rest.slice(0, charsPerLine - 1) + "-");
      rest = rest.slice(charsPerLine - 1);
    }
    const candidate = line === "" ? rest : `${line} ${rest}`;
    if (candidate.length <= charsPerLine) {
      line = candidate;
    } else {
      push();
      line = rest;
    }
  }
  push();
  return lines;
}

function truncate(lines: readonly string[], maxLines: number): string[] {
  const kept = lines.slice(0, maxLines);
  const last = kept[kept.length - 1];
  const dropped = lines.length > maxLines;
  if (dropped && last !== undefined) {
    kept[kept.length - 1] = last.length >= 2 ? `${last.slice(0, -1)}…` : "…";
  }
  return kept;
}

/**
 * Fit the words into the box: wrap, shrink if needed, truncate as a last resort.
 * The size it settles on is what the frame carries, so a renderer never has to
 * guess at a layout the engine did not choose.
 */
export function fitText(
  value: string,
  rect: Rect,
  baseSizePx: number,
  maxLines: number,
): WrappedText {
  let lines: string[] = [];
  let size = baseSizePx;
  for (const step of TEXT_SHRINK_STEPS) {
    size = round(baseSizePx * step);
    const charsPerLine = Math.max(4, Math.floor(rect.width / (size * GLYPH_WIDTH_FACTOR)));
    lines = wrapAt(value, charsPerLine);
    if (lines.length <= maxLines) {
      return { lines, fontSizePx: size, overflow: false };
    }
  }
  return { lines: truncate(lines, maxLines), fontSizePx: size, overflow: true };
}

/**
 * Run a `count_up` event's number into the card's words.
 *
 * The card's text is a template: `{n}` is replaced by the animated number. A card
 * without `{n}` gets the number itself, which is what a "number" card usually
 * wants. `from`, `to`, `decimals`, `unit`, `prefix` come from the event's params;
 * anything missing takes the documented default (0, 100, 0, "", "").
 */
export function countUpValue(
  event: SceneAnimationEvent,
  progress: number,
  template: string,
): { readonly value: string; readonly usedTemplate: boolean } {
  const params = event.params;
  const from = typeof params.from === "number" ? params.from : 0;
  const to = typeof params.to === "number" ? params.to : 100;
  const decimals = clamp(
    typeof params.decimals === "number" ? Math.round(params.decimals) : 0,
    0,
    4,
  );
  const unit = typeof params.unit === "string" ? params.unit : "";
  const prefix = typeof params.prefix === "string" ? params.prefix : "";
  const number = lerp(from, to, clamp01(progress)).toFixed(decimals);
  const rendered = `${prefix}${number}${unit}`;
  if (template.includes("{n}")) {
    return { value: template.split("{n}").join(rendered), usedTemplate: true };
  }
  return { value: rendered, usedTemplate: false };
}

/** How much of a typed-on card is visible, in characters. */
export function revealCharsFor(lines: readonly string[], typeOn: number | null): number {
  if (typeOn === null) return Number.MAX_SAFE_INTEGER;
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  return Math.max(0, Math.min(total, Math.ceil(total * clamp01(typeOn))));
}

/** Slice wrapped lines down to a character budget, line by line. */
export function visibleLines(lines: readonly string[], revealChars: number): string[] {
  const out: string[] = [];
  let left = revealChars;
  for (const line of lines) {
    if (left <= 0) break;
    out.push(left >= line.length ? line : line.slice(0, left));
    left -= line.length;
  }
  return out;
}
