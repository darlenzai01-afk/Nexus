# The QA engine (Phase 12)

`@nexus/qa` is the gate between "there is a render" and "somebody may publish it":

```
research package ─┐
script ───────────┤                    ┌─► QAReport (qa_report + qa_summary)
scene manifest ───┼─► evidence bundle ─┤    verdict: pass | pass_with_warnings | fail
character library ┘                    │    publishable = no error finding
narration + captions ──┐               │
render metadata + MP4 ─┴─► 5 checks ───┤
job steps + artifacts ────► pipeline ──┘
                                       ▼
                       publishable? ──► the `qa` stage stores the report
                       blocked?    ──► …and fails the job (approval never runs)
```

One workspace package: a **schema** (the report and its code registry), five
**checks** (content, visual, audio, video, pipeline — each a pure function of the
documents it is handed), an **engine** (`runQA`), a **persist** layer (`qa_report`

- a readable `qa_summary`), and a **stage task** (`createQATask`) that wires the
  result into the job graph after `render`.

## 1. What this phase is (and is not)

| Requested                          | Where it lives                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content: missing script sections   | `content_section_missing` (a planned section the script lacks, incl. the required hook/introduction/conclusion roles), `content_section_unplanned` (a section no scene shows) |
| Content: unsupported claims        | `content_claim_unsupported` — a sentence asserting a fact that no cleared claim backs; `content_claim_unreferenced` (warning) — a claim nothing asserts                       |
| Content: missing source references | `content_source_missing` — attributed text, a cited claim or a scene's claim with no evidence behind it                                                                       |
| Content: contradictory information | `content_contradiction` — plan/script hash disagreement, two different statements for one claim id, or a contested claim asserted as settled                                  |
| Visual: missing assets             | `visual_asset_missing` — an asset still `planned`, or a scene that draws its placeholder                                                                                      |
| Visual: broken asset references    | `visual_asset_reference_broken` — a `media.assets` id with no matching asset row                                                                                              |
| Visual: missing scenes             | `visual_scene_missing` — a transition into a scene the plan does not have                                                                                                     |
| Visual: unreadable text            | `visual_text_unreadable` (error) / `visual_text_tight` (warning), measured with the real fonts                                                                                |
| Visual: invalid layouts            | `visual_layout_invalid` — invisible or colliding with the caption band; `visual_layout_clipped` (warning) — partly outside the frame                                          |
| Audio: missing audio               | `audio_missing` (no track), `audio_segment_missing` (a scene with no clip)                                                                                                    |
| Audio: duration mismatch           | `audio_duration_mismatch` (error past the tolerance), `audio_drift` (warning past the warn threshold), per-scene drift beyond its window                                      |
| Audio: unexpected silence          | `audio_silence` — a silent stretch ≥ `silenceWindowSec` inside a spoken scene, found by `silentWindowsOf` (§7)                                                                |
| Audio: invalid audio artifact      | `audio_artifact_invalid` — a clip whose bytes are gone or whose header contradicts the track                                                                                  |
| Video: invalid output              | `video_invalid_output` — no file, not an MP4, truncated box, size/frame-count/mux/hash disagreement with the render metadata                                                  |
| Video: incorrect resolution        | `video_resolution_mismatch` — the track's size against the plan (or the render's recorded output)                                                                             |
| Video: invalid duration            | `video_duration_mismatch` — container vs render record, and container vs the plan's total                                                                                     |
| Video: encoding failure            | `video_encoding_failure` — the render's own hard issues (`HARD_RENDER_ISSUE_CODES` or `severity: "error"`)                                                                    |
| Video: corrupted output            | `video_corrupted` — the parser cannot read the tracks the metadata records                                                                                                    |
| Pipeline: invalid job state        | `pipeline_invalid_state` — running on an expired lease, a step after a failure, an episode state that disagrees with the last completed stage, a `DONE` step with no output   |
| Pipeline: missing artifacts        | `pipeline_missing_artifacts` — a declared produce with no artifact, or an artifact whose bytes the store does not have                                                        |
| Pipeline: incomplete stages        | `pipeline_incomplete_stages` — a required stage with no executed step _between_ the first and last executed stage (§6)                                                        |
| Structured QA report               | `QAReport` — versioned, hashed settings, per-check reports, ordered findings, counts, `blocking[]`, notes                                                                     |
| QA can block publication           | `publishable = counts.errors === 0`; `assertPublishable` throws `QABlockedError`; the `qa` stage fails the job when blocked                                                   |

Deliberately **not** here: a semantic "does the narration _mean_ the claim"
checker (Phase 5's GAP-19 still holds — QA checks the ledger, not paraphrase
semantics), subjective visual quality (GAP-38), ASR verification that a voice clip
says the right words (OD-29), any fixing — QA reports and blocks; repair stays
with the stage that produced the defect.

## 2. The evidence bundle — why the checks are pure

`runQA(evidence, deps, options)` takes **documents that are already loaded** — a
`QAEvidence` of `{manifest, manifestHash, script?, research?, audio?, captions?,
render?, video?, pipeline?}` — rather than paths and hashes it fetches itself.
That makes every check a pure function of its input, which is what lets every
failing case be a small test that hands over one broken document. The two places
where the _bytes_ are the evidence (a clip's PCM, the encoded file) go through the
`deps.storage`/`deps.readFile` seams. The `qa` stage (`task.ts`) is the only place
that knows where the pipeline keeps things, and it assembles the bundle from the
upstream stages' **outputs** (hashes from step outputs, never inferred paths).

A check that cannot run — no script was supplied, no pipeline snapshot in a
standalone run — returns `status: "skipped"` with a note and, when the absence is
itself a defect, a `qa_evidence_missing` warning. **"No findings" always has a
scope attached**: `report.checks[]` says what was examined and what was not.

## 3. The report

`QAReportSchema`: `version` (report format, currently 1), `generatedAt`, `engine`
(`{name: "nexus-qa", version}`), episode/job ids, the `subject` (what was checked,
by hash), the **settings** and their `settingsHash`, the `verdict`
(`pass` / `pass_with_warnings` / `fail`), `publishable` (no `error` finding),
`blocked` (this report refuses publication), deduplicated `blocking[]` codes,
`counts` (`{findings, errors, warnings, infos, checks, skipped}`), per-check
reports, ordered `findings[]` (category → code → subject → message), and `notes`
(what a reader should know that is not a finding — e.g. what could not be read).

Findings are sorted deterministically (`compareFindings`), and the only value that
varies between two runs of the same evidence is `generatedAt` — overridable via
`deps.now`, which is what keeps fixtures byte-reproducible. `settingsHash` makes a
stored report name the rules that produced it: relax a threshold and every verdict
after that is traceably a different measurement.

`describeBlocking(report)` renders the one-line "why" that goes into the stage
error; `qaSummaryMarkdown` renders the human-readable summary artifact.

## 4. The code registry

`QA_CODES` (35 entries) is the single table of every finding: category, severity —
and therefore whether it blocks. `error` blocks; `warning` is recorded for a
human; `info` is context. Only two meta codes are not about the episode itself:
`qa_evidence_missing` (warning; something QA should have had is absent) and
`qa_check_skipped` (info; the note says why). The full registry is §1's table plus
`visual_text_undrawable` (warning: text with no drawable lines — an empty value or
no glyphs) and `audio_unmeasurable` (warning: the track's own metadata cannot be
verified against bytes).

Hard/soft is data, not code: `HARD_QA_CODES` / `isHardQACode` derive from
`QA_CODES`, so adding a blocking rule is one schema entry plus the check that
emits it.

## 5. The checks

Each check walks one category and reports `examined` (what it actually looked at,
so a skipped check is visible as `examined: 0`).

**Content** (`content.script`) reads the script against the research package and
the plan: every planned section present (with the required roles), every claim
either cleared by evidence (a `fact` sentence must cite a cleared claim) or
attributed, every `sourceIds` entry resolvable, every scene's claim wording
identical to the script's, no disagreement between documents
(non-empty `manifest.scriptHash` ≠ script hash ⇒ `content_contradiction`), and
the script's own lint issues that survived the corrective round reported as
`content_quality_issue` (warning).

**Visual** (`visual.frames`) composes the plan with Phase 9 (`buildTimeline` +
`composeVideo` — the same frames the renderer draws) and measures them:

- asset rows must be `resolved` (a `planned` asset is `visual_asset_missing` twice
  over: the row, and the placeholder the scene draws in its place);
- every `media.assets` id must have a matching asset row for that scene;
- a transition's `toSceneId` must exist (`visual_scene_missing`);
- text is measured **as ink, not boxes** (§8): height below `minFontPx` is
  `visual_text_unreadable`, below `tightFontPx` a `visual_text_tight` warning,
  and a text with no drawable lines is `visual_text_undrawable`;
- layout: an element whose ink lies wholly outside the frame is
  `visual_layout_invalid` (it is never seen — an error); partly outside (1 px
  tolerance) is `visual_layout_clipped` (a warning — a camera crop is a look, not
  a defect); a burned-in caption colliding with on-screen text is
  `visual_layout_invalid`, because the two renders are unreadable _together_.

**Audio** (`audio.track`) verifies the narration track against its clips and the
plan: every scene voiced, measured durations within `durationToleranceSec`
(error) / `durationWarnSec` (warning), per-scene windows within
`sceneDriftToleranceSec`, clips present in the CAS with headers that agree with
the track, and silence — `silentWindowsOf` reports runs of RMS <
`silenceRms` at least `silenceWindowSec` long inside a spoken scene. A clip that
is _entirely_ silent fails `minClipRms` and is a defect, not a style.

**Video** (`video.output`) reads the delivered file — from disk or from the CAS by
hash — parses it with the renderer's own MP4 parser, and compares three ways:
container vs render metadata (size, duration ± `videoToleranceSec`, frame count,
audio track presence, byte size, mux/hash agreement), container vs plan
(resolution, total duration), and render metadata vs episode (the burned caption
track must be the captions artifact's track: `video_captions_missing`; a
`render.manifestHash` that is not this plan's hash is `video_invalid_output` —
"was rendered from plan …"). The render's own hard issues become
`video_encoding_failure`; a file without a leading `moov` box earns the
`video_not_streamable` warning (it plays, but a player must download it whole).
A file smaller than `minVideoBytes` cannot be a video at all.

**Pipeline** (`pipeline.state`) reads the job's own records: step states and
leases, episode state vs the last stage that completed, declared produces vs
registered artifacts (and artifact hashes vs bytes actually in the store — a hash
without bytes looks complete until someone tries to publish), and stage coverage:
a required stage with no executed step **between the first and last executed
stage** is a hole in the middle of the run (`pipeline_incomplete_stages`); stages
not yet reached report nothing, because "not yet" is honest.

## 6. Blocking

`publishable` is computed, never authored: `counts.errors === 0`. Three layers
enforce it:

1. `assertPublishable(report)` throws `QABlockedError` (with
   `describeBlocking`'s one-liner) — the guard any publisher calls, so a caller
   that forgets to read the verdict still cannot ship a blocked episode.
2. `persistQAReport` writes the report and summary **either way** — a blocked
   episode is precisely when the operator needs the report — and
   `validateReuse` refuses to adopt a previous QA result whose report is blocked
   or whose inputs changed.
3. `createQATask` (stage key `qa`, after `render`, before `approval`) stores the
   report and then **throws `PermanentError` when the report refuses publication**:
   the step fails, the job fails, the episode lands in `FAILED`, and
   `approval`/`publish` never run. The stage's output carries the verdict and the
   report hashes, so downstream stages and the status view read the verdict from
   the step output without re-parsing the artifact.

## 7. `silentWindowsOf` — how silence is found

`silentWindowsOf(samples, sampleRate, settings)` walks the PCM with a **50 ms hop**
and a prefix-sum of squared samples, so each window's RMS is O(1) after one pass.
A window is silent when its RMS < `silenceRms`; consecutive silent windows are
merged into runs, and a run of at least `silenceWindowSec` is reported with
`{startSec, endSec, durationSec}`. Starts are hop-aligned, so a reported start may
be up to one hop (50 ms) late — good enough to name the scene and the second, which
is what a finding needs. Windows are only reported inside a scene's spoken window;
silence between scenes is a transition, not a hole.

## 8. Ink, not boxes — how layout is measured

The naive layout check compares element _boxes_ with the frame. That is wrong twice
over: the composer scales and moves boxes with the camera (so a valid frame can
report every element out of bounds — 399 findings on the first fixture probe), and
a text box is mostly air (a short line in a full-width box "fits" or "clips" for
reasons the box cannot see). So the check measures what is actually drawn:

- `placedRect` — the element's box after its transform, in output pixels;
- `inkBox` — for non-text, the box; for text, the block the rasteriser draws: the
  wrapped lines **measured with the same `measureRun` and real fonts** the
  renderer uses (plus the attribution line at 0.78×), centred exactly the way
  `drawTextElement` centres it, with a line height of `fontSizePx × 1.25`;
- rotated text is reported by its box (the axis-aligned ink box would be wrong,
  and a wrong measurement is worse than a rough one); no fonts ⇒ box, and the
  readability rules report as unmeasurable rather than guessed.

This is also what makes the caption-band rule honest: it compares the caption
band's top edge with the _text's ink_ bottom, not with a box that was never drawn.

## 9. Configuration

The engine never reads `process.env`: `@nexus/config` validates the `NEXUS_QA_*`
block and exposes `AppConfig.qa`, shaped exactly like the engine's
`QASettingsInput` — so `resolveQASettings(loadEnv().qa)` needs no translation, and
an operator changes what counts as publishable without touching the engine.

| Variable                          | Default | Meaning                                                 |
| --------------------------------- | ------- | ------------------------------------------------------- |
| `NEXUS_QA_MIN_FONT_PX`            | 18      | smallest type, in output pixels, that is still readable |
| `NEXUS_QA_TIGHT_FONT_PX`          | 24      | below this, type is tight (warning)                     |
| `NEXUS_QA_DURATION_TOLERANCE_SEC` | 0.5     | audio may deviate this far from the plan                |
| `NEXUS_QA_SILENCE_RMS`            | 0.006   | RMS below this is silence (0…1)                         |
| `NEXUS_QA_SILENCE_WINDOW_SEC`     | 0.6     | a silent stretch this long is a hole                    |
| `NEXUS_QA_VIDEO_TOLERANCE_SEC`    | 0.25    | container may deviate this far from the render record   |
| `NEXUS_QA_CAPTION_SAFE_AREA`      | `on`    | check burned captions against the safe area             |

Unconfigured thresholds keep their documented defaults
(`DEFAULT_QA_SETTINGS`); unknown keys are refused, not ignored. The scene plan
owns the _resolution_ and _fps_ a video is judged against, and the render metadata
owns the rest of the contract — QA adds no sizing of its own.

## 10. Running it

```bash
# the whole package (98 tests; the three real-render tests skip without FFmpeg)
corepack pnpm exec vitest run packages/qa

# with the real binary: a real render, a real QA pass, then two real refusals
NEXUS_FFMPEG_PATH=/path/to/ffmpeg corepack pnpm exec vitest run packages/qa/src/render-e2e.test.ts
```

The e2e suite renders the fixture plan for real (640×360, real x264), asserts a
**clean pass** — a green verdict is something an episode can actually earn — and
then breaks one thing at a time: an unsupported claim, and a video swapped under a
render record. Both refusals are asserted down to `assertPublishable` throwing.

## 11. Limits (what is not here)

- **No semantic claim check** — QA verifies the ledger (citations, evidence,
  wording consistency), not whether a paraphrase quietly changes meaning
  (`GAP-19`); an NLI-style checker would sit behind the provider interface.
- **No ASR** — a voice clip is verified to exist, to be measurable and to sit in
  its window; that it _says the words_ is still the adapter's and the operator's
  word (`OD-29`).
- **No subjective quality** — contrast, composition and pacing are measured only
  where a rule can be deterministic (font size, safe area, silence); "is it good"
  stays with the approval gate (`GAP-38`).
- **Frames are measured, not pixels** — layout runs on the composer's output with
  real font metrics, not on the encoded frames; a defect the rasteriser itself
  introduced (and only the rasteriser could see) is `GAP-42`'s remaining half,
  now narrowed to pixel-level comparison.
- **The stage is not registered in a worker** — `createQATask` is complete and
  tested inside the runner, but no entrypoint builds a registry with it yet (the
  same shape as GAP-9/18/34/41).

## 12. Related documents

- `docs/architecture/video-rendering.md` — the render metadata and the MP4 facts
  the video check compares against.
- `docs/architecture/audio-captions.md` — the narration/caption tracks and the
  timing the audio check verifies.
- `docs/architecture/render-engine.md` — the composer whose frames the visual
  check measures.
- `docs/architecture/job-orchestration.md` — steps, artifacts, reuse and the
  stage graph the pipeline check reads.
- `docs/architecture/script-engine.md` — the claim/evidence ledger the content
  check re-verifies.
- `docs/plans/ISSUES.md` — the open items this phase leaves (`CI-42`…).
