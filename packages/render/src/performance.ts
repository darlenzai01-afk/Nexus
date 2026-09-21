import {
  CharacterLibrary,
  readCharacterAsset,
  selectionForState,
  type Character,
  type CharacterFacing,
  type CharacterSelection,
  type ResolvedCharacter,
} from "@nexus/characters";
import type { SceneCharacterState } from "@nexus/scenes";

import type { PerformanceOverrides } from "./animation.js";

/**
 * The character side of composition.
 *
 * The compositor never invents a character and never copies one: it asks a
 * **stage** for a performance, and the stage is a thin adapter over the Phase 8
 * character library. A cast entry in the manifest is an id plus a state; the
 * library turns that into a pose, an expression, an outfit and an ordered layer
 * stack, and the compositor only places what it is handed.
 *
 * Two behaviours matter here:
 *
 * - **State first, events second.** A scene's state picks the performance
 *   (`talking` → the character's `talk` pose), and a `pose_change` /
 *   `expression_change` event overrides it from the moment it starts.
 * - **Fall back, never fail.** A state naming a variant the character does not
 *   have, an unknown override, a missing definition — all of them degrade to the
 *   character's own default performance and come back as notes the composer turns
 *   into diagnostics. A composer that throws produces no video.
 */

export interface CharacterStage {
  /** Every character id the stage knows. */
  readonly ids: readonly string[];
  has(characterId: string): boolean;
  character(characterId: string): Character | undefined;
  resolve(characterId: string, selection: CharacterSelection): ResolvedCharacter;
  /** The bytes of a layer file, or `undefined` when the stage cannot read it. */
  read(path: string): string | undefined;
}

/** A stage backed by a loaded character library (assets checked as they are read). */
export function createCharacterStage(library: CharacterLibrary): CharacterStage {
  const byPath = new Map<string, { readonly character: Character; readonly assetId: string }>();
  for (const definition of library.list()) {
    for (const asset of definition.character.assets) {
      byPath.set(asset.path, { character: definition.character, assetId: asset.id });
    }
  }
  const root = library.root;

  return {
    ids: library.ids(),
    has: (characterId) => library.has(characterId),
    character: (characterId) => library.get(characterId),
    resolve: (characterId, selection) => library.resolve(characterId, selection),
    read: (path) => {
      if (root === undefined) return undefined;
      const found = byPath.get(path);
      if (found === undefined) return undefined;
      try {
        // Reads through the character system, so every byte a frame draws has been
        // size- and hash-checked against the definition that named it.
        const bytes = readCharacterAsset(found.character, found.assetId, root).bytes;
        return new TextDecoder().decode(bytes);
      } catch {
        return undefined;
      }
    },
  };
}

export interface PerformanceRequest {
  readonly characterId: string;
  readonly state: SceneCharacterState;
  readonly overrides?: PerformanceOverrides | undefined;
}

export interface Performance {
  readonly characterId: string;
  /** False when even the character's default performance could not be resolved. */
  readonly ok: boolean;
  readonly resolved: ResolvedCharacter | undefined;
  readonly pose: string;
  readonly expression: string;
  readonly gesture: string;
  readonly clothing: readonly string[];
  readonly accessories: readonly string[];
  readonly facing: CharacterFacing;
  /** Why anything fell back, in the order it happened. */
  readonly notes: readonly string[];
}

const EMPTY_PERFORMANCE: Omit<Performance, "characterId" | "notes"> = {
  ok: false,
  resolved: undefined,
  pose: "",
  expression: "",
  gesture: "",
  clothing: [],
  accessories: [],
  facing: "front",
};

function fromResolved(
  characterId: string,
  resolved: ResolvedCharacter,
  notes: readonly string[],
): Performance {
  return {
    characterId,
    ok: true,
    resolved,
    pose: resolved.selection.pose,
    expression: resolved.selection.expression,
    gesture: resolved.selection.gesture,
    clothing: resolved.selection.clothing,
    accessories: resolved.selection.accessories,
    facing: resolved.placement.facing,
    notes,
  };
}

/** What a character is doing at a moment, with every fallback recorded. */
export function performanceFor(
  stage: CharacterStage | undefined,
  request: PerformanceRequest,
): Performance {
  const notes: string[] = [];
  if (stage === undefined) {
    return {
      ...EMPTY_PERFORMANCE,
      characterId: request.characterId,
      notes: ["no character stage was given"],
    };
  }
  const character = stage.character(request.characterId);
  if (character === undefined) {
    return {
      ...EMPTY_PERFORMANCE,
      characterId: request.characterId,
      notes: [
        `${request.characterId} is not in the character library (have: ${stage.ids.join(", ") || "none"})`,
      ],
    };
  }

  const state = selectionForState(character, request.state);
  notes.push(...state.notes);
  const selection: {
    pose?: string;
    expression?: string;
    gesture?: string;
    clothing?: readonly string[];
    facing?: CharacterFacing;
  } = { ...state.selection };
  if (request.overrides?.pose !== undefined) selection.pose = request.overrides.pose;
  if (request.overrides?.expression !== undefined)
    selection.expression = request.overrides.expression;

  try {
    return fromResolved(request.characterId, stage.resolve(request.characterId, selection), notes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown resolution failure";
    notes.push(`${request.characterId}: ${reason}; using the definition's default performance`);
    try {
      return fromResolved(request.characterId, stage.resolve(request.characterId, {}), notes);
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : "unknown failure";
      notes.push(
        `${request.characterId}: its default performance does not resolve either (${message})`,
      );
      return { ...EMPTY_PERFORMANCE, characterId: request.characterId, notes };
    }
  }
}

/** The distinct asset paths a resolved performance draws, in draw order. */
export function performanceAssets(resolved: ResolvedCharacter): readonly string[] {
  return resolved.layers.map((layer) => layer.path);
}
