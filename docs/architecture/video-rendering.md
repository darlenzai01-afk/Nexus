# The rendering pipeline (Phase 11)

`@nexus/video` turns everything the earlier phases produce into a **video file**:

```
scene manifest ─┐
character assets ┼─► buildTimeline ─► composeVideo ─► rasterise frames (PNG)
animation events │                                          │
                 │                                          ▼
narration (CAS) ─┼──────────────────────────────────► segments ─► MP4 (FFmpeg)
caption track ───┘                                          │
render config ──────────────────────────────────────────────┴─► metadata + render log
                                                                 failure report (on error)
```

It is one workspace package with three layers — a **rasteriser** (pure TypeScript,
no browser), a **pipeline** (frames → segments → one MP4, resumable), and a **stage
task** (`render` in the job graph) — plus a demo tool and a smoke test that render a
real file with a real FFmpeg.

## 1. What this phase is (and is not)

| Requested                     | Where it lives                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Accept a scene manifest       | `RenderPipelineInput.manifest` + `manifestHash` (the bytes in the CAS, not a path)                   |
| Accept the assets             | `characterStage` (`CharacterStage.read`, asset-hash verified per layer by Phase 8)                   |
| Accept animation instructions | Phase 9 `buildTimeline` + `composeVideo` — the manifest's events, folded per frame                   |
| Accept narration/audio        | `audioTrack` + `audioTrackHash` (Phase 10 `AudioTrack`; clips read from the CAS)                     |
| Accept captions               | `captionTrack` + `captionTrackHash` (Phase 10 `CaptionTrack`)                                        |
| Accept render configuration   | `RenderConfig` — a validated document, hashed into the render key                                    |
| Produce the video artifact    | `video` (`video_master`) + `thumbnail` (`render_thumbnail`) + `audio` (`narration_track`)            |
| Produce metadata              | `metadata` (`render_metadata`) — the `RenderMetadata` document                                       |
| Produce render logs           | `document` (`render_log`) — every event, in order                                                    |
| Produce failure information   | `metadata` (`render_failure`) — a `RenderFailure` report, plus a coded `RenderError`                 |
| Resumability                  | work directory + journal per render key; a killed process resumes at the segment it died on          |
| Deterministic configuration   | `configHash` (the config), `renderKey` (config + plan + audio + captions + fonts)                    |
| Artifact reuse                | segments adopted by key, frames verified by recorded hash, `validateReuse` for the whole step        |
| Clear errors                  | `RenderError` codes, `RenderPhase`, `stderrTail`, `hint` — see §7                                    |
| Render smoke test             | `src/render-smoke.test.ts` — real FFmpeg, real MP4, read back with `readMp4`                         |
| A minimal real test video     | `tools/render-demo.mjs` — 1920×1080, 11.5 s, 1.2 MB, rendered from `packages/render/demo/scene.json` |

Deliberately **not** here: a browser or a rasteriser dependency (see §2), visual
polish (correctness first — the brief says so), quality/bitrate tuning beyond sane
defaults, YouTube upload, thumbnails as art, audio mastering beyond a single
loudness measurement, and lipsync.

## 2. Why not Remotion (AD-03 / OD-1)

AD-03 pairs **Remotion** (frames) with **FFmpeg** (encoding). Remotion renders in a
browser and needs Chromium plus a Puppeteer-driven frame capture; this project's
decision record already lists that as OD-1, and the environment has no rasteriser
(ENV-8). So Phase 11 implements the _other half_ of AD-03 honestly:

- **FFmpeg is used exactly as AD-03 says** — every encoded byte goes through it.
- **The frame half is a small in-process rasteriser** (`canvas.ts`, `path.ts`,
  `ttf.ts`, `text-raster.ts`, `svg-shapes.ts`, `raster.ts`) that draws the _same_
  frame documents Phase 9's SVG writer emits, so a frame is identical whether you
  look at `frameToSvg` output in a viewer or at the PNG the pipeline rasterised.
- **The seam stays open.** `RenderPipelineDeps.ffmpeg` is an interface and the
  rasteriser is one module: dropping in a Chromium-backed frame source later means
  replacing `rasteriseFrame`, not rewriting the pipeline. OD-1 remains open, with
  the trade recorded in `docs/plans/ISSUES.md`.

What the rasteriser buys: renders run anywhere Node runs, offline, deterministically
— no fonts installed by luck, no GPU, no headless browser, no 300 MB download.

## 3. The rasteriser

| Module           | Responsibility                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `canvas.ts`      | RGBA canvas, colour parsing, anti-aliased polygon fill (active-edge list), rects, ellipses, capsules, gradients |
| `path.ts`        | SVG path data → flattened polylines (`M L H V Q C S T Z`, absolute + relative; `A` **throws**)                  |
| `transform.ts`   | 2D matrices, composition, point/rect transforms                                                                 |
| `ttf.ts`         | TrueType parser: `cmap`, `loca`/`glyf`, `hmtx`, composites → contours                                           |
| `font.ts`        | Face discovery (`NEXUS_RENDER_FONT`, else the usual system paths) and weight selection                          |
| `text-raster.ts` | Runs, advances, wrapping-free layout (the lines were decided upstream), synthetic italic/bold fallback          |
| `svg-shapes.ts`  | The character layers' SVG subset (rect/circle/ellipse/path/line/polyline/polygon + fill/stroke)                 |
| `png.ts`         | Deterministic PNG encode/decode (filter 0, zlib) + round-trip verification                                      |
| `raster.ts`      | A composed `Frame` → pixels, with diagnostics (`missing_asset`, `text_skipped`, …)                              |

Cost at 1920×1080 on the reference machine: **~315 ms/frame** (108.5 s for 345
frames), which is why segments — not frames — are the resume unit.

Two honesty rules the rasteriser never breaks: a **missing asset is an error**
(it is never silently skipped, because a hole in the picture would ship), and
**text with no font is reported** (`text_skipped`, and `font_missing` from the
pipeline) rather than drawn as boxes.

## 4. The pipeline: frames → segments → one file

| Phase       | What happens                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `plan`      | `buildTimeline` → `composeVideo`; `validateAgainstManifest` refuses a mismatch (fps, aspect, size) |
| `rasterise` | Each segment's frames → `frames/frame-######.png`, hashed as they are written                      |
| `segment`   | One FFmpeg call per segment (`-f rawvideo` in via pipe, `libx264`, faststart)                      |
| `audio`     | The narration is assembled from the clips in the CAS into one WAV                                  |
| `mux`       | Segments concatenated, narration muxed, captions burned, `-movflags +faststart`                    |
| `verify`    | The output is **read back** (`readMp4`) and compared with the plan                                 |
| `thumbnail` | One JPEG poster frame                                                                              |

`verify` is not decoration: it is what makes "the render succeeded" a statement
about bytes rather than about FFmpeg's exit code.

## 5. Resumability and artifact reuse

Everything for one render lives under `<workRoot>/<renderKey[:16]>/`:

```
journal.json     the resume point: which segments are done, and the hash of each frame
frames/          frame-######.png  (deleted after a segment is encoded unless keepFrames)
seg-0000.mp4     one encoded segment per file
narration.wav    the assembled narration
video.mp4        the muxed output          thumbnail.jpg
```

The **render key** is a hash over the config, the plan, the audio track, the caption
track and the fonts. A **segment key** is a hash over the frames it contains (by
digest), the captions in its window, the fonts and the encoder settings that matter.
Consequences, all tested:

- Re-render with nothing changed → **0 frames rasterised, 0 FFmpeg calls**, same bytes.
- Kill the process mid-render and run again → the finished segments are adopted, the
  half-written one is re-encoded.
- Change `crf`, a font, the caption text or the plan → a different key, so nothing is
  adopted from the old render.
- A frame PNG that is not the one the journal recorded (corruption, a bad merge) is
  detected by hash and rasterised again — `render.frame_stale`.
- A journal written by a different render is ignored, and a truncated journal is
  treated as "no journal" (start clean) rather than trusted.
- `validateReuse` refuses to let the job runner adopt a video whose metadata says the
  render had hard failures, or whose plan hash differs — reuse follows evidence.

## 6. Determinism

- Same inputs → same `renderKey`, same frame PNGs, same **video bytes** (asserted in
  the smoke test's second run and in `pipeline.test.ts`).
- Curve flattening, glyph subdivision, PNG filtering and encoder settings are fixed
  constants, not adaptive to time or machine load.
- `metadata.deterministic` plus `determinismNotes[]` record the parts that are _not_
  machine-independent (the FFmpeg build, the font file) instead of pretending.
- Anything that would vary run to run (timestamps) is confined to `generatedAt` and
  overridable through `now`, which is how the fixtures stay reproducible.

## 7. Failure information

`RenderError` carries a **code**, the **phase** it died in, whether it is
**retryable**, a **hint**, and `stderrTail` when FFmpeg's own words explain it:

| Code             | Meaning                                         | Retryable |
| ---------------- | ----------------------------------------------- | --------- |
| `ffmpeg_missing` | no usable binary (`NEXUS_FFMPEG_PATH` named it) | no        |
| `ffmpeg_timeout` | the deadline passed                             | **yes**   |
| `ffmpeg_failed`  | a non-zero exit, with the last stderr lines     | no        |
| `audio_missing`  | narration was expected and is not there         | no        |
| `asset_missing`  | a layer the plan references is not in the CAS   | no        |
| `frame_failed`   | a frame could not be rasterised                 | no        |
| `output_invalid` | the produced file does not match the plan       | no        |
| `config_invalid` | the configuration does not fit the plan         | no        |
| `cancelled`      | the signal was aborted                          | no        |

Every failure also writes a **failure report** (`render_failure`, JSON) into the CAS:
phase, code, message, hint, work directory, render key, the segments that _did_
finish, and `stderrTail`. The `render` stage task registers it, appends
`(failure report <hash>)` to the error the job records, and lets the runner decide
retry-vs-fail from the code — a timeout is worth another attempt, a missing asset is
not.

## 8. The `render` stage

| Stage    | Episode state      | Produces             | Task               |
| -------- | ------------------ | -------------------- | ------------------ |
| `render` | `RENDERING` → `QA` | `video`, `thumbnail` | `createRenderTask` |

The task reads its inputs **from the previous stages' outputs**, not from paths:
`plan.manifestHash`, `voice.trackHash`, `captions.trackHash`, `job.params`. It then
calls `renderVideo`, persists the artifacts, mirrors the render log into the job log,
and hands the QA state the metadata hash. Captions are burned only when configured
(`captions: "burn"`); without audio the render still succeeds but records
`audio_missing` as an issue, so the QA engine (Phase 12) can decide whether that is
acceptable for this episode.

## 9. Configuration

The app layer owns the environment: `@nexus/config` validates the whole render block
and exposes `AppConfig.render`, whose shape is exactly `RenderConfig`'s input — so
`resolveRenderConfig(loadEnv().render)` needs no translation, and `@nexus/video`
never reads `process.env`.

| Variable                      | Default       | Meaning                                         |
| ----------------------------- | ------------- | ----------------------------------------------- |
| `NEXUS_FFMPEG_PATH`           | (auto)        | the binary to use; a wrong path fails loudly    |
| `NEXUS_RENDER_WIDTH/HEIGHT`   | 1920/1080     | output size (must keep the plan's aspect ratio) |
| `NEXUS_RENDER_FPS`            | 30            | must equal the plan's fps                       |
| `NEXUS_RENDER_VIDEO_CODEC`    | `libx264`     | encoder name                                    |
| `NEXUS_RENDER_CRF`            | 23            | quality/size knob                               |
| `NEXUS_RENDER_PRESET`         | `veryfast`    | x264 speed/size preset                          |
| `NEXUS_RENDER_AUDIO_BITRATE`  | `128k`        | AAC bitrate                                     |
| `NEXUS_RENDER_CAPTIONS`       | `burn`        | `burn` or `none`                                |
| `NEXUS_RENDER_FONT`           | (auto)        | the TrueType face text is drawn with            |
| `NEXUS_RENDER_SEGMENT_FRAMES` | 90            | frames per segment (the resume unit)            |
| `NEXUS_RENDER_THREADS`        | 0 (auto)      | encoder threads                                 |
| `NEXUS_RENDER_WORK_DIR`       | `data/render` | where work directories live                     |

## 10. Running it

```bash
corepack pnpm build
# a real 1920×1080 MP4 from the demonstration scene (≈2 min, git-ignored output)
NEXUS_FFMPEG_PATH=/path/to/ffmpeg node packages/video/tools/render-demo.mjs
# the numbers, not the file: real FFmpeg, real MP4, read back with the pipeline's parser
NEXUS_FFMPEG_PATH=/path/to/ffmpeg corepack pnpm exec vitest run packages/video/src/render-smoke.test.ts
```

The smoke test **skips** (loudly) when no FFmpeg exists, so a laptop without one does
not look like a broken renderer; on CI, where FFmpeg is installed, it runs for real.
