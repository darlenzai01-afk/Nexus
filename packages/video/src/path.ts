import type { Point } from "./canvas.js";

/**
 * SVG path data, flattened to polylines.
 *
 * The pipeline has to turn a character layer's `<path d="…">` into pixels, so it
 * needs a path parser. This one supports exactly the vocabulary the character
 * system's art is generated with — `M L H V Q C S T Z`, absolute and relative —
 * and throws on anything else (`A`, the elliptical arc) rather than guessing a
 * shape. A silently wrong limb would be far worse than a loud error: the layer
 * it came from is hash-verified, so an unsupported command means the asset
 * vocabulary changed and somebody must look.
 *
 * Curves are flattened at a fixed subdivision count, which keeps the output
 * deterministic: the same `d` produces the same points on every machine.
 */

/** Curve flattening: segments per quadratic/cubic command. */
export const CURVE_SEGMENTS = 16;

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/gu;

export interface FlatPath {
  /** Closed or open subpaths, in the order they were written. */
  readonly subpaths: readonly (readonly Point[])[];
  /** True when the path ends with `Z` (a closed shape that can be filled). */
  readonly closed: boolean;
}

const PATH_CACHE = new Map<string, FlatPath>();
/** Path data is parsed once per distinct `d` — assets are drawn every frame. */
export function parsePathData(data: string): FlatPath {
  const cached = PATH_CACHE.get(data);
  if (cached !== undefined) return cached;
  const parsed = parsePathDataUncached(data);
  if (PATH_CACHE.size > 4096) PATH_CACHE.clear();
  PATH_CACHE.set(data, parsed);
  return parsed;
}

function parsePathDataUncached(data: string): FlatPath {
  const tokens = tokenize(data);
  const subpaths: Point[][] = [];
  let current: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let command = "";
  let closed = false;
  let index = 0;

  const push = (point: Point): void => {
    const last = current[current.length - 1];
    if (last !== undefined && last.x === point.x && last.y === point.y) return;
    current.push(point);
  };
  const flush = (): void => {
    if (current.length >= 2) subpaths.push(current);
    current = [];
  };
  const number = (): number => {
    const token = tokens[index];
    if (token === undefined || typeof token === "string") {
      throw new TypeError(`path data ends early in ${JSON.stringify(data)}`);
    }
    index += 1;
    return token;
  };
  const point = (): Point => ({ x: number(), y: number() });

  while (index < tokens.length) {
    const token = tokens[index];
    if (typeof token === "string") {
      command = token;
      index += 1;
    } else if (command === "") {
      throw new TypeError(`path data starts with a number in ${JSON.stringify(data)}`);
    } else if (command === "M") {
      command = "L";
    } else if (command === "m") {
      command = "l";
    }
    const relative = command === command.toLowerCase() && command !== "Z" && command !== "z";
    const upper = command.toUpperCase();
    const at = (p: Point): Point => (relative ? { x: cursor.x + p.x, y: cursor.y + p.y } : p);

    switch (upper) {
      case "M": {
        flush();
        const next = at(point());
        cursor = next;
        start = next;
        push(next);
        closed = false;
        break;
      }
      case "L": {
        const next = at(point());
        push(next);
        cursor = next;
        break;
      }
      case "H": {
        const x = number();
        const next = { x: relative ? cursor.x + x : x, y: cursor.y };
        push(next);
        cursor = next;
        break;
      }
      case "V": {
        const y = number();
        const next = { x: cursor.x, y: relative ? cursor.y + y : y };
        push(next);
        cursor = next;
        break;
      }
      case "C": {
        const control1 = at(point());
        const control2 = at(point());
        const end = at(point());
        flattenCubic(cursor, control1, control2, end).forEach(push);
        cursor = end;
        break;
      }
      case "S": {
        const control2 = at(point());
        const end = at(point());
        const last = current[current.length - 1] ?? cursor;
        const control1 = { x: 2 * cursor.x - last.x, y: 2 * cursor.y - last.y };
        flattenCubic(cursor, control1, control2, end).forEach(push);
        cursor = end;
        break;
      }
      case "Q": {
        const control = at(point());
        const end = at(point());
        flattenQuadratic(cursor, control, end).forEach(push);
        cursor = end;
        break;
      }
      case "T": {
        const end = at(point());
        const control = { x: 2 * cursor.x - cursor.x, y: 2 * cursor.y - cursor.y };
        flattenQuadratic(cursor, control, end).forEach(push);
        cursor = end;
        break;
      }
      case "Z": {
        if (current.length >= 2) {
          push(start);
          flush();
          closed = true;
        } else {
          flush();
        }
        cursor = start;
        break;
      }
      default:
        throw new TypeError(
          `path command ${upper} is not supported by this rasteriser (${JSON.stringify(data.slice(0, 80))})`,
        );
    }
  }
  flush();
  return { subpaths, closed };
}

type Token = string | number;

function tokenize(data: string): Token[] {
  const tokens: Token[] = [];
  const matched = data.matchAll(TOKEN);
  for (const match of matched) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(Number(match[2]));
  }
  return tokens;
}

export function flattenQuadratic(from: Point, control: Point, to: Point): Point[] {
  const points: Point[] = [];
  for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
    const t = step / CURVE_SEGMENTS;
    const inverse = 1 - t;
    points.push({
      x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
    });
  }
  return points;
}

export function flattenCubic(from: Point, control1: Point, control2: Point, to: Point): Point[] {
  const points: Point[] = [];
  for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
    const t = step / CURVE_SEGMENTS;
    const inverse = 1 - t;
    points.push({
      x:
        inverse ** 3 * from.x +
        3 * inverse * inverse * t * control1.x +
        3 * inverse * t * t * control2.x +
        t ** 3 * to.x,
      y:
        inverse ** 3 * from.y +
        3 * inverse * inverse * t * control1.y +
        3 * inverse * t * t * control2.y +
        t ** 3 * to.y,
    });
  }
  return points;
}
