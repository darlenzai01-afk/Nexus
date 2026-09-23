import {
  SceneSchema,
  parseSceneManifest,
  type Scene,
  type SceneAnimationEvent,
  type SceneAsset,
  type SceneCamera,
  type SceneCastEntry,
  type SceneCastMember,
  type SceneManifest,
  type SceneTransition,
  type SceneType,
} from "@nexus/scenes";

import type { Size } from "./types.js";

/**
 * Fixtures for the composition engine.
 *
 * Composing needs a *valid* scene manifest — the engine never re-checks what the
 * Phase 7 schemas already guarantee — so the fixtures here build manifests through
 * those very schemas. A test that composes a fixture is therefore composing
 * something the real pipeline could legitimately have produced: correct indices,
 * correct timeline arithmetic, correct word counts.
 */

export const FIXTURE_FPS = 30;
export const FIXTURE_RESOLUTION: Size = { width: 1920, height: 1080 };
export const FIXTURE_CLOCK = "2024-05-01T00:00:00.000Z";
export const FIXTURE_SCRIPT_HASH = "c".repeat(64);
export const FIXTURE_WORDS = "Fixture narration for the compositor.";

export interface SceneFixtureOptions {
  readonly id?: string;
  readonly index?: number;
  readonly type?: SceneType;
  readonly startSec?: number;
  readonly durationSec?: number;
  readonly words?: string;
  readonly characters?: readonly SceneCastEntry[];
  readonly text?: unknown;
  readonly media?: unknown;
  readonly diagram?: unknown;
  readonly camera?: Partial<SceneCamera>;
  readonly animation?: readonly SceneAnimationEvent[];
  readonly transition?: Partial<SceneTransition>;
}

/** One valid scene, with every block a caller does not override filled in. */
export function sceneFixture(options: SceneFixtureOptions = {}): Scene {
  const id = options.id ?? "scn_fixture";
  const words = options.words ?? FIXTURE_WORDS;
  const wordsCount = words.split(/\s+/u).filter((word) => word !== "").length;
  const type = options.type ?? "HYBRID";
  const input = {
    id,
    index: options.index ?? 0,
    type,
    sectionId: "sec_fixture",
    role: "narrative" as const,
    startSec: options.startSec ?? 0,
    durationSec: options.durationSec ?? 3.5,
    narration:
      type === "TRANSITION"
        ? {
            // A spoken bridge is a transition, not a sentence: the type says so.
            kind: "transition" as const,
            text: words,
            sectionId: "sec_fixture",
            role: "narrative" as const,
            sentenceIds: [],
            words: wordsCount,
            estimatedDurationSec: Math.round((wordsCount / 2.5) * 10) / 10,
          }
        : {
            kind: "sentence" as const,
            text: words,
            sectionId: "sec_fixture",
            role: "narrative" as const,
            sentenceIds: ["snt_fixture"],
            words: wordsCount,
            estimatedDurationSec: Math.round((wordsCount / 2.5) * 10) / 10,
          },
    characters: options.characters ?? [{ characterId: "maya", state: "talking" }],
    camera: {
      shot: "medium",
      movement: "static",
      angle: "eye_level",
      focus: "presenter",
      ...options.camera,
    },
    animation: options.animation ?? [],
    transition: {
      kind: "cut",
      durationSec: 0,
      toSceneId: "",
      audio: "none",
      ...options.transition,
    },
    text: options.text,
    media: options.media,
    diagram: options.diagram,
  };
  return SceneSchema.parse(input);
}

export interface ManifestFixtureOptions {
  readonly fps?: number;
  readonly resolution?: Size;
  readonly cast?: readonly SceneCastMember[];
  /** Extra inventory entries; ids referenced by a scene's media are added automatically. */
  readonly assets?: readonly SceneAsset[];
}

/** A valid manifest around a set of scenes, with the inventory they need. */
export function manifestFixture(
  scenes: readonly Scene[],
  options: ManifestFixtureOptions = {},
): SceneManifest {
  const fps = options.fps ?? FIXTURE_FPS;
  const resolution = options.resolution ?? FIXTURE_RESOLUTION;
  const totalDurationSec = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const cast = new Map<string, SceneCastMember>();
  for (const member of options.cast ?? []) cast.set(member.id, member);
  for (const scene of scenes) {
    for (const entry of scene.characters) {
      if (cast.has(entry.characterId)) continue;
      // A scene may only show somebody the cast names; a fixture adds the member,
      // exactly as the planner's cast input would have.
      cast.set(entry.characterId, {
        id: entry.characterId,
        name: entry.characterId,
        role: "host",
        description: "",
      });
    }
  }
  const inventory = new Map<string, SceneAsset>();
  for (const asset of options.assets ?? []) inventory.set(asset.id, asset);
  for (const scene of scenes) {
    for (const assetId of scene.media?.assets ?? []) {
      if (inventory.has(assetId)) continue;
      inventory.set(assetId, {
        id: assetId,
        sceneId: scene.id,
        kind: "generated",
        purpose: "still",
        description: `Fixture asset ${assetId}.`,
        searchHint: "",
        orientation: "landscape",
        minDurationSec: 0,
        status: "planned",
        uri: "",
        licence: "generated",
      });
    }
  }
  // A manifest's transitions follow its scenes: each scene hands over to the next
  // one, and the last scene ends the video. Fixtures wire that chain the way the
  // planner does, so a caller only ever writes the transition it cares about.
  const wired = scenes.map((scene, position) => ({
    ...scene,
    transition: { ...scene.transition, toSceneId: scenes[position + 1]?.id ?? "" },
  }));
  return parseSceneManifest({
    version: 1,
    topic: "Compositor fixture",
    workingTitle: "Compositor Fixture",
    scriptId: "",
    scriptHash: FIXTURE_SCRIPT_HASH,
    generatedAt: FIXTURE_CLOCK,
    fps,
    aspect: "16:9",
    resolution,
    wordsPerSecond: 2.5,
    totalDurationSec: Math.round(totalDurationSec * 10) / 10,
    cast: [...cast.values()],
    scenes: wired,
    assets: [...inventory.values()],
    warnings: [],
    provenance: {
      engine: { name: "nexus-render-fixtures", version: "1.0.0" },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
      generatedAt: FIXTURE_CLOCK,
    },
  });
}

/** One scene, as a whole manifest, for the tests that only need a timeline. */
export function timelineFixture(options: SceneFixtureOptions = {}): SceneManifest {
  return manifestFixture([sceneFixture(options)]);
}
