import type { SceneKind } from "@nexus/db";

import type { SceneCamera, SceneType } from "./schema.js";

/**
 * The scene-type table: one row per scene type, and the *only* place where the
 * differences between them live.
 *
 * The strict schemas read `requires` (a scene of that type must carry those
 * blocks), the planner reads the timing floor, the padding and the camera base,
 * and the persistence path reads `legacyKind`. Adding a scene type is a row
 * here — not an edit in four files.
 */

/** Blocks a scene of a given type must carry. */
export type SceneRequirement = "characters" | "text" | "diagram" | "media_assets";

export interface SceneTypeSpec {
  readonly type: SceneType;
  /**
   * The `scenes.kind` value this scene type maps to *if* rows are written
   * (`title | talk | fact | media | quote`). The six-type vocabulary is
   * deliberately richer than the Phase 2 CHECK constraint, so the mapping is a
   * documented compromise rather than a bijection (OD-19).
   */
  readonly legacyKind: SceneKind;
  /** Blocks the strict schema insists on. */
  readonly requires: readonly SceneRequirement[];
  /** Narration a scene of this type carries. */
  readonly narration: "sentence" | "transition";
  /** How long the shot may stay on screen at minimum (seconds). */
  readonly minDurationSec: number;
  /** Reading/breathing room added to the narration estimate (seconds). */
  readonly holdPaddingSec: number;
  /** Base camera setup; the planner varies the movement deterministically. */
  readonly camera: SceneCamera;
  /** Operator-facing description — also used in validation messages. */
  readonly description: string;
}

export const SCENE_TYPE_SPECS: Readonly<Record<SceneType, SceneTypeSpec>> = {
  CHARACTER: {
    type: "CHARACTER",
    legacyKind: "talk",
    requires: ["characters"],
    narration: "sentence",
    minDurationSec: 2.5,
    holdPaddingSec: 0.3,
    camera: { shot: "medium", movement: "static", angle: "eye_level", focus: "presenter" },
    description: "The presenter carries the line: nobody else's material is on screen.",
  },
  EVIDENCE: {
    type: "EVIDENCE",
    legacyKind: "quote",
    requires: ["text"],
    narration: "sentence",
    minDurationSec: 4,
    holdPaddingSec: 1.2,
    camera: { shot: "close_up", movement: "zoom_in", angle: "eye_level", focus: "screen" },
    description: "A source artefact on screen: a quotation, a document card or a claim card.",
  },
  HYBRID: {
    type: "HYBRID",
    legacyKind: "talk",
    requires: ["characters"],
    narration: "sentence",
    minDurationSec: 3,
    holdPaddingSec: 0.6,
    camera: { shot: "medium", movement: "dolly_in", angle: "eye_level", focus: "presenter" },
    description: "Presenter and material together: a fact or a label over footage.",
  },
  DIAGRAM: {
    type: "DIAGRAM",
    legacyKind: "fact",
    requires: ["diagram"],
    narration: "sentence",
    minDurationSec: 4.5,
    holdPaddingSec: 1.5,
    camera: { shot: "wide", movement: "static", angle: "high", focus: "diagram" },
    description: "A drawn explainer: numbers, a timeline, a map, a comparison.",
  },
  ENVIRONMENT: {
    type: "ENVIRONMENT",
    legacyKind: "media",
    requires: ["media_assets"],
    narration: "sentence",
    minDurationSec: 3,
    holdPaddingSec: 0.8,
    camera: { shot: "wide", movement: "pan_right", angle: "eye_level", focus: "background" },
    description: "The world as footage or stills: a place, a process, a scale shot.",
  },
  TRANSITION: {
    type: "TRANSITION",
    legacyKind: "title",
    requires: [],
    narration: "transition",
    minDurationSec: 1,
    holdPaddingSec: 0.4,
    camera: { shot: "wide", movement: "dolly_in", angle: "eye_level", focus: "background" },
    description: "The spoken bridge between sections, with a visual seam behind it.",
  },
};

/** The `scenes.kind` mapping, for the stage that eventually writes rows (OD-19). */
export function legacySceneKind(type: SceneType): SceneKind {
  return SCENE_TYPE_SPECS[type].legacyKind;
}

/** Camera movement cycles, so consecutive shots of one type do not march in step. */
export const CAMERA_MOVEMENT_CYCLE: readonly SceneCamera["movement"][] = [
  "static",
  "pan_right",
  "dolly_in",
  "zoom_in",
  "pan_left",
  "dolly_out",
];

/**
 * Shot cycle for presenter scenes (a talking head needs rhythm, not one size).
 * Adjacent entries differ, so two consecutive presenter scenes never open the same
 * way; the first entry is every presenter type's base shot.
 */
export const PRESENTER_SHOT_CYCLE: readonly SceneCamera["shot"][] = [
  "medium",
  "close_up",
  "medium_close",
];
