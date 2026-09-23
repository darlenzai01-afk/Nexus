import type { SceneType } from "./schema.js";
import { SCENE_TYPE_SPECS } from "./scene-types.js";

/**
 * Scene timing.
 *
 * Every duration in a manifest is derived from the narration it carries and the
 * type's floor/padding, in **deciseconds** (integers) so that the timeline adds
 * up exactly: `totalDurationSec === Σ scene.durationSec` and
 * `scene.startSec === Σ previous durations` hold with no floating-point drift,
 * which is what lets the validator check them with a near-zero tolerance.
 */

export const DEFAULT_WORDS_PER_SECOND = 2.5;

export function toDeciseconds(seconds: number): number {
  return Math.round(seconds * 10);
}

export function fromDeciseconds(deciseconds: number): number {
  return deciseconds / 10;
}

/** Seconds (to 0.1) that a line of narration takes at the given pace. */
export function narrationDurationSec(words: number, wordsPerSecond: number): number {
  return fromDeciseconds(narrationDurationDs(words, wordsPerSecond));
}

/**
 * Words ÷ pace, in deciseconds. A line with no words takes no time — the type's
 * floor in `sceneDurationDs` is what keeps a scene on screen long enough to read.
 */
export function narrationDurationDs(words: number, wordsPerSecond: number): number {
  return toDeciseconds(words / wordsPerSecond);
}

/**
 * How long a scene of this type stays on screen: the narration plus the type's
 * reading room, or the type's floor when the line is shorter than that.
 */
export function sceneDurationDs(type: SceneType, words: number, wordsPerSecond: number): number {
  const spec = SCENE_TYPE_SPECS[type];
  const narration = narrationDurationDs(words, wordsPerSecond);
  return Math.max(
    toDeciseconds(spec.minDurationSec),
    narration + toDeciseconds(spec.holdPaddingSec),
  );
}

export function sceneDurationSec(type: SceneType, words: number, wordsPerSecond: number): number {
  return fromDeciseconds(sceneDurationDs(type, words, wordsPerSecond));
}
