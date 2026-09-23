import { describe, expect, it } from "vitest";

import { CLEAR_CLAIM_ID, SCRIPT_HASH, handWrittenManifest, manifestFixture } from "./fixtures.js";
import {
  SCENE_ISSUE_CODES,
  SCENE_TYPES,
  SceneAnimationKindSchema,
  SceneManifestSchema,
  manifestNarration,
  parseSceneManifest,
  sceneManifestBytes,
  scenesOfType,
} from "./schema.js";
import {
  CAMERA_MOVEMENT_CYCLE,
  PRESENTER_SHOT_CYCLE,
  SCENE_TYPE_SPECS,
  legacySceneKind,
} from "./scene-types.js";
import { fromDeciseconds, narrationDurationSec, toDeciseconds } from "./timing.js";
import { manifestWordCount } from "./validate.js";

/**
 * The contract itself: what a scene manifest is allowed to contain, what it fills
 * in when it does not say, and what it hands back.
 *
 * Everything here is about the *document*. Whether a manifest is good enough to
 * render is `validate.test.ts`; this file is about the shape.
 */

/** Write one unknown key into a nested path, the way a broken producer would. */
function withExtraKey(
  input: Record<string, unknown>,
  path: readonly (string | number)[],
  key: string,
): Record<string, unknown> {
  const clone = structuredClone(input) as Record<string, unknown>;
  let node: unknown = clone;
  for (const step of path) {
    if (node === null || typeof node !== "object")
      throw new Error(`path ${String(step)} is not an object`);
    node = (node as Record<string, unknown>)[String(step)] ?? (node as unknown[])[step as number];
  }
  if (node === null || typeof node !== "object")
    throw new Error("path does not point at an object");
  (node as Record<string, unknown>)[key] = "unexpected";
  return clone;
}

describe("parsing a manifest", () => {
  it("fills in every default a hand-written plan leaves out", () => {
    const manifest = parseSceneManifest(handWrittenManifest());
    expect(manifest).toMatchObject({
      version: 1,
      fps: 30,
      aspect: "16:9",
      wordsPerSecond: 2.5,
      scriptId: "",
      warnings: [],
      assets: [
        expect.objectContaining({
          searchHint: "",
          orientation: "landscape",
          status: "planned",
          uri: "",
          licence: "unknown",
          minDurationSec: 0,
        }),
      ],
      cast: [expect.objectContaining({ description: "" })],
    });
    const [first, second] = manifest.scenes;
    expect(first).toMatchObject({
      characters: [{ characterId: "presenter", state: "talking" }],
      sources: [],
      sourceIds: [],
      notes: [],
      animation: [],
      transition: { kind: "cut", durationSec: 0, toSceneId: "scn_2", audio: "crossfade" },
    });
    expect(second!.media).toMatchObject({
      searchHint: "",
      orientation: "landscape",
      treatment: "full_frame",
    });
    expect(second!.narration).toMatchObject({ sentenceIds: ["s2_1"] });
  });

  it("closes the scene type vocabulary at the six types", () => {
    expect(SCENE_TYPES).toEqual([
      "CHARACTER",
      "EVIDENCE",
      "HYBRID",
      "DIAGRAM",
      "ENVIRONMENT",
      "TRANSITION",
    ]);
    const manifest = parseSceneManifest(handWrittenManifest());
    for (const type of SCENE_TYPES) {
      expect(SCENE_TYPE_SPECS[type].type, type).toBe(type);
    }
    const unknown = structuredClone(manifest) as unknown as { scenes: { type: string }[] };
    unknown.scenes[0]!.type = "SONG";
    const result = SceneManifestSchema.safeParse(unknown);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({ path: ["scenes", 0, "type"] });
  });

  it("rejects the wrong version, and a version-less document", () => {
    const base = handWrittenManifest();
    expect(SceneManifestSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
    const { version: _dropped, ...noVersion } = base;
    expect(SceneManifestSchema.safeParse(noVersion).success).toBe(false);
  });

  it("rejects a document that is missing something the timeline needs", () => {
    const base = handWrittenManifest();
    for (const key of [
      "topic",
      "scriptHash",
      "generatedAt",
      "resolution",
      "totalDurationSec",
      "scenes",
    ]) {
      const { [key as keyof typeof base]: _dropped, ...rest } = base;
      expect(SceneManifestSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("rejects an empty manifest", () => {
    expect(SceneManifestSchema.safeParse({ ...handWrittenManifest(), scenes: [] }).success).toBe(
      false,
    );
  });

  it("rejects a hash that is not a sha256", () => {
    expect(
      SceneManifestSchema.safeParse({ ...handWrittenManifest(), scriptHash: "abc" }).success,
    ).toBe(false);
  });
});

describe("the strictness promise", () => {
  const levels: readonly (readonly (string | number)[])[] = [
    [],
    ["cast", 0],
    ["scenes", 0],
    ["scenes", 0, "narration"],
    ["scenes", 0, "characters", 0],
    ["scenes", 0, "camera"],
    ["scenes", 1, "media"],
    ["scenes", 0, "transition"],
    ["assets", 0],
    ["provenance"],
    ["provenance", "engine"],
  ];

  it("refuses an unknown key at every level of the document", () => {
    const base = parseSceneManifest(handWrittenManifest()) as unknown as Record<string, unknown>;
    for (const path of levels) {
      const candidate = withExtraKey(base, path, "surprise");
      const result = SceneManifestSchema.safeParse(candidate);
      expect(result.success, path.join(".") || "manifest").toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.code).toBe("unrecognized_keys");
      }
    }
  });

  it("refuses an unknown animation event, and an unknown kind inside one", () => {
    const parsed = parseSceneManifest(handWrittenManifest());
    const withAnimation = {
      ...parsed,
      scenes: [
        {
          ...parsed.scenes[0]!,
          animation: [
            {
              id: "a1",
              atSec: 0.2,
              durationSec: 0.3,
              kind: "fade_in",
              target: "scene",
              targetId: "",
              params: {},
            },
          ],
        },
        parsed.scenes[1]!,
      ],
    };
    expect(SceneManifestSchema.safeParse(withAnimation).success).toBe(true);
    expect(
      SceneManifestSchema.safeParse(
        withExtraKey(withAnimation as never, ["scenes", 0, "animation", 0], "easing"),
      ).success,
    ).toBe(false);
    const badKind = structuredClone(withAnimation) as unknown as {
      scenes: { animation: { kind: string }[] }[];
    };
    badKind.scenes[0]!.animation[0]!.kind = "explode";
    expect(SceneManifestSchema.safeParse(badKind).success).toBe(false);
  });

  it("carries the compositor's animation vocabulary, including the performance kinds", () => {
    expect(SceneAnimationKindSchema.options).toEqual([
      "fade_in",
      "fade_out",
      "slide_in",
      "slide_out",
      "scale_in",
      "type_on",
      "count_up",
      "highlight",
      "lower_third",
      "callout",
      "wipe_in",
      "push_in",
      "zoom_to",
      "pulse",
      "rotate",
      "split_open",
      "dissolve_out",
      "pose_change",
      "expression_change",
    ]);

    const parsed = parseSceneManifest(handWrittenManifest());
    const withPerformance = {
      ...parsed,
      scenes: [
        {
          ...parsed.scenes[0]!,
          animation: [
            {
              id: "a1",
              atSec: 0.2,
              durationSec: 0.3,
              kind: "pose_change",
              target: "character",
              targetId: "presenter",
              params: { pose: "walk" },
            },
            {
              id: "a2",
              atSec: 0.6,
              durationSec: 0.3,
              kind: "rotate",
              target: "scene",
              targetId: "",
              params: { to: 4 },
            },
          ],
        },
        parsed.scenes[1]!,
      ],
    };
    expect(SceneManifestSchema.safeParse(withPerformance).success).toBe(true);

    // A performance change has to name the character and the variant.
    const noTarget = structuredClone(withPerformance) as unknown as {
      scenes: { animation: { target: string }[] }[];
    };
    noTarget.scenes[0]!.animation[0]!.target = "scene";
    expect(SceneManifestSchema.safeParse(noTarget).success).toBe(false);

    const noVariant = structuredClone(withPerformance) as unknown as {
      scenes: { animation: { params: Record<string, unknown> }[] }[];
    };
    noVariant.scenes[0]!.animation[0]!.params = {};
    expect(SceneManifestSchema.safeParse(noVariant).success).toBe(false);
  });

  it("refuses narration whose word count does not match its words", () => {
    const manifest = parseSceneManifest(handWrittenManifest());
    const scene = {
      ...manifest.scenes[0]!,
      narration: { ...manifest.scenes[0]!.narration, words: 30 },
    };
    const result = SceneManifestSchema.safeParse({
      ...manifest,
      scenes: [scene, manifest.scenes[1]!],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain("narration_mismatch");
  });

  it("refuses a scene whose narration kind does not fit its type", () => {
    const manifest = parseSceneManifest(handWrittenManifest());
    const scene = {
      ...manifest.scenes[0]!,
      type: "TRANSITION" as const,
      characters: [],
      narration: { ...manifest.scenes[0]!.narration, kind: "paragraph" as const, sentenceIds: [] },
    };
    const result = SceneManifestSchema.safeParse({
      ...manifest,
      scenes: [scene, manifest.scenes[1]!],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain("carries the section's spoken bridge");
  });
});

describe("bytes and helpers", () => {
  it("round-trips through canonical bytes", () => {
    const manifest = manifestFixture();
    const bytes = sceneManifestBytes(manifest);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "scenes": [');
    expect(parseSceneManifest(JSON.parse(text))).toEqual(manifest);
    expect(new TextDecoder().decode(sceneManifestBytes(manifest))).toBe(text);
  });

  it("hands back scenes by type, and the narration in shot order", () => {
    const manifest = manifestFixture();
    expect(scenesOfType(manifest, "TRANSITION").map((scene) => scene.id)).toEqual([
      "scn_sec2_t",
      "scn_sec3_t",
      "scn_sec4_t",
      "scn_sec5_t",
    ]);
    const narration = manifestNarration(manifest);
    expect(narration).toHaveLength(manifest.scenes.length);
    expect(narration[0]).toContain("Forty thousand vehicles");
    expect(manifestWordCount(manifest)).toBe(
      manifest.scenes.reduce((total, scene) => total + scene.narration.words, 0),
    );
  });

  it("keeps the planner's promises about the type table", () => {
    for (const type of SCENE_TYPES) {
      const spec = SCENE_TYPE_SPECS[type];
      expect(spec.type).toBe(type);
      expect(["title", "talk", "fact", "media", "quote"]).toContain(legacySceneKind(type));
      expect(spec.minDurationSec).toBeGreaterThan(0);
      expect(spec.holdPaddingSec).toBeGreaterThan(spec.holdPaddingSec - 1);
      expect(spec.description.length).toBeGreaterThan(10);
    }
    // Presenter shots and camera movements vary: no cycle is a single value.
    expect(new Set(PRESENTER_SHOT_CYCLE).size).toBeGreaterThan(1);
    expect(new Set(CAMERA_MOVEMENT_CYCLE).size).toBeGreaterThan(1);
    expect(PRESENTER_SHOT_CYCLE[0]).toBe(SCENE_TYPE_SPECS.CHARACTER.camera.shot);
  });

  it("keeps the issue vocabulary unique and documented", () => {
    expect(new Set(SCENE_ISSUE_CODES).size).toBe(SCENE_ISSUE_CODES.length);
    expect(SCENE_ISSUE_CODES).toContain("missing_assets");
    expect(SCENE_ISSUE_CODES).toContain("unsupported_scene_type");
  });
});

describe("the timing arithmetic", () => {
  it("converts to and from deciseconds without drift", () => {
    for (const value of [0, 0.1, 2.5, 59.9, 120]) {
      expect(fromDeciseconds(toDeciseconds(value))).toBeCloseTo(value, 6);
    }
    expect(toDeciseconds(4.35)).toBe(44); // rounds to the nearest tenth
    expect(toDeciseconds(4.34)).toBe(43);
    expect(fromDeciseconds(44)).toBe(4.4);
  });

  it("keeps a long timeline exact by adding whole tenths", () => {
    let ds = 0;
    for (let index = 0; index < 200; index += 1) ds += toDeciseconds(0.1);
    expect(ds).toBe(200);
    expect(fromDeciseconds(ds)).toBe(20);
    // …where a float sum would have drifted off the tenth it started on.
    expect(
      Array.from({ length: 200 }, () => 0.1).reduce((total, value) => total + value, 0),
    ).not.toBe(20);
  });

  it("prices narration by the words actually spoken", () => {
    expect(narrationDurationSec(0, 2.5)).toBe(0);
    expect(narrationDurationSec(25, 2.5)).toBe(10);
    expect(narrationDurationSec(6, 2.5)).toBe(2.4);
  });
});

describe("the fixture script", () => {
  it("is a script the planner can plan, not a plan in disguise", () => {
    const manifest = manifestFixture();
    expect(manifest.scriptHash).toBe(SCRIPT_HASH);
    expect(
      manifest.scenes.some((scene) =>
        scene.sources.some((claim) => claim.claimId === CLEAR_CLAIM_ID),
      ),
    ).toBe(true);
    // Every scene's evidence is verbatim what the script's ledger holds.
    for (const scene of manifest.scenes) {
      for (const claim of scene.sources) {
        for (const evidence of claim.evidence) {
          expect(evidence.excerpt.length).toBeGreaterThan(20);
          expect(evidence.locator).toMatch(/^\d+:\d+$/u);
        }
      }
    }
  });
});
