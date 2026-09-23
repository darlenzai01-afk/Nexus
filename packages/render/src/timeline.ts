import type { Scene, SceneAnimationEvent, SceneManifest, SceneType } from "@nexus/scenes";

import { EASINGS, type EaseName } from "./easing.js";
import { makeLook } from "./look.js";
import { clamp01, mix, round } from "./numbers.js";
import type { FrameTransition, Look, Size } from "./types.js";

/**
 * The timeline: a validated scene manifest, indexed for time.
 *
 * The manifest already knows its own timings (scene `startSec`, `durationSec`,
 * `fps`, `transition.durationSec`); the timeline is the smallest structure that
 * turns them into *frames*. Everything downstream — blocking, the camera, the
 * animation fold — is a pure function of a timeline and a frame index, which is
 * what makes composition reproducible: no clock, no state, no accumulation.
 */

export interface SceneTimeline {
  readonly scene: Scene;
  readonly index: number;
  readonly type: SceneType;
  /** First global frame this scene owns. */
  readonly startFrame: number;
  /** How many frames it owns. */
  readonly frameCount: number;
  /** Last global frame it owns (inclusive). */
  readonly endFrame: number;
  /** The scene's animation events, in the order the manifest lists them. */
  readonly events: readonly SceneAnimationEvent[];
}

export interface Timeline {
  readonly manifest: SceneManifest;
  readonly fps: number;
  readonly resolution: Size;
  readonly frameCount: number;
  readonly durationSec: number;
  readonly look: Look;
  readonly scenes: readonly SceneTimeline[];
}

export interface TimelineOptions {
  readonly look?: Partial<Look>;
}

/**
 * Index a manifest. The manifest has already been through
 * `parseSceneManifest`, so this function does not re-validate: it only rounds
 * scene timings to whole frames.
 */
export function buildTimeline(manifest: SceneManifest, options: TimelineOptions = {}): Timeline {
  const scenes: SceneTimeline[] = [];
  for (const [index, scene] of manifest.scenes.entries()) {
    const startFrame = Math.round(scene.startSec * manifest.fps);
    const frameCount = Math.max(1, Math.round(scene.durationSec * manifest.fps));
    scenes.push({
      scene,
      index,
      type: scene.type,
      startFrame,
      frameCount,
      endFrame: startFrame + frameCount - 1,
      events: scene.animation,
    });
  }
  const last = scenes[scenes.length - 1];
  return {
    manifest,
    fps: manifest.fps,
    resolution: {
      width: manifest.resolution.width,
      height: manifest.resolution.height,
    },
    frameCount: last?.endFrame !== undefined ? last.endFrame + 1 : 0,
    durationSec: manifest.totalDurationSec,
    look: makeLook(options.look),
    scenes,
  };
}

/** The time a global frame index is sampled at. */
export function frameTime(timeline: Timeline, index: number): number {
  return index / timeline.fps;
}

/** The frame index that contains a time (clamped to the timeline). */
export function frameIndexForTime(timeline: Timeline, timeSec: number): number {
  return Math.min(Math.max(0, Math.floor(timeSec * timeline.fps)), timeline.frameCount - 1);
}

/** The scene a time falls in; times past the end clamp to the last scene. */
export function sceneTimelineAt(timeline: Timeline, timeSec: number): SceneTimeline {
  let current = timeline.scenes[0]!;
  for (const scene of timeline.scenes) {
    if (timeSec >= scene.scene.startSec - 1e-9) current = scene;
  }
  return current;
}

export function sceneTimelineById(timeline: Timeline, sceneId: string): SceneTimeline | undefined {
  return timeline.scenes.find((entry) => entry.scene.id === sceneId);
}

/**
 * The scene a frame index belongs to. Frames are partitioned by index rather than
 * by time, so a scene can never lose or duplicate a frame to floating-point
 * rounding at its boundary.
 */
export function sceneTimelineForFrame(timeline: Timeline, index: number): SceneTimeline {
  for (const scene of timeline.scenes) {
    if (index >= scene.startFrame && index <= scene.endFrame) return scene;
  }
  return timeline.scenes[timeline.scenes.length - 1]!;
}

/** Every frame index of one scene, in order. */
export function framesOfScene(timeline: Timeline, scene: SceneTimeline): number[] {
  const frames: number[] = [];
  for (let index = scene.startFrame; index <= scene.endFrame; index += 1) {
    if (index >= timeline.frameCount) break;
    frames.push(index);
  }
  return frames;
}

/**
 * How much of a scene's outgoing seam a moment sits in.
 *
 * A seam is the tail of the scene: it starts `transition.durationSec` before the
 * scene ends and runs to the end. A `cut` has no seam at all, so it is always
 * `progress: 0` and a renderer simply swaps frames.
 */
export function transitionAt(scene: SceneTimeline, localSec: number): FrameTransition {
  const transition = scene.scene.transition;
  const start = scene.scene.durationSec - transition.durationSec;
  const progress =
    transition.durationSec <= 0 ? 0 : clamp01((localSec - start) / transition.durationSec);
  const ease: EaseName =
    transition.kind === "match_cut" || transition.kind === "zoom_through" ? "easeIn" : "easeInOut";
  return {
    kind: transition.kind,
    durationSec: transition.durationSec,
    toSceneId: transition.toSceneId,
    progress: round(progress),
    mix: round(EASINGS[ease](progress)),
  };
}

/** Where a seam mixes: a hard cut and a dissolve both read from these numbers. */
export function transitionMix(transition: FrameTransition): number {
  return transition.mix;
}

/** Seconds covered by a list of frame indices. */
export function spanSec(timeline: Timeline, frames: readonly number[]): number {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return 0;
  return (last - first + 1) / timeline.fps;
}

/** A 0..1 ramp over a whole scene, for tests and diagnostics. */
export function sceneProgress(scene: SceneTimeline, localSec: number): number {
  return round(mix(0, 1, localSec / scene.scene.durationSec));
}
