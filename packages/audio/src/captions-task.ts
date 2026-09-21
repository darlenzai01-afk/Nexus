import type { ArtifactRef, ArtifactRow, Repo } from "@nexus/db";
import {
  PermanentError,
  RetryableError,
  type Task,
  type TaskContext,
  type TaskResult,
} from "@nexus/jobs";
import type { Clock } from "@nexus/providers";
import type { BlobStore } from "@nexus/storage";

import {
  CaptionTrackSchema,
  buildCaptionTrack,
  captionTrackBytes,
  isCaptionReady,
  type CaptionTrack,
  type CaptionTuning,
} from "./captions.js";
import { loadAudioTrack } from "./persist.js";
import { isComplete } from "./schema.js";

/**
 * The `captions` stage: the caption track as an artifact.
 *
 * The stage is deliberately thin, because the interesting work is a *derivation*
 * and not a generation: it reads the audio track the `voice` stage published (one
 * artifact — the cue text is already in it, sentence by sentence, as it was
 * spoken), computes the cues, and registers the result as a `captions` artifact.
 * There is no model call, no operator input and nothing to park on: given the same
 * audio track it always produces the same bytes, so an unchanged episode re-run
 * adopts the previous artifact instead of recomputing it.
 *
 * The one thing it refuses to do is caption half an episode: an audio track with a
 * scene that has no audio is a track the `voice` stage failed to complete, and
 * burning captions in over a gap would hide the gap in the output rather than in
 * the report.
 */

export const CAPTIONS_STAGE_KEY = "captions";
export const CAPTION_ARTIFACT_KIND = "captions" as const;
export const CAPTION_TRACK_ARTIFACT_ROLE = "caption_track" as const;

export interface CaptionPersistDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
}

export interface PersistedCaptionTrack {
  readonly hash: string;
  readonly bytes: number;
  readonly created: boolean;
  readonly artifact: ArtifactRow;
}

export function persistCaptionTrack(
  deps: CaptionPersistDeps,
  track: CaptionTrack,
): PersistedCaptionTrack {
  // Validate before writing: everything downstream trusts the CAS bytes.
  const valid = CaptionTrackSchema.parse(track);
  const put = deps.storage.put(captionTrackBytes(valid));
  const artifact = deps.repo.registerArtifact({
    hash: put.hash,
    kind: CAPTION_ARTIFACT_KIND,
    bytes: put.bytes,
    meta: {
      durationSec: valid.totals.captionDurationSec,
      // The artifact-meta schema is small by design: cue counts, settings and the
      // per-cue lines all live in the document, which is one read away.
      codec: "webvtt",
    },
  });
  return { hash: put.hash, bytes: put.bytes, created: put.created, artifact };
}

export function captionTrackArtifactRef(
  persisted: Pick<PersistedCaptionTrack, "hash">,
): ArtifactRef {
  return { hash: persisted.hash, kind: CAPTION_ARTIFACT_KIND, role: CAPTION_TRACK_ARTIFACT_ROLE };
}

/** Read a persisted caption track back (the renderer and the QA stage do this). */
export function loadCaptionTrack(storage: BlobStore, hash: string): CaptionTrack {
  return CaptionTrackSchema.parse(JSON.parse(new TextDecoder().decode(storage.read(hash))));
}

export interface CaptionsTaskDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
  readonly clock?: Clock;
  readonly tuning?: Partial<CaptionTuning>;
}

export function createCaptionsTask(deps: CaptionsTaskDeps): Task {
  return {
    stageKey: CAPTIONS_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const audioTrackHash = audioTrackHashFrom(ctx);
      if (audioTrackHash === undefined) {
        throw new PermanentError(
          "captions stage has no audio track: run the voice stage first, or pass params.audioTrackHash",
        );
      }

      let audio;
      try {
        audio = loadAudioTrack(deps.storage, audioTrackHash);
      } catch (error) {
        throw new RetryableError(
          `captions stage cannot read audio track ${audioTrackHash}: ${messageOf(error)}`,
          { cause: error },
        );
      }

      if (!isComplete(audio)) {
        throw new PermanentError(
          `audio track ${audioTrackHash.slice(0, 12)}… is incomplete (${audio.totals.failedSegments} scene(s) have no audio): ` +
            "captions cannot cover a gap, so the voice stage has to complete first",
        );
      }

      const track = buildCaptionTrack(audio, {
        ...(deps.clock !== undefined ? { now: deps.clock.now().toISOString() } : {}),
        audioTrackHash,
        ...(deps.tuning !== undefined ? { tuning: deps.tuning } : {}),
      });
      const persisted = persistCaptionTrack({ storage: deps.storage, repo: deps.repo }, track);

      ctx.log(
        "captions.completed",
        `${track.totals.cues} cue(s) over ${track.totals.endMs}ms of speech`,
        {
          captionHash: persisted.hash,
          audioTrackHash,
          cues: track.totals.cues,
          lines: track.totals.lines,
          words: track.totals.words,
          startMs: track.totals.startMs,
          endMs: track.totals.endMs,
          longestCueMs: track.totals.longestCueMs,
          maxCharactersPerSecond: track.totals.maxCharactersPerSecond,
          estimatedCues: track.totals.estimatedCues,
          silentScenes: track.totals.silentScenes,
        },
      );
      for (const warning of track.warnings) ctx.log("captions.warning", warning);
      for (const issue of track.issues) {
        ctx.log("captions.issue", issue.message, {
          code: issue.code,
          severity: issue.severity,
          cueId: issue.cueId,
          sceneId: issue.sceneId,
        });
      }

      return {
        output: {
          captionHash: persisted.hash,
          audioTrackHash,
          manifestHash: track.manifestHash,
          language: track.language,
          cues: track.totals.cues,
          counts: {
            lines: track.totals.lines,
            words: track.totals.words,
            characters: track.totals.characters,
            estimatedCues: track.totals.estimatedCues,
            silentScenes: track.totals.silentScenes,
          },
          settings: track.settings,
          firstCue: track.cues[0] ?? null,
          lastCue: track.cues[track.cues.length - 1] ?? null,
          quality: {
            ok: isCaptionReady(track),
            issues: track.issues.map((issue) => ({
              code: issue.code,
              severity: issue.severity,
              cueId: issue.cueId,
              sceneId: issue.sceneId,
              message: issue.message,
            })),
          },
          warnings: track.warnings,
        },
        artifacts: [captionTrackArtifactRef(persisted)],
      };
    },

    /**
     * Reuse guard: an unchanged episode adopts its caption track only when it still
     * parses, still covers the whole audio, and was derived from *this* audio track.
     */
    validateReuse(ctx, run): void {
      const ref = run.artifacts.find((artifact) => artifact.kind === CAPTION_ARTIFACT_KIND);
      if (ref === undefined) throw new PermanentError("captions step has no captions artifact");
      const track = loadCaptionTrack(deps.storage, ref.hash);
      if (!isCaptionReady(track)) {
        throw new PermanentError(
          "the previous caption track has overlapping cues; captioning again is safer",
        );
      }
      const audioTrackHash = audioTrackHashFrom(ctx);
      if (audioTrackHash !== undefined && track.audioTrackHash !== audioTrackHash) {
        throw new PermanentError(
          `the previous caption track was derived from audio ${track.audioTrackHash.slice(0, 12) || "(unknown)"}…, ` +
            `not ${audioTrackHash.slice(0, 12)}…: captioning again is safer`,
        );
      }
      if (track.totals.silentScenes > 0) {
        throw new PermanentError(
          `the previous caption track leaves ${track.totals.silentScenes} scene(s) uncaptioned; captioning again is safer`,
        );
      }
    },
  };
}

/** The audio track this job voiced, or one named explicitly in params. */
function audioTrackHashFrom(ctx: TaskContext): string | undefined {
  const upstream = ctx.upstream as Record<string, unknown>;
  const voice = upstream.voice;
  if (typeof voice === "object" && voice !== null) {
    const hash = (voice as { trackHash?: unknown }).trackHash;
    if (typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash)) return hash;
  }
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const named = (params as Record<string, unknown>).audioTrackHash;
  return typeof named === "string" && named !== "" ? named : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
