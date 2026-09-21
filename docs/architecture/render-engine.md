# The animation & composition engine (Phase 9)

`@nexus/render` turns a validated **scene manifest** (Phase 7) plus the
**character library** (Phase 8) into **frames** and, from those, into **SVG**.

This document is the reference for that engine: what a frame document contains,
how blocking, camera, text and animation are decided, what is deterministic about
it, and what Phase 9 deliberately leaves to later phases.

The one-line contract:

```
scene manifest + character library  →  timeline → frames (documents) → SVG
```

Nothing in this package reads a database, a provider or the network, and nothing
writes a video file: a **frame is a document**, and turning documents into pixels
is a later stage's job.

---

## 1. Why an engine at all (and what it is not)

The scene manifest says _what_ is on screen — who appears, what they are doing,
what the camera is doing, what text is shown, which animation events play and how
the scene hands over to the next. It deliberately contains **no coordinates**:
`camera` is a setup (shot, movement, angle, focus), `characters` is a cast entry
plus a state, `text` is words and a position.

Composition is therefore a _pure projection_ of the manifest into frame documents:

| Step        | Module           | What it does                                                                         |
| ----------- | ---------------- | ------------------------------------------------------------------------------------ |
| Timeline    | `timeline.ts`    | rounds the manifest's timings into whole frames, indexes scenes and their events     |
| Blocking    | `layout.ts`      | where the cast stands, from cast count, shot and who is presenting                   |
| Camera      | `camera.ts`      | a camera state per frame (aim, scale, rotation) and its application to every element |
| Text        | `text.ts`        | type size, wrapping/fitting, `count_up` numbers, `type_on` reveal                    |
| Animation   | `animation.ts`   | folds every applicable event into one `AnimState` at a moment                        |
| Performance | `performance.ts` | cast entry + state + overrides → a resolved character (layers, pose, expression)     |
| Composer    | `compose.ts`     | one frame document: elements, transforms, opacities, reveals, diagnostics            |
| Writer      | `svg.ts`         | a frame document → SVG (and a storyboard of sampled frames)                          |

None of it renders a whole video, and none of it is a video pipeline: there is no
encoder, no job stage, no artifact, no DB row and no cache (see §10).

---

## 2. The frame document (`compose.ts`)

`composeFrame(timeline, index, deps)` returns a `Frame`:

| Field                                                           | Meaning                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `index`, `timeSec`, `fps`                                       | where the frame is in the video                                            |
| `sceneId`, `sceneIndex`, `sceneType`, `localSec`, `durationSec` | where it is in its scene                                                   |
| `resolution`, `background`                                      | the canvas and the look's background                                       |
| `camera`                                                        | `{shot, movement, angle, focus, scale, aim, rotationDeg}`                  |
| `elements[]`                                                    | every drawable thing, `z` ascending                                        |
| `transition`                                                    | the outgoing seam: `{kind, durationSec, toSceneId, progress, mix}`         |
| `narration`                                                     | the scene's spoken words, word count and sentence ids (for captions/voice) |
| `diagnostics[]`                                                 | what could not be drawn, and why                                           |

Two conventions hold everywhere: **frame pixels** with **y growing downwards**
(SVG and every raster format), and **transforms about an origin** — an element's
own box is drawn at `(x, y)`, scaled, and rotated about `origin`, expressed as a
fraction of that box, so `{x: 0.5, y: 1}` means "the bottom centre of the
element stays put" (which is how a figure keeps its feet on the ground).
`Transform.scale` is _pixels per source pixel_: a character's SVG canvas is
`512 × 1024`, so a figure that should occupy 84% of a 1080-line frame carries
`scale ≈ 0.886` — times the camera.

Elements are one of five kinds: `character`, `text`, `diagram`, `media`,
`effect` (the card a `callout` draws behind on-screen text).

### Draw order

|     z | Layer                                           |
| ----: | ----------------------------------------------- |
|     5 | media as a background                           |
|     6 | media full frame                                |
|    10 | characters standing behind (the listening side) |
|    20 | characters in front (the presenting side)       |
|    25 | split-screen media, diagrams                    |
|    30 | callout cards                                   |
| 35–36 | overlay and picture-in-picture media            |
|    40 | on-screen text                                  |

Ties keep build order, so the order inside a layer is the order the scene lists it.

---

## 3. Blocking (`layout.ts`)

A scene says _who_ and _what state_; blocking turns that into positions.

- **How many** cast members are on screen decides their centres: one at `0.5`,
  two at `0.34 / 0.66`, three at `0.22 / 0.5 / 0.78`, and beyond three evenly
  spread across `0.16 … 0.84`.
- **The shot** decides how tall the figure stands (as a fraction of the frame):

  | shot   | wide | medium | medium_close | close_up | extreme_close_up | over_shoulder |  pov | insert |
  | ------ | ---: | -----: | -----------: | -------: | ---------------: | ------------: | ---: | -----: |
  | height | 0.58 |   0.72 |         0.84 |     0.98 |             1.15 |          0.88 | 0.70 |   0.48 |

  Because the height comes from the shot rather than from the artwork, two
  characters with different canvases still stand the same height.

- **Who is presenting** — the first cast member in `talking`, `gesturing`,
  `pointing` or `entering` — stands in front (`z = 20`, full opacity); everyone
  else listens from behind (`z = 10`, `0.94 ×` height, `0.86` opacity, lifted
  `1.5%` up the frame to read as further away).
- Figures' anchor points all land on `GROUND_Y = 0.94`, the scene's floor.

A definition's own `placement.scale` multiplies the blocked height, so a character
authored smaller or larger keeps that intent inside the shot's framing.

---

## 4. Camera (`camera.ts`)

Per frame: `aim` (a fraction of the frame), `scale` and `rotationDeg`.

- **Focus** decides what the camera points at: `presenter` and `action` aim at the
  presenting character's own x (and `0.55` down the frame), `screen` aims at the
  on-screen text's centre, `diagram` at the middle with `1.04 ×`, `background`
  slightly up at `0.96 ×`.
- **Movement** is a deterministic excursion _around_ that aim, over the scene's own
  duration, eased (default `easeInOut`):

  | movement                  | effect from scene start to end                                     |
  | ------------------------- | ------------------------------------------------------------------ |
  | `static`                  | nothing                                                            |
  | `pan_left` / `pan_right`  | aim x `+4% → −4%` / `−4% → +4%`                                    |
  | `tilt_up` / `tilt_down`   | aim y `+4% → −4%` / `−4% → +4%`                                    |
  | `dolly_in`                | scale `1 → 1.08` and aim y `0 → +1.5%`                             |
  | `dolly_out`               | the mirror image of `dolly_in`                                     |
  | `zoom_in` / `zoom_out`    | scale `1 → 1.14` / `1.14 → 1`                                      |
  | `crane_up` / `crane_down` | aim y `±6%` and scale `1 → 1.03`                                   |
  | `handheld`                | `±0.4%` breathing on fixed sine/cosine frequencies (no randomness) |
  | `whip_pan`                | aim x `−8% → +8%`, `easeOut`                                       |

- **Angle** tilts or lifts the frame: `dutch` rotates 3°, `high`/`overhead` raise
  the aim, `low` lowers it.

Applying the camera is a similarity transform about its aim: every element's
position is shifted and scaled, and every element's _scale multiplies_ — which is
what makes a dolly read as the frame moving rather than each element separately
deciding to grow.

---

## 5. Animation (`animation.ts`)

The manifest's animation events are folded, not simulated. For any moment, each
event that applies to an element contributes to one `AnimState`:
`{opacity, offsetX, offsetY, scale, rotationDeg, reveal, highlight, typeOn, countUp}`.

Three properties make the fold trustworthy:

1. **Cumulative and monotone.** A finished `fade_in` stays at opacity 1; a
   finished entrance stays revealed; a `pulse` returns to exactly 1 (`sin(π·t)`).
2. **Local time.** An event's `atSec` is seconds from its own scene's start, so an
   event folds identically wherever the scene sits in the video.
3. **Pure.** Same events, same moment, same resolution ⇒ same state.

| kind                                | what it does                                                   | params                                     |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| `fade_in` / `fade_out`              | opacity `e` / `1 − e`                                          | —                                          |
| `dissolve_out`                      | as `fade_out` (a rasteriser may add grain)                     | —                                          |
| `slide_in` / `slide_out`            | offset from / to an edge, default 25% of the frame             | `from`, `distance`                         |
| `push_in`                           | scale `0.85 → 1` and a small lift into place                   | —                                          |
| `scale_in`                          | scale `0.55 → 1`, `easeOutBack` (a little overshoot)           | —                                          |
| `wipe_in` / `split_open`            | reveal a fraction left-to-right / from the centre out          | —                                          |
| `zoom_to`                           | scale `1 → params.scale` (default 1.12) and holds              | `scale`                                    |
| `pulse`                             | scale `1 + amount·sin(π·t)`, back to 1                         | `amount`                                   |
| `rotate`                            | rotation `from → to` degrees                                   | `from`, `to`                               |
| `type_on`                           | reveals the card's characters progressively                    | —                                          |
| `count_up`                          | runs a number through the card's `{n}` template                | `from`, `to`, `decimals`, `unit`, `prefix` |
| `highlight`                         | fades in the band behind the type and keeps it                 | —                                          |
| `lower_third`                       | a text card that lifts and fades in                            | —                                          |
| `callout`                           | draws a card behind its target (a derived `fx:<id>` element)   | —                                          |
| `pose_change` / `expression_change` | switches the character's performance from the moment it starts | `pose`, `expression`                       |

**Scene-targeted events are folded once, by the frame** (every element inherits
that state); element-targeted events are folded per element. That split is what
stops a scene-wide `fade_in` from being applied twice to a character that an event
of its own also touches. Easing is owned by the compositor (per kind), not by the
manifest: a `fade_in` feels the same in every scene that uses one.

---

## 6. Text (`text.ts`)

The manifest gives words, position, `maxLines` and attribution; the engine decides
type size, wrapping and reveal.

| kind      | size (× frame height) | weight | note                     |
| --------- | --------------------: | -----: | ------------------------ |
| `title`   |                 0.085 |    700 |                          |
| `claim`   |                 0.050 |    600 |                          |
| `quote`   |                 0.045 |    500 | italic, with attribution |
| `number`  |                 0.125 |    800 | the `count_up` target    |
| `label`   |                 0.038 |    600 |                          |
| `callout` |                 0.042 |    600 |                          |

Positions are frame fractions: `lower_third`, `upper_third`, `center`, `corner`,
`full_screen`. Wrapping cannot be exact without the font file, so the engine
documents its approximation — an average glyph is `0.55 × fontSize` wide — and
fits the words in stages: wrap, then shrink through `1.0, 0.9, 0.8, 0.7, 0.6`,
then truncate at `maxLines` with an ellipsis **and** a `text_overflow`
diagnostic. Nothing is ever silently cut.

`count_up` replaces `{n}` in the card's words with the animated number; a card
without `{n}` shows the number instead, and says so with a
`defaulted_parameter` diagnostic. `type_on` reveals characters line by line, so a
partially typed card never shows a half line that has not started.

---

## 7. Performances (`performance.ts`)

A cast entry is `{characterId, state}`. The stage:

1. asks the character system for the state's performance (`selectionForState`),
   which records a note for any variant the character does not have,
2. applies whatever `pose_change` / `expression_change` events have started by
   this moment (the last one wins),
3. resolves through `CharacterLibrary.resolve`, and
4. **falls back rather than failing**: an unresolvable selection retries with the
   definition's own `defaultPerformance`, and every fallback becomes a note the
   frame carries as a diagnostic.

The frame then carries the resolved pose, expression, gesture, clothing,
accessories, facing, palette, canvas, anchor and the ordered layer list — with
each layer's `assetId`, `path`, `hash` and size. The compositor never invents a
variant and never copies a definition: a scene references a character, and the
library decides what that looks like.

---

## 8. Transitions (`timeline.ts`)

A scene's `transition` describes the seam at its end: it starts
`durationSec` before the scene ends and runs to the end. `progress` is linear over
that window; `mix` is the same ramp eased (`easeInOut`, or `easeIn` for
`match_cut` / `zoom_through`) and is what a renderer mixes with. A `cut` has no
seam at all — `progress 0`, `mix 0` — and a renderer simply swaps frames. The
_incoming_ half of a seam belongs to the next scene's own transition, so a
dissolve is one scene's tail mixed with the next scene's head.

---

## 9. Diagnostics

Composition is **total**: nothing throws because a scene asked for something that
is not there; the frame says what it could not draw.

| code                     | severity | meaning                                                                                                                 |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `missing_character`      | warning  | the cast names somebody the library does not have (or cannot resolve at all)                                            |
| `unresolved_performance` | warning  | the performance fell back to the definition's defaults (with the reason)                                                |
| `unknown_target`         | warning  | an animation event names an element this scene does not show                                                            |
| `kind_not_applicable`    | warning  | e.g. `type_on` aimed at a character                                                                                     |
| `missing_asset`          | error    | a layer the frame draws has no readable file behind it (raised by the writer/verifier, the only place that reads bytes) |
| `text_overflow`          | warning  | the card did not fit and was truncated at `maxLines`                                                                    |
| `defaulted_parameter`    | warning  | an event parameter was missing, so the documented default applied                                                       |

---

## 10. Determinism, digests and what is _not_ here

Every number that reaches a frame is rounded to three decimals, and
`frameDigest`/`composeScene` hash the canonical JSON of the frames. Same manifest,
same library ⇒ same frames, same digest, on any machine — so a change in blocking,
a camera curve, an easing or a character layer shows up as a different hash
instead of a subtle drift nobody notices.

Deliberately **not** in Phase 9:

- **No rasteriser, no encoder, no video file.** Frames become SVG; PNG/MP4 need a
  rasteriser and an encoder (GAP-27) — the sandbox has neither.
- **No persistence and no pipeline stage.** No artifact kind, no DB row, no
  `render`/`compose` task in the job graph; the engine is a library used by tests
  and one tool (GAP-29).
- **No frame cache, streaming or parallelism.** `composeVideo` composes frames in
  memory; a ten-minute video would be ~18 000 documents (GAP-28).
- **No real text shaping.** Font metrics are approximated, no font is embedded, and
  there is no line-breaking beyond spaces (GAP-30).
- **No audio, captions or narration timing.** The frame carries the narration for
  those stages; nothing syncs frames to real voice timings (GAP-31).
- **No media or diagram drawing.** Media renders as a labelled placeholder until
  the media stage fills a `uri`; diagrams draw a minimal panel because `series[]`
  is still empty (GAP-32).
- **No continuity between cuts.** A pose changes when an event says so; two scenes
  that show the same character in different outfits/poses are not compared
  (GAP-33), and there is no rig, tweening or lip sync (GAP-24).
- **No golden-frame comparisons.** The smoke test asserts the numbers and the
  structure of frames; a byte-exact reference render waits for the rasteriser.

---

## 11. The demonstration scene

`packages/render/demo/scene.json` is one complete, hand-written scene — the thing
Phase 9 exists to prove. It is a `HYBRID` scene, `11.5s` at `30fps` (**345
frames**), with:

- **two characters** from the Phase 8 demonstration set: Maya (`talking`, stands
  in front) and Tomás (`listening`, stands behind), both referenced by id with the
  definition hash they were planned against — no definition copied into the
  manifest;
- **one on-screen number card** that is typed on, counted up to the frame count and
  called out with a card;
- **one generated plate** as media (an overlay), which wipes in;
- **twelve animation events** covering opacity, position, scale, rotation, pose,
  expression, text and camera movement;
- **a camera** on `medium_close / dolly_in / eye_level / presenter`;
- **a trailing `fade_to_black`** seam of `0.8s`.

Its narration and on-screen text are **synthetic and say so**: the scene exists to
prove the engine, not to state a fact, and its `scriptHash` is the hash of the
fixture document id rather than of a real script (OD-26). Both are recorded in the
scene's own `notes`.

### Running it

```bash
corepack pnpm verify                                  # format + lint + types + 47 suites
corepack pnpm exec vitest run packages/render/src/demo.test.ts   # the smoke test
corepack pnpm build && node packages/render/tools/compose-demo.mjs
```

The tool writes `data/render-demo/` (git-ignored): `storyboard.svg` — a contact
sheet of sampled frames, one file showing the whole scene — plus `frames.json`
(the frame documents) and four full-resolution frames. Expected summary:

```
scene            scn_demo_composite — HYBRID, 11.5s at 30fps
frames           345 composed (345 in the timeline)
characters       tomas (stand, engaged), maya (walk, explaining)
assets           16 layers drawn, 16 verified against the definitions
animation        12 events: fade_in, slide_in, lower_third, type_on, wipe_in, ...
camera           medium_close / dolly_in / eye_level / presenter
diagnostics      none
```

(No rasteriser is installed in this environment, so a browser or Inkscape is what
draws those SVG files.)

---

## 12. How this was verified

| Area                | Evidence                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest → timeline | frame partitioning has no gaps or overlaps; scene lookups by frame and by time; seam progress/mix on cuts and fades                                                                     |
| Asset resolution    | the smoke test loads the real library (38 layers), composes all 345 frames, then reads **every** layer the frames drew back through `readCharacterAsset`, which re-checks size and hash |
| Position / scale    | blocking tests per cast size and shot; a camera-undo helper asserts a figure's anchor lands exactly where blocking put it                                                               |
| Rotation / opacity  | fold tests per kind; frames show a `rotate` settling to level and a scene-wide `fade_in` reaching full opacity                                                                          |
| Pose / expression   | `pose_change` and `expression_change` are visible in the frames (layer paths change; the expression switches at the event's second)                                                     |
| Text                | wrapping/fitting/truncation, `count_up` arithmetic, `type_on` reveal across lines, escaping in the writer                                                                               |
| Camera movement     | every movement's excursion and end state; the dolly ramp; determinism of the handheld breathe                                                                                           |
| Transitions         | seam arithmetic and easing, and the ramp measured on real frames                                                                                                                        |
| Composited scene    | element kinds, `z` order, two-character two-shot, effect card, media plate and text card in every frame                                                                                 |
| Diagnostics         | missing character, unknown target, non-applicable kind, text overflow, defaulted parameter, unreadable layer                                                                            |
| Determinism         | two full compositions of the demo scene compare equal, digest included; SVG output is byte-identical between runs                                                                       |

---

## 13. Related documents

- `docs/architecture/scene-manifest.md` — the input contract.
- `docs/architecture/character-system.md` — where performances and layers come from.
- `docs/plans/ISSUES.md` — OD-24…OD-26, GAP-27…GAP-33, CI-25…CI-28.
- `docs/plans/000-decisions.md` — AD-07 (deterministic code), AD-01 (modular monolith).
