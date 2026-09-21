import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CharacterAssetError,
  CharacterLibrary,
  CharacterLibraryError,
  assetFilePath,
  checkAsset,
  demoRoot,
  readCharacterAsset,
  verifyCharacterAssets,
} from "./index.js";

/**
 * Asset resolution: a reference in a definition becomes bytes on disk, and the
 * bytes have to be exactly the ones the definition recorded — a missing file, a
 * truncated file and a quietly edited file are three different failures.
 */

/** A throwaway copy of the bundled set, so a test can break one file on purpose. */
function copyOfDemoSet(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-characters-assets-"));
  fs.cpSync(path.join(demoRoot(), "assets"), path.join(root, "assets"), { recursive: true });
  fs.cpSync(path.join(demoRoot(), "characters"), path.join(root, "characters"), {
    recursive: true,
  });
  return root;
}

const library = CharacterLibrary.load();
const maya = library.require("maya");
const firstAsset = maya.assets[0]!;

describe("character assets", () => {
  it("verifies every asset of the bundled set against its recorded size and hash", () => {
    const checks = verifyCharacterAssets(maya, demoRoot());
    expect(checks).toHaveLength(maya.assets.length);
    for (const check of checks) {
      expect(check.ok).toBe(true);
      expect(check.problem).toBeNull();
      expect(check.actual).toEqual(check.expected);
    }
    for (const { characterId, checks: perCharacter } of library.verifyAssets()) {
      expect(perCharacter.every((check) => check.ok)).toBe(true);
      expect(characterId).toBeTruthy();
    }
  });

  it("reads an asset and joins its path inside the library", () => {
    const root = demoRoot();
    expect(assetFilePath(root, firstAsset)).toBe(
      path.join(root, "assets", "maya", "maya_plate.svg"),
    );
    const read = readCharacterAsset(maya, firstAsset.id, root);
    expect(new TextDecoder().decode(read.bytes).startsWith("<svg")).toBe(true);
    expect(read.file).toBe(assetFilePath(root, firstAsset));
    expect(read.bytes.byteLength).toBe(firstAsset.bytes);
    expect(() => readCharacterAsset(maya, "no_such_asset", root)).toThrow(
      /maya has no asset no_such_asset/u,
    );
  });

  it("reports a missing, truncated or edited file as three different problems", () => {
    const root = copyOfDemoSet();
    const file = assetFilePath(root, firstAsset);
    const original = fs.readFileSync(file);

    fs.rmSync(file);
    expect(checkAsset(firstAsset, root)).toMatchObject({
      ok: false,
      problem: "missing",
      actual: null,
    });
    expect(() => readCharacterAsset(maya, firstAsset.id, root)).toThrow(CharacterAssetError);

    fs.writeFileSync(file, original.subarray(0, original.byteLength - 10));
    expect(checkAsset(firstAsset, root)).toMatchObject({ ok: false, problem: "bytes" });

    const edited = Buffer.from(original);
    edited[edited.indexOf('fill="') + 6] = "0".charCodeAt(0);
    fs.writeFileSync(file, edited);
    expect(checkAsset(firstAsset, root)).toMatchObject({ ok: false, problem: "hash" });

    fs.writeFileSync(file, original);
    expect(checkAsset(firstAsset, root).ok).toBe(true);
  });

  it("refuses to load a library whose art does not match its definitions", () => {
    const root = copyOfDemoSet();
    const good = CharacterLibrary.load({ dir: root, verifyAssets: true });
    expect(good.size).toBe(2);

    fs.rmSync(assetFilePath(root, firstAsset));
    expect(() => CharacterLibrary.load({ dir: root, verifyAssets: true })).toThrow(
      CharacterLibraryError,
    );
    expect(() => CharacterLibrary.load({ dir: root, verifyAssets: true })).toThrow(
      new RegExp(`${firstAsset.id}.*missing`, "u"),
    );
    // Loading without the check still works: the definition is the contract, the
    // files are checked when a caller asks for them.
    expect(CharacterLibrary.load({ dir: root }).size).toBe(2);
    expect(checkAsset(firstAsset, root).problem).toBe("missing");
  });

  it("reports an unreadable path instead of throwing", () => {
    const root = copyOfDemoSet();
    const file = assetFilePath(root, firstAsset);
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(checkAsset(firstAsset, root)).toMatchObject({ ok: false, problem: "unreadable" });
  });
});
