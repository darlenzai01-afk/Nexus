/**
 * `@nexus/video` — the cloud-compatible rendering pipeline (Phase 11).
 *
 * Pipeline position: a validated **scene manifest** (Phase 7) with its
 * **character assets** (Phase 8), the **animation instructions** the composition
 * engine expanded (Phase 9), the **narration audio** and **captions** (Phase 10)
 * and a **render configuration** go in; one **MP4**, its **metadata**, a
 * **render log** and — when something fails — a **failure report** come out.
 *
 * The pieces, in the order a run uses them:
 *
 * 1. `resolveRenderConfig` — the configuration, resolved once and hashed
 *    (`config.ts`); the hash is what makes a render reproducible.
 * 2. `renderVideo` — compose → rasterise → encode → concat → mux → verify, with a
 *    journal after every segment (`pipeline.ts`).
 * 3. `rasteriseFrame` — the in-process rasteriser: no browser, no headless
 *    Chromium, just SVG paths, filled polygons, PNG and determinism (`raster.ts`,
 *    `canvas.ts`, `path.ts`, `svg-shapes.ts`, `ttf.ts`, `font.ts`,
 *    `text-raster.ts`).
 * 4. `createFFmpegRunner` — the only boundary that shells out, and it never sees a
 *    shell: argument arrays, timeouts, progress, stderr (`ffmpeg.ts`).
 * 5. `readMp4` — the container read back, so the pipeline checks its own output
 *    rather than trusting the encoder (`mp4.ts`).
 * 6. `assembleNarration` — one continuous track from the voice stage's clips,
 *    placed at their measured times (`audio.ts`).
 * 7. `drawCaption` — the caption track burned in, cue for cue, never re-derived
 *    (`captions-overlay.ts`).
 * 8. `persistRender` / `persistRenderFailure` — the artifacts: video, thumbnail,
 *    narration, metadata, log, and the failure report (`persist.ts`).
 * 9. `createRenderTask` — the `render` stage the orchestrator runs (`task.ts`).
 *
 * Two properties hold throughout. **Determinism**: every input is hashed, every
 * frame is rasterised in-process and verified to decode back to its own pixels,
 * and the toolchain's version is recorded. **Resumability**: work is split into
 * segments, each keyed by everything that decides its bytes, journalled when it is
 * finished, and reused on the next run — which is what makes a $0 runner that gets
 * killed after twenty minutes a nuisance rather than a catastrophe.
 */

export {
  DEFAULTS as RENDER_CONFIG_DEFAULTS,
  configHash,
  resolveRenderConfig,
  validateAgainstManifest,
} from "./config.js";

export { RenderError, isRenderError, messageOf, type RenderErrorCode } from "./errors.js";

export {
  canEncode,
  createFFmpegRunner,
  parseProgress,
  probeFFmpeg,
  resolveFFmpegPath,
  tail,
  type FFmpegCommand,
  type FFmpegProbe,
  type FFmpegResult,
  type FFmpegRunner,
  type RealFFmpegOptions,
} from "./ffmpeg.js";

export {
  assembleNarration,
  audioFilters,
  decodeWav,
  encodeWav,
  measureLoudness,
  narrationClips,
  peakOf,
  type AudioAssemblyOptions,
  type AudioAssemblyResult,
  type Loudness,
  type NarrationClip,
  type WavData,
} from "./audio.js";

export {
  DEFAULT_CAPTION_STYLE,
  activeCue,
  drawCaption,
  type CaptionDraw,
  type CaptionStyle,
} from "./captions-overlay.js";

export {
  SUB_SCANLINES,
  canvasBytes,
  clamp01,
  clampClip,
  createCanvas,
  fillEllipse,
  fillLinearGradient,
  fillPath,
  fillRect,
  parseColour,
  pixelAt,
  thinPolyline,
  strokePolyline,
  type Canvas,
  type Colour,
  type Rect,
} from "./canvas.js";

export {
  CURVE_SEGMENTS,
  flattenCubic,
  flattenQuadratic,
  parsePathData,
  type FlatPath,
} from "./path.js";

export { decodePng, encodePng, pngSize, verifyPngRoundTrip } from "./png.js";

export {
  BOLD_WEIGHT,
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  findFont,
  fontForWeight,
  loadFontFile,
  missingGlyphs,
  type FontSet,
  type LoadedFont,
} from "./font.js";

export {
  ATTRIBUTION_SCALE,
  CAPTION_INK,
  ITALIC_SLANT,
  LINE_HEIGHT_FACTOR,
  SYNTHETIC_BOLD,
  drawTextElement,
  drawTextRun,
  measureRun,
  runOrigin,
  type RunContext,
  type TextElementDraw,
  type TextRun,
} from "./text-raster.js";

export {
  PIXEL_LOOK,
  colourAt,
  elementMatrix,
  hexAt,
  rasteriseFrame,
  type DrawnElement,
  type RasterDeps,
  type RasterDiagnostic,
  type RasterOptions,
  type RasterResult,
} from "./raster.js";

export {
  drawSvg,
  parseSvg,
  type DrawSvgOptions,
  type ParsedSvg,
  type SvgShape,
} from "./svg-shapes.js";

export {
  contourToPolygon,
  parseFont,
  type Contour,
  type ContourPoint,
  type Font,
  type FontMetrics,
} from "./ttf.js";

export {
  IDENTITY,
  applyMatrix,
  compose,
  composeAll,
  isIdentity,
  rotation,
  scaling,
  shearX,
  transformPoints,
  transformRect,
  translation,
  type Matrix,
} from "./transform.js";

export {
  parseMp4,
  readBoxes,
  readMp4,
  type Mp4AudioTrack,
  type Mp4Info,
  type Mp4VideoTrack,
} from "./mp4.js";

export {
  digestOfFrames,
  fileBytes,
  fileDigest,
  fileExists,
  planSegments,
  type SegmentPlan,
} from "./segments.js";

export {
  createWorkDir,
  dropSegmentFrames,
  frameFile,
  readJournal,
  resetWorkDir,
  segmentFile,
  writeFileAtomic,
  writeJournal,
  type WorkDir,
} from "./workdir.js";

export {
  renderFailureOf,
  renderVideo,
  type RenderLogEvent,
  type RenderPipelineDeps,
  type RenderPipelineInput,
  type RenderPipelineResult,
} from "./pipeline.js";

export {
  HARD_RENDER_ISSUE_CODES,
  RENDER_ENGINE_NAME,
  RENDER_ENGINE_VERSION,
  RENDER_ISSUE_CODES,
  RENDER_PHASES,
  RESULT_VERSION,
  JournalSegmentSchema,
  RenderConfigInputSchema,
  RenderConfigSchema,
  RenderFailureSchema,
  RenderIssueSchema,
  RenderJournalSchema,
  RenderMetadataSchema,
  RenderOutputSchema,
  RenderSegmentSchema,
  RenderTotalsSchema,
  isHardRenderIssue,
  isRenderComplete,
  journalBytes,
  failureBytes,
  metadataBytes,
  type JournalSegment,
  type RenderConfig,
  type RenderConfigInput,
  type RenderFailure,
  type RenderIssue,
  type RenderIssueCode,
  type RenderMetadata,
  type RenderOutput,
  type RenderPhase,
  type RenderSegment,
  type RenderTotals,
} from "./schema.js";

export {
  FAILURE_ARTIFACT_KIND,
  FAILURE_ARTIFACT_ROLE,
  LOG_ARTIFACT_KIND,
  LOG_ARTIFACT_ROLE,
  METADATA_ARTIFACT_KIND,
  METADATA_ARTIFACT_ROLE,
  NARRATION_ARTIFACT_KIND,
  NARRATION_ARTIFACT_ROLE,
  THUMBNAIL_ARTIFACT_KIND,
  THUMBNAIL_ARTIFACT_ROLE,
  VIDEO_ARTIFACT_KIND,
  VIDEO_ARTIFACT_ROLE,
  loadRenderMetadata,
  persistRender,
  persistRenderFailure,
  readVideo,
  renderArtifactRefs,
  renderFailureArtifactRef,
  renderLogBytes,
  type PersistRenderDeps,
  type PersistedRender,
  type RenderFiles,
} from "./persist.js";

export { RENDER_STAGE_KEY, createRenderTask, locateFFmpeg, type RenderTaskDeps } from "./task.js";

export {
  TINY_JPEG,
  createScriptedFFmpeg,
  syntheticMp4,
  type ScriptedFailure,
  type ScriptedFFmpeg,
  type ScriptedFFmpegOptions,
  type SyntheticMp4Options,
  type SyntheticVideo,
} from "./scripted-ffmpeg.js";

export {
  FIXTURE_CLOCK,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
  fixtureAudio,
  fixtureManifest,
  fixtureManifestIn,
  fixtureRenderConfig,
  fixtureStage,
  type FixtureAudio,
  type FixtureManifest,
  type FixtureManifestOptions,
} from "./fixtures.js";
