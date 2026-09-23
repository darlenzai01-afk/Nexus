import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createCanvas, pixelAt, type Canvas } from "./canvas.js";
import {
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  findFont,
  fontForWeight,
  loadFontFile,
  missingGlyphs,
  type FontSet,
} from "./font.js";
import { IDENTITY, compose, rotation, scaling, translation } from "./transform.js";
import {
  drawTextElement,
  drawTextRun,
  measureRun,
  runOrigin,
  type TextRun,
} from "./text-raster.js";
import { parseFont } from "./ttf.js";
import { parseSvg, drawSvg } from "./svg-shapes.js";
import type { TextElement } from "@nexus/render";

/** Pixels with any ink in them — a cheap way to ask "did anything draw?". */
/** Pixels with ink inside a rectangle — where the ink landed, not just that it did. */
function inkIn(
  canvas: Canvas,
  rect: { x: number; y: number; width: number; height: number },
): number {
  let count = 0;
  for (let y = rect.y; y < Math.min(canvas.height, rect.y + rect.height); y += 1) {
    for (let x = rect.x; x < Math.min(canvas.width, rect.x + rect.width); x += 1) {
      if (pixelAt(canvas, x, y)[3] >= 8) count += 1;
    }
  }
  return count;
}

function countInk(canvas: Canvas, alpha = 8): number {
  let count = 0;
  for (let index = 3; index < canvas.data.length; index += 4) {
    if ((canvas.data[index] ?? 0) >= alpha) count += 1;
  }
  return count;
}

/**
 * Fonts and text, from the bytes up.
 *
 * There is no font server, no browser and no shaping engine in this pipeline: the
 * TTF parser reads the tables straight out of the file, so "the text drew" means
 * *the outlines in the font file landed on the canvas*. These tests read a real
 * system face (DejaVu when present) and check the parts the pipeline depends on —
 * metrics, advances, glyph lookup, missing-glyph honesty — plus the layout rules
 * Phase 9's SVG writer and this rasteriser must agree on.
 */

const REGULAR_FILE = findFont(DEFAULT_FONT_CANDIDATES);
const BOLD_FILE = findFont(DEFAULT_BOLD_FONT_CANDIDATES);

function load(): FontSet | undefined {
  if (REGULAR_FILE === undefined || !existsSync(REGULAR_FILE)) return undefined;
  const regular = loadFontFile(REGULAR_FILE);
  if (BOLD_FILE === undefined || !existsSync(BOLD_FILE)) return { regular };
  return { regular, bold: loadFontFile(BOLD_FILE) };
}

const fonts = load();
const hasFont = fonts !== undefined;
if (!hasFont) {
  console.warn(
    `[text raster] skipping the font tests: no TrueType face found in ${DEFAULT_FONT_CANDIDATES.join(", ")}`,
  );
}

describe("parseFont", () => {
  it("refuses anything that is not a TrueType face", () => {
    expect(() => parseFont(new Uint8Array(64))).toThrow(/not a TrueType font/u);
    const collection = new Uint8Array(64);
    new DataView(collection.buffer).setUint32(0, 0x74746366);
    expect(() => parseFont(collection)).toThrow(/collections are not supported/u);
  });

  it.skipIf(!hasFont)("reads a real face's metrics and glyphs", () => {
    const font = fonts!.regular.font;
    expect(font.metrics.unitsPerEm).toBeGreaterThan(0);
    expect(font.metrics.numGlyphs).toBeGreaterThan(100);
    expect(font.metrics.ascender).toBeGreaterThan(0);
    expect(font.metrics.descender).toBeLessThanOrEqual(0);

    const a = font.glyphIndex("A".codePointAt(0)!);
    expect(a).not.toBe(0);
    expect(font.advanceWidth(a)).toBeGreaterThan(0);
    expect(font.contours(a).length).toBeGreaterThan(0);
    // Unmapped code points are `.notdef` (glyph 0), and a space has no outline.
    expect(font.glyphIndex(0x10ffff)).toBe(0);
    expect(font.contours(font.glyphIndex(32)).length).toBe(0);
  });

  it.skipIf(!hasFont)("hashes the file it loaded, so a font change is a different render", () => {
    expect(fonts!.regular.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(fonts!.regular.bytes).toBeGreaterThan(10_000);
    if (fonts!.bold !== undefined) expect(fonts!.bold.hash).not.toBe(fonts!.regular.hash);
  });
});

describe("missingGlyphs", () => {
  it.skipIf(!hasFont)("reports the characters a face cannot draw, and only those", () => {
    expect(missingGlyphs(fonts!, "The Kira bridge crosses daily.")).toEqual([]);
    // A CJK ideograph is not in DejaVu, and pretending otherwise would put a box
    // on screen; the caller decides what to do about it.
    expect(missingGlyphs(fonts!, "通")).toEqual(["通"]);
  });
});

describe("fontForWeight", () => {
  it.skipIf(!hasFont)("prefers the bold face for bold weights", () => {
    if (fonts!.bold === undefined) {
      // Synthetic emboldening is the fallback, and it is still the regular face.
      expect(fontForWeight(fonts!, 700).hash).toBe(fonts!.regular.hash);
      return;
    }
    expect(fontForWeight(fonts!, 400).hash).toBe(fonts!.regular.hash);
    expect(fontForWeight(fonts!, 700).hash).toBe(fonts!.bold!.hash);
  });
});

describe("measureRun and runOrigin", () => {
  it.skipIf(!hasFont)("measures deterministically and proportionally", () => {
    const run: TextRun = {
      text: "Traffic",
      x: 0,
      baselineY: 0,
      fontSizePx: 40,
      weight: 700,
      italic: false,
      anchor: "start",
      colour: "#ffffff",
    };
    const width = measureRun(fonts!, run);
    expect(width).toBeGreaterThan(0);
    expect(measureRun(fonts!, run)).toBe(width);
    expect(measureRun(fonts!, { ...run, text: "TrafficTraffic" })).toBeGreaterThan(width);
    // Twice the size is twice the advance (a linear scale, exactly).
    expect(measureRun(fonts!, { ...run, fontSizePx: 80 })).toBeCloseTo(width * 2, 6);
    expect(measureRun(fonts!, { ...run, text: "" })).toBe(0);
  });

  it.skipIf(!hasFont)("centres a middle-anchored run on its x", () => {
    const base: TextRun = {
      text: "Centred",
      x: 100,
      baselineY: 50,
      fontSizePx: 24,
      weight: 400,
      italic: false,
      anchor: "middle",
      colour: "#ffffff",
    };
    expect(runOrigin(fonts!, base)).toBeCloseTo(100 - measureRun(fonts!, base) / 2, 6);
    expect(runOrigin(fonts!, { ...base, anchor: "start" })).toBe(100);
  });
});

describe("drawTextRun", () => {
  const base: TextRun = {
    text: "Kira",
    x: 4,
    baselineY: 30,
    fontSizePx: 24,
    weight: 400,
    italic: false,
    anchor: "start",
    colour: "#ffffff",
  };

  it.skipIf(!hasFont)("puts the glyph outlines on the canvas", () => {
    const canvas = createCanvas(120, 40);
    expect(drawTextRun(canvas, base, { fonts: fonts!, matrix: IDENTITY })).toBeGreaterThan(0);
    expect(countInk(canvas)).toBeGreaterThan(20);
    // Nothing outside the run's own box, and nothing above the ascender.
    expect(pixelAt(canvas, 118, 20)[3]).toBe(0);
    expect(pixelAt(canvas, 6, 1)[3]).toBe(0);
  });

  it.skipIf(!hasFont)("draws nothing for empty text or zero alpha", () => {
    const empty = createCanvas(60, 40);
    expect(drawTextRun(empty, { ...base, text: "" }, { fonts: fonts!, matrix: IDENTITY })).toBe(0);
    expect(countInk(empty)).toBe(0);
    const transparent = createCanvas(60, 40);
    expect(
      drawTextRun(transparent, { ...base, alpha: 0 }, { fonts: fonts!, matrix: IDENTITY }),
    ).toBe(0);
    expect(countInk(transparent)).toBe(0);
  });

  it.skipIf(!hasFont)("scales and moves with the matrix, like every other element", () => {
    const small = createCanvas(240, 120);
    drawTextRun(small, base, { fonts: fonts!, matrix: IDENTITY });
    const big = createCanvas(240, 120);
    drawTextRun(big, base, { fonts: fonts!, matrix: scaling(2, 2) });
    expect(countInk(big)).toBeGreaterThan(countInk(small) * 2);

    const moved = createCanvas(240, 120);
    drawTextRun(moved, base, { fonts: fonts!, matrix: translation(60, 40) });
    expect(countInk(moved)).toBe(countInk(small));
    // The same glyphs, sixty pixels right and forty down.
    expect(inkIn(moved, { x: 62, y: 36, width: 76, height: 40 })).toBe(countInk(small));
    expect(inkIn(moved, { x: 2, y: 8, width: 56, height: 28 })).toBe(0);

    // A rotation keeps the ink, and puts it somewhere else.
    const turned = createCanvas(120, 120);
    drawTextRun(turned, base, {
      fonts: fonts!,
      // A quarter turn about the middle of the canvas: the run ends up running
      // down the page, still on screen.
      matrix: compose(compose(translation(60, 60), rotation(90)), translation(-60, -60)),
    });
    expect(countInk(turned)).toBeGreaterThan(0);
  });

  it.skipIf(!hasFont)("clips text to the frame it was given", () => {
    const canvas = createCanvas(120, 40);
    const unclipped = countInk(canvas);
    void unclipped;
    const clipped = createCanvas(120, 40);
    drawTextRun(
      clipped,
      { ...base, text: "Kira bridge crossing" },
      {
        fonts: fonts!,
        matrix: IDENTITY,
        clip: { x: 0, y: 0, width: 20, height: 40 },
      },
    );
    expect(countInk(clipped)).toBeGreaterThan(0);
    expect(pixelAt(clipped, 30, 25)[3]).toBe(0);
  });
});

describe("drawTextElement", () => {
  const element = (overrides: Partial<TextElement> = {}): TextElement => ({
    kind: "text",
    id: "txt_fixture",
    z: 10,
    textKind: "title",
    value: "The Kira bridge carries forty thousand",
    lines: ["The Kira bridge", "carries forty thousand"],
    revealChars: 1_000,
    attribution: "",
    highlight: 0,
    rect: { x: 0, y: 0, width: 300, height: 100 },
    style: {
      fontSizePx: 24,
      weight: 700,
      italic: false,
      align: "center",
      colour: "#ffffff",
    },
    opacity: 1,
    reveal: { mode: "none", amount: 1 },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, origin: { x: 0.5, y: 0.5 } },
    ...overrides,
  });

  it.skipIf(!hasFont)("lays the lines out inside the box and says where they went", () => {
    const canvas = createCanvas(300, 120);
    const drawn = drawTextElement(canvas, element(), { fonts: fonts!, matrix: IDENTITY });
    expect(drawn.lines).toHaveLength(2);
    expect(drawn.lineHeight).toBe(30);
    expect(drawn.firstBaselineY).toBeGreaterThan(0);
    expect(drawn.firstBaselineY).toBeLessThan(100);
    expect(countInk(canvas)).toBeGreaterThan(100);
  });

  it.skipIf(!hasFont)("reveals characters progressively, as the type-on does", () => {
    const partial = createCanvas(300, 120);
    drawTextElement(partial, element({ revealChars: 4 }), { fonts: fonts!, matrix: IDENTITY });
    const full = createCanvas(300, 120);
    drawTextElement(full, element(), { fonts: fonts!, matrix: IDENTITY });
    expect(countInk(partial)).toBeGreaterThan(0);
    expect(countInk(partial)).toBeLessThan(countInk(full));
    // The reveal is per character, so a shorter reveal never adds a line.
    const drawn = drawTextElement(partial, element({ revealChars: 4 }), {
      fonts: fonts!,
      matrix: IDENTITY,
    });
    expect(drawn.lines[0]?.length).toBeLessThan(18);
  });

  it.skipIf(!hasFont)("draws a highlight band behind the box when the scene asked for one", () => {
    const plain = createCanvas(300, 120);
    drawTextElement(plain, element(), { fonts: fonts!, matrix: IDENTITY });
    const banded = createCanvas(300, 120);
    drawTextElement(banded, element({ highlight: 1 }), { fonts: fonts!, matrix: IDENTITY });
    expect(countInk(banded)).toBeGreaterThan(countInk(plain));
  });

  it.skipIf(!hasFont)("draws an attribution line below the caption", () => {
    const canvas = createCanvas(300, 120);
    const drawn = drawTextElement(canvas, element({ attribution: "Nexus research" }), {
      fonts: fonts!,
      matrix: IDENTITY,
    });
    expect(drawn.lines).toContain("Nexus research");
  });
});

describe("drawSvg", () => {
  it("draws the shapes of a small SVG document", () => {
    const svg = `<svg viewBox="0 0 100 50" width="100" height="50">
      <rect x="5" y="5" width="30" height="20" fill="#e0a33c"/>
      <circle cx="60" cy="20" r="10" fill="#f6f4ee"/>
      <path d="M5 40 L40 45 L20 48 Z" fill="#9fb0bd" stroke="#12161c" stroke-width="1"/>
    </svg>`;
    const canvas = createCanvas(100, 50);
    const parsed = parseSvg(svg);
    expect(parsed.shapes.length).toBeGreaterThanOrEqual(3);
    drawSvg(canvas, parsed, { matrix: IDENTITY });
    expect(countInk(canvas)).toBeGreaterThan(200);
    // Deterministic: the same document draws the same bytes.
    const again = createCanvas(100, 50);
    drawSvg(again, parseSvg(svg), { matrix: IDENTITY });
    expect(Array.from(again.data)).toEqual(Array.from(canvas.data));
  });

  it("accepts a document with nothing drawable in it, and refuses one with no size", () => {
    expect(parseSvg('<svg viewBox="0 0 10 10"></svg>').shapes).toHaveLength(0);
    // A document with no size cannot be placed, so it is an error rather than a
    // guess: guessing here would put a layer in the wrong place on screen.
    expect(() => parseSvg("<svg></svg>")).toThrow(/width/u);
  });
});
