import { z } from "zod";

/**
 * The rendering pipeline's documents.
 *
 * Three of them, and each has one job:
 *
 * - `RenderConfig` — everything that decides what the pixels and the file look
 *   like. It is canonicalised and hashed, and that hash is what artifact reuse
 *   is keyed on: a render is reproducible only if the configuration behind it is
 *   named exactly (deterministic configuration, in the brief's words).
 * - `RenderMetadata` — what actually happened: the toolchain, the inputs by hash,
 *   the segments, the output's verified facts, the timings and the issues. It is
 *   evidence, so every field is something the pipeline measured.
 * - `RenderJournal` — the resume point. Written after every segment, so a killed
 *   process leaves the finished segments on disk *and on record*, and the next
 *   run reuses them instead of re-rasterising them.
 */

export const RESULT_VERSION = 1;
export const RENDER_ENGINE_NAME = "nexus-video";
export const RENDER_ENGINE_VERSION = "1.0.0";

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "expected a sha256 hex digest");

export const RenderConfigSchema = z.strictObject({
  /**
   * Output size. Must keep the scene plan's aspect ratio; the defaults are
   * 1080p30, and a plan at another shape fails validation rather than being
   * silently stretched.
   */
  width: z.number().int().min(64).max(3840).default(1920),
  height: z.number().int().min(64).max(2160).default(1080),
  /** Must equal the timeline's rate: a render does not re-time a scene plan. */
  fps: z.number().int().min(1).max(60).default(30),
  videoCodec: z.string().min(1).max(40).default("libx264"),
  crf: z.number().int().min(0).max(51).default(23),
  preset: z
    .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"])
    .default("veryfast"),
  pixFmt: z.enum(["yuv420p", "yuv444p"]).default("yuv420p"),
  audioCodec: z.string().min(1).max(40).default("aac"),
  audioBitrate: z
    .string()
    .regex(/^\d+k?$/u)
    .default("128k"),
  audioSampleRate: z.number().int().min(8_000).max(48_000).default(48_000),
  audioChannels: z.union([z.literal(1), z.literal(2)]).default(1),
  /** EBU R128 single-pass normalisation at -16 LUFS (off by default). */
  normalizeAudio: z.boolean().default(false),
  /** Measure loudness (a second decode of the narration) and record it. */
  measureLoudness: z.boolean().default(true),
  /** Burn the caption track into the frames, or leave the video uncaptioned. */
  captions: z.enum(["burn", "none"]).default("burn"),
  captionFontPx: z.number().int().min(8).max(120).default(22),
  captionMarginPx: z.number().int().min(0).max(400).default(24),
  captionBandOpacity: z.number().min(0).max(1).default(0.72),
  /** Frames per independently rendered unit; smaller means finer resumption. */
  segmentFrames: z.number().int().min(1).max(3600).default(90),
  /** Encoder threads; 0 lets x264 choose (and makes output machine-dependent). */
  threads: z.number().int().min(0).max(256).default(0),
  /** Keep the rasterised frames after a successful render (for inspection). */
  keepFrames: z.boolean().default(false),
  /** Refuse an output larger than this. */
  maxOutputBytes: z
    .number()
    .int()
    .min(1_000_000)
    .default(2 * 1024 * 1024 * 1024),
  /** Deadline per FFmpeg command. */
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .default(30 * 60 * 1000),
  /** Path to the FFmpeg binary; empty means "find it". */
  ffmpegPath: z.string().default(""),
  /** Font file for text and captions; empty means "find one". */
  fontFile: z.string().default(""),
  /** Bold face, when the system has one. */
  fontBoldFile: z.string().default(""),
  /** Work directory root (frames, segments, logs); empty means the data dir. */
  workDir: z.string().default(""),
  /** Verify that each segment's first frame PNG decodes to what was rendered. */
  verifyFrames: z.boolean().default(true),
});
export type RenderConfig = z.infer<typeof RenderConfigSchema>;

export const RenderConfigInputSchema = RenderConfigSchema.partial();
export type RenderConfigInput = z.input<typeof RenderConfigInputSchema>;

export const RENDER_ISSUE_CODES = [
  // errors
  "ffmpeg_missing",
  "ffmpeg_failed",
  "ffmpeg_timeout",
  "unsupported_codec",
  "invalid_config",
  "empty_timeline",
  "aspect_mismatch",
  "frame_failed",
  "audio_missing",
  "audio_unusable",
  "mux_failed",
  "concat_failed",
  "output_missing",
  "output_too_large",
  "frame_corrupt",
  // warnings
  "font_missing",
  "captions_missing",
  "captions_skipped",
  "caption_cue_empty",
  "text_skipped",
  "missing_asset",
  "reveal_rotated",
  "audio_unmeasured",
  "thumbnail_failed",
  "segment_reused",
  "duration_shortfall",
  "output_reused",
] as const;
export type RenderIssueCode = (typeof RENDER_ISSUE_CODES)[number];

/** The issues that mean "this render is not a deliverable". */
export const HARD_RENDER_ISSUE_CODES: readonly RenderIssueCode[] = [
  "ffmpeg_missing",
  "ffmpeg_failed",
  "ffmpeg_timeout",
  "unsupported_codec",
  "invalid_config",
  "empty_timeline",
  "aspect_mismatch",
  "frame_failed",
  "audio_unusable",
  "mux_failed",
  "concat_failed",
  "output_missing",
  "output_too_large",
  "frame_corrupt",
];

export function isHardRenderIssue(code: RenderIssueCode): boolean {
  return HARD_RENDER_ISSUE_CODES.includes(code);
}

export const RenderIssueSchema = z.strictObject({
  code: z.enum(RENDER_ISSUE_CODES),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1).max(2_000),
  /** The segment this happened in, when it is segment-scoped. */
  segment: z.number().int().min(0).optional(),
  /** FFmpeg's own last words, when the issue came from a command. */
  command: z.string().max(4_000).optional(),
});
export type RenderIssue = z.infer<typeof RenderIssueSchema>;

export const RenderSegmentSchema = z.strictObject({
  index: z.number().int().min(0),
  firstFrame: z.number().int().min(0),
  lastFrame: z.number().int().min(0),
  frameCount: z.number().int().min(1),
  /** Hash of everything that decides this segment's pixels. */
  key: Sha256Schema,
  /** Digest of the composed frames in this range. */
  frameDigest: Sha256Schema,
  file: z.string().min(1),
  bytes: z.number().int().min(0),
  hash: Sha256Schema,
  /** Wall-clock milliseconds spent rasterising and encoding it. */
  renderMs: z.number().int().min(0),
  /** True when a previous run's segment was adopted instead of re-rendered. */
  reused: z.boolean(),
});
export type RenderSegment = z.infer<typeof RenderSegmentSchema>;

export const RenderOutputSchema = z.strictObject({
  file: z.string().min(1),
  bytes: z.number().int().min(1),
  hash: Sha256Schema,
  container: z.string().min(1),
  durationSec: z.number().min(0),
  videoCodec: z.string().min(1),
  audioCodec: z.string().min(1),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  fps: z.number().min(1),
  frameCount: z.number().int().min(0),
  hasAudio: z.boolean(),
  fastStart: z.boolean(),
});
export type RenderOutput = z.infer<typeof RenderOutputSchema>;

export const RenderAudioSchema = z.strictObject({
  hash: Sha256Schema,
  bytes: z.number().int().min(0),
  sampleRate: z.number().int().min(8_000).max(192_000),
  channels: z.number().int().min(1).max(2),
  durationSec: z.number().min(0),
  /** Clips placed on the timeline; reported so a silent render is visible. */
  clips: z.number().int().min(0),
  skipped: z.number().int().min(0),
  sourceTrackHash: Sha256Schema.optional(),
  loudness: z
    .strictObject({
      inputI: z.number(),
      inputTp: z.number(),
      inputLra: z.number(),
      targetI: z.number().optional(),
    })
    .optional(),
});
export type RenderAudio = z.infer<typeof RenderAudioSchema>;

export const RenderToolchainSchema = z.strictObject({
  engine: z.string().min(1),
  engineVersion: z.string().min(1),
  ffmpegPath: z.string().min(1),
  ffmpegVersion: z.string().min(1),
  ffmpegBanner: z.string().max(500),
  encoders: z.array(z.string().max(80)).max(64),
  node: z.string().min(1),
  font: z
    .strictObject({
      name: z.string().min(1),
      file: z.string().min(1),
      hash: Sha256Schema,
      bytes: z.number().int().min(0),
    })
    .optional(),
  boldFont: z
    .strictObject({
      name: z.string().min(1),
      file: z.string().min(1),
      hash: Sha256Schema,
      bytes: z.number().int().min(0),
    })
    .optional(),
});
export type RenderToolchain = z.infer<typeof RenderToolchainSchema>;

export const RenderTotalsSchema = z.strictObject({
  frames: z.number().int().min(0),
  /** Frames this run rasterised (a frame kept from a previous run is not counted). */
  framesRendered: z.number().int().min(0),
  /** Frames this run did not have to rasterise: kept PNGs and adopted segments. */
  framesReused: z.number().int().min(0),
  segments: z.number().int().min(0),
  segmentsRendered: z.number().int().min(0),
  segmentsReused: z.number().int().min(0),
  ffmpegCalls: z.number().int().min(0),
  rasterMs: z.number().int().min(0),
  encodeMs: z.number().int().min(0),
  muxMs: z.number().int().min(0),
  wallMs: z.number().int().min(0),
  captionsBurned: z.number().int().min(0),
  bytesWritten: z.number().int().min(0),
});
export type RenderTotals = z.infer<typeof RenderTotalsSchema>;

export const RenderMetadataSchema = z.strictObject({
  version: z.literal(RESULT_VERSION),
  generatedAt: z.string().min(1),
  /** One hash over every input: the identity of this render. */
  renderKey: Sha256Schema,
  configHash: Sha256Schema,
  config: RenderConfigSchema,
  manifestHash: Sha256Schema,
  sceneManifestHash: z.string().optional(),
  audioTrackHash: Sha256Schema.optional(),
  captionTrackHash: Sha256Schema.optional(),
  castHashes: z.array(z.string().min(1).max(120)).max(32),
  timeline: z.strictObject({
    fps: z.number().min(1),
    frameCount: z.number().int().min(0),
    durationSec: z.number().min(0),
    resolution: z.strictObject({ width: z.number().int(), height: z.number().int() }),
    frameDigest: Sha256Schema,
    scenes: z.number().int().min(0),
    diagnostics: z.array(z.string().max(200)).max(64),
  }),
  toolchain: RenderToolchainSchema,
  audio: RenderAudioSchema.optional(),
  output: RenderOutputSchema,
  thumbnail: z
    .strictObject({
      hash: Sha256Schema,
      bytes: z.number().int().min(1),
      atSec: z.number().min(0),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
    })
    .optional(),
  segments: z.array(RenderSegmentSchema),
  totals: RenderTotalsSchema,
  issues: z.array(RenderIssueSchema),
  warnings: z.array(z.string().max(500)),
  resumed: z.boolean(),
  /** True when nothing about this render depends on the machine it ran on. */
  deterministic: z.boolean(),
  determinismNotes: z.array(z.string().max(300)),
  provenance: z.strictObject({
    generator: z.string().min(1),
    aiSteps: z.array(z.string().max(100)),
  }),
});
export type RenderMetadata = z.infer<typeof RenderMetadataSchema>;

/**
 * A segment as the journal records it: the metadata's segment plus the hash of
 * every frame PNG it wrote. Those hashes are what lets a resumed run *verify* the
 * frames a killed process left behind instead of re-rasterising them — and they
 * are journal-only, because the final metadata is a report, not a cache index.
 */
export const JournalSegmentSchema = RenderSegmentSchema.extend({
  frameHashes: z.array(Sha256Schema).max(3_600).optional(),
});
export type JournalSegment = z.infer<typeof JournalSegmentSchema>;

/**
 * The failure report.
 *
 * A failed render must be as legible as a successful one: which phase died, what
 * FFmpeg said, which segments are already on disk (they are reusable), and what to
 * do next. It is written into the render's work directory as `failure.json` when a
 * run throws, and the stage persists it as an artifact, so "the video failed" is
 * always accompanied by the evidence.
 */
export const RENDER_PHASES = [
  "config",
  "compose",
  "segment",
  "audio",
  "finalise",
  "verify",
  "thumbnail",
] as const;
export type RenderPhase = (typeof RENDER_PHASES)[number];

export const RenderFailureSchema = z.strictObject({
  version: z.literal(RESULT_VERSION),
  kind: z.literal("render_failure"),
  generatedAt: z.string().min(1),
  phase: z.enum(RENDER_PHASES),
  code: z.string().min(1).max(40),
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
  renderKey: Sha256Schema.optional(),
  configHash: Sha256Schema.optional(),
  manifestHash: z.string().min(1).max(120).optional(),
  audioTrackHash: z.string().min(1).max(120).optional(),
  captionTrackHash: z.string().min(1).max(120).optional(),
  config: RenderConfigSchema,
  resumed: z.boolean(),
  /** Segments that finished before the failure; their files are still reusable. */
  segments: z.array(RenderSegmentSchema),
  framesRendered: z.number().int().min(0),
  issues: z.array(RenderIssueSchema),
  command: z.string().max(2_000).optional(),
  ffmpegPath: z.string().max(500).optional(),
  ffmpegVersion: z.string().max(200).optional(),
  stderrTail: z.string().max(4_000).optional(),
  logTail: z.array(z.string().max(600)).max(60),
  hint: z.string().max(600),
});
export type RenderFailure = z.infer<typeof RenderFailureSchema>;

export function failureBytes(failure: RenderFailure): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(RenderFailureSchema.parse(failure), null, 2)}\n`,
  );
}

export const RenderJournalSchema = z.strictObject({
  version: z.literal(RESULT_VERSION),
  renderKey: Sha256Schema,
  configHash: Sha256Schema,
  manifestHash: Sha256Schema,
  /** Segments finished (and verified) by any previous run of this render key. */
  segments: z.array(JournalSegmentSchema),
  output: RenderOutputSchema.optional(),
  updatedAt: z.string().min(1),
});
export type RenderJournal = z.infer<typeof RenderJournalSchema>;

export function metadataBytes(metadata: RenderMetadata): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(RenderMetadataSchema.parse(metadata), null, 2)}\n`,
  );
}

export function journalBytes(journal: RenderJournal): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(RenderJournalSchema.parse(journal), null, 2)}\n`,
  );
}

/** True when the metadata describes a complete, deliverable render. */
export function isRenderComplete(metadata: RenderMetadata): boolean {
  return !metadata.issues.some((issue) => issue.severity === "error");
}
