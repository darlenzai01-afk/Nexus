# Scene Manifest (Phase 7)

Phase 7 turns a **validated script** into a **scene manifest**: an ordered list of
scenes, each one carrying everything a downstream system needs before a single
frame exists — the narration it speaks, who is on screen and what they are doing,
the text, diagram, footage or document on screen, the camera, the animation
events, the transition into the next scene, and the research claims and sources it
shows. `@nexus/scenes` holds it; the `plan` stage of the long-form pipeline runs
it.

The manifest is the **contract between the writing side and the production side**.
Nothing in it is a rendered frame: it is data a media stage can source against, a
voice stage can time, a caption stage can read and a renderer can execute — and
every factual scene in it still resolves to the evidence behind it, so the
fact-check path survives into the visuals.

| Promise                                                      | Mechanism                                                                                                                                                                                                                           | Where                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Every scene is a projection of the script, not a rewrite** | Scene narration is the script's sentence text (or a section's spoken transition), copied verbatim; the validator re-joins the referenced sentences and compares.                                                                    | `buildSceneManifest()`, `validateSceneManifest()` |
| **No caption is invented**                                   | On-screen text is either a quoted span from the narration, a research claim's own wording, or the line being spoken — truncated on a word boundary, never paraphrased.                                                              | `textFor()`                                       |
| **No figure is invented**                                    | Diagrams are built from cited claims only; the data-diagram kinds (`number_highlight`, `bar_chart`, `line_chart`, `table`) must cite a claim or the manifest is rejected (hard).                                                    | `diagramFor()`, `validate.ts`                     |
| **The claim/evidence chain survives into the visuals**       | Each scene copies the claim it shows, with `usage`, `status`, `certainty`, `confidence` and the verbatim evidence (source id, URL, excerpt, `start:end` locator); the validator checks it against the script's ledger.              | `claimRefsFor()`, `validateSceneManifest()`       |
| **The timeline adds up exactly**                             | All durations are computed in **deciseconds** (integers) from words ÷ pace plus the type's padding, so `startSec` is the running sum and `totalDurationSec` is the sum of the scenes — checked with a 0.2 s tolerance, not a shrug. | `timing.ts`, `validateSceneManifest()`            |
| **A scene type means something**                             | `SCENE_TYPE_SPECS` is the only place per-type differences live: what the type requires, its duration floor and reading padding, its base camera, its legacy `scenes.kind`.                                                          | `scene-types.ts`                                  |
| **Malformed documents cannot be stored or read**             | Every object is a `z.strictObject`: an unknown field is an error rather than a silent drop. Ids unique, indices gapless, transitions chained, assets owned, cast closed, animation inside its scene.                                | `schema.ts`                                       |
| **The plan is reproducible**                                 | Planning is deterministic: two runs over one script and one clock produce byte-identical documents (tested), and `provenance.aiSteps` is empty.                                                                                     | `plan.ts`, `SCENE_ENGINE`                         |
| **What cannot be planned is said out loud**                  | Anything left out (a source with no backing claim, a chart with no claim) becomes a manifest `warning`, a step log line and a scene note — never a silent omission.                                                                 | `plan.ts` warnings, `task.ts`                     |

No model is involved anywhere in this phase. The script already decided what each
sentence _shows_ (its visual cue: `none`, `text`, `quote`, `chart`, `image`,
`broll`) and who says it; mapping that onto a shot is a rule table, not a
reasoning problem (AD-07). Cost is zero, and a plan can be regenerated for a
diff from the same script at any time.

---

## 1. Pipeline (`packages/scenes/src/plan.ts`)

```
ScriptDoc (validated)  +  cast / frame size / pace
  │
  ├─ cast      code   who may appear (input; never invented by AI)
  ├─ types     code   each sentence → CHARACTER | EVIDENCE | HYBRID | DIAGRAM |
  │                    ENVIRONMENT, each spoken bridge → TRANSITION
  ├─ timing    code   words ÷ pace + the type's padding, in deciseconds
  ├─ camera    code   the type's base look + a deterministic variation cycle
  ├─ animation code   enter / element / exit events that fit inside the scene
  ├─ assets    code   one planned asset per cue that needs one (plus its hint)
  └─ validate  code   run validateSceneManifest() over the result and record it
                       │
                       ▼
                 SceneManifest (validated against its own schema)
```

Each step appends a `SceneStepTrace` (`step`, `engine: "none"`, notes);
`provenance.deterministicSteps` lists all seven and `provenance.aiSteps` is empty.
Unlike the research and script engines there is no corrective AI round, no budget
and no gate: the work is offline, deterministic and free.

### Scene type rules (`sceneTypeFor()`)

| The writer asked for | The sentence             | Scene         |
| -------------------- | ------------------------ | ------------- |
| a spoken transition  | —                        | `TRANSITION`  |
| nothing / `none`     | —                        | `CHARACTER`   |
| `quote`              | —                        | `EVIDENCE`    |
| `text`               | citing claims            | `EVIDENCE`    |
| `text`               | no claims (a label)      | `HYBRID`      |
| `chart`              | —                        | `DIAGRAM`     |
| `image` / `broll`    | asserting a cleared fact | `HYBRID`      |
| `image` / `broll`    | otherwise                | `ENVIRONMENT` |

`CHARACTER` and `HYBRID` need a cast member; the planner throws `ScenePlanError`
(→ a permanent job failure with the operator's own message) if the plan was given
an empty cast. Everything else can be planned with no presenter at all — a script
whose every sentence has its own material renders nobody.

### What the six types require (`SCENE_TYPE_SPECS`)

| Type          | Requires                    | Floor / padding | Base camera                            | Legacy `scenes.kind` |
| ------------- | --------------------------- | --------------- | -------------------------------------- | -------------------- |
| `CHARACTER`   | `characters`                | 2.5 s / +0.3 s  | medium, static, eye level, presenter   | `talk`               |
| `EVIDENCE`    | `text`                      | 4.0 s / +1.2 s  | close-up, zoom in, eye level, screen   | `quote`              |
| `HYBRID`      | `characters`                | 3.0 s / +0.6 s  | medium, dolly in, eye level, presenter | `talk`               |
| `DIAGRAM`     | `diagram`                   | 4.5 s / +1.5 s  | wide, static, high angle, diagram      | `fact`               |
| `ENVIRONMENT` | `media` with ≥1 `assets[]`  | 3.0 s / +0.8 s  | wide, pan right, eye level, background | `media`              |
| `TRANSITION`  | — (speaks a section bridge) | 1.0 s / +0.4 s  | wide, dolly in, eye level, background  | `title`              |

Camera variation is deterministic and **per type**: the count of scenes of that
type so far indexes a cycle (`PRESENTER_SHOT_CYCLE` for presenter shots,
`CAMERA_MOVEMENT_CYCLE` for environments), so two scenes of the same type never
open on the same setup while each type keeps its recognizable base look. Motion is
a fixed grammar — `fade_in`, the type's one element animation
(`slide_in` for a card, `scale_in`/`count_up` for a diagram, `lower_third` for a
presenter caption, `push_in` for footage), `fade_out` — with ids in time order.

Seams follow the same idea: consecutive scenes of one type **cut** (0 s, `audio:
none`), a change of type **dissolves** (`DEFAULT_TRANSITION_DURATION_SEC`), and a
spoken bridge is entered through `fade_to_black` with an audio crossfade. A cut
with a non-zero duration is a validation error: the renderer has nothing to fade.

---

## 2. The document (`packages/scenes/src/schema.ts`)

`SceneManifest` v1 — every block strict, every id `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`:

| Field                               | Contents                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                           | `1` (a different version is a parse error, not a best-effort read)                                                                                                                                                                                        |
| `topic`, `workingTitle`, `scriptId` | Identity carried over from the script document                                                                                                                                                                                                            |
| `scriptHash`                        | sha256 of the script artifact this manifest was planned from (the traceability anchor)                                                                                                                                                                    |
| `generatedAt`, `provenance`         | ISO timestamp; engine `nexus-scenes 1.0.0`, the seven step traces, `aiSteps` / `deterministicSteps`                                                                                                                                                       |
| `fps`, `aspect`, `resolution`       | `30`, `16:9`, `1920×1080` by default; `9:16` flips every asset's orientation to portrait                                                                                                                                                                  |
| `wordsPerSecond`                    | The pace every duration was computed with (default `2.5`)                                                                                                                                                                                                 |
| `totalDurationSec`                  | The sum of the scenes — validated, never assumed                                                                                                                                                                                                          |
| `cast[]`                            | `{id, name, role (host\|narrator\|guest\|expert\|character), description, definition?}` — the people the video may show. `definition` is `{characterId, version, hash}`: a _reference_ to the character definition, never the definition itself (phase 8) |
| `scenes[]`                          | The ordered timeline (below)                                                                                                                                                                                                                              |
| `assets[]`                          | `{id, sceneId, kind, purpose, description, searchHint, orientation, minDurationSec, status, uri, licence}` — the media stage's work list                                                                                                                  |
| `warnings[]`                        | Everything the planner had to leave out or report, in plain words                                                                                                                                                                                         |

A scene carries:

| Field                     | Contents                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `index`             | `scn_<section>_<n>` for a sentence scene, `scn_<section>_t` for a spoken bridge; `index` must equal the position                                                  |
| `type`                    | One of the six, each with its required blocks                                                                                                                     |
| `sectionId`, `role`       | Where in the script it came from (`hook` → `introduction` → `narrative…` → `conclusion`)                                                                          |
| `startSec`, `durationSec` | Position and length on the timeline                                                                                                                               |
| `narration`               | `{kind: sentence\|paragraph\|transition, text, sectionId, role, sentenceIds[], words, estimatedDurationSec}` — the reference back into the script                 |
| `characters[]`            | `{characterId, state}` with the eight-state rig (`idle`, `talking`, `listening`, `gesturing`, `pointing`, `reacting`, `entering`, `exiting`)                      |
| `media`                   | `{kind (image\|video\|document\|generated), description, searchHint, orientation, treatment, assets[]}` — `assets[]` names ids in the manifest inventory          |
| `text`                    | `{kind (title\|claim\|quote\|number\|label\|callout), value, attribution, position, maxLines}` — verbatim from the script or its evidence                         |
| `diagram`                 | `{kind (9 kinds), title, annotations[], series[], claimIds[]}` — `series[]` is empty until a stage has real numbers to plot                                       |
| `camera`                  | `{shot, movement, angle, focus}` — 8 shots × 13 movements × 5 angles × 5 focuses                                                                                  |
| `animation[]`             | `{id, atSec, durationSec, kind (**19 kinds**, see below), target (scene\|character\|media\|text\|diagram), targetId, params}` — ordered, unique, inside the scene |
| `transition`              | `{kind (11 kinds), durationSec, toSceneId, audio (none\|crossfade\|whoosh\|impact\|beat)}` — must point at the next scene, `""` on the last                       |
| `sources[]`               | The claim/evidence chain: `{claimId, statement, usage, status, certainty, confidence, evidence[{sourceId, url, excerpt, locator}]}`                               |
| `sourceIds[]`             | The flat list of research source ids visible in the scene (sorted, deduplicated)                                                                                  |
| `notes[]`                 | Planner/validator notes attached to this scene                                                                                                                    |

The animation vocabulary is grouped by what a kind does: **entrance**
(`fade_in`, `slide_in`, `scale_in`, `wipe_in`, `push_in`, `split_open`), **exit**
(`fade_out`, `slide_out`, `dissolve_out`), **transform** (`zoom_to`, `pulse`,
`rotate`), **text** (`type_on`, `count_up`, `lower_third`, `callout`,
`highlight`) and **performance** (`pose_change`, `expression_change`). Phase 9
added `rotate`, `pose_change` and `expression_change` so a scene can turn an
element and change what a character is doing mid-scene; both performance kinds
must target a character and name the `pose` / `expression` they switch to
(`invalid_animation` otherwise). What each kind _does_ to a frame — easing,
distances, defaults — is the compositor's, not the manifest's:
[`render-engine.md`](./render-engine.md).

`narration.kind` is how a scene says what it is speaking. `sentence` names the
script sentences it covers (the planner's output, and the only form that is
traceable sentence by sentence); `paragraph` speaks script narration that cannot
be addressed by sentence id (a legacy v1 script artifact, or a hand-written plan)
and the validator checks the words appear in the script instead; `transition`
speaks a section's spoken bridge, which is where the audience hears it.

---

## 3. Timing (`packages/scenes/src/timing.ts`)

Durations are integers of 0.1 s, which is what makes the timeline checkable:

```
narrationDs   = round(words ÷ wordsPerSecond × 10)
sceneDs       = max(round(type.minDurationSec × 10), narrationDs + round(type.holdPaddingSec × 10))
startDs(n+1)  = startDs(n) + sceneDs(n)
totalDuration = Σ sceneDs ÷ 10
```

200 scenes of 0.1 s add up to exactly 20 s (a float sum does not), so the
validator checks `startSec`, `totalDurationSec` and every animation boundary
against the arithmetic rather than tolerating drift. The padding is _reading
room_: an `EVIDENCE` card holds 1.2 s past its narration, a diagram 1.5 s — the
time a viewer needs to read a card or follow a chart.

Validation tolerances are explicit and small: `toleranceSec` 0.2 for rounding,
`extraHoldSec` 1.5 for a deliberate beat, `longSceneSec` 20 for the soft
"worth an editor's eye" warning.

---

## 4. Validation (`packages/scenes/src/validate.ts`)

Two layers, one vocabulary:

1. **`SceneManifestSchema`** — shape. Unknown fields, wrong enums, out-of-range
   numbers, and the cross-block rules that hold for any manifest: unique scene
   ids, `index === position`, transitions chained to the next scene, characters
   that exist in the cast, assets that exist and belong to the scene that uses
   them, animation ids unique/ordered/inside their scene, narration kind that
   fits the type, `words` that match `text`, cuts without duration.
2. **`validateSceneManifest(input, {script})`** — everything that needs the script
   or arithmetic: scene duration against the narration it carries (floor _and_
   ceiling), asset `minDurationSec` against the scene it fills, the timeline and
   the total, narration resolved against the script (sentence ids exist, the text
   matches verbatim, a bridge matches its section), claim/source references
   resolved against the ledger (claim exists, the quotation is the ledger's
   excerpt, the source backs a claim), evidence cards and data diagrams that cite
   nothing, and the soft pacing/leftover notes.

Both layers report the same coded issues, so nothing downstream has to read a zod
message to know what kind of thing is wrong. 31 codes, 27 of them hard:

| Code                     | Severity | Code                            | Severity |
| ------------------------ | -------- | ------------------------------- | -------- |
| `invalid_manifest`       | hard     | `unknown_asset`                 | hard     |
| `unsupported_scene_type` | hard     | `unowned_asset`                 | hard     |
| `empty_manifest`         | hard     | `duplicate_asset_id`            | hard     |
| `duplicate_scene_id`     | hard     | `orphan_asset`                  | soft     |
| `invalid_timeline`       | hard     | `unknown_scene`                 | hard     |
| `invalid_duration`       | hard     | `unknown_character`             | hard     |
| `duration_mismatch`      | hard     | `unused_character`              | soft     |
| `long_scene`             | soft     | `unknown_claim`                 | hard     |
| `missing_narration`      | hard     | `unknown_source`                | hard     |
| `dangling_narration`     | hard     | `missing_source_refs`           | hard     |
| `narration_mismatch`     | hard     | `invalid_animation`             | hard     |
| `missing_characters`     | hard     | `invalid_transition`            | hard     |
| `missing_text`           | hard     | `dangling_transition`           | hard     |
| `missing_diagram`        | hard     | `unknown_character_definition`  | hard     |
| `missing_assets`         | hard     | `character_definition_mismatch` | hard     |
|                          |          | `missing_character_definition`  | soft     |

A report is `{ok, issues, stats}`: `ok` is false when any hard issue is present,
and `stats` counts scenes, scenes by type, assets, words and total duration — the
numbers a status view wants without re-walking the document.

Two rules about severity are deliberate. **Shape failures are hard**: if the
document does not parse, the report contains the schema's issues and nothing else,
because arithmetic over an unparseable timeline would be noise. **Soft notes never
fail a parse**: `long_scene`, `orphan_asset` and `unused_character` are notes, so
they live in the validator, not in the schema — a manifest that is merely worth
reviewing must still be storable and readable (a rule learned the hard way, CI-17).

Three checks only run when the caller passes the character library the plan's cast
must resolve against (`{characters}` — `@nexus/characters`' `CharacterLibrary`,
consumed structurally so this package depends on no other). Without it, a cast
member is just a name: `unknown_character_definition` (a cast member the library
has never heard of), `character_definition_mismatch` (the recorded hash is stale —
the character changed since the plan) and `missing_character_definition` (nothing
recorded to check). With it, a plan that was made against an older revision of a
character is caught before anything is rendered from it; see
[`character-system.md`](./character-system.md).

---

## 5. Persistence and the stage

The manifest is one CAS artifact — `kind: "scene_graph"`, role
`scene_manifest` — registered with the metadata a status view wants without
opening the blob (duration, fps, frame size). `persistSceneManifest()` validates
before writing; `loadSceneManifest()` validates on read; `sceneManifestArtifactRef()`
is what the step reports.

**No `scenes` rows are written yet, and this is deliberate (OD-19).** The `scenes`
table's `kind` CHECK constraint knows five values (`title | talk | fact | media |
quote`), and widening a CHECK means rebuilding the table — approval-gated since
Phase 2 (OD-10). The six-type vocabulary is richer, so the mapping lives in
`legacySceneKind()` and the rows can be written by the stage that actually
consumes them (media sourcing / rendering) without re-deriving anything.

The `plan` stage (`createScenePlanTask`) needs **no provider at all**: it reads
the script the `script` stage published (from its step output, or
`params.scriptHash`), plans, validates, stores and reports. The stage graph already
declares it: running `PLANNING`, complete `PLAN_COMPLETE`, episode
`SCENE_PLANNING → MEDIA_GATHERING`, producing `["scene_graph"]`.

There is nothing to park on — no human input, no quota, no model — so the stage has
no gates. What it does have is **reporting**: a manifest that fails its own
validation is still stored (so an operator can see exactly what is wrong) and its
issue count, by-type counts and asset list travel in the step output and the job
log. A permanent failure is reserved for the things retrying cannot fix: no script
to plan, a script hash not in the CAS, or a planning configuration that cannot work
(an empty cast for a script that needs a presenter).

Reuse is guarded: a previous `plan` step is adopted only if its artifact still
parses out of the CAS **and** contains scenes.

---

## 6. Verification

`pnpm verify` green: **34 files / 448 tests** (Phase 6 was 30 / 359). The scenes
package contributes 4 files / 89 tests, all offline — no API key, no network, no
paid call, no rendering:

| Area                            | What is asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type rules (`plan.test.ts`)     | Each visual kind maps to the documented type; all six types appear in one planned fixture; camera shots/movements vary; every animation event fits its scene; seams cut inside a run and dissolve across types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Timeline and content            | The timeline is gapless and the total is the sum; narration is the script's sentence verbatim, with sentence ids; claims and their evidence are copied verbatim; text is never invented; diagrams cite their claims; assets are planned with hints, durations and ownership; determinism over two runs                                                                                                                                                                                                                                                                                                                                                                                         |
| Failure paths                   | Wrong hash, impossible pace, nonsense fps/transition length, an empty cast for a presenter scene — each throws `ScenePlanError` with a readable message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Contract (`schema.test.ts`)     | Defaults filled; the closed six-type vocabulary; strict objects at 11 levels; canonical bytes round-trip; helpers; the timing arithmetic (deciseconds, drift-free addition)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Validation (`validate.test.ts`) | A valid planned manifest and a hand-written one; invalid manifests (empty, unknown field, index, duplicate id, broken chain, unknown character, missing required block, uncited figure/diagram, dangling claim/source); missing assets (unknown, unowned, duplicate, orphan-soft, footage too short); invalid durations (too short, over-held, total mismatch, animation outliving its scene, cut with duration, soft long scene, estimate mismatch); missing narration (no sentence, wrong words, unknown sentence, word count, wrong bridge, unmatchable paragraph); unsupported scene types (unknown type, narration that does not fit, all six accepted); issue severities and attribution |
| The stage (`task.test.ts`)      | Inside the real job runner: the plan reads the previous stage's script artifact and completes; artifact kind/role and metadata; the CAS bytes read back; the step output the media stage consumes; permanent failures (no script, missing blob, impossible cast); params-only script hashes; the reuse guard                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 7. Deliberately not in this phase

- **No renderer, no media fetch, no voice.** Nothing draws, downloads or speaks.
  Assets stay `status: "planned"` with an empty `uri`; camera, animation and
  transition fields are data with no executor (GAP-20).
- **No `scenes` rows.** The manifest is the artifact; the table's kind constraint
  is unresolved by approval (OD-19).
- **No diagram data.** `series[]` is empty because a research claim is a statement,
  not a table: plotting needs a data-extraction step that does not exist yet
  (GAP-21).
- **No licence enforcement.** Assets default to `licence: "unknown"`; the media
  stage owns licence policy (AD-09, GAP-22).
- **Durations are estimates.** Words ÷ 2.5 words-per-second is a planning number;
  the real timings arrive with the voice stage.
- **No semantic check between text and narration.** A claim card shows the claim's
  own wording, but nothing verifies the sentence beside it paraphrases it
  faithfully (GAP-19, GAP-23).

## 8. Related documents

- `docs/architecture/character-system.md` — the definitions the cast references
  point at, and the sync that resolves them.
- `docs/architecture/script-engine.md` — the document this phase plans from.
- `docs/architecture/research-engine.md` — where claims and evidence originate.
- `docs/architecture/job-orchestration.md` — stages, fingerprints, artifact reuse.
- `docs/plans/000-architecture-discovery.md` §6.1 / §11 — the scene-graph intent.
- `docs/architecture/render-engine.md` — what a frame does with this document.
- `docs/plans/ISSUES.md` — OD-19…OD-21 (planning), GAP-20…GAP-23, CI-17…CI-21, the
  phase 8 entries OD-22…OD-23, GAP-24…GAP-26, CI-22…CI-24, and the phase 9 entries
  OD-24…OD-26, GAP-27…GAP-33, CI-25…CI-29.
