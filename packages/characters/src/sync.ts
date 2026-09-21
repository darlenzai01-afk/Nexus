import {
  SceneManifestSchema,
  validateSceneManifest,
  type SceneCastMember,
  type SceneCharacterState,
  type SceneManifest,
  type SceneValidationReport,
} from "@nexus/scenes";

import type { CharacterLibrary, CharacterReference } from "./library.js";
import type { CharacterFacing, CharacterSelection, ResolvedCharacter } from "./resolve.js";
import type { Character } from "./schema.js";

/**
 * Scene integration: pointing a scene manifest at the character definitions whose
 * ids it already uses, without copying anything into it.
 *
 * A phase 7 manifest names a cast (`cast[].id`, `cast[].name`, `cast[].role`) and
 * says who is on screen in each scene (`scenes[].characters[].
 * {characterId, state}`). What it never says is how those people *look* — that is the
 * character's own business, and it lives in exactly one place: its definition.
 *
 * `syncSceneManifest` closes that loop for a given library:
 *
 * 1. it writes each cast member's definition **reference** (id, version, sha256)
 *    into the manifest — a pointer, not a copy;
 * 2. it turns each `state` into a performance (pose, expression, gesture) by the
 *    documented table below, falling back to the character's defaults when a
 *    definition does not have the id the table asks for;
 * 3. it hands back the resolved selection per appearance and a validation report
 *    of the document it produced — definition references fresh, character checks
 *    included — so a caller can store it directly. What the sync *changed* (a stale
 *    hash, a missing definition, a fallback) is recorded in `manifest.warnings`,
 *    where every other planning note lives.
 *
 * The manifest is never rewritten in place, and nothing in the character system is
 * duplicated into it: change a pose in the definition and every scene that asks
 * for that pose changes with it.
 */

/**
 * The performance each on-screen state asks for, by variant id.
 *
 * These are *conventions*, not requirements: a definition that does not have the id
 * keeps its own default and the sync records a note. `facing` is the one thing the
 * table decides outright — the states that face off-centre are the ones where the
 * direction is part of the meaning (a point, a walk on, a walk off).
 */
export const STATE_PERFORMANCE: Readonly<
  Record<
    SceneCharacterState,
    { pose?: string; expression?: string; gesture?: string; facing?: CharacterFacing }
  >
> = {
  idle: { pose: "stand", expression: "neutral" },
  talking: { pose: "talk", expression: "explaining" },
  listening: { pose: "stand", expression: "engaged" },
  gesturing: { pose: "talk", expression: "explaining", gesture: "open_palms" },
  pointing: { pose: "talk", expression: "explaining", gesture: "point", facing: "right" },
  reacting: { pose: "stand", expression: "surprised" },
  entering: { pose: "walk", expression: "neutral", facing: "right" },
  exiting: { pose: "walk", expression: "neutral", facing: "left" },
};

export interface StateSelection {
  readonly selection: CharacterSelection;
  /** What the state asked for but the definition does not have (never fatal). */
  readonly notes: readonly string[];
}

/** Turn one on-screen state into a selection, using the character's defaults for the gaps. */
export function selectionForState(
  character: Character,
  state: SceneCharacterState,
): StateSelection {
  const wanted = STATE_PERFORMANCE[state];
  const notes: string[] = [];
  const pick = (
    kind: "pose" | "expression" | "gesture",
    id: string | undefined,
  ): string | undefined => {
    if (id === undefined) return undefined;
    const variants =
      kind === "pose"
        ? character.poses
        : kind === "expression"
          ? character.expressions
          : character.gestures;
    if (variants.some((variant) => variant.id === id)) return id;
    notes.push(`${character.id} has no ${kind} "${id}" for state ${state}: using its default`);
    return undefined;
  };

  const selection: {
    pose?: string;
    expression?: string;
    gesture?: string;
    facing?: CharacterFacing;
  } = {};
  const pose = pick("pose", wanted.pose);
  const expression = pick("expression", wanted.expression);
  const gesture = pick("gesture", wanted.gesture);
  if (pose !== undefined) selection.pose = pose;
  if (expression !== undefined) selection.expression = expression;
  if (gesture !== undefined) selection.gesture = gesture;
  selection.facing = wanted.facing ?? "front";
  return { selection, notes };
}

/** One scene the character appears in, with the performance it was resolved in. */
export interface SceneCharacterAppearance {
  readonly sceneId: string;
  readonly sceneIndex: number;
  readonly state: SceneCharacterState;
  /** The selection actually used: the state's ids, or the definition's defaults. */
  readonly selection: ResolvedCharacter["selection"];
  readonly facing: CharacterFacing;
  readonly notes: readonly string[];
}

export interface SceneCharacterUsage {
  readonly characterId: string;
  /** The reference now recorded in the manifest for this character. */
  readonly reference: CharacterReference;
  readonly appearances: readonly SceneCharacterAppearance[];
  /** Every scene it appears in, in manifest order. */
  readonly sceneIds: readonly string[];
}

export interface SceneCharacterSync {
  /** The manifest with definition references recorded; everything else unchanged. */
  readonly manifest: SceneManifest;
  readonly characters: readonly SceneCharacterUsage[];
  /** Validation, now including the character-definition checks. */
  readonly report: SceneValidationReport;
}

export interface CharacterSyncOptions {
  /**
   * When the manifest has no cast at all, seed it from the library's default cast
   * (default `true`). Set `false` to sync a cast-less manifest as-is; note that a
   * scene which shows someone then fails the cast closure check.
   */
  readonly adoptDefaultCast?: boolean;
}

export class CharacterSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterSyncError";
  }
}

/**
 * Point a manifest at the definitions in `library` and resolve every appearance.
 *
 * Throws `CharacterSyncError` if the manifest is not a valid scene manifest at all:
 * sync *annotates* a plan, it does not repair an unparseable document (run
 * `validateSceneManifest` and fix the structure first).
 */
export function syncSceneManifest(
  input: unknown,
  library: CharacterLibrary,
  options: CharacterSyncOptions = {},
): SceneCharacterSync {
  const parsed = SceneManifestSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CharacterSyncError(
      `scene manifest is not valid (${first?.code ?? "unknown"} at ${first?.path.map(String).join(".") ?? "manifest"}): ${first?.message ?? "invalid manifest"}`,
    );
  }
  const manifest = parsed.data;
  const warnings = [...manifest.warnings];
  const note = (message: string): void => {
    const line = `character_sync: ${message}`;
    if (!warnings.includes(line)) warnings.push(line);
  };

  let cast: SceneCastMember[] = manifest.cast.map((member) => ({ ...member }));
  if (cast.length === 0 && options.adoptDefaultCast !== false) {
    cast = library.defaultCast().map((member) => ({ ...member }));
    note(
      `no cast in the manifest: adopted the library default cast (${cast.map((m) => m.id).join(", ")})`,
    );
  }

  const characters: SceneCharacterUsage[] = [];
  for (const member of cast) {
    if (!library.has(member.id)) {
      note(
        `"${member.id}" is in the cast but not in library "${library.name}": no definition to reference`,
      );
      continue;
    }
    const reference = library.ref(member.id);
    const recorded = member.definition;
    if (recorded === undefined) {
      note(`cast member "${member.id}" resolved to definition ${reference.hash.slice(0, 12)}`);
    } else if (recorded.version !== reference.version || recorded.hash !== reference.hash) {
      note(
        `cast member "${member.id}" was planned against ${recorded.hash.slice(0, 12)}; ` +
          `library "${library.name}" has ${reference.hash.slice(0, 12)}`,
      );
    }
    member.definition = reference;

    const character = library.require(member.id);
    const appearances: SceneCharacterAppearance[] = [];
    for (const [sceneIndex, scene] of manifest.scenes.entries()) {
      const entry = scene.characters.find((candidate) => candidate.characterId === member.id);
      if (entry === undefined) continue;
      const { selection, notes } = selectionForState(character, entry.state);
      const resolved = library.resolve(member.id, selection);
      for (const line of notes) note(line);
      appearances.push({
        sceneId: scene.id,
        sceneIndex,
        state: entry.state,
        selection: resolved.selection,
        facing: resolved.placement.facing,
        notes,
      });
    }
    // A cast member nobody shows gets no usage entry: the definition is still
    // referenced in the manifest, and the validator reports it as a soft note.
    if (appearances.length === 0) continue;
    characters.push({
      characterId: member.id,
      reference,
      appearances,
      sceneIds: appearances.map((appearance) => appearance.sceneId),
    });
  }

  const synced: SceneManifest = { ...manifest, cast, warnings };
  return {
    manifest: synced,
    characters,
    report: validateSceneManifest(synced, { characters: library }),
  };
}
