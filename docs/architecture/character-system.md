# Character System (Phase 8)

Phase 8 turns "who is in this video" from a name in a cast list into a **reusable
character definition**: identity, visual configuration (canvas, anchor,
proportions, palette, hair), poses, expressions, gestures, clothing, accessories,
and the asset files that carry all of it. `@nexus/characters` holds the contract,
the library, the resolver and the demonstration set; the scene planner references
those characters by id and never copies them.

The system exists so a character can be fixed in **one** place — change a pose,
re-colour a jacket, add an accessory — and every scene that asks for it changes
with it. Each promise below is enforced by code and has a test that fails if the
enforcement is removed:

| Promise                                         | Mechanism                                                                                                                                                                              | Where                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **A character is defined once**                 | The manifest records `cast[].definition = {characterId, version, hash}` — a pointer — and never a palette, pose list or asset path.                                                    | `sync.ts`, `SceneCastMemberSchema.definition`   |
| **A definition cannot lie about its own art**   | Every asset records `path`, `bytes`, `width`, `height` and `sha256`; `verifyAssets` re-reads the files and refuses a missing, truncated or edited one.                                 | `assets.ts`, `CharacterLibrary.load()`          |
| **A performance resolves deterministically**    | One layer per painted region, ordered by slot → asset order → id; a later slot that paints a contested region _replaces_ the earlier layer, so no figure gets four arms.               | `resolve.ts`, `SLOT_PAINTS`                     |
| **Unknown parts are refused by name**           | A pose, expression, gesture, outfit or accessory the definition does not have raises `UnknownCharacterPartError` listing the ids it does have — never a silently different figure.     | `resolve.ts`                                    |
| **The plan still knows which revision it drew** | A stale definition hash is a hard validation issue (`character_definition_mismatch`); a cast member with no definition is a soft note, and one the library has never heard of is hard. | `validate.ts`, `sync.test.ts`                   |
| **The planner needs no character knowledge**    | `buildSceneManifest` accepts a cast list _or_ anything with `defaultCast()` — the library shape — and only ever reads `id`, `name`, `role`, `description`, `definition`.               | `plan.ts`, `SceneCastSource`                    |
| **The set is original and small on purpose**    | Two original characters, 38 hand-generated SVG layers, 17 KB; licence `kind: "original"` with a note, and no third-party character, name or brand anywhere in the set.                 | `tools/build-demo-set.mjs`, `characters/*.json` |

The character system contains **no AI and no randomness**: a definition in, a
layer stack out, byte-for-byte the same every time (AD-07). Where a model would be
tempted — inventing a pose the character does not have, or quietly refitting a
stale reference — the code stops instead.

---

## 1. The definition (`packages/characters/src/schema.ts`)

One strict document per character (`version: 1`). Every block is a
`z.strictObject`: an unknown field is an error, not a silent drop.

| Block                | Shape                                                                                             | What it is for                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `id`                 | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`                                                              | The character's id everywhere: cast lists, scenes, paths        |
| `identity`           | `{name, shortName, pronoun, description, traits[]}`                                               | Who they are, in words a lower third can use                    |
| `role`               | `host \| narrator \| guest \| expert \| character`                                                | The role this character is cast in by default                   |
| `visual`             | `{canvas{width,height}, anchor{x,y}, proportions{…6}, palette{7 colours}, hair{style,colourKey}}` | How they are built — the numbers every layer is drawn from      |
| `defaultPerformance` | `{pose, expression, gesture?, clothing[], accessories[]}`                                         | What they do when a scene does not say                          |
| `poses[]`            | `{id, name, description, assets[], contexts[]}`                                                   | Body + arms variants (`stand`, `walk`, `talk`)                  |
| `expressions[]`      | same shape                                                                                        | Face variants (`neutral`, `explaining`, `engaged`, `surprised`) |
| `gestures[]`         | same shape                                                                                        | Arms (+ prop) variants (`open_palms`, `point`)                  |
| `clothing[]`         | same shape                                                                                        | Outfits drawn over the torso and upper arms                     |
| `accessories[]`      | same shape                                                                                        | Worn items drawn over everything but a prop                     |
| `assets[]`           | `{id, slot, paints, path, kind:"svg", order, hash, bytes, width, height}`                         | The files, with the size and hash they must have                |
| `provenance`         | `{origin: generated\|authored\|imported, generator, note}`                                        | How the definition came to exist                                |
| `licence`            | `{kind: original\|cc0\|licensed, note}`                                                           | The licensing statement; the bundled set is `original`          |

Rules the schema refuses to let a definition break:

- **Ids are the interface.** Variants name assets by id, `defaultPerformance`
  names variants by id, and the cast names characters by id. Every reference is
  checked for existence, and the closure is enforced on load: an asset no variant
  uses (base layers excepted — they are always drawn), a variant naming an asset
  that does not exist, an asset whose `slot` is not the variant's slot, a duplicate
  asset or variant id, or a default that names a variant that is not there.
- **Colours are lowercase `#rrggbb`**, so two identical colours are always one
  string.
- **Asset paths stay inside the library**: relative, POSIX separators, no `..`.
- **Ids are bounded** to something readable in a log line and safe in a filename.
- **A slot may only paint the regions it owns** (`SLOT_PAINTS`): `base` paints
  `plate`, `pose` paints `body` and `arms`, `clothing` paints `torso`,
  `expression` paints `face`, `accessory` paints `worn`, `gesture` paints `arms`
  and `prop`.

---

## 2. The library (`packages/characters/src/library.ts`)

```
packages/characters/
  characters/index.json      name, default cast, definition files to load
  characters/<id>.json       one definition per character
  assets/<id>/<asset>.svg    the layers those definitions reference
```

- `CharacterLibrary.load({dir?, verifyAssets?})` reads a library from disk;
  without `dir` it loads the bundled demonstration set. Strict at every step: an
  index that does not match its schema, a definition file that is missing or does
  not parse, a duplicate character id, a default cast naming a character no file
  declares — each fails with the file it failed on. `verifyAssets` adds the asset
  check from §4.
- `CharacterLibrary.from(documents, {index?, root?})` builds the same object from
  documents already in memory (tests, an imported set, a future database).
- Lookup and casting: `ids`, `list`, `has`, `get`, `require` (throws
  `UnknownCharacterError` listing what the library does have), `hashOf`, `ref`
  (`{characterId, version, hash}` — exactly what a manifest records), `castMember`
  (a cast member in a chosen role) and `defaultCast`.
- `hash` is a set-wide hash over sorted `id:definition-hash` lines, so a library
  and a copy of it agree, whatever order the files were read in.
- `resolve(id, selection)` delegates to §3; `verifyAssets()` returns one result per
  asset for every character.

---

## 3. Resolving a performance (`packages/characters/src/resolve.ts`)

A **selection** — what a scene asks for — is entirely optional:

```ts
{ pose?, expression?, gesture?, clothing?, accessories?, facing?, scale? }
```

Anything left out falls back to the definition's `defaultPerformance`, and
`gesture: ""` explicitly asks for no gesture. Resolution returns an ordered
**layer stack**, the distinct files it needs, and the placement (canvas, anchor,
facing, scale) — everything a renderer needs and nothing it has to guess.

Draw order is a total order, computed the same way every time:

1. **slot** — `base` → `pose` → `clothing` → `expression` → `accessory` → `gesture`
   (`SLOT_ORDER`), then
2. the asset's own `order` inside its slot (a pose's arms follow its body), then
3. asset id, then the source label.

The **replacement rule** is what makes layering honest: a layer that paints a
region an earlier layer painted removes that earlier layer from the stack, so a
gesture that draws its own arms replaces the pose's arms, and a second accessory
replaces the first rather than stacking on it. Exactly one layer per painted
region survives.

Refusals: an unknown variant id (`UnknownCharacterPartError`, with the ids the
character does have), an asset a variant names that is not in the asset table
(`MissingCharacterAssetError`), and a scale outside `(0.05, 8]` (`RangeError`).

---

## 4. Assets: reference → bytes (`packages/characters/src/assets.ts`)

`checkAsset` and `verifyCharacterAssets` compare a file's real size and sha256
against what the definition recorded, and distinguish three failures an operator
actually needs told apart: `missing` (the file is not there), `bytes` (truncated
or half-written), `hash` (same length, different content — an edit nobody
recorded). `readCharacterAsset` returns the bytes and throws `CharacterAssetError`
carrying the check. `assetFilePath` joins a relative path onto a library root.
The size/hash pair is what makes a library portable: a render can be reproduced,
and a drifted generator is a load-time error rather than a wrong picture.

---

## 5. The demonstration set

Two original characters — **Maya Okonkwo** (host, studio palette, curly hair) and
**Tomás Reyes** (narrator, field palette, wavy hair) — with 19 SVG layers each:

| Slot         | Layers per character | Variants                                        |
| ------------ | -------------------- | ----------------------------------------------- |
| `base`       | 1                    | backdrop plate with a ground shadow             |
| `pose`       | 6                    | `stand`, `walk`, `talk` (body + arms each)      |
| `expression` | 4                    | `neutral`, `explaining`, `engaged`, `surprised` |
| `gesture`    | 4                    | `open_palms`, `point` (arms + prop each)        |
| `clothing`   | 2                    | `studio` jacket, `field` vest                   |
| `accessory`  | 2                    | `studio_badge`, `field_bag`                     |

38 files, 17 KB of SVG, drawn on a 512×1024 canvas with shapes only (no raster
art, no rig): flat layers that make layering, palettes and replacement _visible_,
which is what the system needs a subject for. It is deliberately not an asset
library (GAP-25), and nothing in it imitates an existing channel's characters:
both are original, and each definition says so in `licence`.

`node packages/characters/tools/build-demo-set.mjs` regenerates the whole set
deterministically (byte-identical on a re-run, so recorded hashes stay valid) and
writes the definitions through the repository's own formatter. The definitions and
the art therefore cannot drift apart: the tool computes the hash it records.

---

## 6. Scene references (`packages/characters/src/sync.ts`)

A phase 7 manifest already knows **who** is on screen (`cast[].id`,
`scenes[].characters[].{characterId, state}`) and knows nothing about how they
look. `syncSceneManifest(manifest, library)` closes the loop:

1. it writes each cast member's definition **reference** (`{characterId, version,
hash}`) into the manifest — a pointer, not a copy;
2. it turns each on-screen `state` into a performance by a documented table, and
3. it returns the resolved selection per appearance, plus a validation report of
   the document it produced.

The state table (conventions, not requirements — a definition that lacks the id
keeps its own default and the sync records a note):

| State       | Pose    | Expression   | Gesture      | Facing |
| ----------- | ------- | ------------ | ------------ | ------ |
| `idle`      | `stand` | `neutral`    | —            | front  |
| `talking`   | `talk`  | `explaining` | —            | front  |
| `listening` | `stand` | `engaged`    | —            | front  |
| `gesturing` | `talk`  | `explaining` | `open_palms` | front  |
| `pointing`  | `talk`  | `explaining` | `point`      | right  |
| `reacting`  | `stand` | `surprised`  | —            | front  |
| `entering`  | `walk`  | `neutral`    | —            | right  |
| `exiting`   | `walk`  | `neutral`    | —            | left   |

What the sync repairs, it also says: a stale hash, a missing definition and a
fallback all land in `manifest.warnings` (where every other planning note lives),
and the definition reference is updated in the returned manifest — the input is
never mutated. A cast member nobody shows gets no usage entry (the validator
reports it as a soft `unused_character` note); a cast member the library does not
have is left alone and surfaces as the hard `unknown_character_definition`.

The scene side of the contract lives in `@nexus/scenes` and depends on the
_library shape_, not the package: `buildSceneManifest(script, {cast: library})`
takes the default cast from a library, and `validateSceneManifest(manifest,
{characters})` checks references (§4 of the scene-manifest document).

---

## 7. How this was verified

`pnpm verify` (format, lint, typecheck, test) is green: **39 files, 501 tests**.

| Suite                              | Tests | What it pins                                                                                                                                                                                                                                               |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `characters/src/schema.test.ts`    | 13    | The bundled definitions parse; defaults filled; unknown fields, wrong version, missing blocks, bad colours, escaping paths, orphan/duplicate assets and variants, bad defaults and slot/paint mismatches all refused; canonical hashing; the library index |
| `characters/src/library.test.ts`   | 10    | Loading the bundled set, definition references, casting and roles, unknown-id reporting, order-independent set hash, in-memory libraries, and every load failure naming its file                                                                           |
| `characters/src/resolve.test.ts`   | 9     | Defaults, scene-chosen pose/expression/outfit, the replacement rule, layer ordering, asset paths that exist on disk, every unknown-part error, scale bounds, determinism, hash change on edit                                                              |
| `characters/src/assets.test.ts`    | 5     | Every bundled asset verifies; missing vs truncated vs edited are three problems; a library with broken art refuses to load with `verifyAssets`; unreadable paths are reported                                                                              |
| `characters/src/sync.test.ts`      | 9     | Reference recorded and definition not copied, per-state selections, stale hashes replaced and warned, unknown cast members, default-cast adoption, fallbacks for characters without the convention, determinism, refusal to sync a non-manifest            |
| `scenes/src/plan.test.ts` (+3)     | 28    | A plan takes its cast from a library (references and all), still refuses a presenter scene with no body, and plans the same scenes either way                                                                                                              |
| `scenes/src/validate.test.ts` (+4) | 44    | Definition mismatch (hard), missing definition (soft), unknown cast member (hard), and no character checks at all without a library                                                                                                                        |

Everything runs offline: no paid API, no network, no credentials. The art is
checked by hash, and the tests read the same documents the library ships.

---

## 8. What Phase 8 deliberately does not include

- No renderer, no rig, no skeleton or IK: the resolver hands out an ordered layer
  stack and a placement (GAP-24).
- No animation between poses (walk cycles, lip sync, blinking) and no expression
  morphing: a state picks a variant, it does not tween one (GAP-24).
- No raster or generated art pipeline, and no image model: layers are SVG, and the
  demonstration set is hand-generated (GAP-25).
- No per-scene performance overrides in the manifest (a scene says `state`, the
  state maps to a performance); hand-written manifests can carry more by editing
  the definition's defaults (GAP-26).
- No voice casting or per-character voices: the voice stage owns voices.
- No character library stored in the database: the library is a directory, and a
  future phase can back it with rows without changing the contract.
- No operator UI for editing characters; definitions are documents.

---

## 9. Related documents

- `docs/architecture/scene-manifest.md` — the manifest these references live in.
- `docs/architecture/render-engine.md` — the first consumer: the composition
  engine resolves a scene's cast through `performanceFor` → `selectionForState` →
  this package's `resolve`, so what a character _is_ stays defined here while what
  it _looks like in a frame_ is decided there.
- `docs/architecture/script-engine.md` — where the narration comes from.
- `docs/plans/ISSUES.md` — OD-22…OD-23, GAP-24…GAP-26, CI-22…CI-24, and the phase 9
  entries OD-24…OD-26, GAP-27…GAP-33, CI-25…CI-29.
- `docs/plans/000-decisions.md` — AD-07 (deterministic code, AI for prose only).
