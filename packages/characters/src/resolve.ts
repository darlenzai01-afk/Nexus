import { sha256 } from "@nexus/storage";

import {
  SLOT_ORDER,
  characterBytes,
  type Character,
  type CharacterAsset,
  type CharacterPalette,
  type CharacterSlot,
} from "./schema.js";

/**
 * State resolution: a character plus what a scene asks for becomes an ordered
 * layer stack of asset references.
 *
 * The resolver is pure and cheap — same character and same selection always give
 * the same layers, byte for byte — which is what lets a renderer (or a test)
 * trust the output. It never invents a variant: an unknown pose or expression is
 * an error that names the ids the character actually has, and a variant that
 * points at a missing asset is an error rather than a silently thinner figure.
 */

export const CHARACTER_FACINGS = ["front", "left", "right"] as const;
export type CharacterFacing = (typeof CHARACTER_FACINGS)[number];

/** What a scene asks of a character. Everything is optional: the definition defaults the rest. */
export interface CharacterSelection {
  readonly pose?: string;
  readonly expression?: string;
  /** A prop gesture; omit for none. */
  readonly gesture?: string;
  /** Outfit layer ids; omit to take the definition's default. */
  readonly clothing?: readonly string[];
  /** Worn items; omit to take the definition's default. */
  readonly accessories?: readonly string[];
  readonly facing?: CharacterFacing;
  /** Placement scale in the frame (1 = the canvas as authored). */
  readonly scale?: number;
}

export type CharacterPartKind = "pose" | "expression" | "gesture" | "clothing" | "accessory";

export class UnknownCharacterPartError extends Error {
  readonly kind: CharacterPartKind;
  readonly requestedId: string;
  readonly available: readonly string[];

  constructor(
    characterId: string,
    kind: CharacterPartKind,
    requestedId: string,
    available: readonly string[],
  ) {
    super(
      `${characterId} has no ${kind} "${requestedId}" (available: ${available.join(", ") || "none"})`,
    );
    this.name = "UnknownCharacterPartError";
    this.kind = kind;
    this.requestedId = requestedId;
    this.available = available;
  }
}

export class MissingCharacterAssetError extends Error {
  constructor(characterId: string, assetId: string) {
    super(`${characterId} references asset ${assetId}, which is not in its asset table`);
    this.name = "MissingCharacterAssetError";
  }
}

/** A variant that contributed a layer. */
export interface ResolvedLayer {
  /** Draw order across the whole figure, lowest first. */
  drawIndex: number;
  assetId: string;
  /** Path inside the character library root. */
  path: string;
  slot: CharacterSlot;
  /** The variant that asked for this layer: `pose:talk`, `base`, `clothing:field`. */
  source: string;
  variantId: string;
  kind: "svg";
  hash: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ResolvedCharacterAssetRef {
  readonly assetId: string;
  readonly path: string;
  readonly hash: string;
}

export interface ResolvedCharacter {
  readonly characterId: string;
  readonly version: number;
  /** sha256 of the definition's canonical bytes. */
  readonly hash: string;
  readonly name: string;
  readonly shortName: string;
  readonly role: Character["role"];
  readonly palette: CharacterPalette;
  readonly placement: {
    readonly canvas: { readonly width: number; readonly height: number };
    readonly anchor: { readonly x: number; readonly y: number };
    readonly facing: CharacterFacing;
    readonly scale: number;
  };
  /** The selection with every default filled in — what the scene actually gets. */
  readonly selection: {
    readonly pose: string;
    readonly expression: string;
    /** The chosen gesture, or `""` for none. */
    readonly gesture: string;
    readonly clothing: readonly string[];
    readonly accessories: readonly string[];
  };
  /** Every layer to draw, in order. */
  readonly layers: readonly ResolvedLayer[];
  /** The distinct files the layers need, in draw order (no duplicates). */
  readonly assets: readonly ResolvedCharacterAssetRef[];
}

const ids = (variants: readonly { id: string }[]): string[] =>
  variants.map((variant) => variant.id);

function variantById<T extends { id: string }>(
  characterId: string,
  kind: CharacterPartKind,
  variants: readonly T[],
  id: string,
): T {
  const found = variants.find((variant) => variant.id === id);
  if (found === undefined) {
    throw new UnknownCharacterPartError(characterId, kind, id, ids(variants));
  }
  return found;
}

function assetOf(
  character: Character,
  byId: ReadonlyMap<string, CharacterAsset>,
  assetId: string,
): CharacterAsset {
  const asset = byId.get(assetId);
  if (asset === undefined) throw new MissingCharacterAssetError(character.id, assetId);
  return asset;
}

/**
 * Resolve a character in a given performance.
 *
 * Variant ids are checked against the definition; anything left out falls back to
 * `defaultPerformance` (and `gesture: ""` asks for no gesture at all). The layer
 * stack is ordered by the slot table (`base` → `pose` → `clothing` →
 * `expression` → `accessory` → `gesture`), then by each asset's own order, then by
 * id — a total order, so the stack never depends on iteration accidents. A layer
 * whose region a later layer also paints replaces it: a gesture that draws its own
 * arms takes the pose's arms out of the stack instead of drawing four arms.
 */
export function resolveCharacter(
  character: Character,
  selection: CharacterSelection = {},
): ResolvedCharacter {
  const defaults = character.defaultPerformance;
  const byId = new Map(character.assets.map((asset) => [asset.id, asset]));
  const poseId = selection.pose ?? defaults.pose;
  const expressionId = selection.expression ?? defaults.expression;
  // A selection of `gesture: ""` explicitly asks for no gesture; leaving it out
  // takes the definition's default.
  const gestureId = selection.gesture === undefined ? (defaults.gesture ?? "") : selection.gesture;
  const clothingIds = selection.clothing ?? defaults.clothing;
  const accessoryIds = selection.accessories ?? defaults.accessories;
  const scale = selection.scale ?? 1;
  if (!(scale > 0.05) || scale > 8) {
    throw new RangeError(`${character.id}: scale must be in (0.05, 8], received ${scale}`);
  }

  const pose = variantById(character.id, "pose", character.poses, poseId);
  const expression = variantById(character.id, "expression", character.expressions, expressionId);
  const gesture =
    gestureId === ""
      ? undefined
      : variantById(character.id, "gesture", character.gestures, gestureId);
  const clothing = clothingIds.map((id) =>
    variantById(character.id, "clothing", character.clothing, id),
  );
  const accessories = accessoryIds.map((id) =>
    variantById(character.id, "accessory", character.accessories, id),
  );

  interface Candidate {
    readonly asset: CharacterAsset;
    readonly source: string;
    readonly variantId: string;
    readonly slotRank: number;
  }
  const candidates: Candidate[] = [];
  const add = (
    variant: { id: string; assets: readonly string[] },
    kind: CharacterPartKind,
  ): void => {
    for (const assetId of variant.assets) {
      const asset = assetOf(character, byId, assetId);
      candidates.push({
        asset,
        source: `${kind}:${variant.id}`,
        variantId: variant.id,
        slotRank: SLOT_ORDER[asset.slot],
      });
    }
  };

  // The base body is always drawn, whatever the performance.
  for (const asset of character.assets.filter((entry) => entry.slot === "base")) {
    candidates.push({ asset, source: "base", variantId: "", slotRank: SLOT_ORDER.base });
  }
  add(pose, "pose");
  for (const outfit of clothing) add(outfit, "clothing");
  add(expression, "expression");
  for (const accessory of accessories) add(accessory, "accessory");
  if (gesture !== undefined) add(gesture, "gesture");

  // A later slot wins a contested region: the gesture's arms cover the pose's,
  // so a figure never ends up with two pairs of arms.
  const decided: Candidate[] = [];
  for (const candidate of candidates) {
    const contested = decided.some((entry) => entry.asset.paints === candidate.asset.paints);
    if (contested) {
      for (let index = decided.length - 1; index >= 0; index -= 1) {
        if (decided[index]!.asset.paints === candidate.asset.paints) decided.splice(index, 1);
      }
    }
    decided.push(candidate);
  }

  decided.sort(
    (left, right) =>
      left.slotRank - right.slotRank ||
      left.asset.order - right.asset.order ||
      left.asset.id.localeCompare(right.asset.id) ||
      left.source.localeCompare(right.source),
  );

  const layers: ResolvedLayer[] = decided.map((candidate, drawIndex) => ({
    drawIndex,
    assetId: candidate.asset.id,
    path: candidate.asset.path,
    slot: candidate.asset.slot,
    source: candidate.source,
    variantId: candidate.variantId,
    kind: candidate.asset.kind,
    hash: candidate.asset.hash,
    bytes: candidate.asset.bytes,
    width: candidate.asset.width,
    height: candidate.asset.height,
  }));

  const seen = new Set<string>();
  const assets: ResolvedCharacterAssetRef[] = [];
  for (const layer of layers) {
    if (seen.has(layer.assetId)) continue;
    seen.add(layer.assetId);
    assets.push({ assetId: layer.assetId, path: layer.path, hash: layer.hash });
  }

  return {
    characterId: character.id,
    version: character.version,
    hash: characterHash(character),
    name: character.identity.name,
    shortName: character.identity.shortName,
    role: character.role,
    palette: character.visual.palette,
    placement: {
      canvas: character.visual.canvas,
      anchor: character.visual.anchor,
      facing: selection.facing ?? "front",
      scale,
    },
    selection: {
      pose: pose.id,
      expression: expression.id,
      gesture: gesture?.id ?? "",
      clothing: clothing.map((outfit) => outfit.id),
      accessories: accessories.map((accessory) => accessory.id),
    },
    layers,
    assets,
  };
}

/** sha256 over the definition's canonical bytes — the identity a scene records. */
export function characterHash(character: Character): string {
  return sha256(characterBytes(character));
}
