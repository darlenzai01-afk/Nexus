import {
  ellipsePolygon,
  fillPath,
  fillRect,
  parseColour,
  strokePolyline,
  type Canvas,
  type Colour,
  type Point,
  type Rect,
} from "./canvas.js";
import { parsePathData } from "./path.js";
import { IDENTITY, type Matrix } from "./transform.js";

/**
 * The SVG subset the character system's art is made of.
 *
 * Phase 8 ships flat, hand-generated layers: `<path>`, `<circle>`, `<ellipse>`,
 * `<rect>`, `<line>`, `<polyline>` with `fill`, `stroke`, `stroke-width`,
 * `stroke-linecap` and `opacity`. Nothing else — no gradients, no masks, no
 * nested groups, no text. That is a small enough vocabulary to rasterise exactly,
 * and small enough that an *unknown* element (a gradient a future asset might
 * add) can be a loud error rather than a silently missing limb.
 *
 * Geometry is transformed *before* it is filled, so every shape goes through the
 * same two primitives as the rest of the frame (`fillPath`, `strokePolyline`) and
 * "anti-aliased" means the same thing for a limb and for a caption glyph.
 * Strokes are drawn with round caps and joins, which is what the art asks for
 * (`stroke-linecap="round"` on every stroked shape).
 */

export interface SvgShape {
  readonly kind: "rect" | "circle" | "ellipse" | "path" | "line" | "polyline" | "polygon";
  readonly attributes: Readonly<Record<string, string>>;
}

export interface ParsedSvg {
  readonly width: number;
  readonly height: number;
  readonly shapes: readonly SvgShape[];
}

const SHAPE_TAGS = new Set(["rect", "circle", "ellipse", "path", "line", "polyline", "polygon"]);
const IGNORED_TAGS = new Set(["svg", "g", "defs", "title", "desc", "metadata", "style"]);
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/gu;

const SVG_CACHE = new Map<string, ParsedSvg>();

/**
 * Parse a layer document into its root size and its shapes. Parsed once per
 * distinct source: the same layers are drawn on every frame of a scene.
 */
export function parseSvg(source: string): ParsedSvg {
  const cached = SVG_CACHE.get(source);
  if (cached !== undefined) return cached;
  const parsed = parseSvgUncached(source);
  if (SVG_CACHE.size > 512) SVG_CACHE.clear();
  SVG_CACHE.set(source, parsed);
  return parsed;
}

function parseSvgUncached(source: string): ParsedSvg {
  const root = /<svg\b([^>]*)>/u.exec(source);
  if (root === null) throw new TypeError("SVG has no <svg> root");
  const rootAttributes = attributesOf(root[1] ?? "");
  const viewBox = (rootAttributes.viewBox ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  const width = Number(rootAttributes.width ?? viewBox[2] ?? 0);
  const height = Number(rootAttributes.height ?? viewBox[3] ?? 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError("SVG root has no usable width/height or viewBox");
  }

  const shapes: SvgShape[] = [];
  const element = /<([A-Za-z][-A-Za-z0-9]*)\b([^>]*?)\/?>/gu;
  for (const match of source.matchAll(element)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attributes = attributesOf(match[2] ?? "");
    if (SHAPE_TAGS.has(tag)) {
      shapes.push({ kind: tag as SvgShape["kind"], attributes });
      continue;
    }
    if (IGNORED_TAGS.has(tag)) continue;
    throw new TypeError(`SVG element <${tag}> is not part of the supported layer vocabulary`);
  }
  return { width, height, shapes };
}

export interface DrawSvgOptions {
  /** Layer → device transform; identity by default. */
  readonly matrix?: Matrix;
  /** Multiplied into every shape's own opacity. */
  readonly alpha?: number;
  readonly clip?: Rect | undefined;
}

/** Draw parsed shapes onto a canvas, through an optional transform and clip. */
export function drawSvg(canvas: Canvas, parsed: ParsedSvg, options: DrawSvgOptions = {}): number {
  const matrix = options.matrix ?? IDENTITY;
  let drawn = 0;
  for (const shape of parsed.shapes) {
    drawShape(canvas, shape, matrix, options);
    drawn += 1;
  }
  return drawn;
}

function drawShape(canvas: Canvas, shape: SvgShape, matrix: Matrix, options: DrawSvgOptions): void {
  const attributes = shape.attributes;
  const opacity = clamp01(Number(attributes.opacity ?? "1")) * (options.alpha ?? 1);
  if (opacity <= 0) return;
  const fill = colourOf(attributes.fill);
  const stroke = colourOf(attributes.stroke);
  const strokeWidth = Number(attributes["stroke-width"] ?? "0");
  const scale = scaleOf(matrix);
  const clip = options.clip;
  const toDevice = (point: Point): Point => ({
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  });

  switch (shape.kind) {
    case "rect": {
      const rect = transformRect(
        matrix,
        Number(attributes.x ?? "0"),
        Number(attributes.y ?? "0"),
        Number(attributes.width ?? "0"),
        Number(attributes.height ?? "0"),
      );
      if (fill !== undefined) {
        fillRect(canvas, rect, fill, {
          alpha: opacity,
          clip,
          radius: Number(attributes.rx ?? "0") * scale,
        });
      }
      if (stroke !== undefined && strokeWidth > 0) {
        strokePolyline(
          canvas,
          [
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.width, y: rect.y },
            { x: rect.x + rect.width, y: rect.y + rect.height },
            { x: rect.x, y: rect.y + rect.height },
            { x: rect.x, y: rect.y },
          ],
          stroke,
          strokeWidth * scale,
          { alpha: opacity, clip },
        );
      }
      return;
    }
    case "circle": {
      const radius = Number(attributes.r ?? "0");
      paint(
        canvas,
        ellipsePolygon(Number(attributes.cx ?? "0"), Number(attributes.cy ?? "0"), radius, radius),
        toDevice,
        { fill, stroke, strokeWidth: strokeWidth * scale, opacity, clip },
      );
      return;
    }
    case "ellipse": {
      const polygon = ellipsePolygon(
        Number(attributes.cx ?? "0"),
        Number(attributes.cy ?? "0"),
        Number(attributes.rx ?? "0"),
        Number(attributes.ry ?? "0"),
      );
      paint(canvas, polygon, toDevice, {
        fill,
        stroke,
        strokeWidth: strokeWidth * scale,
        opacity,
        clip,
      });
      return;
    }
    case "path": {
      const parsed = parsePathData(attributes.d ?? "");
      const closedSubpaths = parsed.subpaths.map((subpath) => subpath.map(toDevice));
      if (fill !== undefined && parsed.closed && closedSubpaths.length > 0) {
        fillPath(canvas, closedSubpaths, fill, { alpha: opacity, clip });
      }
      if (stroke !== undefined && strokeWidth > 0) {
        for (const subpath of closedSubpaths) {
          strokePolyline(canvas, subpath, stroke, strokeWidth * scale, { alpha: opacity, clip });
        }
      }
      return;
    }
    case "line": {
      if (stroke === undefined || strokeWidth <= 0) return;
      strokePolyline(
        canvas,
        [
          toDevice({ x: Number(attributes.x1 ?? "0"), y: Number(attributes.y1 ?? "0") }),
          toDevice({ x: Number(attributes.x2 ?? "0"), y: Number(attributes.y2 ?? "0") }),
        ],
        stroke,
        strokeWidth * scale,
        { alpha: opacity, clip },
      );
      return;
    }
    case "polyline":
    case "polygon": {
      const points = parsePoints(attributes.points ?? "").map(toDevice);
      if (points.length < 2) return;
      if (fill !== undefined && shape.kind === "polygon") {
        fillPath(canvas, [points], fill, { alpha: opacity, clip });
      }
      if (stroke !== undefined && strokeWidth > 0) {
        strokePolyline(canvas, points, stroke, strokeWidth * scale, { alpha: opacity, clip });
      }
      return;
    }
  }
}

function paint(
  canvas: Canvas,
  polygon: readonly Point[],
  toDevice: (point: Point) => Point,
  style: {
    readonly fill: Colour | undefined;
    readonly stroke: Colour | undefined;
    readonly strokeWidth: number;
    readonly opacity: number;
    readonly clip: Rect | undefined;
  },
): void {
  const device = polygon.map(toDevice);
  if (style.fill !== undefined) {
    fillPath(canvas, [device], style.fill, { alpha: style.opacity, clip: style.clip });
  }
  if (style.stroke !== undefined && style.strokeWidth > 0) {
    strokePolyline(canvas, device, style.stroke, style.strokeWidth, {
      alpha: style.opacity,
      clip: style.clip,
    });
  }
}

function transformRect(matrix: Matrix, x: number, y: number, width: number, height: number): Rect {
  const corners = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((point) => ({
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Uniform-ish scale factor: how much a stroke width has to grow. */
function scaleOf(matrix: Matrix): number {
  return Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) attributes[name] = value;
  }
  return attributes;
}

function parsePoints(value: string): Point[] {
  const numbers = value
    .trim()
    .split(/[\s,]+/u)
    .map(Number)
    .filter((number) => Number.isFinite(number));
  const points: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index] ?? 0, y: numbers[index + 1] ?? 0 });
  }
  return points;
}

function colourOf(value: string | undefined): Colour | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "" || text === "none" || text === "transparent") return undefined;
  return parseColour(text);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
