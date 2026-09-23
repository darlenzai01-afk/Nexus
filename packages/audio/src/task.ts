import type { Repo } from "@nexus/db";
import {
  PermanentError,
  RetryableError,
  type Task,
  type TaskContext,
  type TaskResult,
} from "@nexus/jobs";
import { MANUAL_INPUT_GATE, type Clock, type TTSProvider } from "@nexus/providers";
import { loadSceneManifest } from "@nexus/scenes";
import type { BlobStore } from "@nexus/storage";

import { AudioError, messageOf } from "./errors.js";
import {
  audioSegmentArtifactRefs,
  audioTrackArtifactRef,
  loadAudioTrack,
  persistAudioTrack,
} from "./persist.js";
import { synthesizeNarration, type AudioPipelineDeps, type AudioTuning } from "./pipeline.js";
import { isComplete, OperatorAudioListSchema, type VoiceCasting } from "./schema.js";
import { castingFor, validateCasting, type VoiceDefaults } from "./voices.js";

/**
 * The `voice` stage task: the orchestrator's entry point into the audio engine.
 *
 * It owns the three decisions the engine must not make on its own:
 *
 * - **who speaks** — the casting, from configuration unless a caller supplies one;
 * - **what happens when the voice fails** — by default the run is reported and the
 *   job **parks at the manual gate** with everything that *did* synthesize stored,
 *   so an operator can supply the missing clips through `params.operatorAudio` and
 *   retry the stage without paying for the scenes that already worked;
 * - **how provider failures reach the runner** — translated with the same
 *   retryable/permanent split every other stage uses.
 */

export const VOICE_STAGE_KEY = "voice";

export interface VoiceTaskDeps {
  readonly tts: TTSProvider;
  readonly storage: BlobStore;
  readonly repo: Repo;
  readonly clock?: Clock;
  /** Fixed casting; when absent it is built from `defaults` and the manifest. */
  readonly casting?: VoiceCasting;
  readonly defaults?: VoiceDefaults;
  readonly tuning?: Partial<AudioTuning>;
  readonly cache?: AudioPipelineDeps["cache"];
  readonly sleep?: AudioPipelineDeps["sleep"];
}

export function createVoiceTask(deps: VoiceTaskDeps): Task {
  return {
    stageKey: VOICE_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const manifestHash = manifestHashFrom(ctx);
      if (manifestHash === undefined) {
        throw new PermanentError(
          "voice stage has no scene manifest: run the plan stage first, or pass params.manifestHash",
        );
      }

      let manifest;
      try {
        manifest = loadSceneManifest(deps.storage, manifestHash);
      } catch (error) {
        throw new PermanentError(
          `voice stage cannot read scene manifest ${manifestHash}: ${messageOf(error)}`,
          { cause: error },
        );
      }

      const casting = deps.casting ?? castingFor(manifest, deps.defaults ?? {});
      const castingReport = validateCasting(casting, manifest);
      for (const issue of castingReport.issues) {
        ctx.log("voice.casting", issue.message, {
          characterId: issue.characterId,
          code: issue.code,
        });
      }

      const operatorAudio = operatorAudioFrom(ctx);

      ctx.log("voice.started", `voicing ${manifest.scenes.length} scene(s)`, {
        manifestHash,
        adapter: deps.tts.id,
        mode: deps.tts.mode,
        language: casting.language,
        format: casting.format,
        narrator: casting.narrator.label,
      });

      let report;
      try {
        report = await synthesizeNarration(
          {
            manifest,
            manifestHash,
            casting,
            ...(operatorAudio.length > 0 ? { operatorAudio } : {}),
            signal: ctx.signal,
            correlationId: ctx.job.id,
          },
          {
            tts: deps.tts,
            storage: deps.storage,
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
            ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
            ...(deps.tuning !== undefined ? { tuning: deps.tuning } : {}),
            log: (event, message, data) => ctx.log(event, message, data),
          },
        );
      } catch (error) {
        if (error instanceof AudioError) {
          throw error.retryable
            ? new RetryableError(error.message, { cause: error })
            : new PermanentError(error.message, { cause: error });
        }
        throw error;
      }

      const persisted = persistAudioTrack({ storage: deps.storage, repo: deps.repo }, report.track);

      const hardIssues = report.issues.filter((issue) => issue.severity === "error");
      ctx.log(
        "voice.completed",
        `${report.track.totals.spokenDurationSec}s of audio across ${report.track.totals.segments} segment(s)`,
        {
          trackHash: persisted.hash,
          segments: report.track.totals.segments,
          spokenDurationSec: report.track.totals.spokenDurationSec,
          plannedDurationSec: report.track.totals.plannedDurationSec,
          driftSec: report.track.totals.driftSec,
          wordsPerSecond: report.track.totals.wordsPerSecond,
          providerCalls: report.calls.providerCalls,
          cacheHits: report.calls.cacheHits,
          retries: report.calls.retries,
          failedSegments: report.calls.failedSegments,
        },
      );
      for (const warning of report.track.warnings) ctx.log("voice.warning", warning);

      const output = {
        trackHash: persisted.hash,
        manifestHash,
        language: report.track.language,
        narrator: report.track.casting.narrator,
        format: report.track.casting.format,
        sampleRate: report.track.casting.sampleRate,
        adapter: deps.tts.id,
        totals: report.track.totals,
        calls: report.calls,
        segments: report.track.segments.map((segment) => ({
          id: segment.id,
          sceneId: segment.sceneId,
          startSec: segment.startSec,
          durationSec: segment.durationSec,
          voiceId: segment.voice.voiceId,
          hash: segment.audio.hash,
          cached: segment.cached,
          durationMethod: segment.durationMethod,
        })),
        scenes: report.track.scenes.map((scene) => ({
          sceneId: scene.sceneId,
          verdict: scene.verdict,
          driftSec: scene.driftSec,
        })),
        quality: {
          ok: !report.waiting,
          hardIssues: hardIssues.length,
          issues: report.issues.map((issue) => ({
            code: issue.code,
            severity: issue.severity,
            sceneId: issue.sceneId,
            message: issue.message,
          })),
        },
      };

      const artifacts = [
        audioTrackArtifactRef(persisted),
        ...audioSegmentArtifactRefs(report.track),
      ];

      if (report.waiting) {
        const failing = report.track.scenes
          .filter((scene) => scene.verdict === "silent")
          .map((scene) => scene.sceneId);
        ctx.log(
          "voice.manual_required",
          "the voice stage could not voice every scene; an operator can supply the missing clips",
          {
            scenes: failing,
            issues: hardIssues.map((issue) => `${issue.code}: ${issue.message}`),
          },
        );
        return {
          output,
          artifacts,
          waiting: MANUAL_INPUT_GATE,
          waitingReason:
            `voice synthesis failed for ${report.calls.failedSegments} scene(s). Supply clips through ` +
            "params.operatorAudio (one entry per scene: {sceneId, hash}) and retry the stage, or fix the voice " +
            "configuration and run it again.",
        };
      }

      return { output, artifacts };
    },

    /**
     * Reuse guard: a previous run may only be adopted when its track is complete
     * and still voices *this* manifest.
     */
    validateReuse(
      ctx: TaskContext,
      run: { readonly artifacts: readonly { readonly kind: string; readonly hash: string }[] },
    ): void {
      const ref = run.artifacts.find((artifact) => artifact.kind === "audio");
      if (ref === undefined) throw new PermanentError("voice step has no audio artifact");
      const track = loadAudioTrack(deps.storage, ref.hash);
      if (!isComplete(track)) {
        throw new PermanentError(
          "the previous voice track is incomplete (a scene has no audio); synthesizing again is safer",
        );
      }
      const manifestHash = manifestHashFrom(ctx);
      if (manifestHash !== undefined && track.manifestHash !== manifestHash) {
        throw new PermanentError(
          `the previous voice track voices manifest ${track.manifestHash.slice(0, 12)}…, not ${manifestHash.slice(0, 12)}…`,
        );
      }
    },
  };
}

/** The scene manifest this job planned, or one named explicitly in params. */
function manifestHashFrom(ctx: TaskContext): string | undefined {
  const upstream = ctx.upstream as Record<string, unknown>;
  const plan = upstream.plan;
  if (typeof plan === "object" && plan !== null) {
    const hash = (plan as { manifestHash?: unknown }).manifestHash;
    if (typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash)) return hash;
  }
  return namedParam(ctx, "manifestHash");
}

/** Clips an operator supplied, by scene (`params.operatorAudio`). */
function operatorAudioFrom(ctx: TaskContext): ReturnType<typeof OperatorAudioListSchema.parse> {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return [];
  const value = (params as Record<string, unknown>).operatorAudio;
  if (value === undefined) return [];
  const parsed = OperatorAudioListSchema.safeParse(value);
  if (!parsed.success) {
    throw new PermanentError(
      `params.operatorAudio is not a list of {sceneId, hash} entries: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function namedParam(ctx: TaskContext, key: string): string | undefined {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
