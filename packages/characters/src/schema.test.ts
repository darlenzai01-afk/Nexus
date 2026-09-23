import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mayaDocument, minimalCharacterDocument as minimalCharacter } from "./fixtures.js";
import {
  CHARACTER_SCHEMA_VERSION,
  CharacterLibraryIndexSchema,
  CharacterSchema,
  SLOT_ORDER,
  SLOT_PAINTS,
  characterBytes,
  demoRoot,
  parseCharacter,
} from "./index.js";

/**
 * The character contract: what a definition may say, what it must say, and what it
 * may never say. Everything here is about the *document* — the art, the loading and
 * the resolution have their own suites.
 */

const mayaDoc = mayaDocument;

function messages(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message);
}
describe("character schema", () => {
  it("parses the bundled demonstration definitions", () => {
    for (const id of ["maya", "tomas"]) {
      const doc = JSON.parse(
        fs.readFileSync(path.join(demoRoot(), "characters", `${id}.json`), "utf8"),
      ) as Record<string, unknown>;
      const character = parseCharacter(doc);
      expect(character.id).toBe(id);
      expect(character.version).toBe(CHARACTER_SCHEMA_VERSION);
      expect(character.provenance.origin).toBe("generated");
      expect(character.licence.kind).toBe("original");
      expect(character.poses.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("fills the documented defaults", () => {
    const character = parseCharacter(minimalCharacter());
    expect(character.identity.traits).toEqual([]);
    expect(character.gestures).toEqual([]);
    expect(character.accessories).toEqual([]);
    expect(character.defaultPerformance.gesture).toBeUndefined();
    expect(character.provenance.generator).toBe("");
    expect(character.provenance.note).toBe("Written for the character test suite.");

    const bare = minimalCharacter();
    delete (bare.provenance as Record<string, unknown>).note;
    expect(parseCharacter(bare).provenance.note).toBe("");
    for (const variant of [...character.poses, ...character.expressions, ...character.clothing]) {
      expect(variant.contexts).toEqual([]);
    }
  });

  it("rejects unknown fields instead of dropping them", () => {
    const topLevel = { ...minimalCharacter(), posses: [] };
    expect(CharacterSchema.safeParse(topLevel).success).toBe(false);

    const nested = minimalCharacter();
    (nested.visual as Record<string, unknown>).shadow = true;
    const result = CharacterSchema.safeParse(nested);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["visual"]);
    }

    const inVariant = minimalCharacter();
    (inVariant.poses as Record<string, unknown>[])[0]!.rotation = 12;
    expect(CharacterSchema.safeParse(inVariant).success).toBe(false);
  });

  it("rejects the wrong version and missing blocks", () => {
    expect(CharacterSchema.safeParse({ ...minimalCharacter(), version: 2 }).success).toBe(false);
    for (const key of ["identity", "visual", "poses", "expressions", "clothing", "assets"]) {
      const doc = minimalCharacter();
      delete doc[key];
      expect(CharacterSchema.safeParse(doc).success).toBe(false);
    }
  });

  it("insists on lowercase #rrggbb colours", () => {
    const doc = minimalCharacter();
    (doc.visual as { palette: Record<string, string> }).palette.primary = "#AABBCC";
    expect(CharacterSchema.safeParse(doc).success).toBe(false);
    (doc.visual as { palette: Record<string, string> }).palette.primary = "#abc";
    expect(CharacterSchema.safeParse(doc).success).toBe(false);
  });

  it("keeps asset paths inside the library", () => {
    for (const bad of ["/abs/path.svg", "../outside.svg", "assets\\win.svg"]) {
      const doc = minimalCharacter();
      (doc.assets as Record<string, unknown>[])[0]!.path = bad;
      expect(CharacterSchema.safeParse(doc).success).toBe(false);
    }
  });

  it("requires every asset to be used by a variant of its own slot", () => {
    const orphan = minimalCharacter();
    orphan.assets = [
      ...(orphan.assets as Record<string, unknown>[]),
      {
        id: "unused",
        slot: "pose",
        paints: "arms",
        path: "assets/test/unused.svg",
        kind: "svg",
        order: 1,
        hash: "b".repeat(64),
        bytes: 64,
        width: 256,
        height: 512,
      },
    ];
    expect(CharacterSchema.safeParse(orphan).success).toBe(false);

    const wrongSlot = minimalCharacter();
    (wrongSlot.poses as { assets: string[] }[])[0]!.assets = ["expr_neutral"];
    const result = CharacterSchema.safeParse(wrongSlot);
    expect(result.success).toBe(false);
    expect(messages(result).join("; ")).toContain("whose slot is expression");
  });

  it("rejects a variant naming an asset that does not exist, and duplicate ids", () => {
    const dangling = minimalCharacter();
    (dangling.poses as { assets: string[] }[])[0]!.assets = ["pose_body", "ghost"];
    const result = CharacterSchema.safeParse(dangling);
    expect(result.success).toBe(false);
    expect(messages(result).join("; ")).toContain("references asset ghost");

    const duplicateAsset = minimalCharacter();
    (duplicateAsset.assets as Record<string, unknown>[])[1] = {
      ...(duplicateAsset.assets as Record<string, unknown>[])[0]!,
    };
    expect(CharacterSchema.safeParse(duplicateAsset).success).toBe(false);

    const duplicateVariant = minimalCharacter();
    (duplicateVariant.expressions as unknown[]).push(
      (duplicateVariant.expressions as unknown[])[0],
    );
    expect(CharacterSchema.safeParse(duplicateVariant).success).toBe(false);
  });

  it("makes the default performance point at variants that exist", () => {
    for (const [field, value] of [
      ["pose", "walk"],
      ["expression", "surprised"],
      ["gesture", "point"],
    ] as const) {
      const doc = minimalCharacter();
      (doc.defaultPerformance as Record<string, unknown>)[field] = value;
      expect(CharacterSchema.safeParse(doc).success).toBe(false);
    }
    const badClothing = minimalCharacter();
    (badClothing.defaultPerformance as { clothing: string[] }).clothing = ["field"];
    expect(CharacterSchema.safeParse(badClothing).success).toBe(false);
  });

  it("only lets a slot paint the regions it owns", () => {
    expect(SLOT_PAINTS.pose).toEqual(["body", "arms"]);
    expect(SLOT_PAINTS.base).toEqual(["plate"]);
    expect(SLOT_ORDER.gesture).toBeGreaterThan(SLOT_ORDER.accessory);

    const doc = minimalCharacter();
    (doc.assets as Record<string, unknown>[])[0]!.paints = "arms";
    const result = CharacterSchema.safeParse(doc);
    expect(result.success).toBe(false);
    expect(messages(result).join("; ")).toContain("a base layer may paint plate");
  });

  it("hashes the definition canonically and deterministically", () => {
    const parsed = parseCharacter(mayaDoc());
    const bytes = characterBytes(parsed);
    expect(new TextDecoder().decode(bytes.slice(-1))).toBe("\n");
    expect(Array.from(characterBytes(parseCharacter(mayaDoc())))).toEqual(Array.from(bytes));
    const other = parseCharacter({ ...mayaDoc(), id: "maya_2" });
    expect(new TextDecoder().decode(characterBytes(other))).not.toEqual(
      new TextDecoder().decode(bytes),
    );
  });

  it("validates the library index", () => {
    const index = JSON.parse(
      fs.readFileSync(path.join(demoRoot(), "characters", "index.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsed = CharacterLibraryIndexSchema.parse(index);
    expect(parsed.defaultCast.map((entry) => entry.characterId)).toEqual(["maya", "tomas"]);
    expect(parsed.characters).toEqual(["characters/maya.json", "characters/tomas.json"]);

    expect(CharacterLibraryIndexSchema.safeParse({ ...index, defaultCast: [] }).success).toBe(
      false,
    );
    expect(
      CharacterLibraryIndexSchema.safeParse({
        ...index,
        defaultCast: [{ characterId: "maya", role: "presenter" }],
      }).success,
    ).toBe(false);
    expect(CharacterLibraryIndexSchema.safeParse({ ...index, extra: 1 }).success).toBe(false);
  });

  it("bounds ids to something readable in a log line and safe in a filename", () => {
    for (const id of ["maya", "maya_2", "a.b:c-d", "Maya12"]) {
      expect(CharacterSchema.safeParse({ ...minimalCharacter(), id }).success).toBe(true);
    }
    for (const id of ["", "-maya", "maya/2", "may a", "a".repeat(65)]) {
      expect(CharacterSchema.safeParse({ ...minimalCharacter(), id }).success).toBe(false);
    }
  });
});
