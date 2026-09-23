/**
 * The pixel surface and the rasteriser.
 *
 * Everything a frame is drawn with ends up here: paths, rectangles, ellipses,
 * strokes, gradients, clipping and compositing. Two properties matter more than
 * speed or beauty:
 *
 * - **Determinism.** The same geometry and colour produce the same bytes on any
 *   machine. Anti-aliasing is a fixed 4×4 sub-scanline coverage calculation, not
 *   a floating-point sampling heuristic, and nothing depends on wall-clock time,
 *   iteration order of a `Map`, or a random number.
 * - **One rasteriser.** Every shape in a frame — a character layer's path, a
 *   diagram's bar, a caption's glyph, a reveal clip — is filled by the same
 *   scanline coverage code, so "partially visible" means the same thing
 *   everywhere.
 *
 * Colours are straight (non-premultiplied) RGBA; `blend` does source-over.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1. */
  readonly a: number;
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, `(y * width + x) * 4`. */
  readonly data: Uint8ClampedArray;
}

/** Sub-scanlines per pixel row: the anti-aliasing quality knob. */
export const SUB_SCANLINES = 4;

export function createCanvas(width: number, height: number): Canvas {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`canvas size must be positive integers, got ${width}x${height}`);
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

const NAMED: Readonly<Record<string, string>> = {
  black: "#000000",
  white: "#ffffff",
  none: "#00000000",
  transparent: "#00000000",
};

/**
 * Parse the colour forms this pipeline emits: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb(...)`, `rgba(...)` and a few names. An unknown value is a
 * hard error, because silently painting black would put the wrong picture in the
 * artifact and nothing downstream could tell.
 */
export function parseColour(value: string): Colour {
  const raw = value.trim().toLowerCase();
  const named = NAMED[raw];
  const text = named ?? raw;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = hex[0];
      const g = hex[1];
      const b = hex[2];
      const a = hex.length === 4 ? hex[3] : undefined;
      if (r === undefined || g === undefined || b === undefined) breakColour(value);
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16),
        a: a === undefined ? 1 : parseInt(a + a, 16) / 255,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].some((channel) => Number.isNaN(channel))) breakColour(value);
      return { r, g, b, a };
    }
    breakColour(value);
  }
  const functional = /^rgba?\(([^)]+)\)$/u.exec(text);
  if (functional !== null) {
    const parts = (functional[1] ?? "")
      .split(/[,\s/]+/u)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const [r, g, b, a] = parts;
    if (r === undefined || g === undefined || b === undefined) breakColour(value);
    return {
      r: clampChannel(Number(r)),
      g: clampChannel(Number(g)),
      b: clampChannel(Number(b)),
      a: a === undefined ? 1 : clamp01(Number(a)),
    };
  }
  breakColour(value);
}

function breakColour(value: string): never {
  throw new TypeError(`unsupported colour ${JSON.stringify(value)}`);
}

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError(`unsupported colour channel ${value}`);
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Source-over blend of one pixel. `coverage` is the rasteriser's own 0–1. */
export function blendPixel(
  canvas: Canvas,
  x: number,
  y: number,
  colour: Colour,
  coverage: number,
): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const alpha = colour.a * coverage;
  if (alpha <= 0) return;
  const index = (y * canvas.width + x) * 4;
  const data = canvas.data;
  if (alpha >= 1) {
    data[index] = colour.r;
    data[index + 1] = colour.g;
    data[index + 2] = colour.b;
    data[index + 3] = 255;
    return;
  }
  const inverse = 1 - alpha;
  const existing = (data[index + 3] ?? 0) / 255;
  const outAlpha = alpha + existing * inverse;
  if (outAlpha <= 0) return;
  const mix = (source: number, destination: number): number =>
    (source * alpha + destination * existing * inverse) / outAlpha;
  data[index] = mix(colour.r, data[index] ?? 0);
  data[index + 1] = mix(colour.g, data[index + 1] ?? 0);
  data[index + 2] = mix(colour.b, data[index + 2] ?? 0);
  data[index + 3] = outAlpha * 255;
}

export function pixelAt(
  canvas: Canvas,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
    throw new RangeError(`pixel ${x},${y} is outside the ${canvas.width}x${canvas.height} canvas`);
  }
  const index = (y * canvas.width + x) * 4;
  return [
    canvas.data[index] ?? 0,
    canvas.data[index + 1] ?? 0,
    canvas.data[index + 2] ?? 0,
    canvas.data[index + 3] ?? 0,
  ];
}

/** A `coverage * width` accumulator, reused between rows so filling stays linear. */
class CoverageBuffer {
  private readonly values: Float32Array;
  private dirtyFrom = Number.POSITIVE_INFINITY;
  private dirtyTo = Number.NEGATIVE_INFINITY;

  constructor(width: number) {
    this.values = new Float32Array(width);
  }

  add(x: number, amount: number): void {
    if (x < 0 || x >= this.values.length || amount === 0) return;
    this.values[x] = (this.values[x] ?? 0) + amount;
    if (x < this.dirtyFrom) this.dirtyFrom = x;
    if (x > this.dirtyTo) this.dirtyTo = x;
  }

  forEach(visit: (x: number, value: number) => void): void {
    if (this.dirtyTo < this.dirtyFrom) return;
    for (let x = this.dirtyFrom; x <= this.dirtyTo; x += 1) {
      const value = this.values[x] ?? 0;
      if (value !== 0) visit(x, value);
    }
  }

  reset(): void {
    if (this.dirtyTo < this.dirtyFrom) return;
    this.values.fill(0, this.dirtyFrom, this.dirtyTo + 1);
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.dirtyTo = Number.NEGATIVE_INFINITY;
  }
}

interface Edge {
  readonly yMin: number;
  readonly yMax: number;
  readonly x: number;
  readonly slope: number;
  /** +1 or −1: which way the edge crosses a scanline (winding). */
  readonly direction: number;
}

interface ActiveEdge {
  readonly edge: Edge;
  /** Last sub-scanline position this edge was advanced to. */
  x: number;
  y: number;
}

interface Crossing {
  readonly x: number;
  readonly direction: number;
}

interface EdgeList {
  readonly edges: Edge[];
  readonly yMin: number;
  readonly yMax: number;
  /** True once the list is known to be sorted by `yMin`. */
  sorted: boolean;
}

function edgesOf(polygons: readonly (readonly Point[])[]): EdgeList {
  const edges: Edge[] = [];
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  let sorted = true;
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const from = polygon[index];
      const to = polygon[(index + 1) % polygon.length];
      if (from === undefined || to === undefined) continue;
      if (from.y === to.y) continue; // horizontal edges never cross a scanline
      const upward = to.y < from.y;
      const edgeMin = upward ? to.y : from.y;
      if (edgeMin < yMin) yMin = edgeMin;
      const edgeMax = upward ? from.y : to.y;
      if (edgeMax > yMax) yMax = edgeMax;
      const previous = edges[edges.length - 1];
      if (previous !== undefined && previous.yMin > edgeMin) sorted = false;
      edges.push({
        yMin: edgeMin,
        yMax: edgeMax,
        x: upward ? to.x : from.x,
        slope: (to.x - from.x) / (to.y - from.y),
        direction: upward ? 1 : -1,
      });
    }
  }
  return { edges, yMin, yMax, sorted };
}

/**
 * Fill a path (one or more closed subpaths) with anti-aliasing.
 *
 * Coverage is computed on `SUB_SCANLINES` sub-scanlines per pixel row and
 * accumulated per column, so a partially covered edge pixel is blended exactly
 * once. Subpaths are wound together (`nonzero`), which is what makes a stroke
 * built from overlapping capsules paint a clean union instead of darkening its
 * own joints.
 */
export function fillPath(
  canvas: Canvas,
  polygons: readonly (readonly Point[])[],
  colour: Colour,
  options: { readonly alpha?: number; readonly clip?: Rect | undefined } = {},
): void {
  const alpha = clamp01(options.alpha ?? 1);
  if (alpha <= 0 || colour.a <= 0) return;
  const { edges, sorted } = edgesOf(polygons);
  if (edges.length === 0) return;

  const clip = clampClip(options.clip, canvas);
  if (clip === undefined) return;

  // The edges are sorted by their first row and kept in an *active list* that only
  // holds the ones a given row can actually cross. Rebuilding the full edge test
  // per scanline is what makes a naive scanline filler quadratic; walking a list of
  // a handful of active edges is what makes a frame cheap enough to render.
  const ordered = sorted ? edges : edges.slice().sort((left, right) => left.yMin - right.yMin);
  let nextEdge = 0;

  let yMin = Math.max(0, Math.floor(edges[0] === undefined ? 0 : minimumOf(edges)));
  let yMax = Math.min(canvas.height, Math.ceil(maximumOf(edges)));
  yMin = Math.max(yMin, Math.floor(clip.y));
  yMax = Math.min(yMax, Math.ceil(clip.y + clip.height));
  if (yMin >= yMax) return;

  const xMin = Math.floor(clip.x);
  const xMax = Math.ceil(clip.x + clip.width);
  const coverage = new CoverageBuffer(canvas.width);
  const crossings: Crossing[] = [];
  const step = 1 / SUB_SCANLINES;
  const weight = 1 / SUB_SCANLINES;
  const active: ActiveEdge[] = [];

  for (let y = yMin; y < yMax; y += 1) {
    const rowTop = y;
    const rowBottom = y + 1;
    while (nextEdge < ordered.length) {
      const edge = ordered[nextEdge];
      if (edge === undefined || edge.yMin >= rowBottom) break;
      active.push({ edge, x: edge.x, y: edge.yMin });
      nextEdge += 1;
    }
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const entry = active[index];
      if (entry !== undefined && entry.edge.yMax <= rowTop) active.splice(index, 1);
    }
    if (active.length < 2) continue;

    for (let sub = 0; sub < SUB_SCANLINES; sub += 1) {
      const scanY = y + (sub + 0.5) * step;
      crossings.length = 0;
      for (const entry of active) {
        if (scanY < entry.edge.yMin || scanY >= entry.edge.yMax) continue;
        entry.x = entry.edge.x + (scanY - entry.edge.yMin) * entry.edge.slope;
        entry.y = scanY;
        crossings.push({ x: entry.x, direction: entry.edge.direction });
      }
      if (crossings.length < 2) continue;
      crossings.sort((left, right) => left.x - right.x);

      let winding = 0;
      let spanStart = 0;
      let inside = false;
      for (const crossing of crossings) {
        const wasInside = inside;
        winding += crossing.direction;
        inside = winding !== 0;
        if (!wasInside && inside) {
          spanStart = crossing.x;
        } else if (wasInside && !inside) {
          addSpan(coverage, spanStart, crossing.x, xMin, xMax, weight);
        }
      }
    }

    coverage.forEach((x, value) => {
      blendPixel(canvas, x, y, colour, Math.min(1, value) * alpha);
    });
    coverage.reset();
  }
}

function minimumOf(edges: readonly Edge[]): number {
  let value = Number.POSITIVE_INFINITY;
  for (const edge of edges) if (edge.yMin < value) value = edge.yMin;
  return value;
}

function maximumOf(edges: readonly Edge[]): number {
  let value = Number.NEGATIVE_INFINITY;
  for (const edge of edges) if (edge.yMax > value) value = edge.yMax;
  return value;
}

/** Add one horizontal span to the row's coverage, splitting partial end pixels. */
function addSpan(
  coverage: CoverageBuffer,
  start: number,
  end: number,
  xMin: number,
  xMax: number,
  weight: number,
): void {
  const from = Math.max(start, xMin);
  const to = Math.min(end, xMax);
  if (to <= from) return;
  if (to - from < 1e-9) return;
  const firstFull = Math.ceil(from);
  const lastFull = Math.floor(to);
  if (firstFull > lastFull) {
    coverage.add(Math.floor(from), (to - from) * weight);
    return;
  }
  coverage.add(Math.floor(from), (firstFull - from) * weight);
  for (let x = firstFull; x < lastFull; x += 1) coverage.add(x, weight);
  coverage.add(lastFull, (to - lastFull) * weight);
}

export function clampClip(clip: Rect | undefined, canvas: Canvas): Rect | undefined {
  const rect = clip ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(canvas.width, rect.x + rect.width);
  const bottom = Math.min(canvas.height, rect.y + rect.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/** A closed polygon approximating an ellipse, flattened to a fixed chord error. */
export function ellipsePolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  options: { readonly startDeg?: number; readonly endDeg?: number } = {},
): Point[] {
  const start = ((options.startDeg ?? 0) * Math.PI) / 180;
  const end = ((options.endDeg ?? 360) * Math.PI) / 180;
  const radius = Math.max(Math.abs(rx), Math.abs(ry), 1);
  const segments = Math.max(12, Math.min(128, Math.ceil(radius * 1.5)));
  const points: Point[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = start + ((end - start) * index) / segments;
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return points;
}

export function fillEllipse(
  canvas: Canvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  colour: Colour,
  options: { readonly alpha?: number; readonly clip?: Rect | undefined } = {},
): void {
  fillPath(canvas, [ellipsePolygon(cx, cy, rx, ry)], colour, options);
}

export function fillRect(
  canvas: Canvas,
  rect: Rect,
  colour: Colour,
  options: {
    readonly alpha?: number;
    readonly clip?: Rect | undefined;
    readonly radius?: number;
  } = {},
): void {
  const radius = Math.max(0, Math.min(options.radius ?? 0, rect.width / 2, rect.height / 2));
  if (radius <= 0) {
    blendRegion(canvas, rect, colour, options.alpha ?? 1, options.clip);
    return;
  }
  const { x, y, width, height } = rect;
  fillPath(
    canvas,
    [
      [
        { x: x + radius, y },
        { x: x + width - radius, y },
        ...arcPoints(x + width - radius, y + radius, radius, -90, 0),
        { x: x + width, y: y + height - radius },
        ...arcPoints(x + width - radius, y + height - radius, radius, 0, 90),
        { x: x + radius, y: y + height },
        ...arcPoints(x + radius, y + height - radius, radius, 90, 180),
        { x, y: y + radius },
        ...arcPoints(x + radius, y + radius, radius, 180, 270),
      ],
    ],
    colour,
    options,
  );
}

function arcPoints(
  cx: number,
  cy: number,
  radius: number,
  fromDeg: number,
  toDeg: number,
  limit?: number,
): Point[] {
  const segments = limit ?? Math.max(4, Math.ceil((radius * Math.PI * 2) / 4));
  const points: Point[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = ((fromDeg + ((toDeg - fromDeg) * index) / segments) * Math.PI) / 180;
    points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return points;
}

/** Axis-aligned fill for rectangles: no coverage maths needed, so it is exact. */
function blendRegion(
  canvas: Canvas,
  rect: Rect,
  colour: Colour,
  alpha: number,
  clip: Rect | undefined,
): void {
  const region = clampClip(
    {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    canvas,
  );
  const outer = clampClip(clip, canvas);
  if (region === undefined || outer === undefined) return;
  const x0 = Math.max(region.x, outer.x);
  const y0 = Math.max(region.y, outer.y);
  const x1 = Math.min(region.x + region.width, outer.x + outer.width);
  const y1 = Math.min(region.y + region.height, outer.y + outer.height);
  if (alpha >= 1) {
    // The common case is a full-frame fill: write the bytes directly instead of
    // calling the blend path a quarter of a million times.
    for (let y = y0; y < y1; y += 1) {
      let index = (y * canvas.width + x0) * 4;
      for (let x = x0; x < x1; x += 1) {
        canvas.data[index] = colour.r;
        canvas.data[index + 1] = colour.g;
        canvas.data[index + 2] = colour.b;
        canvas.data[index + 3] = 255;
        index += 4;
      }
    }
    return;
  }
  const inverse = 1 - alpha;
  for (let y = y0; y < y1; y += 1) {
    let index = (y * canvas.width + x0) * 4;
    for (let x = x0; x < x1; x += 1) {
      const existing = (canvas.data[index + 3] ?? 0) / 255;
      canvas.data[index] = colour.r * alpha + (canvas.data[index] ?? 0) * inverse;
      canvas.data[index + 1] = colour.g * alpha + (canvas.data[index + 1] ?? 0) * inverse;
      canvas.data[index + 2] = colour.b * alpha + (canvas.data[index + 2] ?? 0) * inverse;
      canvas.data[index + 3] = (alpha + existing * inverse) * 255;
      index += 4;
    }
  }
}

/**
 * Stroke a polyline with round caps and joins.
 *
 * The stroke is built as the union of one capsule per flattened segment, filled
 * as a single nonzero path. That is exact for the geometry this pipeline draws
 * (poses, limbs, ground rules) and it cannot leave the seams a per-segment disc
 * stamp would.
 */
export function strokePolyline(
  canvas: Canvas,
  points: readonly Point[],
  colour: Colour,
  width: number,
  options: { readonly alpha?: number; readonly clip?: Rect | undefined } = {},
): void {
  const radius = Math.max(width, 0) / 2;
  if (radius <= 0 || points.length < 2) return;
  // Capsules, one per segment, filled as a single nonzero path. The polyline is
  // first thinned so that no two capsules land closer than a fraction of their own
  // radius: the silhouette is identical to within the anti-aliasing, and a curve
  // flattened into sixteen points does not become sixteen fills.
  const spaced = thinPolyline(points, Math.max(0.35, radius * 0.75));
  const capsules: Point[][] = [];
  for (let index = 0; index < spaced.length - 1; index += 1) {
    const from = spaced[index];
    const to = spaced[index + 1];
    if (from === undefined || to === undefined) continue;
    capsules.push(capsule(from, to, radius));
  }
  fillPath(canvas, capsules, colour, options);
}

/** Keep the ends and every point at least `spacing` away from the one kept. */
export function thinPolyline(points: readonly Point[], spacing: number): Point[] {
  if (points.length < 3) return points.slice();
  const out: Point[] = [];
  let last = points[0];
  if (last === undefined) return [];
  out.push(last);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (point === undefined || last === undefined) continue;
    if (Math.hypot(point.x - last.x, point.y - last.y) < spacing) continue;
    out.push(point);
    last = point;
  }
  const final = points[points.length - 1];
  if (final !== undefined) out.push(final);
  return out;
}

function capsule(from: Point, to: Point, radius: number): Point[] {
  const degrees = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  // The outline, in order: the near-side corner at `from`, the half-circle around
  // `to` (out past it and back), the far-side corner at `from`... which is to say
  // one rectangle's edge, one cap, the other edge, the other cap. Written this way
  // the polygon never crosses itself, which matters: the fill rule is nonzero, and
  // a bow-tie cancels to nothing.
  // Few segments per cap: neighbouring capsules overlap along the stroke, so the
  // joint is filled by the next capsule and the silhouette stays smooth anyway.
  const capSegments = Math.max(2, Math.min(12, Math.ceil(radius)));
  // Back cap: around `from`, sweeping the long way round (through the far side),
  // from one side of the ribbon to the other. Front cap: around `to`, bulging past
  // it. Both sweep *through* the outward direction, which is what makes the ends
  // round instead of clipping the ribbon flat — and what keeps the outline simple.
  const tail = arcPoints(from.x, from.y, radius, degrees + 270, degrees + 90, capSegments);
  const head = arcPoints(to.x, to.y, radius, degrees + 90, degrees - 90, capSegments);
  return [...tail, ...head];
}

/** A two-stop vertical gradient over a rectangle (the frame's floor wash). */
export function fillLinearGradient(
  canvas: Canvas,
  rect: Rect,
  from: Colour,
  to: Colour,
  options: { readonly alpha?: number; readonly clip?: Rect | undefined } = {},
): void {
  const alpha = clamp01(options.alpha ?? 1);
  const region = clampClip(
    {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    canvas,
  );
  const outer = clampClip(options.clip, canvas);
  if (region === undefined || outer === undefined) return;
  const x0 = Math.max(region.x, outer.x);
  const y0 = Math.max(region.y, outer.y);
  const x1 = Math.min(region.x + region.width, outer.x + outer.width);
  const y1 = Math.min(region.y + region.height, outer.y + outer.height);
  const span = Math.max(1, region.height - 1);
  for (let y = y0; y < y1; y += 1) {
    const position = clamp01((y - region.y) / span);
    const r = from.r + (to.r - from.r) * position;
    const g = from.g + (to.g - from.g) * position;
    const b = from.b + (to.b - from.b) * position;
    const a = (from.a + (to.a - from.a) * position) * alpha;
    if (a <= 0) continue;
    let index = (y * canvas.width + x0) * 4;
    for (let x = x0; x < x1; x += 1) {
      const existing = (canvas.data[index + 3] ?? 0) / 255;
      const outAlpha = a + existing * (1 - a);
      if (outAlpha > 0) {
        const inverse = 1 - a;
        canvas.data[index] = (r * a + (canvas.data[index] ?? 0) * existing * inverse) / outAlpha;
        canvas.data[index + 1] =
          (g * a + (canvas.data[index + 1] ?? 0) * existing * inverse) / outAlpha;
        canvas.data[index + 2] =
          (b * a + (canvas.data[index + 2] ?? 0) * existing * inverse) / outAlpha;
        canvas.data[index + 3] = outAlpha * 255;
      }
      index += 4;
    }
  }
}

/** Copy another canvas over this one at an offset (character layers on a frame). */
export function drawCanvas(
  target: Canvas,
  source: Canvas,
  offset: Point,
  options: { readonly alpha?: number; readonly clip?: Rect | undefined } = {},
): void {
  const alpha = clamp01(options.alpha ?? 1);
  const outer = clampClip(options.clip, target);
  if (outer === undefined) return;
  const x0 = Math.max(outer.x, Math.floor(offset.x));
  const y0 = Math.max(outer.y, Math.floor(offset.y));
  const x1 = Math.min(outer.x + outer.width, Math.floor(offset.x) + source.width);
  const y1 = Math.min(outer.y + outer.height, Math.floor(offset.y) + source.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const sx = x - Math.floor(offset.x);
      const sy = y - Math.floor(offset.y);
      const index = (sy * source.width + sx) * 4;
      const a = (source.data[index + 3] ?? 0) / 255;
      if (a <= 0) continue;
      blendPixel(
        target,
        x,
        y,
        {
          r: source.data[index] ?? 0,
          g: source.data[index + 1] ?? 0,
          b: source.data[index + 2] ?? 0,
          a,
        },
        alpha,
      );
    }
  }
}

/** Every RGBA byte of a canvas, in row-major order — what the PNG encoder wants. */
export function canvasBytes(canvas: Canvas): Uint8Array {
  return new Uint8Array(canvas.data.buffer, canvas.data.byteOffset, canvas.data.byteLength);
}
