import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AudioTrack, CaptionTrack } from "@nexus/audio";
import type { Clock } from "@nexus/providers";
import {
  buildTimeline,
  canonicalJson,
  composeVideo,
  frameDigest,
  type CharacterStage,
  type ComposedVideo,
  type Frame,
  type Look,
} from "@nexus/render";
import type { SceneManifest } from "@nexus/scenes";
import type { BlobStore } from "@nexus/storage";
import { sha256 } from "@nexus/storage";

import {
  assembleNarration,
  audioFilters,
  encodeWav,
  measureLoudness,
  narrationClips,
} from "./audio.js";
import { drawCaption } from "./captions-overlay.js";
import { configHash, validateAgainstManifest } from "./config.js";
import { isRenderError, RenderError } from "./errors.js";
import { canEncode, tail, type FFmpegRunner } from "./ffmpeg.js";
import {
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  findFont,
  loadFontFile,
  type FontSet,
} from "./font.js";
import { readMp4, type Mp4Info } from "./mp4.js";
import { encodePng, verifyPngRoundTrip } from "./png.js";
import { rasteriseFrame } from "./raster.js";
import {
  failureBytes,
  isHardRenderIssue,
  RENDER_ENGINE_NAME,
  RENDER_ENGINE_VERSION,
  RenderJournalSchema,
  RESULT_VERSION,
  type JournalSegment,
  type RenderFailure,
  type RenderPhase,
  type RenderConfig,
  type RenderIssue,
  type RenderIssueCode,
  type RenderMetadata,
  type RenderOutput,
  type RenderSegment,
} from "./schema.js";
import { fileDigest, planSegments, type SegmentPlan } from "./segments.js";
import {
  createWorkDir,
  dropSegmentFrames,
  frameFile,
  readJournal,
  segmentFile,
  writeJournal,
  type WorkDir,
} from "./workdir.js";

/**
 * The rendering pipeline: inputs in, one real video file out.
 *
 * ```
 * scene manifest ─┐
 * character assets ┼─► buildTimeline ─► composeVideo ─► rasterise frames (PNG)
 * animation events ┘                                        │ per segment
 * narration audio ──► assembled into one WAV ───────────────┤
 * caption track ────► burned into each frame's cue ─────────┤
 * render config ────► hashed, pinned, recorded ─────────────┴─► FFmpeg ─► video.mp4
 *                                                                            + metadata
 *                                                                            + render log
 *                                                                            + failure report
 * ```
 *
 * The order matters and is the point of the design: everything that decides a
 * pixel is decided *before* FFmpeg runs (so a segment's key is a complete
 * description of its bytes), and FFmpeg only ever does what it is good at —
 * encoding a frame sequence, concatenating, muxing and measuring.
 */

export interface RenderLogEvent {
  readonly at: number;
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export interface RenderPipelineDeps {
  readonly ffmpeg: FFmpegRunner;
  readonly storage: BlobStore;
  readonly workRoot: string;
  readonly clock?: Clock | undefined;
  readonly look?: Look | undefined;
  /** Called for every log event, so a stage can mirror them into the job log. */
  readonly onEvent?: ((event: RenderLogEvent) => void) | undefined;
}

export interface RenderPipelineInput {
  readonly manifest: SceneManifest;
  readonly manifestHash: string;
  readonly config: RenderConfig;
  readonly characterStage: CharacterStage;
  readonly audioTrack?: AudioTrack | undefined;
  readonly audioTrackHash?: string | undefined;
  readonly captionTrack?: CaptionTrack | undefined;
  readonly captionTrackHash?: string | undefined;
  /** Font overrides; without them the pipeline looks for a system font. */
  readonly fonts?: FontSet | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Overrides `generatedAt`, so a fixture render is reproducible. */
  readonly now?: string | undefined;
}

export interface RenderPipelineResult {
  readonly metadata: RenderMetadata;
  readonly work: WorkDir;
  readonly events: readonly RenderLogEvent[];
  readonly renderKey: string;
  readonly video: { readonly file: string; readonly hash: string; readonly bytes: number };
  readonly thumbnail?:
    { readonly file: string; readonly hash: string; readonly bytes: number } | undefined;
  readonly narration?:
    { readonly file: string; readonly hash: string; readonly bytes: number } | undefined;
}

interface RunStats {
  framesRendered: number;
  framesReused: number;
  rasterMs: number;
  encodeMs: number;
  muxMs: number;
  ffmpegCalls: number;
}

export function renderVideo(
  input: RenderPipelineInput,
  deps: RenderPipelineDeps,
): RenderPipelineResult {
  const startedAt = Date.now();
  const events: RenderLogEvent[] = [];
  const issues: RenderIssue[] = [];
  const warnings: string[] = [];
  const stats: RunStats = {
    framesRendered: 0,
    framesReused: 0,
    rasterMs: 0,
    encodeMs: 0,
    muxMs: 0,
    ffmpegCalls: 0,
  };
  const log = (
    level: RenderLogEvent["level"],
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    const entry: RenderLogEvent = {
      at: Date.now() - startedAt,
      level,
      event,
      message,
      ...(data !== undefined ? { data } : {}),
    };
    events.push(entry);
    deps.onEvent?.(entry);
  };
  const issue = (
    code: RenderIssueCode,
    message: string,
    extra: Partial<RenderIssue> = {},
  ): void => {
    const severity = isHardRenderIssue(code) ? "error" : "warning";
    issues.push({ code, severity, message, ...extra });
    log(
      severity === "error" ? "error" : "warn",
      code,
      message,
      extra.segment !== undefined ? { segment: extra.segment } : undefined,
    );
  };

  // Mutable run state, so a failure can report exactly how far the run got.
  let phase: RenderPhase = "config";
  let work: WorkDir | undefined;
  let hashes:
    | {
        readonly manifestHash: string;
        readonly audioTrackHash: string;
        readonly captionTrackHash: string;
        readonly configHash: string;
      }
    | undefined;
  let renderKey = "";
  // The segments that finished, for the failure report: a failed render still has
  // to say what it got done before it died.
  const completed: JournalSegment[] = [];

  try {
    const config = input.config;
    validateAgainstManifest(config, input.manifest);
    const composed = composeVideoFor(input);
    if (composed.frameCount === 0) {
      throw new RenderError("the scene manifest produced no frames to render", {
        code: "empty_timeline",
      });
    }
    if (!canEncode(deps.ffmpeg, config.videoCodec)) {
      throw new RenderError(
        `this FFmpeg (${deps.ffmpeg.version}) cannot write ${config.videoCodec}`,
        { code: "unsupported_codec" },
      );
    }

    hashes = {
      manifestHash: input.manifestHash,
      audioTrackHash: input.audioTrackHash ?? "none",
      captionTrackHash: input.captionTrackHash ?? "none",
      configHash: configHash(config),
    };
    renderKey = sha256(
      new TextEncoder().encode(canonicalJson({ kind: "video.render", ...hashes })),
    );
    const fonts = input.fonts ?? loadRenderFonts(config, issue);
    work = createWorkDir(deps.workRoot, renderKey);
    const previousJournal = readJournal(work);
    const resumed = previousJournal !== undefined && previousJournal.segments.length > 0;
    const plans = planSegments(composed, config, {
      renderKey,
      captionTrack: input.captionTrack,
      fontHash: fonts?.regular.hash,
    });

    phase = "segment";
    log(
      "info",
      "render.started",
      `rendering ${composed.frameCount} frame(s) as ${plans.length} segment(s)`,
      {
        renderKey: renderKey.slice(0, 16),
        resolution: `${config.width}x${config.height}`,
        fps: config.fps,
        ffmpeg: deps.ffmpeg.version,
        resumed,
        captions: config.captions,
      },
    );

    const segments: JournalSegment[] = [];
    for (const plan of plans) {
      if (input.signal?.aborted === true) {
        throw new RenderError(`render cancelled before segment ${plan.index}`, {
          code: "ffmpeg_failed",
          retryable: true,
        });
      }
      const record = renderSegment({
        plan,
        input,
        config,
        composed,
        work,
        deps,
        fonts,
        stats,
        log,
        issue,
        previous: previousJournal?.segments.find((entry) => entry.index === plan.index),
      });
      segments.push(record);
      completed.push(record);
      // The journal is written *after* the segment's bytes exist and are verified,
      // which is what makes a killed process resume here instead of starting over.
      writeJournal(
        work,
        makeJournal(work, renderKey, hashes, segments, undefined, generatedAt(input, deps)),
      );
    }

    phase = "audio";
    const narration = assembleAudio({ input, deps, work, log, issue });
    phase = "finalise";
    const output = finalise({
      work,
      deps,
      config,
      segments,
      narration,
      previous: previousJournal?.output,
      log,
      issue,
      stats,
    });

    phase = "verify";
    const info = verifyOutput(output.file, config, input, log, issue);
    phase = "thumbnail";
    const thumbnail = makeThumbnail({
      work,
      deps,
      config,
      log,
      issue,
      atSec: Math.min(Math.max(0, info.durationSec * 0.25), Math.max(0, info.durationSec - 0.05)),
    });
    const outputRecord: RenderOutput = {
      file: output.file,
      bytes: output.bytes,
      hash: output.hash,
      container: "mp4",
      durationSec: info.durationSec,
      videoCodec: info.video?.codec ?? config.videoCodec,
      audioCodec: info.audio?.codec ?? (narration === undefined ? "none" : config.audioCodec),
      width: info.video?.width ?? config.width,
      height: info.video?.height ?? config.height,
      fps: config.fps,
      frameCount: info.video?.frameCount ?? composed.frameCount,
      hasAudio: info.audio !== undefined,
      fastStart: info.fastStart,
    };

    if (config.captions === "burn" && input.captionTrack === undefined) {
      issue("captions_missing", "captions were requested but no caption track was supplied");
    } else if (config.captions === "none" && input.captionTrack !== undefined) {
      issue(
        "captions_skipped",
        `${input.captionTrack.totals.cues} cue(s) were not burned in because burn-in is disabled`,
      );
    }
    if (fonts === undefined) {
      // The issue is raised once, before rendering; this keeps it in the report even
      // when a caller supplied no configuration at all.
      if (!issues.some((entry) => entry.code === "font_missing")) {
        issue("font_missing", "no font was available, so text and captions were not drawn");
      }
    }
    if (config.keepFrames) warnings.push(`frames are kept under ${work.framesDir}`);

    const metadata: RenderMetadata = {
      version: RESULT_VERSION,
      generatedAt: generatedAt(input, deps),
      renderKey,
      configHash: hashes.configHash,
      config,
      manifestHash: input.manifestHash,
      ...(input.audioTrackHash !== undefined ? { audioTrackHash: input.audioTrackHash } : {}),
      ...(input.captionTrackHash !== undefined ? { captionTrackHash: input.captionTrackHash } : {}),
      castHashes: input.manifest.cast.map((member) =>
        member.definition === undefined
          ? member.id
          : `${member.id}@${member.definition.hash.slice(0, 16)}`,
      ),
      timeline: {
        fps: composed.fps,
        frameCount: composed.frameCount,
        durationSec: composed.durationSec,
        resolution: composed.resolution,
        frameDigest: frameDigest(flatFrames(composed)),
        scenes: composed.scenes.length,
        diagnostics: [...new Set(composed.diagnostics.map((entry) => entry.code))],
      },
      toolchain: {
        engine: RENDER_ENGINE_NAME,
        engineVersion: RENDER_ENGINE_VERSION,
        ffmpegPath: deps.ffmpeg.path,
        ffmpegVersion: deps.ffmpeg.version,
        ffmpegBanner: deps.ffmpeg.banner.slice(0, 500),
        encoders: deps.ffmpeg.encoders.filter((encoder) =>
          [config.videoCodec, config.audioCodec, "libx264", "aac"].includes(encoder),
        ),
        node: process.version,
        ...(fonts !== undefined
          ? {
              font: {
                name: fonts.regular.name,
                file: fonts.regular.file ?? fonts.regular.name,
                hash: fonts.regular.hash,
                bytes: fonts.regular.bytes,
              },
            }
          : {}),
        ...(fonts?.bold !== undefined
          ? {
              boldFont: {
                name: fonts.bold.name,
                file: fonts.bold.file ?? fonts.bold.name,
                hash: fonts.bold.hash,
                bytes: fonts.bold.bytes,
              },
            }
          : {}),
      },
      ...(narration !== undefined ? { audio: narration.metadata } : {}),
      output: outputRecord,
      ...(thumbnail !== undefined
        ? {
            thumbnail: {
              hash: thumbnail.hash,
              bytes: thumbnail.bytes,
              atSec: thumbnail.atSec,
              width: config.width,
              height: config.height,
            },
          }
        : {}),
      segments: segments.map(toMetadataSegment),
      totals: {
        frames: composed.frameCount,
        framesRendered: stats.framesRendered,
        framesReused: stats.framesReused,
        segments: segments.length,
        segmentsRendered: segments.filter((segment) => !segment.reused).length,
        segmentsReused: segments.filter((segment) => segment.reused).length,
        ffmpegCalls: stats.ffmpegCalls,
        rasterMs: stats.rasterMs,
        encodeMs: stats.encodeMs,
        muxMs: stats.muxMs,
        wallMs: Date.now() - startedAt,
        captionsBurned: captionsBurned(input.captionTrack, config),
        bytesWritten: outputRecord.bytes + (thumbnail?.bytes ?? 0),
      },
      issues,
      warnings,
      resumed: resumed || segments.some((segment) => segment.reused) || output.reused,
      deterministic: true,
      determinismNotes: [
        `frames are rasterised in-process from the frame documents (${RENDER_ENGINE_NAME} ${RENDER_ENGINE_VERSION})`,
        config.verifyFrames
          ? "every frame is verified to decode back to the pixels that produced it"
          : "frame verification is disabled, so a corrupt frame would not be caught",
        config.threads === 0
          ? "the encoder chooses its own thread count, so the encoded bytes may differ between machines"
          : `the encoder is pinned to ${config.threads} thread(s)`,
        fonts === undefined
          ? "no font was configured, so on-screen text and captions were skipped"
          : `text uses ${fonts.regular.name} (${fonts.regular.hash.slice(0, 12)})`,
      ],
      provenance: {
        generator: `${RENDER_ENGINE_NAME} ${RENDER_ENGINE_VERSION}`,
        // No model is consulted anywhere in this pipeline: captions were derived in
        // Phase 10, the frames composed in Phase 9, and this stage draws and encodes.
        aiSteps: [],
      },
    };

    writeJournal(
      work,
      makeJournal(work, renderKey, hashes, segments, outputRecord, metadata.generatedAt),
    );

    return {
      metadata,
      work,
      events,
      renderKey,
      video: { file: output.file, hash: output.hash, bytes: output.bytes },
      ...(thumbnail !== undefined
        ? { thumbnail: { file: thumbnail.file, hash: thumbnail.hash, bytes: thumbnail.bytes } }
        : {}),
      ...(narration !== undefined
        ? { narration: { file: narration.file, hash: narration.hash, bytes: narration.bytes } }
        : {}),
    };
  } catch (error) {
    // A failed render leaves evidence, not just an exception: the phase, the
    // command, and the segments that already finished (which a retry reuses).
    const failure = buildFailure({
      input,
      deps,
      phase,
      renderKey,
      hashes,
      config: input.config,
      segments: completed,
      framesRendered: stats.framesRendered,
      issues,
      events,
      error,
    });
    if (work !== undefined) {
      try {
        writeFileSync(path.join(work.dir, "failure.json"), failureBytes(failure));
      } catch {
        // The report is best-effort: never let it hide the original failure.
      }
    }
    throw attachFailure(error, failure);
  }
}

const FAILURE = Symbol.for("nexus.video.renderFailure");

/** Read the failure report off an error thrown by `renderVideo`, if it has one. */
export function renderFailureOf(error: unknown): RenderFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = (error as Record<symbol, unknown>)[FAILURE];
  return failure === undefined ? undefined : (failure as RenderFailure);
}

function attachFailure(error: unknown, failure: RenderFailure): unknown {
  if (error instanceof Error) {
    (error as unknown as Record<symbol, unknown>)[FAILURE] = failure;
  }
  return error;
}

function buildFailure(options: {
  readonly input: RenderPipelineInput;
  readonly deps: RenderPipelineDeps;
  readonly phase: RenderPhase;
  readonly renderKey: string;
  readonly hashes:
    | {
        readonly manifestHash: string;
        readonly audioTrackHash: string;
        readonly captionTrackHash: string;
        readonly configHash: string;
      }
    | undefined;
  readonly config: RenderConfig;
  readonly segments: readonly JournalSegment[];
  readonly framesRendered: number;
  readonly issues: readonly RenderIssue[];
  readonly events: readonly RenderLogEvent[];
  readonly error: unknown;
}): RenderFailure {
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  const errorCode = renderErrorCodeOf(options.error);
  return {
    version: RESULT_VERSION,
    kind: "render_failure",
    generatedAt: generatedAt(options.input, options.deps),
    phase: options.phase,
    code: errorCode,
    message: message.slice(0, 4_000),
    retryable: isRenderError(options.error) ? options.error.retryable : false,
    ...(options.renderKey !== "" ? { renderKey: options.renderKey } : {}),
    ...(options.hashes !== undefined
      ? {
          configHash: options.hashes.configHash,
          manifestHash: options.hashes.manifestHash,
          audioTrackHash: options.hashes.audioTrackHash,
          captionTrackHash: options.hashes.captionTrackHash,
        }
      : {}),
    config: options.config,
    resumed:
      options.segments.some((segment) => segment.reused) ||
      options.events.some(
        (event) => event.event === "render.started" && event.data?.resumed === true,
      ),
    segments: options.segments.map(toMetadataSegment),
    framesRendered: options.framesRendered,
    issues: [...options.issues],
    ...(options.deps.ffmpeg.path !== ""
      ? { ffmpegPath: options.deps.ffmpeg.path, ffmpegVersion: options.deps.ffmpeg.version }
      : {}),
    ...(FFMPEG_CODES.has(renderErrorCodeOf(options.error)) ? { stderrTail: tail(message) } : {}),
    logTail: options.events
      .slice(-40)
      .map((event) => `${event.level} ${event.event}: ${event.message}`),
    hint: hintFor(errorCode),
  };
}

function renderErrorCodeOf(error: unknown): string {
  return isRenderError(error) ? error.code : "unknown";
}

/** Codes whose message is FFmpeg's own output, worth keeping verbatim. */
const FFMPEG_CODES = new Set(["ffmpeg_failed", "ffmpeg_timeout", "ffmpeg_missing"]);

function hintFor(code: string): string {
  switch (code) {
    case "ffmpeg_missing":
      return "Install FFmpeg or point NEXUS_FFMPEG_PATH (alias NEXUS_RENDER_FFMPEG) at a static build.";
    case "ffmpeg_timeout":
      return "Raise the render timeout or lower config.segmentFrames so each command does less work.";
    case "ffmpeg_failed":
      return "Read stderrTail: a bad filter, a missing input or an unwritable directory are the usual causes.";
    case "unsupported_codec":
      return "Pick a codec this FFmpeg can write; `ffmpeg -encoders` lists them (toolchain.encoders in the metadata).";
    case "invalid_config":
      return "Fix the render configuration; the fps must match the scene plan and the aspect ratio must agree.";
    case "empty_timeline":
      return "The scene manifest composed to zero frames; check scene durations and the animation cues.";
    case "frame_failed":
      return "A frame could not be rasterised or encoded; check the character assets and the scene's text.";
    case "audio_failed":
      return "Check the narration artifacts: the clips must be readable PCM WAV in the content-addressed store.";
    case "concat_failed":
      return "Segment joining failed; the segment files may be missing or from different encoders.";
    default:
      return "The failure report names the phase; the segments listed there are already rendered and will be reused.";
  }
}

function toMetadataSegment(segment: JournalSegment): RenderSegment {
  return {
    index: segment.index,
    firstFrame: segment.firstFrame,
    lastFrame: segment.lastFrame,
    frameCount: segment.frameCount,
    key: segment.key,
    frameDigest: segment.frameDigest,
    file: segment.file,
    bytes: segment.bytes,
    hash: segment.hash,
    renderMs: segment.renderMs,
    reused: segment.reused,
  };
}

function flatFrames(composed: ComposedVideo): Frame[] {
  return composed.scenes.flatMap((scene) => [...scene.frames]);
}

function composeVideoFor(input: RenderPipelineInput): ComposedVideo {
  return composeVideo(buildTimeline(input.manifest), {
    deps: { characters: input.characterStage },
  });
}

function generatedAt(input: RenderPipelineInput, deps: RenderPipelineDeps): string {
  if (input.now !== undefined) return input.now;
  return (deps.clock?.now() ?? new Date()).toISOString();
}

function loadRenderFonts(
  config: RenderConfig,
  issue: (code: RenderIssueCode, message: string) => void,
): FontSet | undefined {
  const regularFile = config.fontFile !== "" ? config.fontFile : findFont(DEFAULT_FONT_CANDIDATES);
  if (regularFile === undefined || !existsSync(regularFile)) {
    issue(
      "font_missing",
      "no font file was configured and none of the usual system fonts exist, so on-screen text and captions are not drawn (set NEXUS_RENDER_FONT)",
    );
    return undefined;
  }
  const regular = loadFontFile(regularFile);
  const boldFile =
    config.fontBoldFile !== "" ? config.fontBoldFile : findFont(DEFAULT_BOLD_FONT_CANDIDATES);
  const bold = boldFile !== undefined && existsSync(boldFile) ? loadFontFile(boldFile) : undefined;
  return bold === undefined ? { regular } : { regular, bold };
}

interface SegmentContext {
  readonly plan: SegmentPlan;
  readonly input: RenderPipelineInput;
  readonly config: RenderConfig;
  readonly composed: ComposedVideo;
  readonly work: WorkDir;
  readonly deps: RenderPipelineDeps;
  readonly fonts: FontSet | undefined;
  readonly stats: RunStats;
  readonly previous: JournalSegment | undefined;
  readonly log: (
    level: RenderLogEvent["level"],
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ) => void;
  readonly issue: (code: RenderIssueCode, message: string, extra?: Partial<RenderIssue>) => void;
}

/**
 * Render (or reuse) one segment.
 *
 * Reuse is decided on the *key* — a hash of the frames, the captions in the
 * window, the fonts and the encoder settings — and confirmed on the *bytes*: the
 * recorded file must still be there and still hash to what was recorded. A key
 * match with a missing or altered file is a re-render, never a silent adoption of
 * something else.
 */
function renderSegment(context: SegmentContext): JournalSegment {
  const { plan, work, previous, config, deps, stats } = context;
  const file = segmentFile(work, plan.index);

  if (previous !== undefined && previous.key === plan.key && existsSync(file)) {
    const digest = fileDigest(file);
    if (digest.hash === previous.hash && digest.bytes === previous.bytes) {
      context.issue(
        "segment_reused",
        `segment ${plan.index} was adopted from a previous run (${plan.frameCount} frames, ${digest.bytes} bytes)`,
        { segment: plan.index },
      );
      context.stats.framesReused += plan.frameCount;
      return { ...previous, reused: true };
    }
    context.log(
      "warn",
      "render.segment_stale",
      `segment ${plan.index} on disk no longer matches the journal; rendering it again`,
    );
  }

  const frameHashes = rasteriseSegment(context);
  const encodeStarted = Date.now();
  deps.ffmpeg.run({
    label: `encode segment ${plan.index}`,
    timeoutMs: config.timeoutMs,
    args: [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-framerate",
      String(config.fps),
      "-start_number",
      String(plan.firstFrame),
      "-i",
      path.join(work.framesDir, "frame-%06d.png"),
      "-frames:v",
      String(plan.frameCount),
      "-c:v",
      config.videoCodec,
      "-preset",
      config.preset,
      "-crf",
      String(config.crf),
      "-pix_fmt",
      config.pixFmt,
      "-threads",
      String(config.threads),
      "-r",
      String(config.fps),
      "-progress",
      "pipe:1",
      "-nostats",
      file,
    ],
  });
  stats.ffmpegCalls += 1;
  const encodeMs = Date.now() - encodeStarted;
  if (!existsSync(file)) {
    throw new RenderError(`segment ${plan.index} produced no file`, { code: "output_invalid" });
  }
  const digest = fileDigest(file);
  stats.encodeMs += encodeMs;
  if (!config.keepFrames) dropSegmentFrames(work, plan.firstFrame, plan.lastFrame);

  context.log("info", "render.segment_done", `segment ${plan.index} encoded`, {
    frames: plan.frameCount,
    bytes: digest.bytes,
    encodeMs,
  });

  return {
    index: plan.index,
    firstFrame: plan.firstFrame,
    lastFrame: plan.lastFrame,
    frameCount: plan.frameCount,
    key: plan.key,
    frameDigest: plan.frameDigest,
    file,
    bytes: digest.bytes,
    hash: digest.hash,
    renderMs: encodeMs,
    reused: false,
    frameHashes: [...frameHashes],
  };
}

/**
 * Rasterise every frame of a segment to PNG.
 *
 * A frame a previous run wrote is adopted only when the journal's recorded hash
 * for it still matches the file: the seconds a rasteriser spends are worth
 * keeping, but not at the price of adopting a half-written file from a killed
 * process.
 */
function rasteriseSegment(context: SegmentContext): readonly string[] {
  const { plan, work, config, composed, input, deps, fonts, previous } = context;
  const hashes: string[] = [];
  const started = Date.now();
  for (let index = plan.firstFrame; index <= plan.lastFrame; index += 1) {
    const frame = frameAt(composed, index);
    if (frame === undefined) {
      throw new RenderError(`frame ${index} is missing from the composed timeline`, {
        code: "frame_failed",
      });
    }
    const file = frameFile(work, index);
    const expected = previous?.frameHashes?.[index - plan.firstFrame];
    if (existsSync(file)) {
      const digest = fileDigest(file);
      if (expected === undefined || expected === digest.hash) {
        hashes.push(digest.hash);
        context.stats.framesReused += 1;
        continue;
      }
      context.log(
        "warn",
        "render.frame_stale",
        `frame ${index} changed on disk; rasterising it again`,
      );
    }

    let raster;
    try {
      raster = rasteriseFrame(
        frame,
        {
          readAsset: (assetPath) => input.characterStage.read(assetPath),
          ...(fonts !== undefined ? { fonts } : {}),
        },
        {
          resolution: { width: config.width, height: config.height },
          ...(deps.look !== undefined ? { look: deps.look } : {}),
        },
      );
    } catch (error) {
      context.issue(
        "frame_failed",
        `frame ${index} could not be rasterised: ${error instanceof Error ? error.message : String(error)}`,
        { segment: plan.index },
      );
      throw error;
    }
    reportRasterDiagnostics(raster.diagnostics, context);
    if (config.captions === "burn" && input.captionTrack !== undefined && fonts !== undefined) {
      const drawn = drawCaption(
        raster.canvas,
        input.captionTrack,
        Math.round(frame.timeSec * 1_000),
        fonts,
        captionStyleFor(config),
      );
      if (drawn !== undefined && drawn.lines.every((line) => line.trim() === "")) {
        context.issue("caption_cue_empty", `cue ${drawn.cueId} has no text to draw`, {
          segment: plan.index,
        });
      }
    }
    const bytes = encodePng(raster.canvas);
    if (config.verifyFrames) {
      const problem = verifyPngRoundTrip(bytes, raster.canvas);
      if (problem !== undefined) {
        context.issue("frame_corrupt", `frame ${index} did not survive encoding: ${problem}`, {
          segment: plan.index,
        });
        throw new RenderError(`frame ${index} did not survive PNG encoding: ${problem}`, {
          code: "frame_failed",
        });
      }
    }
    writeFileSync(file, bytes);
    hashes.push(sha256(bytes));
    context.stats.framesRendered += 1;
  }
  context.stats.rasterMs += Date.now() - started;
  return hashes;
}

function reportRasterDiagnostics(
  diagnostics: readonly { code: string; severity: string; elementId: string; message: string }[],
  context: SegmentContext,
): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      context.issue("missing_asset", `${diagnostic.elementId}: ${diagnostic.message}`, {
        segment: context.plan.index,
      });
      continue;
    }
    if (diagnostic.code === "text_skipped") {
      context.issue("text_skipped", `${diagnostic.elementId}: ${diagnostic.message}`, {
        segment: context.plan.index,
      });
    } else if (diagnostic.code === "reveal_rotated") {
      context.issue("reveal_rotated", `${diagnostic.elementId}: ${diagnostic.message}`, {
        segment: context.plan.index,
      });
    }
  }
}

function frameAt(composed: ComposedVideo, index: number): Frame | undefined {
  for (const scene of composed.scenes) {
    for (const frame of scene.frames) {
      if (frame.index === index) return frame;
    }
  }
  return undefined;
}

function captionStyleFor(config: RenderConfig): {
  fontPx: number;
  marginPx: number;
  bandOpacity: number;
  ink: string;
  band: string;
  safeWidthRatio: number;
} {
  return {
    fontPx: config.captionFontPx,
    marginPx: config.captionMarginPx,
    bandOpacity: config.captionBandOpacity,
    ink: "#f6f4ee",
    band: "#0b0f14",
    safeWidthRatio: 0.9,
  };
}

function captionsBurned(captionTrack: CaptionTrack | undefined, config: RenderConfig): number {
  if (captionTrack === undefined || config.captions !== "burn") return 0;
  return captionTrack.totals.cues;
}

interface NarrationResult {
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
  readonly metadata: NonNullable<RenderMetadata["audio"]>;
}

/** Build the continuous narration WAV from the voice track's clips. */
function assembleAudio(options: {
  readonly input: RenderPipelineInput;
  readonly deps: RenderPipelineDeps;
  readonly work: WorkDir;
  readonly log: SegmentContext["log"];
  readonly issue: SegmentContext["issue"];
}): NarrationResult | undefined {
  const track = options.input.audioTrack;
  if (track === undefined) {
    options.issue(
      "audio_missing",
      "the render has no narration track, so the video is silent (run the voice stage first)",
    );
    return undefined;
  }
  const assembled = assembleNarration(
    narrationClips(track),
    (hash) => options.deps.storage.read(hash),
    {
      sampleRate: options.input.config.audioSampleRate,
      channels: options.input.config.audioChannels,
      durationSec: options.input.manifest.totalDurationSec,
    },
  );
  if (assembled.skipped.length > 0) {
    options.issue(
      "audio_unusable",
      `${assembled.skipped.length} narration clip(s) could not be placed: ${assembled.skipped.join("; ")}`,
    );
  }
  if (assembled.clips === 0) {
    options.issue(
      "audio_unusable",
      "none of the narration clips could be read, so the video is silent",
    );
  }
  const bytes = encodeWav(assembled.wav);
  const file = path.join(options.work.dir, "narration.wav");
  writeFileSync(file, bytes);
  const digest = fileDigest(file);
  const loudness =
    options.input.config.measureLoudness && assembled.clips > 0
      ? measureLoudness(options.deps.ffmpeg, file)
      : undefined;
  if (options.input.config.measureLoudness && assembled.clips > 0 && loudness === undefined) {
    options.issue("audio_unmeasured", "loudness could not be measured for the narration track");
  }
  options.log("info", "render.audio", `narration assembled from ${assembled.clips} clip(s)`, {
    durationSec: Number(assembled.wav.durationSec.toFixed(3)),
    sampleRate: assembled.wav.sampleRate,
    channels: assembled.wav.channels,
    skipped: assembled.skipped.length,
  });
  return {
    file,
    hash: digest.hash,
    bytes: digest.bytes,
    metadata: {
      hash: digest.hash,
      bytes: digest.bytes,
      sampleRate: assembled.wav.sampleRate,
      channels: assembled.wav.channels,
      durationSec: Number(assembled.wav.durationSec.toFixed(3)),
      clips: assembled.clips,
      skipped: assembled.skipped.length,
      ...(options.input.audioTrackHash !== undefined
        ? { sourceTrackHash: options.input.audioTrackHash }
        : {}),
      ...(loudness !== undefined ? { loudness } : {}),
    },
  };
}

interface FinaliseResult {
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
  readonly reused: boolean;
}

/** Concat the segments and mux the narration — or adopt both from a previous run. */
function finalise(options: {
  readonly work: WorkDir;
  readonly deps: RenderPipelineDeps;
  readonly config: RenderConfig;
  readonly segments: readonly JournalSegment[];
  readonly narration: NarrationResult | undefined;
  readonly previous: RenderOutput | undefined;
  readonly log: SegmentContext["log"];
  readonly issue: SegmentContext["issue"];
  readonly stats: RunStats;
}): FinaliseResult {
  const { work, deps, config, segments, narration } = options;
  if (options.previous !== undefined && existsSync(options.previous.file)) {
    const digest = fileDigest(options.previous.file);
    if (digest.hash === options.previous.hash && digest.bytes === options.previous.bytes) {
      options.issue("output_reused", "the assembled video was adopted from a previous run");
      return { file: options.previous.file, hash: digest.hash, bytes: digest.bytes, reused: true };
    }
  }

  const started = Date.now();
  const videoOnly =
    segments.length === 1 ? (segments[0]?.file ?? "") : path.join(work.dir, "concat.mp4");
  if (segments.length !== 1) {
    writeFileSync(
      work.concatFile,
      `${segments.map((segment) => `file '${segment.file.replace(/'/gu, "'\\''")}'`).join("\n")}\n`,
    );
    deps.ffmpeg.run({
      label: "concat segments",
      timeoutMs: config.timeoutMs,
      args: [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        work.concatFile,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        videoOnly,
      ],
    });
    options.stats.ffmpegCalls += 1;
  }
  if (videoOnly === "" || !existsSync(videoOnly)) {
    throw new RenderError("the concatenated video was not produced", { code: "concat_failed" });
  }

  const filters = audioFilters(config.normalizeAudio);
  deps.ffmpeg.run({
    label: "mux narration",
    timeoutMs: config.timeoutMs,
    args: [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      videoOnly,
      ...(narration !== undefined ? ["-i", narration.file] : []),
      "-map",
      "0:v:0",
      ...(narration !== undefined ? ["-map", "1:a:0"] : []),
      "-c:v",
      "copy",
      ...(narration !== undefined
        ? [
            "-c:a",
            config.audioCodec,
            "-b:a",
            config.audioBitrate,
            "-ar",
            String(config.audioSampleRate),
            "-ac",
            String(config.audioChannels),
            ...(filters !== undefined ? ["-af", filters] : []),
          ]
        : ["-an"]),
      "-movflags",
      "+faststart",
      work.outputFile,
    ],
  });
  options.stats.ffmpegCalls += 1;
  options.stats.muxMs += Date.now() - started;
  if (!existsSync(work.outputFile)) {
    throw new RenderError("the mux step produced no video file", { code: "output_invalid" });
  }
  const digest = fileDigest(work.outputFile);
  if (digest.bytes > config.maxOutputBytes) {
    throw new RenderError(
      `the output is ${digest.bytes} bytes, over the ${config.maxOutputBytes} byte ceiling the configuration allows`,
      { code: "output_invalid" },
    );
  }
  if (segments.length !== 1) rmSync(videoOnly, { force: true });
  return { file: work.outputFile, hash: digest.hash, bytes: digest.bytes, reused: false };
}

/** Read the container back and check the promises the pipeline made. */
function verifyOutput(
  file: string,
  config: RenderConfig,
  input: RenderPipelineInput,
  log: SegmentContext["log"],
  issue: SegmentContext["issue"],
): Mp4Info {
  let info: Mp4Info;
  try {
    info = readMp4(file);
  } catch (error) {
    issue(
      "output_missing",
      `the video could not be read back: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new RenderError("the rendered video could not be read back", { code: "output_invalid" });
  }
  log("info", "render.verified", `output is ${info.durationSec.toFixed(3)}s`, {
    durationSec: Number(info.durationSec.toFixed(3)),
    videoCodec: info.video?.codec ?? "none",
    audioCodec: info.audio?.codec ?? "none",
    frames: info.video?.frameCount ?? 0,
    fastStart: info.fastStart,
  });
  if (info.video === undefined) {
    throw new RenderError("the rendered file has no video track", { code: "output_invalid" });
  }
  if (info.video.width !== config.width || info.video.height !== config.height) {
    issue(
      "invalid_config",
      `the output is ${info.video.width}x${info.video.height}, not the configured ${config.width}x${config.height}`,
    );
  }
  const expected = input.manifest.totalDurationSec;
  if (info.durationSec + 1 / config.fps < expected) {
    issue(
      "duration_shortfall",
      `the output is ${info.durationSec.toFixed(3)}s but the scene plan is ${expected}s`,
    );
  }
  return info;
}

function makeThumbnail(options: {
  readonly work: WorkDir;
  readonly deps: RenderPipelineDeps;
  readonly config: RenderConfig;
  readonly log: SegmentContext["log"];
  readonly issue: SegmentContext["issue"];
  readonly atSec: number;
}): { file: string; hash: string; bytes: number; atSec: number } | undefined {
  const atSec = options.atSec;
  try {
    options.deps.ffmpeg.run({
      label: "thumbnail",
      timeoutMs: options.config.timeoutMs,
      args: [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        atSec.toFixed(3),
        "-i",
        options.work.outputFile,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        options.work.thumbnailFile,
      ],
    });
    if (!existsSync(options.work.thumbnailFile)) {
      options.issue("thumbnail_failed", "the thumbnail frame was not produced");
      return undefined;
    }
    const digest = fileDigest(options.work.thumbnailFile);
    return { file: options.work.thumbnailFile, hash: digest.hash, bytes: digest.bytes, atSec };
  } catch (error) {
    options.issue(
      "thumbnail_failed",
      `the thumbnail could not be produced: ${tail(error instanceof Error ? error.message : String(error))}`,
    );
    options.log("warn", "render.thumbnail_failed", "the thumbnail was not produced");
    return undefined;
  }
}

function makeJournal(
  work: WorkDir,
  renderKey: string,
  hashes: { readonly configHash: string; readonly manifestHash: string },
  segments: readonly JournalSegment[],
  output: RenderOutput | undefined,
  updatedAt: string,
): ReturnType<typeof RenderJournalSchema.parse> {
  void work;
  return RenderJournalSchema.parse({
    version: RESULT_VERSION,
    renderKey,
    configHash: hashes.configHash,
    manifestHash: hashes.manifestHash,
    segments: segments.map((segment) => ({ ...segment })),
    ...(output !== undefined ? { output } : {}),
    updatedAt,
  });
}
