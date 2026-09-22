import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

/**
 * Raw environment schema. Every variable is optional with a safe default so
 * the system boots with zero configuration; invalid values fail fast at
 * startup with an actionable message (never mid-pipeline).
 *
 * Secrets are intentionally NOT part of this schema yet: per AD-12,
 * provider credentials arrive with their adapters (later phases) and are
 * referenced by env-var *name* only — never stored in the DB or repo.
 */
export const envSchema = z.object({
  NEXUS_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXUS_HOST: z.string().min(1).default("127.0.0.1"),
  NEXUS_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  NEXUS_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NEXUS_DATA_DIR: z.string().min(1).default("data"),
  NEXUS_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100).default(30_000),
  // Provider selection (AD-06). "none" = fully offline; "fake" = deterministic
  // offline implementation; "manual" = human-in-the-loop; otherwise an adapter
  // id, optionally with a variant (`openai-compatible:meta-llama/…`).
  NEXUS_LLM_PROVIDER: z.string().min(1).default("none"),
  NEXUS_TTS_PROVIDER: z.string().min(1).default("none"),
  NEXUS_RESEARCH_PROVIDER: z.string().min(1).default("none"),
  NEXUS_MEDIA_PROVIDER: z.string().min(1).default("none"),
  // Artifacts are local by design (AD-09); cloud storage is a later adapter.
  NEXUS_STORAGE_PROVIDER: z.string().min(1).default("local"),
  NEXUS_PUBLISHING_PROVIDER: z.string().min(1).default("none"),

  // ── Voice / audio (Phase 10) ───────────────────────────────────────────
  // Which voice narration is synthesized with. `""` means "whatever the
  // configured adapter lists first", so an install needs no voice id before it
  // has a voice account, and a real adapter is never pinned to a fake voice.
  NEXUS_TTS_VOICE: z.string().default(""),
  // Container and numbers every synthesized segment is produced with. They
  // travel into the audio artifact's metadata, so a re-run, a caption pass and a
  // mux all agree on what the voice actually is.
  NEXUS_TTS_FORMAT: z.enum(["wav", "mp3"]).default("wav"),
  NEXUS_TTS_SAMPLE_RATE: z.coerce.number().int().min(8_000).max(48_000).default(24_000),
  NEXUS_TTS_RATE: z.coerce.number().min(0.5).max(2).default(1),
  // Segment-level audio reuse: a JSON index path, or "off". A cached clip
  // survives an edited script, so only the scenes that changed are re-voiced.
  NEXUS_AUDIO_SEGMENT_CACHE: z.string().min(1).default("off"),

  // ── Rendering (Phase 11) ───────────────────────────────────────────────
  // The FFmpeg binary the render pipeline shells out to. Empty = look in the
  // usual places, then PATH. This is the only external program the system runs.
  NEXUS_FFMPEG_PATH: z.string().default(""),
  // Output shape. The defaults are 1080p30; a render whose size disagrees with
  // the scene plan's aspect ratio (or whose frame rate disagrees with its fps)
  // is refused rather than stretched or re-timed.
  NEXUS_RENDER_WIDTH: z.coerce.number().int().min(64).max(3840).default(1920),
  NEXUS_RENDER_HEIGHT: z.coerce.number().int().min(64).max(2160).default(1080),
  NEXUS_RENDER_FPS: z.coerce.number().int().min(1).max(60).default(30),
  // Encoder settings, recorded in every render's metadata: a video is only
  // reproducible if the settings that produced it are named.
  NEXUS_RENDER_VIDEO_CODEC: z.string().min(1).default("libx264"),
  NEXUS_RENDER_CRF: z.coerce.number().int().min(0).max(51).default(23),
  NEXUS_RENDER_PRESET: z
    .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"])
    .default("veryfast"),
  NEXUS_RENDER_AUDIO_BITRATE: z
    .string()
    .regex(/^\d+k?$/u)
    .default("128k"),
  // Burn the caption track into the picture, or ship the video without captions.
  NEXUS_RENDER_CAPTIONS: z.enum(["burn", "none"]).default("burn"),
  // Font file for on-screen text and captions; empty = search the usual system
  // paths. The font's sha256 travels into the metadata, so a video's text is
  // traceable to the exact face that drew it.
  NEXUS_RENDER_FONT: z.string().default(""),
  // Frames per segment: the unit of resumption and reuse. Smaller costs a
  // little more in encoder start-up and saves a lot when a run is killed.
  NEXUS_RENDER_SEGMENT_FRAMES: z.coerce.number().int().min(1).max(3600).default(90),
  // Encoder threads; 0 lets the encoder choose (and makes the encoded bytes
  // machine-dependent, which the metadata then says out loud).
  NEXUS_RENDER_THREADS: z.coerce.number().int().min(0).max(256).default(0),
  // Where frames, segments and the assembled file live. Empty = under the data
  // directory, so a render never writes inside the repository.
  NEXUS_RENDER_WORK_DIR: z.string().default(""),

  // ── Provider policy (AD-06/AD-13) ──────────────────────────────────────
  // Per-call deadline. Every provider call is bounded; a hung free tier must
  // not stall a stage.
  NEXUS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  // Attempts per call (transport-level retries), including the first.
  NEXUS_PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Content-hash caching of provider results: re-runs cost nothing (AD-13).
  NEXUS_PROVIDER_CACHE: z.enum(["on", "off"]).default("on"),
  // Fraction of a free-tier window at which a capability degrades to manual.
  NEXUS_PROVIDER_DEGRADE_RATIO: z.coerce.number().min(0).max(1).default(0.9),
  // Client-side safety valve (0 = no self-imposed limit).
  NEXUS_PROVIDER_RATE_LIMIT_PER_MIN: z.coerce.number().min(0).default(0),
  // Base URL + default model for OpenAI-compatible LLM endpoints (OD-3).
  // Validated here so a typo fails at startup, not on the first script call.
  NEXUS_LLM_BASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "must be an http(s) URL",
    })
    .default("https://openrouter.ai/api/v1"),
  NEXUS_LLM_MODEL: z.string().min(1).default("meta-llama/llama-3.1-8b-instruct"),
});

/**
 * The encoder presets FFmpeg's x264 accepts, and the only values the render
 * configuration will take. Declared here so the app layer's type *is* the render
 * layer's type: a render config built from `loadEnv().render` needs no widening.
 */
export type RenderPreset =
  "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower";

/** The validated, normalized application configuration. */
export interface AppConfig {
  readonly env: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** Absolute path for persistent state (SQLite DB + artifact store, later phases). */
  readonly dataDir: string;
  readonly workerHeartbeatMs: number;
  /** Which adapter serves each capability (AD-06). `none` = not configured. */
  readonly providers: {
    readonly llm: string;
    readonly tts: string;
    readonly research: string;
    readonly media: string;
    readonly storage: string;
    readonly publishing: string;
  };
  /** Voice + audio defaults the `voice` stage synthesizes with (Phase 10). */
  readonly audio: {
    readonly voice: string;
    readonly format: "wav" | "mp3";
    readonly sampleRate: number;
    readonly rate: number;
    /** `"off"`, or a path to the segment-cache index. */
    readonly segmentCache: string;
  };
  /** Render pipeline defaults: where FFmpeg is, and what a video is encoded as. */
  readonly render: {
    readonly ffmpegPath: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly videoCodec: string;
    readonly crf: number;
    /** The x264 preset, restricted to the names FFmpeg accepts. */
    readonly preset: RenderPreset;
    readonly audioBitrate: string;
    readonly captions: "burn" | "none";
    /** Font file for on-screen text and captions; `""` = search system paths. */
    readonly fontFile: string;
    readonly segmentFrames: number;
    readonly threads: number;
    readonly workDir: string;
  };
  /** Provider call policy: deadlines, retries, caching, budget degradation. */
  readonly providerPolicy: {
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly cacheEnabled: boolean;
    readonly degradeRatio: number;
    readonly rateLimitPerMinute: number;
    readonly llmBaseUrl: string;
    readonly defaultLlmModel: string;
  };
}

export interface LoadEnvOptions {
  /**
   * Explicit environment to validate. When omitted, `.env` is read from
   * `cwd` (if present) and merged under `process.env` — real environment
   * variables always win over file values.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directory to look for `.env` in and to resolve relative paths against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** Thrown when environment validation fails; message lists every issue. */
export class EnvValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(issues: readonly z.ZodIssue[]) {
    const details = issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Load and validate configuration. Pure with respect to `options.env`
 * (no mutation of `process.env`), which keeps it trivially testable.
 */
export function loadEnv(options: LoadEnvOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();

  let raw: Readonly<Record<string, string | undefined>>;
  if (options.env !== undefined) {
    raw = options.env;
  } else {
    const envPath = path.join(cwd, ".env");
    const fromFile: Record<string, string> = existsSync(envPath)
      ? parseDotenv(readFileSync(envPath, "utf8"))
      : {};
    raw = { ...fromFile, ...process.env };
  }

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  const parsed = result.data;

  return {
    env: parsed.NEXUS_ENV,
    host: parsed.NEXUS_HOST,
    port: parsed.NEXUS_PORT,
    logLevel: parsed.NEXUS_LOG_LEVEL,
    dataDir: path.isAbsolute(parsed.NEXUS_DATA_DIR)
      ? parsed.NEXUS_DATA_DIR
      : path.resolve(cwd, parsed.NEXUS_DATA_DIR),
    workerHeartbeatMs: parsed.NEXUS_WORKER_HEARTBEAT_MS,
    providers: {
      llm: parsed.NEXUS_LLM_PROVIDER,
      tts: parsed.NEXUS_TTS_PROVIDER,
      research: parsed.NEXUS_RESEARCH_PROVIDER,
      media: parsed.NEXUS_MEDIA_PROVIDER,
      storage: parsed.NEXUS_STORAGE_PROVIDER,
      publishing: parsed.NEXUS_PUBLISHING_PROVIDER,
    },
    audio: {
      voice: parsed.NEXUS_TTS_VOICE,
      format: parsed.NEXUS_TTS_FORMAT,
      sampleRate: parsed.NEXUS_TTS_SAMPLE_RATE,
      rate: parsed.NEXUS_TTS_RATE,
      segmentCache: parsed.NEXUS_AUDIO_SEGMENT_CACHE,
    },
    render: {
      ffmpegPath: parsed.NEXUS_FFMPEG_PATH,
      width: parsed.NEXUS_RENDER_WIDTH,
      height: parsed.NEXUS_RENDER_HEIGHT,
      fps: parsed.NEXUS_RENDER_FPS,
      videoCodec: parsed.NEXUS_RENDER_VIDEO_CODEC,
      crf: parsed.NEXUS_RENDER_CRF,
      preset: parsed.NEXUS_RENDER_PRESET,
      audioBitrate: parsed.NEXUS_RENDER_AUDIO_BITRATE,
      captions: parsed.NEXUS_RENDER_CAPTIONS,
      fontFile: parsed.NEXUS_RENDER_FONT,
      segmentFrames: parsed.NEXUS_RENDER_SEGMENT_FRAMES,
      threads: parsed.NEXUS_RENDER_THREADS,
      workDir: parsed.NEXUS_RENDER_WORK_DIR,
    },
    providerPolicy: {
      timeoutMs: parsed.NEXUS_PROVIDER_TIMEOUT_MS,
      maxAttempts: parsed.NEXUS_PROVIDER_MAX_ATTEMPTS,
      cacheEnabled: parsed.NEXUS_PROVIDER_CACHE === "on",
      degradeRatio: parsed.NEXUS_PROVIDER_DEGRADE_RATIO,
      rateLimitPerMinute: parsed.NEXUS_PROVIDER_RATE_LIMIT_PER_MIN,
      llmBaseUrl: parsed.NEXUS_LLM_BASE_URL,
      defaultLlmModel: parsed.NEXUS_LLM_MODEL,
    },
  };
}
