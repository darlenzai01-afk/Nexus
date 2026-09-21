import { describe, expect, it } from "vitest";

import { validateSceneManifest } from "@nexus/scenes";
import {
  CharacterLibrary,
  CharacterSyncError,
  STATE_PERFORMANCE,
  selectionForState,
  syncSceneManifest,
} from "./index.js";
import {
  MANIFEST_SCRIPT_HASH,
  mayaDocument,
  minimalCharacterDocument,
  sceneManifestFixture,
  staleDefinitionManifest,
  tomasDocument,
} from "./fixtures.js";

/**
 * Scene references: the manifest names characters by id, the sync writes the
 * definition *reference* back into it, and every appearance resolves to a
 * performance — with nothing of the definition copied into the plan.
 */

const library = CharacterLibrary.load();

/** Every key path in a document, so a test can prove a definition was not copied. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => keyPaths(entry, `${prefix}[${index}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    `${prefix}.${key}`,
    ...keyPaths(entry, `${prefix}.${key}`),
  ]);
}

describe("scene manifest sync", () => {
  it("records the definition reference and never the definition", () => {
    const input = sceneManifestFixture();
    const snapshot = JSON.stringify(input);
    const synced = syncSceneManifest(input, library);

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(synced.manifest.cast[0]).toEqual({
      id: "maya",
      name: "Maya Okonkwo",
      role: "host",
      description: "Studio host.",
      definition: { characterId: "maya", version: 1, hash: library.hashOf("maya") },
    });

    // Nothing of the character's identity, look or performance is in the plan.
    const paths = keyPaths(synced.manifest);
    for (const forbidden of ["poses", "expressions", "gestures", "clothing", "accessories"]) {
      expect(paths.some((entry) => entry.endsWith(`.${forbidden}`))).toBe(false);
    }
    const text = JSON.stringify(synced.manifest);
    for (const value of ["#1f6f6a", "maya_pose_stand_body", "assets/maya", "curly"]) {
      expect(text.includes(value)).toBe(false);
    }
    expect(text.includes(library.hashOf("maya"))).toBe(true);
  });

  it("resolves every appearance from the state the plan asked for", () => {
    const synced = syncSceneManifest(sceneManifestFixture(), library);
    expect(synced.characters).toHaveLength(1);
    const usage = synced.characters[0]!;
    expect(usage.characterId).toBe("maya");
    expect(usage.reference).toEqual({
      characterId: "maya",
      version: 1,
      hash: library.hashOf("maya"),
    });
    expect(usage.sceneIds).toEqual(["scn_sec1_1"]);
    expect(usage.appearances).toEqual([
      expect.objectContaining({
        sceneId: "scn_sec1_1",
        sceneIndex: 0,
        state: "talking",
        facing: "front",
        // "talking" names no gesture, so the definition's own default holds.
        selection: {
          pose: "talk",
          expression: "explaining",
          gesture: "open_palms",
          clothing: ["studio"],
          accessories: ["studio_badge"],
        },
      }),
    ]);
    expect(synced.report.ok).toBe(true);
    // The one soft note is the cast member nobody shows, and it is still soft.
    expect(synced.report.issues.map((entry) => entry.code)).toEqual(["unused_character"]);
  });

  it("replaces a stale definition hash and says so", () => {
    const maya = mayaDocument();
    const edited = CharacterLibrary.from(
      [
        {
          ...maya,
          visual: {
            ...(maya.visual as Record<string, unknown>),
            palette: {
              ...((maya.visual as { palette: Record<string, string> }).palette ?? {}),
              primary: "#0a0b0c",
            },
          },
        },
        tomasDocument(),
      ],
      { root: library.root },
    );
    const stale = staleDefinitionManifest(library.hashOf("maya"));

    // Validated on its own, the stale plan is a mismatch against the library.
    const before = validateSceneManifest(stale, { characters: edited });
    expect(before.ok).toBe(false);
    expect(before.issues.map((entry) => entry.code)).toContain("character_definition_mismatch");

    const synced = syncSceneManifest(stale, edited);
    expect(synced.manifest.cast[0]?.definition?.hash).toBe(edited.hashOf("maya"));
    expect(synced.manifest.warnings.join("\n")).toContain("was planned against");

    // The synced document points at the definition the library actually holds, so
    // it validates clean and the sync warns about what it repaired.
    expect(synced.report.issues.map((entry) => entry.code)).toEqual(["unused_character"]);
    const again = syncSceneManifest(synced.manifest, edited);
    expect(again.report.issues.map((entry) => entry.code)).toEqual(["unused_character"]);
  });

  it("reports a cast member with no definition instead of inventing one", () => {
    const manifest = sceneManifestFixture();
    manifest.cast = [
      { id: "nobody", name: "Nobody", role: "guest", description: "Not in the library." },
    ];
    manifest.scenes = (manifest.scenes as Record<string, unknown>[]).map((scene) => ({
      ...scene,
      characters: (scene.characters as { characterId: string; state: string }[]).map(() => ({
        characterId: "nobody",
        state: "idle",
      })),
    }));

    const synced = syncSceneManifest(manifest, library);
    expect(synced.characters).toEqual([]);
    expect(synced.manifest.cast[0]?.definition).toBeUndefined();
    expect(synced.report.ok).toBe(false);
    expect(synced.report.issues.map((entry) => entry.code)).toEqual([
      "unknown_character_definition",
    ]);
    expect(synced.manifest.warnings.join("\n")).toContain(
      '"nobody" is in the cast but not in library',
    );
  });

  it("adopts the library's default cast when the plan has none", () => {
    const manifest = sceneManifestFixture();
    const scenes = manifest.scenes as Record<string, unknown>[];
    manifest.cast = [];
    manifest.scenes = [{ ...scenes[1]!, index: 0, startSec: 0, transition: scenes[1]!.transition }];
    manifest.totalDurationSec = 3.2;
    manifest.warnings = [];

    const synced = syncSceneManifest(manifest, library);
    expect(synced.manifest.cast.map((member) => member.id)).toEqual(["maya", "tomas"]);
    expect(synced.manifest.cast.map((member) => member.definition?.hash)).toEqual([
      library.hashOf("maya"),
      library.hashOf("tomas"),
    ]);
    expect(synced.manifest.warnings.join("\n")).toContain("adopted the library default cast");
    expect(synced.report.ok).toBe(true);

    const untouched = syncSceneManifest(manifest, library, { adoptDefaultCast: false });
    expect(untouched.manifest.cast).toEqual([]);
    expect(untouched.characters).toEqual([]);
  });

  it("falls back to a definition's own defaults when it lacks the convention", () => {
    // A minimal character has one pose ("stand"), one expression ("neutral") and no
    // gestures; every state still resolves, and the sync records why it fell back.
    const plain = CharacterLibrary.from([minimalCharacterDocument()]);
    const manifest = sceneManifestFixture();
    manifest.cast = [
      { id: "test_character", name: "Test Character", role: "host", description: "Test." },
    ];
    manifest.scenes = (manifest.scenes as Record<string, unknown>[]).map((scene) => ({
      ...scene,
      characters: [{ characterId: "test_character", state: "pointing" }],
    }));

    const synced = syncSceneManifest(manifest, plain);
    const appearance = synced.characters[0]!.appearances[0]!;
    expect(appearance.state).toBe("pointing");
    expect(appearance.selection).toEqual({
      pose: "stand",
      expression: "neutral",
      gesture: "",
      clothing: ["plain"],
      accessories: [],
    });
    expect(appearance.facing).toBe("right");
    expect(appearance.notes.join("; ")).toContain('has no pose "talk" for state pointing');
    expect(appearance.notes.join("; ")).toContain('has no gesture "point" for state pointing');
    expect(synced.manifest.warnings.join("\n")).toContain("using its default");
  });

  it("maps every state to a documented performance", () => {
    const character = library.require("maya");
    for (const state of Object.keys(STATE_PERFORMANCE) as (keyof typeof STATE_PERFORMANCE)[]) {
      const { selection } = selectionForState(character, state);
      expect(selection.pose).toBeTruthy();
      expect(selection.expression).toBeTruthy();
      expect(selection.facing).toBe(STATE_PERFORMANCE[state].facing ?? "front");
    }
    expect(selectionForState(character, "talking").selection).toEqual({
      pose: "talk",
      expression: "explaining",
      facing: "front",
    });
    expect(selectionForState(character, "exiting").selection.facing).toBe("left");
  });

  it("refuses to sync something that is not a scene manifest", () => {
    expect(() => syncSceneManifest({ version: 1 }, library)).toThrow(CharacterSyncError);
    expect(() => syncSceneManifest(sceneManifestFixture(), library)).not.toThrow();
  });

  it("is deterministic and repeatable", () => {
    const once = syncSceneManifest(sceneManifestFixture(), library);
    const twice = syncSceneManifest(sceneManifestFixture(), library);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(MANIFEST_SCRIPT_HASH).toMatch(/^[0-9a-f]{64}$/u);
  });
});
