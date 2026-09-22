# The shorts engine (Phase 14)

`@nexus/shorts` turns a **finished long-form episode** — its scene manifest and
its real narration track — into vertical short-form plans. It answers two
questions with deterministic, reviewable data:

1. **Which moments stand alone?** (`selectShorts`) — scored, scene-aligned
   candidate spans, with the moments that _depend on the surrounding episode_
   rejected outright, with the reason.
2. **What does each moment look like in 9:16?** (`verticalReflow`) — a
   re-composed, re-timed vertical manifest, plus the framing decisions as data.

```
long-form manifest ─┬─► selectShorts ──► ShortsPlan (candidates ≤ maxCandidates + rejections)
narration track ────┘        │
                             └─► verticalReflow ──► 9:16 manifest + VerticalLayout + re-based track
                                                    (same audio bytes, new clock)
```

One package, no new pipeline: the `shorts_v1` stage graph already exists in
`@nexus/jobs` (`short_analyze → … → short_publish`); this package is the engine
its stages will call.

## 1. Selection (`select.ts`)

`selectShorts({ manifest, track }, { config?, now?, source? }) → ShortsPlan`.

- **Candidates are contiguous scene spans**, enumerated between the config's
  duration bounds (default 15–60 s) — never fixed-length chunks. Timecodes come
  from the _spoken_ windows (`sceneWindowsOf`), so a scene the TTS read faster
  than planned is cut where the speech ends.
- **Seven weighted factors**, each returning its score **and the reasons it
  fired** (hook, curiosity, surprise, standalone, payoff, emotion, visual).
  The engine emits exactly `SHORTS_FACTOR_CODES`, in order, for every candidate.
- **Context verdicts reject whole spans** — a clip that leans on missing context
  is not "scored low", it is _rejected_ with a code and the reason:
  `context_opener_unresolved` (opens on a bare pronoun: "It turns out…"),
  `context_connective_open` ("But the numbers…"), `context_backward_reference`
  ("as we saw earlier"), `context_unfinished_contrast` (ends on ", but"),
  `context_dangling_promise` ("stick around…"). A demonstrative **with its
  noun** ("This bridge carries forty thousand…") resolves itself and passes.
  Softer problems — starting mid-section, a leaning opener — become a
  `contextPenalty` recorded on the score.
- **Selection** is best-first over non-overlapping index ranges, up to
  `maxCandidates` (default 3, hard cap 12). The plan records `considered` and
  `provenance.deterministic: true`.
- Every candidate carries its span's `claimIds`/`sourceIds` (from the scenes'
  claim references), its transcript with per-sentence timings, and the topic
  keyword (`topicKeywordOf`) the standalone factor used.

## 2. The 9:16 reflow (`layout.ts`)

`verticalReflow({ manifest, track, candidate }, { canvas?, manifestHash?, now? })`
produces `{ manifest, layout, track, warnings }`. **It is not a crop.** Each
scene is re-composed:

| Decision             | Rule (recorded with a `reason`)                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera               | wide → medium; a focus-following window (`focusOf`: the presenting character's slot, else the text anchor, else the media bias, else centre) sized by shot — the window is clamped into the frame |
| Text cards           | corner → `lower_third`; the narrow frame gains a line (≤ 6)                                                                                                                                       |
| Media                | `split_screen`/`picture_in_picture` → `overlay` (side-by-side becomes stacked)                                                                                                                    |
| Diagrams             | flow `vertical` (top-to-bottom restack)                                                                                                                                                           |
| Safe area / captions | top 8%, bottom 18% (UI chrome / captions), `captionBand` at y=0.8, `captionStyle` fontPx 58, margin 210 — sized for a 1080×1920 canvas, not the 16:9 fixtures                                     |

Timing is re-planned to the **speech**: each scene's duration is its spoken
length (≥ 0.4 s) but never below its scene-type minimum hold (`SCENE_TYPE_SPECS`
— the same floor the scenes validator enforces). The manifest re-declares a
words-per-second every scene honestly spoke at (the fastest scene's rate plus
headroom inside the validator's estimate tolerance), so the vertical manifest
passes `validateSceneManifest` — same rules, new shape.

The narration track is **re-based, not re-synthesised**: segments keep their
audio hashes/bytes and their offset _within_ the scene, landing on the scene's
new vertical start; sentence windows shift with them; totals are recomputed;
`withManifestHash(track, hash)` stamps the persisted vertical manifest's hash.

## 3. Provenance & schema (`schema.ts`)

`ShortsPlan`, `ShortsCandidate`, `ShortsRejection`, `ShortsFactor`,
`VerticalLayout` are strict zod documents with engine provenance
(`nexus-shorts@1.0.0`). Candidate ids are `short_<slug>_<start>_<end>` from the
manifest topic. The layout records per-scene `previousPosition` /
`previousTreatment` so a reviewer sees what moved, not just where it landed.

## 4. Fixtures & tests

`fixtureEpisode()` builds the six-scene "Why the Kira bridge hums at dusk"
episode over the **real** audio pipeline (`synthesizeNarration` on the
`FakeTTSProvider`), so the selection works on honest timecodes.

24 tests (`select.test.ts`, `layout.test.ts`) hold the engine to: scene-aligned
spans with spoken timecodes; every factor recorded with reasons; per-code
context rejections (and the demonstrative-with-noun non-rejection); mid-section
penalties; non-overlap; config bounds/cap; determinism; claim/source
carry-through; a validating 9:16 manifest (through `validateSceneManifest`);
re-timing to speech + type floors; byte-identical re-based audio; hash stamping;
per-scene re-composition decisions (presenter focus, corner→lower-third,
split→overlay, diagram restack) with reasons; safe-area/caption-band geometry.

## 5. What this phase deliberately does not do

- **No shorts stage tasks / no dashboard surface** — `shorts_v1`'s graph exists;
  wiring its stages into the worker (and an episode-kind "short" flow) is
  pending (see `docs/plans/ISSUES.md`).
- **No 9:16 render run end-to-end in the worker** — the render engine is
  resolution-agnostic (fractional rects/composer), so a short renders with a
  1080×1920 `RenderConfig`; the wiring is the missing piece, not the engine.
- **No publishing** — Phase 15 owns the publishing abstraction's QA gate.
