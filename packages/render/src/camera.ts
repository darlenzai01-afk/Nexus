import type { Scene, SceneCamera } from "@nexus/scenes";

import { EASINGS, type EaseName } from "./easing.js";
import { clamp, lerp, round } from "./numbers.js";
import type { CameraState, Point, Size, Transform } from "./types.js";

/**
 * The camera.
 *
 * A scene manifest carries a *setup* — shot, movement, angle, focus — not a
 * keyframe track. The compositor turns that setup into a camera state per frame:
 *
 * - the **focus** decides what the camera is pointed at (the presenter, the
 *   screen, the diagram, the background, the action),
 * - the **movement** is a deterministic excursion *around* that aim — a `pan_right`
 *   starts 4% left of the aim and ends 4% right of it, a `dolly_in` ramps the
 *   scale, a `handheld` breathes on a fixed sine, and every movement returns to
 *   where it started except the ones that are explicitly one-way,
 * - the **angle** tilts the frame (a `dutch` angle is a fixed few degrees).
 *
 * Because the excursion is a pure function of the scene's own local time, the
 * camera is reproducible frame by frame from the manifest alone.
 */

interface Excursion {
  /** Aim offset in frame fractions, from the start of the scene to its end. */
  readonly offsetX?: readonly [number, number];
  readonly offsetY?: readonly [number, number];
  /** Scale multiplier over the scene. */
  readonly scale?: readonly [number, number];
  /** Amplitude of the deterministic handheld breathing, in frame fractions. */
  readonly jitter?: number;
  readonly ease?: EaseName;
}

const MOVEMENTS: Readonly<Record<SceneCamera["movement"], Excursion>> = {
  static: {},
  pan_left: { offsetX: [0.04, -0.04] },
  pan_right: { offsetX: [-0.04, 0.04] },
  tilt_up: { offsetY: [0.04, -0.04] },
  tilt_down: { offsetY: [-0.04, 0.04] },
  dolly_in: { scale: [1, 1.08], offsetY: [0, 0.015] },
  dolly_out: { scale: [1.08, 1], offsetY: [0.015, 0] },
  zoom_in: { scale: [1, 1.14] },
  zoom_out: { scale: [1.14, 1] },
  crane_up: { offsetY: [0.06, -0.06], scale: [1, 1.03] },
  crane_down: { offsetY: [-0.06, 0.06], scale: [1, 1.03] },
  handheld: { jitter: 0.004 },
  whip_pan: { offsetX: [-0.08, 0.08], ease: "easeOut" },
};

/** Where each focus sends the camera, and how much it tightens the frame. */
const FOCUS: Readonly<
  Record<SceneCamera["focus"], { readonly x: number; readonly y: number; readonly scale: number }>
> = {
  presenter: { x: 0.5, y: 0.55, scale: 1 },
  action: { x: 0.5, y: 0.5, scale: 1.02 },
  screen: { x: 0.5, y: 0.55, scale: 1.02 },
  diagram: { x: 0.5, y: 0.5, scale: 1.04 },
  background: { x: 0.5, y: 0.46, scale: 0.96 },
};

const ANGLES: Readonly<
  Record<
    SceneCamera["angle"],
    { readonly aimY: number; readonly scale: number; readonly rotationDeg: number }
  >
> = {
  eye_level: { aimY: 0, scale: 1, rotationDeg: 0 },
  high: { aimY: -0.05, scale: 0.98, rotationDeg: 0 },
  low: { aimY: 0.08, scale: 1.02, rotationDeg: 0 },
  overhead: { aimY: -0.08, scale: 0.94, rotationDeg: 0 },
  dutch: { aimY: 0, scale: 1, rotationDeg: 3 },
};

export interface CameraInput {
  readonly scene: Scene;
  readonly resolution: Size;
  /** Where the presenting character stands, as a fraction of the frame width. */
  readonly presenterX?: number | undefined;
  /** Where on-screen text sits, as a fraction of the frame height. */
  readonly textCentreY?: number | undefined;
}

/** The aim the scene's focus and angle ask for, before the movement's excursion. */
export function focusPoint(input: CameraInput): {
  readonly aim: Point;
  readonly scale: number;
  readonly rotationDeg: number;
} {
  const focus = FOCUS[input.scene.camera.focus];
  const angle = ANGLES[input.scene.camera.angle];
  const aimed = input.scene.camera.focus === "presenter" || input.scene.camera.focus === "action";
  const x = aimed && input.presenterX !== undefined ? input.presenterX : focus.x;
  const y =
    input.scene.camera.focus === "screen" && input.textCentreY !== undefined
      ? input.textCentreY
      : focus.y;
  return {
    aim: { x: round(x), y: round(y + angle.aimY) },
    scale: round(focus.scale * angle.scale),
    rotationDeg: angle.rotationDeg,
  };
}

/** The camera at a moment inside the scene. */
export function cameraStateAt(input: CameraInput, localSec: number): CameraState {
  const focus = focusPoint(input);
  const movement = MOVEMENTS[input.scene.camera.movement];
  const duration = input.scene.durationSec;
  const eased = EASINGS[movement.ease ?? "easeInOut"](
    duration <= 0 ? 1 : clamp(localSec / duration, 0, 1),
  );

  let offsetX = 0;
  let offsetY = 0;
  if (movement.jitter !== undefined) {
    // Deterministic breathing: fixed frequencies, no randomness anywhere.
    offsetX = movement.jitter * Math.sin(2 * Math.PI * 1.7 * localSec);
    offsetY = movement.jitter * 0.75 * Math.cos(2 * Math.PI * 2.3 * localSec);
  } else {
    if (movement.offsetX !== undefined)
      offsetX = lerp(movement.offsetX[0], movement.offsetX[1], eased);
    if (movement.offsetY !== undefined)
      offsetY = lerp(movement.offsetY[0], movement.offsetY[1], eased);
  }
  const scale =
    movement.scale === undefined
      ? focus.scale
      : focus.scale * lerp(movement.scale[0], movement.scale[1], eased);

  return {
    shot: input.scene.camera.shot,
    movement: input.scene.camera.movement,
    angle: input.scene.camera.angle,
    focus: input.scene.camera.focus,
    scale: round(clamp(scale, 0.5, 2)),
    aim: {
      x: round(clamp(focus.aim.x + offsetX, 0, 1)),
      y: round(clamp(focus.aim.y + offsetY, 0, 1)),
    },
    rotationDeg: round(focus.rotationDeg),
  };
}

/**
 * Put a transform through the camera.
 *
 * The camera is a similarity transform about its aim point: everything the scene
 * laid out in frame pixels is shifted so the aim point lands in the middle of the
 * frame, scaled, and rotated with it. Element scales multiply; positions move with
 * the frame, which is what makes a `dolly_in` read as the *frame* moving rather
 * than each element separately deciding to grow.
 */
export function applyCamera(
  transform: Transform,
  camera: CameraState,
  resolution: Size,
): Transform {
  const aimX = camera.aim.x * resolution.width;
  const aimY = camera.aim.y * resolution.height;
  return {
    x: round((transform.x - aimX) * camera.scale + resolution.width / 2),
    y: round((transform.y - aimY) * camera.scale + resolution.height / 2),
    scale: round(transform.scale * camera.scale),
    rotationDeg: round(transform.rotationDeg + camera.rotationDeg),
    origin: transform.origin,
  };
}
