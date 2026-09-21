import type { Scene, SceneCamera, SceneCharacterState } from "@nexus/scenes";

import { round } from "./numbers.js";
import type { Blocking, Point, Size } from "./types.js";

/**
 * Blocking: where the cast stands.
 *
 * A scene manifest says *who* is on screen and what they are doing, and what the
 * camera is doing; it deliberately does **not** contain x/y coordinates. Blocking
 * is the compositor's job, and it is a closed-form function of three things:
 *
 * - **how many** cast members are on screen (`SLOT_CENTRES`),
 * - **how tight** the shot is (`SHOT_FIGURE_HEIGHT`),
 * - **who is presenting** — the character driving the line stands in front, and
 *   whoever is listening to them stands behind and a little smaller
 *   (`DEPTH_BACK`).
 *
 * Two characters of different canvas sizes still stand the same height, because
 * the height is the shot's, not the artwork's: the figure is scaled so that it
 * occupies `SHOT_FIGURE_HEIGHT[shot]` of the frame whatever its own canvas is.
 */

/** Figure height as a fraction of the frame, per shot. */
export const SHOT_FIGURE_HEIGHT: Readonly<Record<SceneCamera["shot"], number>> = {
  wide: 0.58,
  medium: 0.72,
  medium_close: 0.84,
  close_up: 0.98,
  extreme_close_up: 1.15,
  over_shoulder: 0.88,
  pov: 0.7,
  insert: 0.48,
};

/** Where figures stand across the frame, by how many of them there are. */
export const SLOT_CENTRES: readonly (readonly number[])[] = [
  [0.5],
  [0.34, 0.66],
  [0.22, 0.5, 0.78],
];

/** The fraction of the frame the figures' anchor points land on. */
export const GROUND_Y = 0.94;

/** How the listening side of a two-shot differs from the presenting side. */
export const DEPTH_BACK = { scaleFactor: 0.94, opacity: 0.86, liftY: -0.015 } as const;

/** States in which a character is carrying the scene. */
export const PRESENTING_STATES: readonly SceneCharacterState[] = [
  "talking",
  "gesturing",
  "pointing",
  "entering",
];

/** Draw order: the listening side behind, the presenting side in front. */
export const DEPTH_Z = { back: 10, front: 20 } as const;

/** Where the n-th of `count` characters stands, as a fraction of the frame width. */
export function centreFor(index: number, count: number): number {
  const row = SLOT_CENTRES[count - 1];
  if (row !== undefined) return row[index] ?? 0.5;
  if (count <= 1) return 0.5;
  return 0.16 + (0.68 * index) / (count - 1);
}

/** The opacity a character at a given depth is drawn with. */
export function depthOpacity(depth: "front" | "back"): number {
  return depth === "front" ? 1 : DEPTH_BACK.opacity;
}

/**
 * Block a whole scene. The presenting character is the first one whose state says
 * they are driving the scene; when nobody is, the first cast member is.
 */
export function blockScene(scene: Scene, resolution: Size): Blocking[] {
  const cast = scene.characters;
  if (cast.length === 0) return [];

  const presenterIndex = cast.findIndex((entry) => PRESENTING_STATES.includes(entry.state));
  const presenting = presenterIndex >= 0 ? presenterIndex : 0;
  const base = resolution.height * SHOT_FIGURE_HEIGHT[scene.camera.shot];

  return cast.map((entry, index) => {
    const depth: "front" | "back" = index === presenting ? "front" : "back";
    const heightPx = base * (depth === "front" ? 1 : DEPTH_BACK.scaleFactor);
    const position: Point = {
      x: round(resolution.width * centreFor(index, cast.length)),
      y: round(resolution.height * (GROUND_Y + (depth === "front" ? 0 : DEPTH_BACK.liftY))),
    };
    return {
      characterId: entry.characterId,
      state: entry.state,
      elementId: `char:${entry.characterId}`,
      depth,
      heightPx: round(heightPx),
      position,
      z: DEPTH_Z[depth],
    };
  });
}

/** The frame x a scene's presenter stands at, for the camera to aim at. */
export function presenterCentre(
  blocking: readonly Blocking[],
  resolution: Size,
): number | undefined {
  const front = blocking.find((entry) => entry.depth === "front");
  if (front === undefined) return undefined;
  return round(front.position.x / resolution.width);
}
