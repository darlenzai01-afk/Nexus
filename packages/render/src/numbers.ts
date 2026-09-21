/**
 * Numbers, and the one place the engine decides how much precision a frame keeps.
 *
 * Every value that reaches a frame document is rounded to `FRAME_PRECISION`
 * decimals. That is not cosmetic: it is what makes two runs of the compositor —
 * and a `sha256` over the result — agree byte for byte, on any machine.
 */

/** Decimals every number in a frame document is rounded to. */
export const FRAME_PRECISION = 3;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** `lerp` with `t` clamped to 0..1. */
export function mix(from: number, to: number, t: number): number {
  return lerp(from, to, clamp01(t));
}

export function round(value: number, digits: number = FRAME_PRECISION): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  // `-0` is a different string from `0` and would break frame comparison.
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * How far an event has got: 0 before it starts, 1 once it has finished. A
 * zero-length event is treated as instantaneous.
 */
export function progress(t: number, atSec: number, durationSec: number): number {
  if (durationSec <= 0) return t >= atSec ? 1 : 0;
  return clamp01((t - atSec) / durationSec);
}

/** The distance between two frame times, in frames (never negative). */
export function framesBetween(fromSec: number, toSec: number, fps: number): number {
  return Math.max(0, Math.round((toSec - fromSec) * fps));
}

/** `1234.5` → `"1234.5"`, without exponent notation or trailing zeros. */
export function formatNumber(value: number, digits: number = FRAME_PRECISION): string {
  const rounded = round(value, digits);
  return `${rounded}`;
}
