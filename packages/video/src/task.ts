import { existsSync } from "node:fs";
import path from "node:path";

import { loadAudioTrack } from "@nexus/audio";
import { loadCaptionTrack } from "@nexus/audio";
import { CharacterLibrary } from "@nexus/characters";
import type { Repo } from "@nexus/db";
import {
  PermanentError,
  RetryableError,
  type Task,
  type TaskContext,
  type TaskResult,
} from "@nexus/jobs";
import type { Clock } from "@nexus/providers";
import { createCharacterStage } from "@nexus/render";
import { loadSceneManifest } from "@nexus/scenes";
import type { BlobStore } from "@nexus/storage";

import { resolveRenderConfig } from "./config.js";
import { isRenderError, messageOf } from "./errors.js";
import { createFFmpegRunner, resolveFFmpegPath, type FFmpegRunner } from "./ffmpeg.js";
import {
  loadRenderMetadata,
  METADATA_ARTIFACT_ROLE,
  persistRender,
  persistRenderFailure,
  renderArtifactRefs,
  renderLogBytes,
} from "./persist.js";
import { renderFailureOf, renderVideo, type RenderLogEvent } from "./pipeline.js";
import type { RenderConfigInput, RenderMetadata } from "./schema.js";

/**
 * The `render` stage task: the orchestrator's entry point into the pipeline.
 *
 * It owns the four things the pipeline must not decide for itself:
 *
 * - **what it renders** — the scene manifest the plan stage published, the voice
 *   and caption artifacts the stages after it published, read back through their
 *   own loaders (so a malformed artifact fails here, loudly, and not inside a
 *   rasteriser);
 * - **with what** — the character library on disk plus the resolved render
 *   configuration, hashed into the render key;
 * - **where** — a work directory under the data dir (or the configured root),
 *   never inside the repository;
 * - **how failure reaches the runner** — the retryable/permanent split, plus the
 *   metadata artifact that records *why*.
 *
 * The stage is deliberately not parallel: segment-level reuse means a re-run
 * after a fix costs only the segments whose pixels changed, which is the leverage
 * that matters more than threads on a $0 runner.
 */

export const RENDER_STAGE_KEY = "render";

export interface RenderTaskDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
  /** The character library root; defaults to the bundled demonstration cast. */
  readonly charactersRoot?: string | undefined;
  readonly workRoot?: string | undefined;
  readonly config?: RenderConfigInput | undefined;
  readonly clock?: Clock | undefined;
  /** An already probed/scripted FFmpeg; without one the real binary is located. */
  readonly ffmpeg?: FFmpegRunner | undefined;
}

export function createRenderTask(deps: RenderTaskDeps): Task {
  return {
    stageKey: RENDER_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      // The media stage (when it ran) publishes the manifest with resolved
      // assets — the one the video should actually draw.
      const manifestHash =
        upstreamHash(ctx, "source_media", "manifestHash") ??
        upstreamHash(ctx, "plan", "manifestHash") ??
        namedParam(ctx, "manifestHash");
      if (manifestHash === undefined) {
        throw new PermanentError(
          "render stage has no scene manifest: run the plan stage first, or pass params.manifestHash",
        );
      }
      let manifest;
      try {
        manifest = loadSceneManifest(deps.storage, manifestHash);
      } catch (error) {
        throw new PermanentError(
          `render stage cannot read scene manifest ${manifestHash}: ${messageOf(error)}`,
          { cause: error },
        );
      }

      const audioHash =
        upstreamHash(ctx, "voice", "trackHash") ?? namedParam(ctx, "audioTrackHash");
      const captionHash =
        upstreamHash(ctx, "captions", "captionHash") ??
        upstreamHash(ctx, "captions", "trackHash") ??
        namedParam(ctx, "captionTrackHash");

      let audioTrack;
      if (audioHash !== undefined) {
        try {
          audioTrack = loadAudioTrack(deps.storage, audioHash);
        } catch (error) {
          throw new PermanentError(
            `render stage cannot read the voice track ${audioHash}: ${messageOf(error)}`,
            { cause: error },
          );
        }
      }
      let captionTrack;
      if (captionHash !== undefined) {
        try {
          captionTrack = loadCaptionTrack(deps.storage, captionHash);
        } catch (error) {
          throw new PermanentError(
            `render stage cannot read the caption track ${captionHash}: ${messageOf(error)}`,
            { cause: error },
          );
        }
      }

      const config = resolveRenderConfig(deps.config ?? {});
      const runner = deps.ffmpeg ?? locateFFmpeg(config.ffmpegPath);
      const workRoot =
        deps.workRoot ??
        (config.workDir !== "" ? config.workDir : path.join(process.cwd(), "data", "render"));
      const library = CharacterLibrary.load(
        deps.charactersRoot === undefined ? {} : { dir: deps.charactersRoot },
      );
      const characterStage = createCharacterStage(library);

      ctx.log("render.started", `rendering ${manifest.scenes.length} scene(s)`, {
        manifestHash,
        audioTrackHash: audioHash ?? null,
        captionTrackHash: captionHash ?? null,
        resolution: `${config.width}x${config.height}`,
        fps: config.fps,
        captions: config.captions,
        ffmpeg: runner.version,
        workRoot,
      });

      let result;
      try {
        result = renderVideo(
          {
            manifest,
            manifestHash,
            config,
            characterStage,
            ...(audioTrack !== undefined ? { audioTrack } : {}),
            ...(audioHash !== undefined ? { audioTrackHash: audioHash } : {}),
            ...(captionTrack !== undefined ? { captionTrack } : {}),
            ...(captionHash !== undefined ? { captionTrackHash: captionHash } : {}),
            signal: ctx.signal,
          },
          {
            ffmpeg: runner,
            storage: deps.storage,
            workRoot,
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            onEvent: (event: RenderLogEvent) => {
              if (event.level === "error")
                ctx.log("render.error", event.message, { event: event.event });
            },
          },
        );
      } catch (error) {
        // A failed render has a report; put it in the CAS and name it in the
        // error, so a retry decision can be made from the evidence.
        const failure = renderFailureOf(error);
        const report =
          failure === undefined ? undefined : persistFailureQuietly(deps, failure, ctx);
        const suffix = report === undefined ? "" : ` (failure report ${report.hash})`;
        if (isRenderError(error)) {
          throw error.retryable
            ? new RetryableError(`${error.message}${suffix}`, { cause: error })
            : new PermanentError(`${error.message}${suffix}`, { cause: error });
        }
        if (failure !== undefined) {
          throw new PermanentError(
            `${error instanceof Error ? error.message : String(error)}${suffix}`,
            { cause: error },
          );
        }
        throw error;
      }

      const logBytes = renderLogBytes(result.events, {
        renderKey: result.renderKey,
        engine: result.metadata.toolchain.engine,
        engineVersion: result.metadata.toolchain.engineVersion,
      });
      const persisted = persistRender(deps, result, result.metadata, logBytes);
      const metadata: RenderMetadata = result.metadata;
      const hardIssues = metadata.issues.filter((issue) => issue.severity === "error");
      if (hardIssues.length > 0) {
        // The bytes exist, but the pipeline reported something that makes this
        // file not a deliverable. Fail the step, and leave the evidence behind.
        throw new PermanentError(
          `the render produced a file but reported ${hardIssues.length} hard failure(s): ` +
            `${hardIssues.map((issue) => `${issue.code} (${issue.message})`).join("; ")} ` +
            `— metadata ${persisted.metadata.hash}`,
        );
      }

      for (const issue of metadata.issues) {
        ctx.log(issue.severity === "error" ? "render.issue" : "render.warning", issue.message, {
          code: issue.code,
          segment: issue.segment ?? null,
        });
      }

      const output = {
        videoHash: persisted.video.hash,
        metadataHash: persisted.metadata.hash,
        logHash: persisted.log.hash,
        thumbnailHash: persisted.thumbnail?.hash ?? null,
        narrationHash: persisted.narration?.hash ?? null,
        renderKey: result.renderKey,
        manifestHash,
        audioTrackHash: audioHash ?? null,
        captionTrackHash: captionHash ?? null,
        container: metadata.output.container,
        videoCodec: metadata.output.videoCodec,
        audioCodec: metadata.output.audioCodec,
        width: metadata.output.width,
        height: metadata.output.height,
        fps: metadata.output.fps,
        durationSec: metadata.output.durationSec,
        frames: metadata.output.frameCount,
        bytes: metadata.output.bytes,
        hasAudio: metadata.output.hasAudio,
        fastStart: metadata.output.fastStart,
        resumed: metadata.resumed,
        totals: metadata.totals,
        segments: metadata.segments.map((segment) => ({
          index: segment.index,
          firstFrame: segment.firstFrame,
          lastFrame: segment.lastFrame,
          hash: segment.hash,
          reused: segment.reused,
        })),
        quality: {
          ok: metadata.issues.every((issue) => issue.severity !== "error"),
          hardIssues: metadata.issues.filter((issue) => issue.severity === "error").length,
          warnings: metadata.issues.filter((issue) => issue.severity === "warning").length,
        },
      };

      ctx.log(
        "render.completed",
        `${metadata.output.durationSec}s of video (${metadata.output.frameCount} frames, ${metadata.output.bytes} bytes)`,
        {
          videoHash: persisted.video.hash,
          videoCodec: metadata.output.videoCodec,
          audioCodec: metadata.output.audioCodec,
          segments: metadata.segments.length,
          segmentsReused: metadata.totals.segmentsReused,
          framesRendered: metadata.totals.framesRendered,
          ffmpegCalls: metadata.totals.ffmpegCalls,
          wallMs: metadata.totals.wallMs,
          resumed: metadata.resumed,
        },
      );

      return { output, artifacts: renderArtifactRefs(persisted) };
    },

    /**
     * Reuse guard: a previous run may be adopted only when its metadata describes
     * the *same* render — same manifest, same voice, same captions, same
     * configuration — and it completed. Anything else is re-rendered.
     */
    validateReuse(ctx: TaskContext, run): void {
      // The metadata artifact is the record of *what* was rendered; the video
      // artifact is only bytes, and bytes cannot tell you whose they are.
      const ref = run.artifacts.find(
        (artifact) => artifact.kind === "metadata" && artifact.role === METADATA_ARTIFACT_ROLE,
      );
      if (ref === undefined)
        throw new PermanentError("render step has no render metadata artifact");
      let metadata;
      try {
        metadata = loadRenderMetadata(deps.storage, ref.hash);
      } catch (error) {
        throw new PermanentError(
          `the previous render's metadata cannot be read: ${messageOf(error)}`,
          { cause: error },
        );
      }
      const manifestHash = upstreamHash(ctx, "plan", "manifestHash");
      if (manifestHash !== undefined && metadata.manifestHash !== manifestHash) {
        throw new PermanentError(
          `the previous video renders manifest ${metadata.manifestHash.slice(0, 12)}…, not ${manifestHash.slice(0, 12)}…`,
        );
      }
      const audioHash = upstreamHash(ctx, "voice", "trackHash");
      if (audioHash !== undefined && metadata.audioTrackHash !== audioHash) {
        throw new PermanentError("the previous video was rendered with different narration audio");
      }
      const captionHash =
        upstreamHash(ctx, "captions", "captionHash") ?? upstreamHash(ctx, "captions", "trackHash");
      if (captionHash !== undefined && metadata.captionTrackHash !== captionHash) {
        throw new PermanentError("the previous video was rendered with different captions");
      }
      const config = resolveRenderConfig(deps.config ?? {});
      if (metadata.config.width !== config.width || metadata.config.height !== config.height) {
        throw new PermanentError(
          `the previous video is ${metadata.config.width}x${metadata.config.height}, not the configured ${config.width}x${config.height}`,
        );
      }
      if (metadata.issues.some((issue) => issue.severity === "error")) {
        throw new PermanentError(
          "the previous render reported hard failures; rendering again is safer than adopting it",
        );
      }
    },
  };
}

/** Persist a failure report; a reporting problem must never mask the failure. */
function persistFailureQuietly(
  deps: RenderTaskDeps,
  failure: Parameters<typeof persistRenderFailure>[1],
  ctx: TaskContext,
): { readonly hash: string } | undefined {
  try {
    const report = persistRenderFailure({ storage: deps.storage, repo: deps.repo }, failure);
    ctx.log("render.failed", failure.message, {
      phase: failure.phase,
      code: failure.code,
      retryable: failure.retryable,
      segmentsCompleted: failure.segments.length,
      framesRendered: failure.framesRendered,
      hint: failure.hint,
      failureHash: report.hash,
    });
    return report;
  } catch (error) {
    ctx.log("render.failed", `the failure report could not be stored: ${messageOf(error)}`, {
      code: failure.code,
    });
    return undefined;
  }
}

/** A probed runner for a configured or discovered FFmpeg; retryable when absent. */
export function locateFFmpeg(configured: string): FFmpegRunner {
  const binary = resolveFFmpegPath(configured);
  if (binary === undefined || (binary.includes(path.sep) && !existsSync(binary))) {
    throw new RetryableError(
      "no FFmpeg binary is available: set NEXUS_FFMPEG_PATH (or NEXUS_RENDER_FFMPEG), install ffmpeg, or provide a runner to the task",
    );
  }
  try {
    return createFFmpegRunner({ binary });
  } catch (error) {
    if (isRenderError(error) && error.code === "ffmpeg_missing") {
      throw new RetryableError(error.message, { cause: error });
    }
    throw error;
  }
}

/** A hash an upstream stage published, when that stage ran in this job. */
function upstreamHash(ctx: TaskContext, stage: string, key: string): string | undefined {
  const upstream = ctx.upstream as Record<string, unknown>;
  const output = upstream[stage];
  if (typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function namedParam(ctx: TaskContext, key: string): string | undefined {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
