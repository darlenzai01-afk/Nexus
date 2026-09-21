import fs from "node:fs";
import path from "node:path";

import { demoRoot } from "./library.js";

/**
 * Fixtures for the character tests.
 *
 * `characterDocument()` reads a real definition from the bundled set (so the tests
 * exercise the same documents the library ships), and
 * `sceneManifestFixture()` is a small hand-written scene manifest in the phase 7
 * shape: it names its cast by id and says who is on screen where, and it contains
 * no character definition at all — which is exactly what the sync test proves.
 */

/** A bundled definition, read from disk as the library reads it. */
export function characterDocument(id: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(demoRoot(), "characters", `${id}.json`), "utf8"),
  ) as Record<string, unknown>;
}

export const mayaDocument = (): Record<string, unknown> => characterDocument("maya");
export const tomasDocument = (): Record<string, unknown> => characterDocument("tomas");

/**
 * A complete, minimal original character document. Its asset paths point nowhere —
 * this is a *document* fixture for schema, resolution and library tests; only the
 * tests that run `verifyAssets` touch the disk.
 */
export function minimalCharacterDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const asset = (id: string, slot: string, paints: string, order = 0): Record<string, unknown> => ({
    id,
    slot,
    paints,
    path: `assets/test/${id}.svg`,
    kind: "svg",
    order,
    hash: "a".repeat(64),
    bytes: 128,
    width: 256,
    height: 512,
  });
  return {
    version: 1,
    id: "test_character",
    identity: {
      name: "Test Character",
      shortName: "Test",
      pronoun: "they/them",
      description: "A character that exists only inside the test suite.",
    },
    role: "host",
    visual: {
      canvas: { width: 256, height: 512 },
      anchor: { x: 0.5, y: 1 },
      proportions: {
        headRadius: 40,
        shoulderWidth: 90,
        torsoLength: 120,
        armLength: 110,
        legLength: 180,
        limbWidth: 22,
      },
      palette: {
        skin: "#c98f6a",
        hair: "#2a1e18",
        primary: "#336677",
        secondary: "#22303a",
        accent: "#dd9933",
        ink: "#101418",
        backdrop: "#eeeeee",
      },
      hair: { style: "short", colourKey: "hair" },
    },
    defaultPerformance: { pose: "stand", expression: "neutral", clothing: ["plain"] },
    poses: [
      {
        id: "stand",
        name: "Standing",
        description: "Standing still.",
        assets: ["pose_body", "pose_arms"],
      },
    ],
    expressions: [
      { id: "neutral", name: "Neutral", description: "Neutral face.", assets: ["expr_neutral"] },
    ],
    clothing: [
      { id: "plain", name: "Plain shirt", description: "A plain shirt.", assets: ["cloth_plain"] },
    ],
    assets: [
      asset("plate", "base", "plate"),
      asset("pose_body", "pose", "body"),
      asset("pose_arms", "pose", "arms", 1),
      asset("expr_neutral", "expression", "face"),
      asset("cloth_plain", "clothing", "torso"),
    ],
    provenance: { origin: "authored", note: "Written for the character test suite." },
    licence: { kind: "original", note: "Original test character." },
    ...overrides,
  };
}

/** The script hash a fixture manifest was planned from (never a real artifact). */
export const MANIFEST_SCRIPT_HASH = "f".repeat(64);
export const MANIFEST_GENERATED_AT = "2024-05-01T00:00:00.000Z";

/**
 * A valid two-scene manifest: the host talks to camera, then the material carries
 * the narration. `tomas` is in the cast and never on screen, which the validator
 * reports as a soft note — the same behaviour a real plan has.
 */
export function sceneManifestFixture(): Record<string, unknown> {
  return {
    version: 1,
    topic: "How the Kira bridge carries a city",
    workingTitle: "Forty Thousand Crossings",
    scriptId: "script_1",
    scriptHash: MANIFEST_SCRIPT_HASH,
    generatedAt: MANIFEST_GENERATED_AT,
    fps: 30,
    aspect: "16:9",
    resolution: { width: 1920, height: 1080 },
    wordsPerSecond: 2.5,
    totalDurationSec: 5.9,
    cast: [
      { id: "maya", name: "Maya Okonkwo", role: "host", description: "Studio host." },
      { id: "tomas", name: "Tomás Reyes", role: "narrator", description: "Field narrator." },
    ],
    scenes: [
      {
        id: "scn_sec1_1",
        index: 0,
        type: "CHARACTER",
        sectionId: "sec1",
        role: "hook",
        startSec: 0,
        durationSec: 2.7,
        narration: {
          kind: "sentence",
          text: "The Kira bridge opened in 1973.",
          sectionId: "sec1",
          role: "hook",
          sentenceIds: ["s1_1"],
          words: 6,
          estimatedDurationSec: 2.4,
        },
        characters: [{ characterId: "maya", state: "talking" }],
        camera: { shot: "medium", movement: "static", angle: "eye_level", focus: "presenter" },
        animation: [],
        transition: { kind: "cut", durationSec: 0, toSceneId: "scn_sec1_2", audio: "none" },
      },
      {
        id: "scn_sec1_2",
        index: 1,
        type: "ENVIRONMENT",
        sectionId: "sec1",
        role: "hook",
        startSec: 2.7,
        durationSec: 3.2,
        narration: {
          kind: "sentence",
          text: "Traffic streams across it all day.",
          sectionId: "sec1",
          role: "hook",
          sentenceIds: ["s1_2"],
          words: 6,
          estimatedDurationSec: 2.4,
        },
        characters: [],
        media: {
          kind: "video",
          description: "Traffic crossing the Kira bridge",
          searchHint: "Kira bridge traffic",
          orientation: "landscape",
          treatment: "full_frame",
          assets: ["asset_scn_sec1_2"],
        },
        camera: { shot: "wide", movement: "pan_right", angle: "eye_level", focus: "action" },
        animation: [],
        transition: { kind: "cut", durationSec: 0, toSceneId: "", audio: "none" },
      },
    ],
    assets: [
      {
        id: "asset_scn_sec1_2",
        sceneId: "scn_sec1_2",
        kind: "video",
        purpose: "broll",
        description: "Traffic crossing the Kira bridge",
        searchHint: "Kira bridge traffic",
        orientation: "landscape",
        minDurationSec: 3,
        status: "planned",
        licence: "unknown",
      },
    ],
    warnings: [],
    provenance: {
      engine: { name: "nexus-scenes", version: "1.0.0" },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
      generatedAt: MANIFEST_GENERATED_AT,
    },
  };
}

/** A manifest whose cast member records a definition that no longer matches. */
export function staleDefinitionManifest(hash: string): Record<string, unknown> {
  const manifest = sceneManifestFixture();
  manifest.cast = [
    {
      id: "maya",
      name: "Maya Okonkwo",
      role: "host",
      description: "Studio host.",
      definition: { characterId: "maya", version: 1, hash },
    },
    { id: "tomas", name: "Tomás Reyes", role: "narrator", description: "Field narrator." },
  ];
  return manifest;
}
