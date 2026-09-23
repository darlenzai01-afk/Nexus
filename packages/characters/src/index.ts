/**
 * `@nexus/characters` — the reusable character system (Phase 8).
 *
 * A character is defined **once**: identity, visual configuration (canvas, anchor,
 * proportions, palette, hair), poses, expressions, gestures, clothing, accessories
 * and the asset files that carry them. Everything else — the scene manifest, the
 * job pipeline, the renderer-to-come — names the character by id and asks for a
 * variant. Nothing copies a definition.
 *
 * ```ts
 * const library = CharacterLibrary.load({ verifyAssets: true });   // bundled set
 * const cast = library.defaultCast();                              // → scene cast
 * const manifest = buildSceneManifest(script, { scriptHash, cast: library });
 * const synced = syncSceneManifest(manifest, library);
 * const drew = library.resolve("maya", { pose: "talk", expression: "explaining" });
 * ```
 *
 * Public surface, grouped by what a caller is doing:
 *
 * - **The contract:** `CharacterSchema`, `parseCharacter`, `characterBytes`,
 *   `CharacterLibraryIndexSchema` and the block schemas (identity, visual,
 *   variants, assets). Strict zod objects throughout: an unknown field is an error,
 *   not a silent drop.
 * - **The library:** `CharacterLibrary` (`load`, `from`, `get`, `require`, `ref`,
 *   `castMember`, `defaultCast`, `resolve`, `verifyAssets`, `hash`) plus
 *   `demoRoot`/`packageRoot`. It ships one small, original demonstration cast.
 * - **Resolving:** `resolveCharacter`, `characterHash`, `CharacterSelection`,
 *   `ResolvedCharacter` — a selection becomes an ordered layer stack; unknown ids
 *   raise `UnknownCharacterPartError`.
 * - **Assets:** `readCharacterAsset`, `verifyCharacterAssets`, `checkAsset`,
 *   `assetFilePath`, `CharacterAssetError` — resolution to bytes, verified against
 *   the size and sha256 the definition recorded.
 * - **Planner integration:** `syncSceneManifest`, `selectionForState`,
 *   `STATE_PERFORMANCE` — the manifest records `{characterId, version, hash}` and
 *   the per-scene state becomes a pose/expression/gesture selection.
 */

// The contract: identity, visual configuration, variants, assets, library index.
export {
  CHARACTER_SCHEMA_VERSION,
  CharacterAccessorySchema,
  CharacterAssetPathSchema,
  CharacterAssetSchema,
  CharacterCanvasSchema,
  CharacterCastEntrySchema,
  CharacterClothingSchema,
  CharacterContextTagSchema,
  CharacterDefaultPerformanceSchema,
  CharacterExpressionSchema,
  CharacterGestureSchema,
  CharacterHairStyleSchema,
  CharacterIdentitySchema,
  CharacterLibraryIndexSchema,
  CharacterLicenceSchema,
  CharacterPaintSchema,
  CharacterPaletteSchema,
  CharacterPoseSchema,
  CharacterProportionsSchema,
  CharacterProvenanceSchema,
  CharacterRoleSchema,
  CharacterSchema,
  CharacterSlotSchema,
  CharacterVisualSchema,
  HexColourSchema,
  SLOT_ORDER,
  SLOT_PAINTS,
  characterBytes,
  parseCharacter,
  parseCharacterLibraryIndex,
  type Character,
  type CharacterAccessory,
  type CharacterAsset,
  type CharacterClothing,
  type CharacterContextTag,
  type CharacterExpression,
  type CharacterGesture,
  type CharacterIdentity,
  type CharacterLibraryIndex,
  type CharacterPaint,
  type CharacterPalette,
  type CharacterPose,
  type CharacterRole,
  type CharacterSlot,
} from "./schema.js";

// The library: loading, lookup, casting and set-wide hashing.
export {
  CharacterLibrary,
  CharacterLibraryError,
  UnknownCharacterError,
  demoRoot,
  packageRoot,
  type CharacterDefinition,
  type CharacterReference,
  type LibraryCastMember,
  type LoadCharacterLibraryOptions,
} from "./library.js";

// Resolving a performance into an ordered layer stack.
export {
  CHARACTER_FACINGS,
  MissingCharacterAssetError,
  UnknownCharacterPartError,
  characterHash,
  resolveCharacter,
  type CharacterFacing,
  type CharacterPartKind,
  type CharacterSelection,
  type ResolvedCharacter,
  type ResolvedCharacterAssetRef,
  type ResolvedLayer,
} from "./resolve.js";

// Assets: reference → bytes, verified against the recorded size and hash.
export {
  CharacterAssetError,
  assetFilePath,
  checkAsset,
  readCharacterAsset,
  verifyCharacterAssets,
  type AssetProblem,
  type CharacterAssetCheck,
} from "./assets.js";

// Planner integration: definition references and per-state performances.
export {
  STATE_PERFORMANCE,
  CharacterSyncError,
  selectionForState,
  syncSceneManifest,
  type CharacterSyncOptions,
  type SceneCharacterAppearance,
  type SceneCharacterSync,
  type SceneCharacterUsage,
  type StateSelection,
} from "./sync.js";
