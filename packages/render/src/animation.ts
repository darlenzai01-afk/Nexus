import type { SceneAnimationEvent, SceneAnimationKind } from "@nexus/scenes";

import { EASINGS, easeFor } from "./easing.js";
import { clamp01, lerp, progress, round } from "./numbers.js";
import type { FrameElement, Reveal, Size } from "./types.js";

/**
 * The animation fold.
 *
 * An animation event says "at 2.6s, over 0.5s, this character changes pose" or
 * "this text wipes in from the left". The compositor does not simulate anything:
 * for any moment it folds every event that applies to an element into one
 * `AnimState` — a small, ordered set of numbers (opacity, offset, scale, rotation,
 * reveal, type-on progress).
 *
 * Three properties make the fold trustworthy:
 *
 * 1. **Events are cumulative and monotone.** A `fade_in` that finished stays at
 *    opacity 1; an entrance that finished stays revealed; a `pulse` returns to
 *    exactly 1 because its curve is `sin(π·t)`. Composition is therefore stable
 *    frame to frame.
 * 2. **Timing is local.** An event's `atSec` is seconds from the *start of its
 *    scene*, so the same event folds identically wherever its scene is placed.
 * 3. **The fold is pure.** Same events, same moment, same resolution → same
 *    state, which is what lets a digest over frames mean something.
 */

/** The element id scene-targeted events fold into. */
export const SCENE_EVENT_TARGET = "*";

/** The element a derived effect element belongs to (`fx:<event id>`). */
export function effectElementId(event: SceneAnimationEvent): string {
  return `fx:${event.id}`;
}

/** Which element an event animates. */
export function elementIdForEvent(event: SceneAnimationEvent): string {
  switch (event.target) {
    case "scene":
      return SCENE_EVENT_TARGET;
    case "character":
      return `char:${event.targetId}`;
    case "text":
      return "text";
    case "diagram":
      return "diagram";
    case "media":
      return `media:${event.targetId}`;
  }
}

/** Kinds that only mean something on a text card. */
export const TEXT_ONLY_KINDS: readonly SceneAnimationKind[] = [
  "type_on",
  "count_up",
  "lower_third",
  "highlight",
  "callout",
];

/** Kinds the character system, not the compositor, carries out. */
export const CHARACTER_ONLY_KINDS: readonly SceneAnimationKind[] = [
  "pose_change",
  "expression_change",
];

/** Whether a kind may animate an element of this kind. */
export function appliesTo(kind: SceneAnimationKind, elementKind: FrameElement["kind"]): boolean {
  if (TEXT_ONLY_KINDS.includes(kind)) return elementKind === "text";
  if (CHARACTER_ONLY_KINDS.includes(kind)) return elementKind === "character";
  return true;
}

export interface AnimState {
  readonly opacity: number;
  /** Displacement in frame pixels, applied before the camera moves. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scale: number;
  readonly rotationDeg: number;
  readonly reveal: Reveal;
  readonly highlight: number;
  /** How far a `type_on` has typed the card, or `null` when none applies. */
  readonly typeOn: number | null;
  /** How far a `count_up` has run, or `null` when none applies. */
  readonly countUp: number | null;
}

export const IDENTITY_ANIM: AnimState = {
  opacity: 1,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotationDeg: 0,
  reveal: { mode: "none", amount: 1 },
  highlight: 0,
  typeOn: null,
  countUp: null,
};

/** Horizontal/vertical distance a `slide_*` travels when the event gives none. */
export const SLIDE_DISTANCE = { x: 0.25, y: 0.25 } as const;

type Direction = "left" | "right" | "top" | "bottom";

function directionOf(params: SceneAnimationEvent["params"], fallback: Direction): Direction {
  const value = params.from ?? params.to ?? params.direction;
  return value === "left" || value === "right" || value === "top" || value === "bottom"
    ? value
    : fallback;
}

function slideOffset(
  direction: Direction,
  distance: number,
): { readonly x: number; readonly y: number } {
  switch (direction) {
    case "left":
      return { x: -distance, y: 0 };
    case "right":
      return { x: distance, y: 0 };
    case "top":
      return { x: 0, y: -distance };
    case "bottom":
      return { x: 0, y: distance };
  }
}

function numberParam(params: SceneAnimationEvent["params"], key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

/** How a fold should treat one event: `self`, `derived` (its own card), or skip. */
type Classification = "self" | "derived" | null;

function fold(
  events: readonly SceneAnimationEvent[],
  localSec: number,
  resolution: Size,
  classify: (event: SceneAnimationEvent) => Classification,
): AnimState {
  let reveal: Reveal = IDENTITY_ANIM.reveal;
  let scale = 1;
  let opacity = 1;
  let offsetX = 0;
  let offsetY = 0;
  let rotationDeg = 0;
  let highlight = 0;
  let typeOn: number | null = null;
  let countUp: number | null = null;

  for (const event of events) {
    const classification = classify(event);
    if (classification === null) continue;
    const isDerived = classification === "derived";

    const e = EASINGS[easeFor(event.kind)](progress(localSec, event.atSec, event.durationSec));
    const params = event.params;

    if (isDerived) {
      // A callout's own card: fades in and settles a touch smaller than final.
      if (event.kind === "callout") {
        opacity *= e;
        scale *= lerp(0.92, 1, e);
      }
      continue;
    }

    switch (event.kind) {
      case "fade_in":
        opacity *= e;
        break;
      case "fade_out":
      case "dissolve_out":
        opacity *= 1 - e;
        break;
      case "slide_in": {
        const direction = directionOf(params, "bottom");
        const distance =
          numberParam(params, "distance") ??
          (direction === "left" || direction === "right"
            ? SLIDE_DISTANCE.x * resolution.width
            : SLIDE_DISTANCE.y * resolution.height);
        const offset = slideOffset(direction, distance * (1 - e));
        offsetX += offset.x;
        offsetY += offset.y;
        break;
      }
      case "slide_out": {
        const direction = directionOf(params, "right");
        const distance =
          numberParam(params, "distance") ??
          (direction === "left" || direction === "right"
            ? SLIDE_DISTANCE.x * resolution.width
            : SLIDE_DISTANCE.y * resolution.height);
        const offset = slideOffset(direction, distance * e);
        offsetX += offset.x;
        offsetY += offset.y;
        break;
      }
      case "push_in":
        scale *= lerp(0.85, 1, e);
        offsetY += (1 - e) * 0.05 * resolution.height;
        break;
      case "scale_in":
        scale *= lerp(0.55, 1, e);
        break;
      case "wipe_in":
        reveal = { mode: "wipe", amount: Math.max(reveal.mode === "wipe" ? reveal.amount : 0, e) };
        break;
      case "split_open":
        reveal = {
          mode: "split",
          amount: Math.max(reveal.mode === "split" ? reveal.amount : 0, e),
        };
        break;
      case "zoom_to":
        scale *= lerp(1, numberParam(params, "scale") ?? 1.12, e);
        break;
      case "pulse":
        scale *= 1 + (numberParam(params, "amount") ?? 0.04) * Math.sin(Math.PI * e);
        break;
      case "rotate":
        rotationDeg += lerp(numberParam(params, "from") ?? 0, numberParam(params, "to") ?? 0, e);
        break;
      case "lower_third":
        opacity *= e;
        offsetY += (1 - e) * 0.1 * resolution.height;
        break;
      case "type_on":
        typeOn = Math.max(typeOn ?? 0, e);
        break;
      case "count_up":
        countUp = Math.max(countUp ?? 0, e);
        break;
      case "highlight":
        highlight = Math.max(highlight, e);
        break;
      case "callout":
      case "pose_change":
      case "expression_change":
        // `callout` draws its card (a derived element); the performance kinds are
        // carried out by the character system, which the composer reads separately.
        break;
    }
  }

  return {
    opacity: round(clamp01(opacity)),
    offsetX: round(offsetX),
    offsetY: round(offsetY),
    scale: round(scale),
    rotationDeg: round(rotationDeg),
    reveal: { mode: reveal.mode, amount: round(reveal.amount) },
    highlight: round(highlight),
    typeOn,
    countUp,
  };
}

/**
 * Fold every event that applies to `elementId` at `localSec`.
 *
 * Scene-targeted events are *not* folded here: the frame folds them once with
 * `foldSceneAnimation` and every element inherits that state, which is what stops a
 * scene-wide `fade_in` from being applied twice to a character that an event of
 * its own also touches.
 */
export function foldAnimation(
  events: readonly SceneAnimationEvent[],
  localSec: number,
  elementId: string,
  resolution: Size,
): AnimState {
  return fold(events, localSec, resolution, (event) => {
    if (elementId !== SCENE_EVENT_TARGET && elementIdForEvent(event) === elementId) return "self";
    if (elementId === effectElementId(event)) return "derived";
    return null;
  });
}

/** Fold the events that target the scene itself; the whole frame inherits them. */
export function foldSceneAnimation(
  events: readonly SceneAnimationEvent[],
  localSec: number,
  resolution: Size,
): AnimState {
  return fold(events, localSec, resolution, (event) => (event.target === "scene" ? "self" : null));
}

/** An event that has started by this moment (its window is open or finished). */
export function hasStarted(event: SceneAnimationEvent, localSec: number): boolean {
  return localSec >= event.atSec;
}

/** Every event that applies to an element and has started. */
export function activeEvents(
  events: readonly SceneAnimationEvent[],
  localSec: number,
  elementId: string,
): readonly SceneAnimationEvent[] {
  return events.filter(
    (event) =>
      hasStarted(event, localSec) &&
      ((elementIdForEvent(event) === elementId && elementId !== SCENE_EVENT_TARGET) ||
        elementId === effectElementId(event)),
  );
}

export interface PerformanceOverrides {
  readonly pose?: string;
  readonly expression?: string;
}

/**
 * The performance a character is in at a moment: the *last* `pose_change` and
 * `expression_change` that have already started. Events are ordered by the schema,
 * so the last one that started is the one in effect.
 */
export function overridesAt(
  events: readonly SceneAnimationEvent[],
  localSec: number,
  characterId: string,
): PerformanceOverrides {
  const overrides: { pose?: string; expression?: string } = {};
  for (const event of events) {
    if (event.target !== "character" || event.targetId !== characterId) continue;
    if (!hasStarted(event, localSec)) continue;
    const pose = event.params.pose;
    const expression = event.params.expression;
    if (event.kind === "pose_change" && typeof pose === "string" && pose !== "")
      overrides.pose = pose;
    if (event.kind === "expression_change" && typeof expression === "string" && expression !== "") {
      overrides.expression = expression;
    }
  }
  return overrides;
}

/** Which text card a `count_up` runs on, for tests and diagnostics. */
export function countUpEvents(
  events: readonly SceneAnimationEvent[],
  elementId: string,
): readonly SceneAnimationEvent[] {
  return events.filter(
    (event) => event.kind === "count_up" && elementIdForEvent(event) === elementId,
  );
}
