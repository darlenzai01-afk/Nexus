import type { Point, Rect } from "./canvas.js";

/**
 * 2-D affine transforms, in the order SVG applies them.
 *
 * A frame element carries `{ x, y, rotationDeg, scale, origin }`; the composed
 * SVG writes it as `translate(x y) rotate(deg) scale(s) translate(-origin × box)`.
 * This module builds exactly that matrix and applies it to geometry, so the pixel
 * path and the SVG path agree about where a figure stands.
 */
export interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translation(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaling(x: number, y: number = x): Matrix {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

export function rotation(degrees: number): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function shearX(factor: number): Matrix {
  return { a: 1, b: 0, c: factor, d: 1, e: 0, f: 0 };
}

/** `outer ∘ inner`: the inner transform applies to the geometry first. */
export function compose(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function composeAll(...matrices: readonly Matrix[]): Matrix {
  return matrices.reduce<Matrix>((outer, inner) => compose(outer, inner), IDENTITY);
}

export function applyMatrix(matrix: Matrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function isIdentity(matrix: Matrix): boolean {
  return (
    matrix.a === 1 &&
    matrix.b === 0 &&
    matrix.c === 0 &&
    matrix.d === 1 &&
    matrix.e === 0 &&
    matrix.f === 0
  );
}

/** The axis-aligned bounding box of a rectangle after a transform. */
export function transformRect(matrix: Matrix, rect: Rect): Rect {
  const corners = [
    applyMatrix(matrix, { x: rect.x, y: rect.y }),
    applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y }),
    applyMatrix(matrix, { x: rect.x, y: rect.y + rect.height }),
    applyMatrix(matrix, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

export function transformPoints(matrix: Matrix, points: readonly Point[]): Point[] {
  return points.map((point) => applyMatrix(matrix, point));
}
