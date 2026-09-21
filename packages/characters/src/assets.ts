import fs from "node:fs";
import path from "node:path";

import { sha256 } from "@nexus/storage";

import type { Character, CharacterAsset } from "./schema.js";

/**
 * Asset resolution: turning an asset reference into bytes, and checking that the
 * bytes are the ones the definition promised.
 *
 * A definition records each asset's path, size and sha256. That is what makes a
 * character *portable*: the library can be copied between machines, a render can
 * be reproduced, and a mismatch (a half-written file, an edit nobody recorded, a
 * generator that drifted) is a load-time error instead of a wrong picture.
 */

export type AssetProblem = "missing" | "unreadable" | "bytes" | "hash";

export interface CharacterAssetCheck {
  readonly assetId: string;
  readonly path: string;
  readonly ok: boolean;
  readonly problem: AssetProblem | null;
  readonly expected: { readonly bytes: number; readonly hash: string };
  readonly actual: { readonly bytes: number; readonly hash: string } | null;
}

export class CharacterAssetError extends Error {
  readonly check: CharacterAssetCheck;

  constructor(characterId: string, check: CharacterAssetCheck) {
    super(
      `${characterId} asset ${check.assetId} (${check.path}) is ${check.problem}: ` +
        `expected ${check.expected.bytes} bytes / ${check.expected.hash.slice(0, 12)}, ` +
        `found ${check.actual === null ? "nothing" : `${check.actual.bytes} bytes / ${check.actual.hash.slice(0, 12)}`}`,
    );
    this.name = "CharacterAssetError";
    this.check = check;
  }
}

/** Absolute path of an asset inside a library root. */
export function assetFilePath(root: string, asset: CharacterAsset): string {
  return path.join(root, ...asset.path.split("/"));
}

/** Read one asset, verifying size and hash. Throws `CharacterAssetError` on any mismatch. */
export function readCharacterAsset(
  character: Character,
  assetId: string,
  root: string,
): { asset: CharacterAsset; file: string; bytes: Uint8Array } {
  const asset = character.assets.find((candidate) => candidate.id === assetId);
  if (asset === undefined) {
    throw new Error(`${character.id} has no asset ${assetId}`);
  }
  const check = checkAsset(asset, root);
  if (!check.ok) throw new CharacterAssetError(character.id, check);
  return {
    asset,
    file: assetFilePath(root, asset),
    bytes: fs.readFileSync(assetFilePath(root, asset)),
  };
}

/** Verify every asset of a character. Returns one result per asset, in definition order. */
export function verifyCharacterAssets(character: Character, root: string): CharacterAssetCheck[] {
  return character.assets.map((asset) => checkAsset(asset, root));
}

/** Size + hash check for a single asset. Missing or unreadable files are reported, never thrown. */
export function checkAsset(asset: CharacterAsset, root: string): CharacterAssetCheck {
  const expected = { bytes: asset.bytes, hash: asset.hash };
  const file = assetFilePath(root, asset);
  let bytes: Uint8Array;
  try {
    if (!fs.existsSync(file)) {
      return {
        assetId: asset.id,
        path: asset.path,
        ok: false,
        problem: "missing",
        expected,
        actual: null,
      };
    }
    bytes = fs.readFileSync(file);
  } catch {
    return {
      assetId: asset.id,
      path: asset.path,
      ok: false,
      problem: "unreadable",
      expected,
      actual: null,
    };
  }
  const actual = { bytes: bytes.byteLength, hash: sha256(bytes) };
  if (actual.bytes !== expected.bytes) {
    return { assetId: asset.id, path: asset.path, ok: false, problem: "bytes", expected, actual };
  }
  if (actual.hash !== expected.hash) {
    return { assetId: asset.id, path: asset.path, ok: false, problem: "hash", expected, actual };
  }
  return { assetId: asset.id, path: asset.path, ok: true, problem: null, expected, actual };
}
