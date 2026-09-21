# The voice & caption architecture (Phase 10)

`@nexus/audio` turns a validated **scene manifest** (Phase 7) plus a **voice casting**
into voice clips in the CAS and one **audio track** document that carries the timing
everything downstream reads — and then turns _that_ into a **caption track** whose
cues nobody typed.

```
scene manifest ──┐
voice casting ───┼─► segmentPlansFrom ─► synthesizeNarration ─► clips (CAS)
                 │                                              + AudioTrack ─┐
                 └─────────────────────────── captions ◄──────────────────────┘
                                                      CaptionTrack
```

Two stage keys, both already declared by the versioned pipeline graph
(`packages/jobs/src/stages.ts`, `longform_v1`):

| Stage      | Episode state                    | Produces   | Task                 |
| ---------- | -------------------------------- | ---------- | -------------------- |
| `voice`    | `VOICE_SYNTHESIS` → `CAPTIONING` | `audio`    | `createVoiceTask`    |
| `captions` | `CAPTIONING` → `COMPOSITING`     | `captions` | `createCaptionsTask` |

## 1. What this phase is (and is not)

| Requested                          | Where it lives                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| TTS provider abstraction           | `TTSProvider` from `@nexus/providers` (Phase 4); this package never opens a socket itself      |
| Voice configuration                | `voices.ts` — the `VoiceCasting` document, `castingFor`, `validateCasting`, `resolveVoicePlan` |
| Audio artifact creation            | `persist.ts` / `captions-task.ts` — `audio` (track + clips) and `captions` artifacts           |
| Duration metadata                  | `probe.ts` + `measureClip` — measured, probed or honestly estimated                            |
| Caching                            | `cache.ts` (segment level) on top of the provider cache (AD-13) and runner reuse               |
| Retries                            | `pipeline.ts` — attempt budget with a deterministic backoff                                    |
| Provider failure handling          | coded issues, `park` vs `fail`, operator-supplied clips                                        |
| Captions from narration + timing   | `captions.ts` — derived, never embedded per scene                                              |
| Safe line lengths, readable timing | the wrap/hold/split rules in `captions.ts`                                                     |

Deliberately **not** here: muxing, loudness normalisation, lipsync, burning captions
into frames, translation, publishing, and any real voice account (the fake adapter is
a real WAV writer, so the whole path is exercised with no key and no paid call).

## 2. What gets spoken, and by whom (`requests.ts`, `voices.ts`)

**One segment per scene.** A scene's narration is a coherent stretch of speech — the
planner wrote it that way — so it is the natural unit for a synthesis call:

- the seam between two segments lands exactly where the video cuts;
- a retry re-voices one scene, not a whole episode;
- the segment cache reuses the scenes that did not change;
- prosody is not restarted at every full stop.

Sentence-level audio (one call per sentence) would ship more calls, more seams and
worse delivery; it is only worth it when a later stage needs per-sentence editing
(OD-27). Sentence _boundaries_ inside a segment still come from the narration text,
split with the **same splitter the script and scene planner used**, and the ids come
from the manifest (`narration.sentenceIds`), so the caption stage can place a line
without ever seeing the script.

The **speaker** of a scene is decided by the scene: the first cast member whose state
is `talking`, `gesturing` or `pointing` (`SPEAKING_STATES`) speaks the narration;
anything else — a listening guest, a b-roll beat, an evidence card — is read by the
narrator. A scene that says nobody is talking is a scene the narrator describes.

The **casting** is a separate, small document (`VoiceCasting`, v1) so a video can be
re-voiced — another language, another host voice — without touching a single scene:

| Field                                                    | Meaning                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `language`, `format` (`wav`/`mp3`), `sampleRate`, `rate` | the defaults every segment inherits                                                               |
| `narrator`                                               | the voice for scenes that show nobody speaking (or nothing at all)                                |
| `cast[]`                                                 | one voice per cast member, overriding the defaults (max 12)                                       |
| `voiceId: ""`                                            | "whatever the adapter lists first", resolved _once_ per run against the adapter's real voice list |

Two rules make it predictable:

1. **The scene decides who speaks; the casting decides how they sound.** They are
   different documents because they are edited for different reasons.
2. **Nothing is guessed twice.** A _named_ voice the adapter does not offer is never
   silently swapped for another — that would ship the wrong voice in an artifact. It
   is reported as `voice_unavailable` and the segment fails; the operator sees exactly
   what the adapter offers.

`validateCasting` reports what a human would want to know before spending quota: a
cast member with no voice (`missing_voice`), a voice for somebody who is not in the
cast (`unknown_cast_member`), a cast voice in another language (`language_mismatch`).
The `voice` stage logs them and continues — a _complete_ casting is the operator's
job, not a reason to fail an episode.

## 3. The synthesis call (`pipeline.ts`)

`synthesizeNarration` is written to be boring on purpose:

- **Sequential, in manifest order.** Synthesis is metered and rate-limited, and a
  parallel fan-out would make a run's numbers depend on scheduling. One segment at a
  time also means the spoken timeline is assembled in the order the video plays it.
- **Deterministic backoff, no jitter.** Jitter belongs to the transport retry inside
  `invoke`; here the delays are a pure function of the retry number, so a test can
  assert a run's shape exactly (250 ms, 500 ms, 1 s, 2 s, capped at 4 s).
- **Nothing is trusted that can be measured** (§4).
- **Fail visibly.** A segment that cannot be produced becomes an issue with a code and
  a message, the timing document records how many scenes have no audio, and the stage
  parks the job at the manual gate unless the tuning says to fail outright.

| Tuning (`DEFAULT_AUDIO_TUNING`)         | Default         | Why                                                      |
| --------------------------------------- | --------------- | -------------------------------------------------------- |
| `maxAttempts`                           | 3               | including the first; enough for a flaky free tier        |
| `baseDelayMs` / `factor` / `maxDelayMs` | 250 / 2 / 4 000 | 250 ms, 500 ms, 1 s, … no jitter                         |
| `maxSegmentBytes`                       | 32 MiB          | a runaway adapter must not fill the disk                 |
| `durationToleranceMs`                   | 150             | a claim further off than this is reported                |
| `onFailure`                             | `park`          | report, keep what worked, let a human decide             |
| `gapSec`                                | 0               | silence between clips; the writer can add a breath later |
| `wordsPerSecond`                        | the manifest's  | one pace in the system, not two                          |
| `probe`                                 | `true`          | parse the bytes that came back                           |

A clip is rejected before anything else looks at it when it is empty, larger than the
ceiling, or has no content hash — all three are reported as failed attempts, so the
attempt budget applies to them too.

## 4. Duration metadata: measure, never trust (`probe.ts`)

A provider's `durationMs` is a claim. The bytes are not.

| `durationMethod` | When                                                                                 | Trust                                                            |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `probed`         | a WAV header or an MP3 frame header was parsed                                       | exact (the header cannot lie about its own frame count)          |
| `provider`       | the adapter reported a duration and the bytes agreed (or there was nothing to probe) | as good as the adapter                                           |
| `estimated`      | nothing measured it                                                                  | words ÷ the manifest's words-per-second, and the segment says so |

A claim that disagrees with the bytes by more than `durationToleranceMs` is a
`duration_mismatch` **warning**, and the bytes win: every downstream number
(`startSec`, `durationSec`, totals, cue windows) comes from the clip, not the claim.
An MP3 whose bitrate or layer the estimator does not recognise is _unknown_, not
guessed — that falls through to the estimate and is labelled `estimated`.

## 5. Caching: the clip, the call and the stage

Three caches, three different questions:

| Cache                                         | Key                                                             | What it saves                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| provider cache (`@nexus/providers`, AD-13)    | adapter + operation + request inputs                            | the **call**: a repeated synthesis is answered from disk without touching the account                                        |
| runner artifact reuse (`@nexus/jobs`)         | the stage's content fingerprint                                 | the whole **stage**: an unchanged episode adopts its previous track and never runs                                           |
| **this package's segment cache** (`cache.ts`) | adapter + text + voice + container + sample rate + rate + style | the **clip**: it survives an edited script, so an episode whose third scene changed re-voices that scene and reuses the rest |

A cache **hit is only trusted when the bytes it names are still in the CAS** — an index
is a hint, never a source of truth — and the key includes the adapter id, so two
providers can never serve each other's audio.

| Implementation       | Configured by                      | Notes                                                                                                                       |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MemorySegmentCache` | tests, one-shot runs               | in-run reuse: two identical segments cost one call                                                                          |
| `FileSegmentCache`   | `NEXUS_AUDIO_SEGMENT_CACHE=<path>` | JSON index, written atomically (temp + rename); a missing, stale or corrupt index reads as _empty_, never as a failed stage |
| `NullSegmentCache`   | `off` / `""`                       | every run re-synthesizes                                                                                                    |

## 6. Failure handling

`AudioError` carries the one distinction the _runner_ reads: **retryable** (worth
another attempt — the provider lost its connection) or permanent (everything else,
including a configuration mistake). `createVoiceTask` translates it into the same
`RetryableError` / `PermanentError` pair every other stage throws, and the pipeline
reports each segment with an issue code:

| Issue                                               | Severity | Meaning                                                                                       |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `provider_failed`                                   | error    | every attempt failed                                                                          |
| `manual_required`                                   | error    | the capability degraded to its manual fallback (AD-06)                                        |
| `empty_audio` / `bytes_too_large`                   | error    | the clip cannot be used as it arrived                                                         |
| `voice_unavailable`                                 | error    | the configured voice is not one the adapter offers                                            |
| `unsupported_format`                                | error    | the adapter returned another container than the casting asks for                              |
| `operator_audio_missing` / `operator_audio_invalid` | error    | a human's clip is absent from the CAS, or unusable                                            |
| `duration_missing` / `duration_mismatch`            | warning  | the duration was estimated, or the claim disagreed with the bytes                             |
| `cache_stale`                                       | warning  | the index pointed at bytes that are gone                                                      |
| `timing_mismatch`                                   | warning  | sentence ids and sentence count disagree                                                      |
| `spoken_overflow`                                   | warning  | a scene speaks longer than the plan gave it                                                   |
| `silent_scene`                                      | warning  | defensive: a scene with no narration at all (a validated manifest cannot express one — CI-32) |

The **error** set is `HARD_AUDIO_ISSUE_CODES`: while one of those stands, the track is
not fit for downstream stages (`isComplete` is false) and the `voice` stage parks the
job at `MANUAL_INPUT_GATE` with instructions — supply clips through
`params.operatorAudio` (`{sceneId, hash}`, the bytes already uploaded to the CAS, at
most 64) and retry the stage, or fix the voice configuration. The clips that _did_
synthesize stay in the CAS and registered, and the adapter's own cache means a retry
does not pay for them twice.

## 7. The audio track (`schema.ts`, `persist.ts`)

`AudioTrack` (v1) is the artifact everything audio-shaped reads — captions, mux, QA,
the renderer's future sync. Strict schema, unknown field = parse error.

| Part                     | What it holds                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segments[]`             | the text as spoken, the resolved voice settings, the adapter, attempts, `cached`, `durationMethod`, the clip's hash/bytes/mime/format/sample rate/duration, and the adapter's word timings when it gave any |
| `sentences[]`            | one line per sentence: `sentenceId`, `sceneId`, `segmentId`, `startSec`/`endSec`/`durationSec`, words, characters, and **how** the window was placed (`word_timings` or `proportional`)                     |
| `scenes[]`               | the plan next to the spoken truth: `planned*`, `spoken*`, `driftSec` and a verdict (`fits`, `over`, `short`, `silent`)                                                                                      |
| `totals`                 | words, characters, words-per-second actually spoken, planned vs spoken duration, drift, how many segments were cached / operator-supplied / estimated / failed                                              |
| `issues[]`, `warnings[]` | §6, plus "this was synthesized by the fake adapter"                                                                                                                                                         |
| `provenance`             | `nexus-audio 1.0.0`; `aiSteps: ["voice.synthesize"]` — the voice is the only model in the file, which is what makes the audit trail true (AD-12)                                                            |

Persistence registers the **clips** the track names as `audio` artifacts (role
`voice_segment`, meta `{durationSec, codec: "pcm_s16le" | "mp3"}`) and the **track**
as one more (role `voice_track`, meta `{durationSec, codec: "json"}` — it is the
document that describes the audio, not playable bytes; `codec` always names what the
artifact's own bytes are); `registerArtifact` is idempotent by hash, so an operator's
clip and a synthesized one both register exactly once. `loadAudioTrack`/`readSegmentAudio` read
them back; nothing downstream needs the database to read an episode's audio.

## 8. Captions are derived, never authored (`captions.ts`)

A scene manifest carries narration text and **nothing that resembles a subtitle**: no
per-scene caption string, no manual line breaks, no hand-timed cue. Those would be a
second copy of the words that drifts from the first the moment anybody edits the
script, and they would make dubbing, re-cutting or re-pacing a manual job. A test
asserts the manifest carries no caption key anywhere.

`buildCaptionTrack(audioTrack)` reads exactly one document — the audio track — and:

1. **pairs every spoken sentence with its window**, using the segment's text (split
   with the same splitter the planner used) and the track's `sentences[]`;
2. **wraps the text into lines** of at most `maxCharsPerLine` (42), at most
   `maxLinesPerCue` (2) of them per cue, breaking only at word boundaries and
   preferring a break after punctuation — "…crossings a day, / and it is still
   growing" reads better than an arbitrary cut;
3. **shares the sentence's window** across the cues a long sentence produced,
   proportionally and exactly (monotonic, last cue ends where the sentence does);
4. **splits a cue that would sit too long** (`maxCueMs`, 7 s) by halving it at a word
   boundary, repeatedly, until each piece fits or cannot be split further;
5. **holds a cue that would flash by** (`minCueMs`, 800 ms) into the silence after it,
   never over the next cue — captions stay in sync with the words;
6. **reports what a reader would notice**: a line the wrap could not break
   (`long_line`), a cue with no silence to hold it in (`cue_too_short`), a single word
   that cannot be split further (`cue_too_long`), a cue that reads faster than
   `maxCharsPerSecond` (25) (`too_fast`), and a scene with no audio to caption
   (`silent_scene`).

The invariant that ties it together: **the concatenation of a sentence's cues is
exactly the sentence's text.** Nothing is reworded, nothing is dropped for being too
long, and nothing is duplicated when a sentence is split — asserted word for word.

| Caption document (`CaptionTrack`, v1) |                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cues[]`                              | `cue_0001`…, scene/segment/sentence ids, `startMs`/`endMs`, `lines[]` (text, words, characters), words, characters, and `method` (`sentence`, `split`, `estimated`)                |
| `settings`                            | the tuning it was built with, snapshotted so the document explains its own line lengths                                                                                            |
| `totals`                              | cues, lines, words, characters, first/last ms, time on screen, speaking time, shortest/longest cue, the fastest reading speed, how many cues were estimated / over budget / silent |
| `issues`, `warnings`                  | the reports above, plus "some cue windows come from an estimated duration"                                                                                                         |
| `provenance`                          | `nexus-captions 1.0.0` with **`aiSteps: []`** — captions are a derivation, and the audit trail says so                                                                             |

The schema refuses a document whose cues overlap, run backwards, or carry more lines
than their own `settings.maxLinesPerCue` allow, so a hand-edited track cannot be
loaded. `cueAt(track, ms)` / `captionTextAt(track, ms)` answer what is on screen at a
moment, which is what a renderer and the mux QA pass need.

## 9. The `captions` stage (`captions-task.ts`)

The stage is deliberately thin, because the interesting work is a _derivation_, not a
generation: it reads the audio track the `voice` stage published (one artifact — the
cue text is already in it, sentence by sentence, as it was spoken), computes the cues,
and registers the result as a `captions` artifact (meta `{durationSec, codec: "json"}`
— the bytes are the caption document, not a `.vtt` yet).
There is no model call, no operator input and nothing to park on: the same audio track
always produces the same bytes, so an unchanged episode adopts its previous artifact
(`validateReuse` refuses one derived from other audio, or one that leaves a scene
uncaptioned).

The one thing it refuses to do is caption half an episode: an audio track with a scene
that has no audio is a track the `voice` stage failed to complete, and burning captions
in over a gap would hide the gap in the output rather than in the report.

## 10. Configuration (`packages/config`)

| Variable                    | Default | Meaning                                           |
| --------------------------- | ------- | ------------------------------------------------- |
| `NEXUS_TTS_VOICE`           | `""`    | the narrator's voice; empty = the adapter's first |
| `NEXUS_TTS_FORMAT`          | `wav`   | `wav` \| `mp3`, recorded in every segment         |
| `NEXUS_TTS_SAMPLE_RATE`     | `24000` | 8 000–48 000                                      |
| `NEXUS_TTS_RATE`            | `1`     | 0.5–2, the provider's own pace at 1               |
| `NEXUS_AUDIO_SEGMENT_CACHE` | `off`   | `off`, or a path to the segment-cache index       |

They become `AppConfig.audio`; the stage-level tuning (attempts, ceiling, tolerance,
`onFailure`, caption line budget…) is a `Task` dependency, so a test can pin it and a
deployment can change it without editing a document.

## 11. How this was verified

| Property                                                                               | Test                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The whole voice path, offline and for real                                             | `pipeline.test.ts` (20) — the fake adapter writes a real WAV into the CAS, so duration verification, probing, cueing and the document are exercised rather than stubbed                |
| Retries, exhausted budgets, permanent failures, empty/oversized clips, manual hand-off | `pipeline.test.ts` — the delays are asserted exactly (`[250, 500]`), and the scripted adapter counts what reached it                                                                   |
| Voice configuration                                                                    | `voices.test.ts` (8) — the speaker rule, `""` resolution, no silent substitution, the casting report                                                                                   |
| Segment plans                                                                          | `requests.test.ts` (6) — one segment per scene, ids beside text, the request shape                                                                                                     |
| Duration metadata                                                                      | `probe.test.ts` (5) — a real WAV, an MP3 frame header, and the honest "unknown" path                                                                                                   |
| Caching                                                                                | `cache.test.ts` (5) + `pipeline.test.ts` — keys, persistence, a corrupt index, a stale index, reuse across an edited manifest                                                          |
| Artifacts and the runner                                                               | `task.test.ts` (8) — the real job runner, real SQLite: artifacts registered, the step output, the manual gate, operator clips, the reuse guard                                         |
| Cues: lines, timing, invariants                                                        | `captions.test.ts` (17) — one cue per sentence, punctuation breaks, no overlap, hold, split, too-fast, a long unbreakable token, a document that refuses to load when its cues overlap |
| Captions over real audio                                                               | `captions.test.ts` — the real voice engine, then cues that read back the narration word for word                                                                                       |
| The `captions` stage end to end                                                        | `captions-task.test.ts` (6) — `plan` → `voice` → `captions` through `runJob`, artifact, output, reuse guard, an incomplete track refused                                               |

`pnpm verify` runs all of it with no network, no API key and no paid call: the fixture
runtime's transport _rejects_, so a test that tried to reach the internet would fail
rather than quietly pass.

## 12. Limits (what is not here)

- **No real TTS adapter yet** — `fake` and `manual` only. The config surface, the
  retry/ceiling/tolerance rules and the manual fallback are the contract a real adapter
  plugs into (`GAP-35`).
- **No mux, no loudness, no QA** — nothing assembles audio + video, normalises
  loudness, trims silence or checks a finished track (`GAP-35`).
- **Captions are not burned in** — there is no rasteriser (`ENV-8`), no `.vtt`/`.srt`
  serialiser and no frame-level caption element yet (`GAP-36`).
- **Word alignment is only as good as the adapter** — without timings, sentence
  windows are shared out proportionally and say `proportional`/`estimated`
  (`GAP-37`).
- **The stages are not wired into a worker** — `createVoiceTask`/`createCaptionsTask`
  are complete and tested inside the runner, but no entrypoint registers them yet
  (`GAP-34`, the same shape as `GAP-9`).
- **One call per scene** — per-sentence audio, per-scene re-voicing and
  partial-track editing are not offered (`OD-27`).

## 13. Related documents

- `docs/architecture/scene-manifest.md` — what a scene says (narration, sentence ids,
  cast, camera, animation, transitions).
- `docs/architecture/provider-layer.md` — the `TTSProvider` capability, `invoke`,
  budgets, the provider cache and the manual fallback this package builds on.
- `docs/architecture/render-engine.md` — the frames that will consume the timing.
- `docs/architecture/job-orchestration.md` — stages, fingerprints, gates and reuse.
- `docs/plans/ISSUES.md` — the open items this phase leaves (`OD-27`, `GAP-34`…).
