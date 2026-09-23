import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CharacterLibrary,
  CharacterLibraryError,
  UnknownCharacterError,
  demoRoot,
  parseCharacter,
} from "./index.js";
import { mayaDocument, minimalCharacterDocument, tomasDocument } from "./fixtures.js";

/**
 * Character loading: the directory layout, the index, the cast, and the ways a
 * library refuses to load something it cannot trust.
 */

describe("character library", () => {
  it("loads the bundled demonstration set", () => {
    const library = CharacterLibrary.load();
    expect(library.name).toBe("Nexus Forge demonstration set");
    expect(library.size).toBe(2);
    expect(library.ids()).toEqual(["maya", "tomas"]);
    expect(library.root).toBe(demoRoot());
    expect(library.index.characters).toEqual(["characters/maya.json", "characters/tomas.json"]);
    expect(library.has("maya")).toBe(true);
    expect(library.has("nobody")).toBe(false);
    expect(library.get("nobody")).toBeUndefined();
    expect(library.require("maya").identity.shortName).toBe("Maya");
  });

  it("hands out definition references instead of definitions", () => {
    const library = CharacterLibrary.load();
    expect(library.ref("maya")).toEqual({
      characterId: "maya",
      version: 1,
      hash: library.hashOf("maya"),
    });
    expect(library.hashOf("maya")).toMatch(/^[0-9a-f]{64}$/u);
    expect(library.hashOf("tomas")).not.toBe(library.hashOf("maya"));
  });

  it("casts characters in the role the caller asks for", () => {
    const library = CharacterLibrary.load();
    const defaultCast = library.defaultCast();
    expect(defaultCast.map((member) => [member.id, member.role])).toEqual([
      ["maya", "host"],
      ["tomas", "narrator"],
    ]);
    for (const member of defaultCast) {
      expect(member.name).toBe(library.require(member.id).identity.name);
      expect(member.definition.hash).toBe(library.hashOf(member.id));
    }
    expect(library.castMember("maya", "expert").role).toBe("expert");
    expect(library.castMember("tomas").role).toBe("narrator");
  });

  it("names the ids it does have when asked for one it does not", () => {
    const library = CharacterLibrary.load();
    let thrown: unknown;
    try {
      library.require("nobody");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownCharacterError);
    expect((thrown as UnknownCharacterError).message).toBe(
      'unknown character "nobody" (library has: maya, tomas)',
    );
    expect(() => library.hashOf("nobody")).toThrow(UnknownCharacterError);
  });

  it("is deterministic: the same set hashes the same, whatever the file order", () => {
    const first = CharacterLibrary.load();
    const second = CharacterLibrary.load();
    expect(second.hash).toBe(first.hash);

    const forward = CharacterLibrary.from([mayaDocument(), tomasDocument()]);
    const reversed = CharacterLibrary.from([tomasDocument(), mayaDocument()]);
    expect(reversed.hash).toBe(forward.hash);
    expect(reversed.ids()).toEqual(["tomas", "maya"]);
  });

  it("builds a library from documents in memory", () => {
    const library = CharacterLibrary.from([minimalCharacterDocument()]);
    expect(library.ids()).toEqual(["test_character"]);
    expect(library.root).toBeUndefined();
    expect(library.defaultCast().map((member) => [member.id, member.role])).toEqual([
      ["test_character", "host"],
    ]);
    expect(library.resolve("test_character").layers.map((layer) => layer.assetId)).toEqual([
      "plate",
      "pose_body",
      "pose_arms",
      "cloth_plain",
      "expr_neutral",
    ]);
  });

  it("refuses a set that cannot be trusted", () => {
    expect(() => CharacterLibrary.from([])).toThrow(CharacterLibraryError);
    expect(() => CharacterLibrary.from([mayaDocument(), mayaDocument()])).toThrow(
      /character id maya appears twice/u,
    );
    expect(() =>
      CharacterLibrary.from([mayaDocument()], {
        index: {
          version: 1,
          name: "wrong cast",
          defaultCast: [{ characterId: "tomas", role: "narrator" }],
          characters: ["characters/maya.json"],
        },
      }),
    ).toThrow(/default cast names tomas/u);
    expect(() => CharacterLibrary.from([minimalCharacterDocument({ id: "-bad" })])).toThrow(
      CharacterLibraryError,
    );
  });

  it("reports a missing library, a missing definition and a broken definition by file", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-characters-empty-"));
    expect(() => CharacterLibrary.load({ dir: empty })).toThrow(/no character library/u);

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-characters-broken-"));
    fs.mkdirSync(path.join(broken, "characters"), { recursive: true });
    fs.writeFileSync(
      path.join(broken, "characters", "index.json"),
      JSON.stringify({
        version: 1,
        name: "broken set",
        defaultCast: [{ characterId: "ghost", role: "host" }],
        characters: ["characters/ghost.json"],
      }),
    );
    expect(() => CharacterLibrary.load({ dir: broken })).toThrow(/which does not exist/u);

    fs.writeFileSync(path.join(broken, "characters", "ghost.json"), "{ not json");
    expect(() => CharacterLibrary.load({ dir: broken })).toThrow(/ghost\.json/u);

    const wrongSchema = JSON.parse(JSON.stringify(mayaDocument())) as Record<string, unknown>;
    wrongSchema.version = 7;
    fs.writeFileSync(path.join(broken, "characters", "ghost.json"), JSON.stringify(wrongSchema));
    expect(() => CharacterLibrary.load({ dir: broken })).toThrow(CharacterLibraryError);
  });

  it("cannot check assets for a set that was never on disk", () => {
    const library = CharacterLibrary.from([minimalCharacterDocument()]);
    expect(() => library.verifyAssets()).toThrow(/pass \{ root \}/u);
  });

  it("parses every definition it hands out", () => {
    const library = CharacterLibrary.load();
    for (const definition of library.list()) {
      expect(definition.character).toEqual(parseCharacter(definition.character));
      expect(definition.hash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});
