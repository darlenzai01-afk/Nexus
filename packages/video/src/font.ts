import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { sha256 } from "@nexus/storage";

import { parseFont, type Font } from "./ttf.js";

/**
 * Font loading and discovery.
 *
 * The pipeline draws text itself, so it needs a real font file and it has to be
 * honest about which one: the file's path, its sha256 and its glyph count go into
 * the render metadata, because "the same words in the same box" only means the
 * same picture when the font is pinned too (AD-12's spirit: name what you used).
 *
 * A missing font is not fatal — a frame without text is still a frame — but it is
 * reported (`font_missing`), so a video never silently loses its captions.
 */

export interface LoadedFont {
  /** Human-readable identity: the file's base name, or a caller-supplied name. */
  readonly name: string;
  /** Path on disk, when it came from a file. */
  readonly file?: string | undefined;
  /** sha256 of the font bytes: the identity that goes into the metadata. */
  readonly hash: string;
  readonly bytes: number;
  readonly font: Font;
}

/** The font files the pipeline looks for when nothing is configured. */
export const DEFAULT_FONT_CANDIDATES: readonly string[] = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/Library/Fonts/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
];

export const DEFAULT_BOLD_FONT_CANDIDATES: readonly string[] = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
];

/** The first candidate that exists, or `undefined` when none does. */
export function findFont(
  candidates: readonly string[] = DEFAULT_FONT_CANDIDATES,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== "" && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadFontFile(file: string): LoadedFont {
  if (!existsSync(file)) throw new TypeError(`no font file at ${file}`);
  const bytes = new Uint8Array(readFileSync(file));
  return {
    name: path.basename(file),
    file,
    hash: sha256(bytes),
    bytes: bytes.byteLength,
    font: parseFont(bytes),
  };
}

export interface FontSet {
  readonly regular: LoadedFont;
  /** Used for weights ≥ 600 when available; otherwise the regular face is emboldened. */
  readonly bold?: LoadedFont | undefined;
}

/** Weight at which the bold face (or the synthetic emboldening) kicks in. */
export const BOLD_WEIGHT = 600;

export function fontForWeight(fonts: FontSet, weight: number): LoadedFont {
  return weight >= BOLD_WEIGHT && fonts.bold !== undefined ? fonts.bold : fonts.regular;
}

/** Whether the glyphs for these words exist in the font (missing ones draw as boxes). */
export function missingGlyphs(fonts: FontSet, text: string): string[] {
  const missing: string[] = [];
  for (const character of text) {
    if (character === "\n" || character === " ") continue;
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (fonts.regular.font.glyphIndex(code) === 0 && !missing.includes(character)) {
      missing.push(character);
    }
  }
  return missing;
}
