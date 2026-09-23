import { describe, expect, it } from "vitest";

import {
  createCanvas,
  fillEllipse,
  fillLinearGradient,
  fillPath,
  fillRect,
  parseColour,
  pixelAt,
  strokePolyline,
  thinPolyline,
} from "./canvas.js";
import { parsePathData } from "./path.js";
import { decodePng, encodePng, pngSize } from "./png.js";
import {
  IDENTITY,
  applyMatrix,
  compose,
  isIdentity,
  rotation,
  scaling,
  transformRect,
  translation,
} from "./transform.js";

/**
 * The pixel layer: the canvas, the paths, the transforms and the PNG codec.
 *
 * These are the primitives every drawn frame is built from, so the tests are
 * deliberately literal — a filled rectangle is red *there* and transparent
 * elsewhere; a PNG written and read back is the same pixels; a path is the
 * polyline the spec says it is.
 */

type Canvas = ReturnType<typeof createCanvas>;

function alphaAt(canvas: Canvas, x: number, y: number): number {
  return pixelAt(canvas, x, y)[3];
}

function rgbAt(canvas: Canvas, x: number, y: number): readonly number[] {
  return pixelAt(canvas, x, y).slice(0, 3);
}

describe("canvas", () => {
  it("starts transparent and fills an axis-aligned rectangle", () => {
    const canvas = createCanvas(10, 10);
    expect(alphaAt(canvas, 5, 5)).toBe(0);
    fillRect(canvas, { x: 2, y: 2, width: 4, height: 4 }, parseColour("#ff0000"));
    expect(alphaAt(canvas, 3, 3)).toBe(255);
    expect(rgbAt(canvas, 3, 3)).toEqual([255, 0, 0]);
    expect(alphaAt(canvas, 1, 1)).toBe(0);
    expect(alphaAt(canvas, 6, 6)).toBe(0);
  });

  it("honours alpha and rounded corners", () => {
    const canvas = createCanvas(20, 20);
    fillRect(canvas, { x: 0, y: 0, width: 20, height: 20 }, parseColour("#ffffff"), { alpha: 0.5 });
    expect(alphaAt(canvas, 10, 10)).toBeGreaterThan(120);
    expect(alphaAt(canvas, 10, 10)).toBeLessThan(136);

    const rounded = createCanvas(20, 20);
    fillRect(rounded, { x: 0, y: 0, width: 20, height: 20 }, parseColour("#ffffff"), { radius: 8 });
    expect(alphaAt(rounded, 1, 1)).toBe(0); // the corner is cut away
    expect(alphaAt(rounded, 10, 10)).toBe(255);
  });

  it("clips drawing to a rectangle", () => {
    const canvas = createCanvas(20, 20);
    fillRect(canvas, { x: 0, y: 0, width: 20, height: 20 }, parseColour("#00ff00"), {
      clip: { x: 0, y: 0, width: 10, height: 20 },
    });
    expect(alphaAt(canvas, 5, 10)).toBe(255);
    expect(alphaAt(canvas, 15, 10)).toBe(0);
  });

  it("fills a polygon with an even, antialiased edge", () => {
    const canvas = createCanvas(40, 40);
    fillPath(
      canvas,
      [
        [
          { x: 5, y: 5 },
          { x: 35, y: 5 },
          { x: 20, y: 35 },
        ],
      ],
      parseColour("#ffffff"),
    );
    expect(alphaAt(canvas, 20, 15)).toBe(255);
    expect(alphaAt(canvas, 2, 2)).toBe(0);
    // The slanted edge is neither fully in nor fully out at a boundary pixel.
    const edge = alphaAt(canvas, 12, 20);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it("fills an ellipse inside its own bounds only", () => {
    const canvas = createCanvas(40, 40);
    fillEllipse(canvas, 20, 20, 10, 5, parseColour("#0000ff"));
    expect(alphaAt(canvas, 20, 20)).toBe(255);
    expect(alphaAt(canvas, 20, 13)).toBe(0); // above the minor axis
    expect(alphaAt(canvas, 31, 20)).toBe(0); // past the major axis
  });

  it("ramps a linear gradient from one alpha to another", () => {
    const canvas = createCanvas(10, 100);
    fillLinearGradient(
      canvas,
      { x: 0, y: 0, width: 10, height: 100 },
      { r: 0, g: 0, b: 0, a: 0 },
      { r: 0, g: 0, b: 0, a: 0.8 },
    );
    const top = alphaAt(canvas, 5, 2);
    const bottom = alphaAt(canvas, 5, 98);
    expect(top).toBeLessThan(bottom);
    expect(top).toBeLessThan(40);
    expect(bottom).toBeGreaterThan(180);
  });

  it("strokes a polyline as a ribbon of the requested width", () => {
    const canvas = createCanvas(40, 40);
    strokePolyline(
      canvas,
      [
        { x: 5, y: 20 },
        { x: 35, y: 20 },
      ],
      parseColour("#ffffff"),
      6,
    );
    // Six pixels wide means three above and three below the line's own row.
    for (const y of [18, 19, 20, 21, 22]) expect(alphaAt(canvas, 20, y)).toBe(255);
    expect(alphaAt(canvas, 20, 16)).toBe(0);
    expect(alphaAt(canvas, 20, 24)).toBe(0);
    // A hairline keeps at least a hair of alpha rather than vanishing.
    const hairline = createCanvas(40, 40);
    strokePolyline(
      hairline,
      [
        { x: 5, y: 20 },
        { x: 35, y: 20 },
      ],
      parseColour("#ffffff"),
      0.5,
    );
    expect(alphaAt(hairline, 20, 20)).toBeGreaterThan(0);
    // And a stroke is not a fill: the middle of a bent polyline is inked, the
    // outside of the bend is not.
    const bent = createCanvas(40, 40);
    strokePolyline(
      bent,
      [
        { x: 10, y: 10 },
        { x: 10, y: 30 },
      ],
      parseColour("#ffffff"),
      4,
    );
    expect(alphaAt(bent, 10, 30)).toBe(255);
    expect(alphaAt(bent, 20, 20)).toBe(0);
  });

  it("accepts the colour notations the frame documents use", () => {
    expect(parseColour("#fff")).toMatchObject({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour("#e0a33c")).toMatchObject({ r: 224, g: 163, b: 60, a: 1 });
    expect(parseColour("rgba(10, 20, 30, 0.5)")).toMatchObject({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColour("none").a).toBe(0);
    expect(() => parseColour("mauve")).toThrow(TypeError);
  });

  it("exposes its bytes for encoding, with four channels per pixel", () => {
    const canvas = createCanvas(4, 4);
    expect(canvas.data).toHaveLength(4 * 4 * 4);
  });
});

describe("paths", () => {
  it("parses absolute commands into flattened polylines", () => {
    const path = parsePathData("M 10 10 L 30 10 L 30 30 Z");
    expect(path.subpaths).toHaveLength(1);
    expect(path.closed).toBe(true);
    expect(path.subpaths[0]?.[0]).toEqual({ x: 10, y: 10 });
    expect(path.subpaths[0]?.at(-1)).toEqual({ x: 10, y: 10 }); // closed
  });

  it("parses relative commands and curves", () => {
    const path = parsePathData("m 0 0 l 10 0 q 5 5 10 0 c 0 10 10 10 10 0 z");
    expect(path.subpaths).toHaveLength(1);
    const points = path.subpaths[0] ?? [];
    expect(points.length).toBeGreaterThan(20); // curves are flattened, not dropped
    expect(Math.min(...points.map((point) => point.y))).toBe(0);
  });

  it("reads the same path the same way twice (the cache is not a behaviour change)", () => {
    const first = parsePathData("M0 0 L 5 5");
    const second = parsePathData("M0 0 L 5 5");
    expect(second).toEqual(first);
  });

  it("refuses an elliptical arc instead of approximating it wrongly", () => {
    expect(() => parsePathData("M0 0 A 10 10 0 0 1 20 20")).toThrow(/not supported/u);
  });
});

describe("transforms", () => {
  it("applies translation, rotation and scale in matrix order", () => {
    const matrix = compose(translation(10, 20), scaling(2));
    expect(applyMatrix(matrix, { x: 3, y: 4 })).toEqual({ x: 16, y: 28 });
    expect(isIdentity(IDENTITY)).toBe(true);
    const rotated = compose(rotation(90), compose(translation(1, 0), scaling(1)));
    const point = applyMatrix(rotated, { x: 0, y: 0 });
    expect(point.x).toBeCloseTo(0, 6);
    expect(point.y).toBeCloseTo(1, 6);
  });

  it("bounds a transformed rectangle by its four corners", () => {
    const box = transformRect(rotation(45), { x: 0, y: 0, width: 10, height: 10 });
    expect(box.width).toBeGreaterThan(10);
    expect(box.height).toBeGreaterThan(10);
    expect(box.x).toBeLessThan(0);
  });
});

describe("png", () => {
  it("writes and reads back the same pixels", () => {
    const canvas = createCanvas(7, 5);
    fillRect(canvas, { x: 1, y: 1, width: 3, height: 2 }, parseColour("#3366ff"), { alpha: 0.75 });
    const bytes = encodePng(canvas);
    expect(pngSize(bytes)).toEqual({ width: 7, height: 5 });
    const decoded = decodePng(bytes);
    expect(decoded.width).toBe(7);
    expect(decoded.height).toBe(5);
    expect(Array.from(decoded.data)).toEqual(Array.from(canvas.data));
  });

  it("writes a deterministic file for a deterministic canvas", () => {
    const canvas = createCanvas(9, 9);
    fillEllipse(canvas, 4, 4, 3, 3, parseColour("#e0a33c"));
    expect(encodePng(canvas)).toEqual(encodePng(canvas));
  });

  it("refuses a file that is not a PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });
});

describe("thinPolyline", () => {
  it("keeps the endpoints and drops points closer than the spacing", () => {
    const points = thinPolyline(
      [
        { x: 0, y: 0 },
        { x: 0.1, y: 0 },
        { x: 0.2, y: 0 },
        { x: 5, y: 0 },
      ],
      1,
    );
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 5, y: 0 });
    expect(points.length).toBe(2);
  });
});
