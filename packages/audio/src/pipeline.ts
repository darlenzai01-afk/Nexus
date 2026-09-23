import {
  isManualRequired,
  isProviderError,
  systemClock,
  type Clock,
  type SynthesisResult,
  type TTSProvider,
  type WordTiming,
} from "@nexus/providers";
import { words as wordsOf } from "@nexus/script";
import type { BlobStore } from "@nexus/storage";

import { segmentCacheKey, type SegmentAudioCache } from "./cache.js";
import { AudioError, messageOf } from "./errors.js";
import { probeAudio } from "./probe.js";
import {
  estimateDurationMs,
  segmentPlansFrom,
  synthesisRequestFor,
  type SegmentPlan,
} from "./requests.js";
import {
  isHardAudioIssue,
  type AudioIssue,
  type AudioIssueCode,
  type AudioSegment,
  type AudioTrack,
  type DurationMethod,
  type OperatorAudio,
  type SceneTiming,
  type SentenceTiming,
  type SegmentAudioRef,
  type VoiceCasting,
  type VoiceSettings,
} from "./schema.js";
import { resolveVoicePlan } from "./voices.js";

import type { SceneManifest } from "@nexus/scenes";

/**
 * The `voice` stage's engine: a scene manifest plus a casting become **one audio
 * clip per scene** and the **timing document** the rest of the pipeline reads.
 *
 * The pipeline is written to be boring on purpose:
 *
 * - **Sequential, in manifest order.** Synthesis is metered and rate-limited, and
 *   a parallel fan-out would make a run's numbers depend on scheduling. One
 *   segment at a time also means the spoken timeline is assembled in the order the
 *   video plays it.
 * - **Deterministic backoff, no jitter.** Jitter belongs to the transport retry
 *   inside `invoke` (where many callers share a quota); at this level the delays
 *   are a pure function of the attempt number, so a test can assert the run's
 *   shape exactly.
 * - **Measure, never trust.** A provider's `durationMs` is verified against the
 *   bytes it just returned. Only when nothing measured the clip does the word
 *   count estimate it, and that segment says so.
 * - **Fail visibly.** A segment that cannot be produced is an issue with a code
 *   and a message, the track records how many scenes have no audio, and the stage
 *   parks the job at the manual gate unless the tuning says to fail outright.
 */

export const AUDIO_ENGINE_NAME = "nexus-audio";
export const AUDIO_ENGINE_VERSION = "1.0.0";

export interface AudioTuning {
  /** Attempts per segment, including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  /** Refuse a clip larger than this (a runaway adapter must not fill the disk). */
  readonly maxSegmentBytes: number;
  /** How far a provider's duration may differ from the bytes before it is reported. */
  readonly durationToleranceMs: number;
  /** `park` (default): report the failures and let an operator supply clips. */
  readonly onFailure: "park" | "fail";
  /** Silence kept between two neighbouring scenes' clips. */
  readonly gapSec: number;
  /** Pace used to *estimate* a duration nothing measured. */
  readonly wordsPerSecond: number;
  /** Parse the clips that were returned (default on). */
  readonly probe: boolean;
}

export const DEFAULT_AUDIO_TUNING: AudioTuning = {
  maxAttempts: 3,
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 4_000,
  maxSegmentBytes: 32 * 1024 * 1024,
  durationToleranceMs: 150,
  onFailure: "park",
  gapSec: 0,
  wordsPerSecond: 2.5,
  probe: true,
};

export interface AudioPipelineDeps {
  readonly tts: TTSProvider;
  readonly storage: BlobStore;
  readonly clock?: Clock;
  readonly cache?: SegmentAudioCache;
  /** Injectable wait, so a retry test does not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (event: string, message: string, data?: Record<string, unknown>) => void;
  readonly tuning?: Partial<AudioTuning>;
}

export interface AudioPipelineInput {
  readonly manifest: SceneManifest;
  /** Hash of the manifest artifact this track voices (the traceability anchor). */
  readonly manifestHash: string;
  readonly casting: VoiceCasting;
  /** Clips an operator supplied, by scene (`params.operatorAudio`). */
  readonly operatorAudio?: readonly OperatorAudio[];
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  /** Overrides `generatedAt`; defaults to the clock. */
  readonly now?: string;
}

export interface AudioRunReport {
  readonly track: AudioTrack;
  readonly issues: readonly AudioIssue[];
  /** True when the run needs a human (the manual gate) before it can proceed. */
  readonly waiting: boolean;
  readonly calls: {
    readonly scenes: number;
    readonly segments: number;
    readonly providerCalls: number;
    readonly cacheHits: number;
    readonly retries: number;
    readonly operatorSegments: number;
    readonly failedSegments: number;
  };
}

export async function synthesizeNarration(
  input: AudioPipelineInput,
  deps: AudioPipelineDeps,
): Promise<AudioRunReport> {
  // The manifest's own pace is the estimator's default: a plan built at 3
  // words/second is not re-estimated at some other speed when a clip arrives with
  // no measurable duration. An explicit tuning still wins.
  const tuning = {
    ...DEFAULT_AUDIO_TUNING,
    wordsPerSecond: input.manifest.wordsPerSecond,
    ...deps.tuning,
  };
  const cache = deps.cache;
  const issues: AudioIssue[] = [];
  const now = input.now ?? (deps.clock ?? systemNow).now().toISOString();

  if (input.manifest.scenes.length === 0) {
    throw new AudioError("the scene manifest has no scenes to voice", { code: "invalid_input" });
  }

  const plans = segmentPlansFrom(input.manifest, input.casting);
  issues.push(...plans.issues);

  const offered = safeVoices(deps.tts);
  const operatorByScene = new Map(
    (input.operatorAudio ?? []).map((entry) => [entry.sceneId, entry]),
  );
  const segments: AudioSegment[] = [];
  const failedScenes = new Set<string>();
  let cursor = 0;
  let providerCalls = 0;
  let cacheHits = 0;
  let retries = 0;
  let operatorSegments = 0;

  for (const plan of plans.plans) {
    const resolved = resolveVoicePlan(plan.plan, offered);
    if ("issue" in resolved) {
      const issue = withScene({ ...resolved.issue, severity: "error" }, plan);
      issues.push(issue);
      failedScenes.add(plan.sceneId);
      continue;
    }
    const settings = resolved.settings;

    const operator = operatorByScene.get(plan.sceneId);
    if (operator !== undefined) {
      const adopted = adoptOperatorAudio(operator, plan, settings, deps, tuning);
      if ("issue" in adopted) {
        issues.push(adopted.issue);
        failedScenes.add(plan.sceneId);
        continue;
      }
      for (const note of adopted.notes) issues.push(note);
      operatorSegments += 1;
      cursor = placeSegment(segments, adopted.segment, cursor, tuning.gapSec).cursor;
      continue;
    }

    const cached = cache?.get(
      segmentCacheKey({
        provider: deps.tts.id,
        text: plan.text,
        voiceId: settings.voiceId,
        format: settings.format,
        sampleRate: settings.sampleRate,
        rate: settings.rate,
        ...(settings.style !== undefined ? { style: settings.style } : {}),
      }),
    );
    if (cached !== undefined) {
      if (deps.storage.has(cached.hash)) {
        cacheHits += 1;
        cursor = placeSegment(
          segments,
          {
            ...baseSegment(plan, settings, cursor),
            provider: deps.tts.id,
            attempts: 0,
            cached: true,
            durationMethod: "provider",
            audio: {
              hash: cached.hash,
              bytes: cached.bytes,
              mime: cached.mime,
              format: cached.format,
              sampleRate: cached.sampleRate,
              durationMs: cached.durationMs,
            },
          },
          cursor,
          tuning.gapSec,
        ).cursor;
        continue;
      }
      issues.push({
        code: "cache_stale",
        severity: "warning",
        sceneId: plan.sceneId,
        segmentId: plan.id,
        message: `the segment cache points at ${cached.hash.slice(0, 12)}…, which is not in the store: synthesizing again`,
      });
    }

    deps.log?.(
      "voice.segment.started",
      `${plan.id}: ${plan.words} words with ${settings.voiceId}`,
      {
        sceneId: plan.sceneId,
        speakerId: plan.speakerId,
        voiceId: settings.voiceId,
      },
    );
    const attempt = await attemptSegment(plan, settings, deps, tuning, input);
    providerCalls += attempt.providerCalls;
    retries += attempt.retries;
    if (attempt.outcome.kind === "failed") {
      const issue: AudioIssue = {
        code: attempt.outcome.code,
        severity: "error",
        sceneId: plan.sceneId,
        segmentId: plan.id,
        message: attempt.outcome.message,
      };
      issues.push(issue);
      failedScenes.add(plan.sceneId);
      continue;
    }

    const measured = measureClip(attempt.outcome.result, plan, settings, deps, tuning);
    for (const note of measured.issues) {
      issues.push({ ...note, sceneId: plan.sceneId, segmentId: plan.id });
    }

    const placed = placeSegment(
      segments,
      {
        ...baseSegment(plan, settings, cursor),
        provider: deps.tts.id,
        attempts: attempt.attempts,
        cached: false,
        durationMethod: measured.method,
        audio: measured.ref,
        ...(attempt.outcome.result.wordTimings !== undefined
          ? { wordTimings: normalizeWordTimings(attempt.outcome.result.wordTimings) }
          : {}),
      },
      cursor,
      tuning.gapSec,
    );
    const segment = placed.segment;
    cursor = placed.cursor;
    deps.log?.("voice.segment.completed", `${segment.id}: ${segment.durationSec}s of audio`, {
      sceneId: segment.sceneId,
      hash: segment.audio.hash,
      durationMs: segment.audio.durationMs,
      method: segment.durationMethod,
      attempts: segment.attempts,
    });

    if (cache !== undefined) {
      cache.set(
        segmentCacheKey({
          provider: deps.tts.id,
          text: plan.text,
          voiceId: settings.voiceId,
          format: settings.format,
          sampleRate: settings.sampleRate,
          rate: settings.rate,
          ...(settings.style !== undefined ? { style: settings.style } : {}),
        }),
        {
          hash: segment.audio.hash,
          bytes: segment.audio.bytes,
          mime: segment.audio.mime,
          format: segment.audio.format,
          sampleRate: segment.audio.sampleRate,
          durationMs: segment.audio.durationMs,
          voiceId: settings.voiceId,
          provider: deps.tts.id,
        },
      );
    }
  }

  const sentences = sentenceTimingsFor(plans.plans, segments, issues);
  const scenes = sceneTimingsFor(input.manifest, segments, issues);
  const track = buildTrack({
    input,
    now,
    sentences,
    scenes,
    segments,
    issues,
    failedSegments: failedScenes.size,
    tuning,
    adapterMode: deps.tts.mode,
    adapterId: deps.tts.id,
  });

  const waiting = issues.some((issue) => isHardAudioIssue(issue.code));
  if (waiting && tuning.onFailure === "fail") {
    const failures = issues.filter((issue) => isHardAudioIssue(issue.code));
    throw new AudioError(
      `the voice stage could not synthesize ${failures.length} scene(s): ${failures
        .map((issue) => `${issue.sceneId}: ${issue.message}`)
        .join("; ")}`,
      { code: "provider_failed", retryable: false },
    );
  }

  return {
    track,
    issues,
    waiting,
    calls: {
      scenes: input.manifest.scenes.length,
      segments: segments.length,
      providerCalls,
      cacheHits,
      retries,
      operatorSegments,
      failedSegments: failedScenes.size,
    },
  };
}

// ── One segment ───────────────────────────────────────────────────────────

type AttemptOutcome =
  | { readonly kind: "ok"; readonly result: SynthesisResult }
  | { readonly kind: "failed"; readonly code: AudioIssueCode; readonly message: string };

interface Attempt {
  readonly outcome: AttemptOutcome;
  readonly attempts: number;
  readonly retries: number;
  readonly providerCalls: number;
}

async function attemptSegment(
  plan: SegmentPlan,
  settings: VoiceSettings,
  deps: AudioPipelineDeps,
  tuning: AudioTuning,
  input: AudioPipelineInput,
): Promise<Attempt> {
  const request = synthesisRequestFor(plan, settings);
  const context = {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };

  let attempts = 0;
  let retries = 0;

  while (attempts < tuning.maxAttempts) {
    attempts += 1;
    if (attempts > 1) {
      retries += 1;
      await wait(deps, backoffMs(tuning, retries - 1));
    }
    try {
      const result = await deps.tts.synthesize(request, context);
      const rejected = rejectReason(result.value, tuning);
      if (rejected === undefined) {
        return {
          outcome: { kind: "ok", result: result.value },
          attempts,
          retries,
          providerCalls: attempts,
        };
      }
      if (attempts >= tuning.maxAttempts) {
        return {
          outcome: { kind: "failed", code: rejected.code, message: rejected.message },
          attempts,
          retries,
          providerCalls: attempts,
        };
      }
    } catch (error) {
      if (isManualRequired(error)) {
        return {
          outcome: {
            kind: "failed",
            code: "manual_required",
            message: `the voice capability needs a human: ${messageOf(error)}`,
          },
          attempts,
          retries,
          providerCalls: attempts,
        };
      }
      if (!isProviderError(error)) throw error;
      if (!error.retryable || attempts >= tuning.maxAttempts) {
        return {
          outcome: {
            kind: "failed",
            code: "provider_failed",
            message: `${error.summary()}${attempts > 1 ? ` (after ${attempts} attempts)` : ""}`,
          },
          attempts,
          retries,
          providerCalls: attempts,
        };
      }
    }
  }

  /* c8 ignore next 3 -- the loop always returns; this keeps the type total. */
  return {
    outcome: { kind: "failed", code: "provider_failed", message: "synthesis produced nothing" },
    attempts,
    retries,
    providerCalls: attempts,
  };
}

function rejectReason(
  result: SynthesisResult,
  tuning: AudioTuning,
): { code: AudioIssueCode; message: string } | undefined {
  if (result.audio.bytes <= 0) {
    return { code: "empty_audio", message: "the provider returned an empty clip (0 bytes)" };
  }
  if (result.audio.bytes > tuning.maxSegmentBytes) {
    return {
      code: "bytes_too_large",
      message: `the provider returned ${result.audio.bytes} bytes, over the ${tuning.maxSegmentBytes}-byte ceiling`,
    };
  }
  if (!/^[0-9a-f]{64}$/u.test(result.audio.hash)) {
    return { code: "empty_audio", message: "the provider returned a clip with no content hash" };
  }
  return undefined;
}

/** Verify a clip's duration against its own bytes, and record what was trusted. */
function measureClip(
  result: SynthesisResult,
  plan: SegmentPlan,
  settings: VoiceSettings,
  deps: AudioPipelineDeps,
  tuning: AudioTuning,
): {
  readonly ref: SegmentAudioRef;
  readonly method: DurationMethod;
  readonly issues: readonly AudioIssue[];
} {
  const issues: AudioIssue[] = [];
  const claimed = result.audio.durationMs;
  let format = settings.format;
  let sampleRate = settings.sampleRate;
  let mime = result.audio.mime;
  let measured: number | undefined;

  if (tuning.probe && deps.storage.has(result.audio.hash)) {
    const probe = probeAudio(deps.storage.read(result.audio.hash));
    if (probe.format !== "unknown") {
      format = probe.format;
      sampleRate = probe.sampleRate ?? sampleRate;
      measured = probe.durationMs;
      if (probe.format !== settings.format) {
        issues.push({
          code: "unsupported_format",
          severity: "error",
          sceneId: "",
          segmentId: "",
          message: `the adapter returned ${probe.format} while the casting asks for ${settings.format}`,
        });
      }
    }
  }

  let method: DurationMethod;
  let durationMs: number;
  if (measured !== undefined) {
    durationMs = measured;
    if (claimed > 0 && Math.abs(measured - claimed) > tuning.durationToleranceMs) {
      issues.push({
        code: "duration_mismatch",
        severity: "warning",
        sceneId: "",
        segmentId: "",
        message: `the provider reported ${claimed}ms but the clip is ${measured}ms; the bytes win`,
      });
    }
    method = claimed > 0 ? "provider" : "probed";
  } else if (claimed > 0) {
    durationMs = Math.round(claimed);
    method = "provider";
  } else {
    durationMs = estimateDurationMs(plan.text, tuning.wordsPerSecond);
    method = "estimated";
    issues.push({
      code: "duration_missing",
      severity: "warning",
      sceneId: "",
      segmentId: "",
      message:
        `nothing measured ${plan.id}'s duration (no probeable header, and the adapter reported none), ` +
        `so it is estimated from ${plan.words} words at ${tuning.wordsPerSecond} words/second`,
    });
  }

  if (durationMs <= 0) {
    durationMs = estimateDurationMs(plan.text, tuning.wordsPerSecond);
    method = "estimated";
  }

  if (mime === "" || (measured !== undefined && method === "probed")) {
    mime = format === "wav" ? "audio/wav" : "audio/mpeg";
  }

  return {
    ref: {
      hash: result.audio.hash,
      bytes: result.audio.bytes,
      mime,
      format,
      sampleRate,
      durationMs: Math.max(1, Math.round(durationMs)),
    },
    method,
    issues,
  };
}

function adoptOperatorAudio(
  entry: OperatorAudio,
  plan: SegmentPlan,
  settings: VoiceSettings,
  deps: AudioPipelineDeps,
  tuning: AudioTuning,
):
  | { readonly segment: AudioSegment; readonly notes: readonly AudioIssue[] }
  | { readonly issue: AudioIssue } {
  if (!deps.storage.has(entry.hash)) {
    return {
      issue: {
        code: "operator_audio_missing",
        severity: "error",
        sceneId: plan.sceneId,
        segmentId: plan.id,
        message: `the operator clip for ${plan.sceneId} (${entry.hash.slice(0, 12)}…) is not in the store`,
      },
    };
  }

  const bytes = deps.storage.read(entry.hash);
  if (bytes.byteLength === 0 || bytes.byteLength > tuning.maxSegmentBytes) {
    return {
      issue: {
        code: "operator_audio_invalid",
        severity: "error",
        sceneId: plan.sceneId,
        segmentId: plan.id,
        message: `the operator clip for ${plan.sceneId} is ${bytes.byteLength} bytes, which no stage will accept`,
      },
    };
  }

  const probe = probeAudio(bytes);
  const notes: AudioIssue[] = [];
  const format = probe.format === "unknown" ? settings.format : probe.format;
  const sampleRate = probe.sampleRate ?? settings.sampleRate;
  let durationMs = probe.durationMs;
  let method: DurationMethod = probe.durationMs !== undefined ? "probed" : "estimated";

  if (entry.durationMs !== undefined) {
    if (
      probe.durationMs !== undefined &&
      Math.abs(probe.durationMs - entry.durationMs) > tuning.durationToleranceMs
    ) {
      notes.push({
        code: "duration_mismatch",
        severity: "warning",
        sceneId: plan.sceneId,
        segmentId: plan.id,
        message: `the operator clip for ${plan.sceneId} is ${probe.durationMs}ms, not the ${entry.durationMs}ms recorded`,
      });
    }
    if (durationMs === undefined) {
      durationMs = entry.durationMs;
      method = "provider";
    }
  }
  if (durationMs === undefined) {
    durationMs = estimateDurationMs(plan.text, tuning.wordsPerSecond);
    notes.push({
      code: "duration_missing",
      severity: "warning",
      sceneId: plan.sceneId,
      segmentId: plan.id,
      message: `the operator clip for ${plan.sceneId} has no measurable duration; it is estimated from ${plan.words} words`,
    });
  }

  return {
    segment: {
      ...baseSegment(plan, settings, 0),
      provider: "operator",
      attempts: 0,
      cached: false,
      durationMethod: method,
      audio: {
        hash: entry.hash,
        bytes: bytes.byteLength,
        mime: entry.mime ?? probe.mime,
        format,
        sampleRate,
        durationMs: Math.max(1, Math.round(durationMs)),
      },
    },
    notes,
  };
}

function baseSegment(plan: SegmentPlan, settings: VoiceSettings, startSec: number): AudioSegment {
  return {
    id: plan.id,
    sceneId: plan.sceneId,
    index: plan.index,
    sceneType: plan.sceneType,
    startSec: round(startSec),
    durationSec: 0,
    plannedStartSec: round(plan.plannedStartSec),
    plannedDurationSec: round(plan.plannedDurationSec),
    text: plan.text,
    sentenceIds: [...plan.sentenceIds],
    words: plan.words,
    characters: plan.characters,
    voice: settings,
    provider: "",
    attempts: 0,
    cached: false,
    durationMethod: "estimated",
    audio: {
      hash: "0".repeat(64),
      bytes: 1,
      mime: "audio/wav",
      format: settings.format,
      sampleRate: settings.sampleRate,
      durationMs: 1,
    },
  };
}

/**
 * Place a clip on the spoken timeline. The duration always comes from the clip's
 * own milliseconds, so the timeline and the metadata cannot drift apart.
 */
function placeSegment(
  segments: AudioSegment[],
  segment: AudioSegment,
  cursor: number,
  gapSec: number,
): { readonly segment: AudioSegment; readonly cursor: number } {
  const durationSec = Math.max(0.001, round(segment.audio.durationMs / 1_000));
  const placed: AudioSegment = { ...segment, startSec: round(cursor), durationSec };
  segments.push(placed);
  return { segment: placed, cursor: round(cursor + durationSec + gapSec) };
}

// ── Timing ────────────────────────────────────────────────────────────────

function sentenceTimingsFor(
  plans: readonly SegmentPlan[],
  segments: readonly AudioSegment[],
  issues: AudioIssue[],
): SentenceTiming[] {
  const out: SentenceTiming[] = [];
  const planById = new Map(plans.map((plan) => [plan.id, plan]));

  for (const segment of segments) {
    const plan = planById.get(segment.id);
    if (plan === undefined || plan.sentenceTexts.length === 0) continue;

    const aligned = alignByWordTimings(plan, segment);
    if (aligned !== undefined) {
      out.push(...aligned);
      continue;
    }

    if (segment.wordTimings !== undefined && plan.sentenceTexts.length > 1) {
      issues.push({
        code: "timing_mismatch",
        severity: "warning",
        sceneId: segment.sceneId,
        segmentId: segment.id,
        message:
          `${segment.id}: the provider's word timings do not line up with the narration's ` +
          `${plan.sentenceTexts.length} sentence(s); sentence windows are distributed proportionally`,
      });
    }

    out.push(...distributeProportionally(plan, segment));
  }

  return out;
}

function alignByWordTimings(
  plan: SegmentPlan,
  segment: AudioSegment,
): SentenceTiming[] | undefined {
  const timings = segment.wordTimings;
  if (timings === undefined || timings.length === 0 || plan.sentenceTexts.length === 0)
    return undefined;
  const textWords = wordsOf(plan.text);
  if (textWords.length !== timings.length) return undefined;
  for (const [index, timing] of timings.entries()) {
    if (normalizeWord(timing.word) !== normalizeWord(textWords[index] ?? "")) return undefined;
  }

  const out: SentenceTiming[] = [];
  let cursor = 0;
  for (const sentence of plan.sentenceTexts) {
    const count = wordsOf(sentence).length;
    const first = timings[cursor];
    const last = timings[Math.min(timings.length - 1, cursor + count - 1)];
    if (first === undefined || last === undefined) return undefined;
    const startSec = round(segment.startSec + first.startMs / 1_000);
    const endSec = round(segment.startSec + last.endMs / 1_000);
    out.push({
      sentenceId: plan.sentenceIds[out.length] ?? "",
      sceneId: segment.sceneId,
      segmentId: segment.id,
      startSec,
      endSec: Math.max(startSec, endSec),
      durationSec: round(Math.max(0, endSec - startSec)),
      words: count,
      characters: sentence.length,
      method: "word_timings",
    });
    cursor += count;
  }
  return out;
}

/** No timings to trust: share the segment's window by characters, exactly once. */
function distributeProportionally(plan: SegmentPlan, segment: AudioSegment): SentenceTiming[] {
  const totalMs = Math.max(1, Math.round(segment.durationSec * 1_000));
  const totalChars = plan.sentenceTexts.reduce((sum, sentence) => sum + sentence.length, 0);
  const out: SentenceTiming[] = [];
  let cursorMs = 0;

  for (const [index, sentence] of plan.sentenceTexts.entries()) {
    const last = index === plan.sentenceTexts.length - 1;
    const share = totalChars === 0 ? 0 : Math.round((sentence.length / totalChars) * totalMs);
    const spanMs = last ? totalMs - cursorMs : Math.min(share, totalMs - cursorMs);
    const startSec = round(segment.startSec + cursorMs / 1_000);
    const endSec = round(segment.startSec + (cursorMs + spanMs) / 1_000);
    out.push({
      sentenceId: plan.sentenceIds[index] ?? "",
      sceneId: segment.sceneId,
      segmentId: segment.id,
      startSec,
      endSec,
      durationSec: round(Math.max(0, spanMs / 1_000)),
      words: wordsOf(sentence).length,
      characters: sentence.length,
      method: "proportional",
    });
    cursorMs += spanMs;
  }
  return out;
}

function sceneTimingsFor(
  manifest: SceneManifest,
  segments: readonly AudioSegment[],
  issues: AudioIssue[],
): SceneTiming[] {
  const byScene = new Map(segments.map((segment) => [segment.sceneId, segment]));
  const out: SceneTiming[] = [];

  for (const [index, scene] of manifest.scenes.entries()) {
    const segment = byScene.get(scene.id);
    if (segment === undefined) {
      out.push({
        sceneId: scene.id,
        index,
        type: scene.type,
        segmentId: "",
        plannedStartSec: round(scene.startSec),
        plannedDurationSec: round(scene.durationSec),
        spokenStartSec: 0,
        spokenDurationSec: 0,
        driftSec: round(-scene.durationSec),
        verdict: "silent",
      });
      continue;
    }

    const driftSec = round(segment.durationSec - scene.durationSec);
    const verdict: SceneTiming["verdict"] =
      driftSec > 0.05 ? "over" : driftSec < -0.5 ? "short" : "fits";
    if (verdict === "over") {
      issues.push({
        code: "spoken_overflow",
        severity: "warning",
        sceneId: scene.id,
        segmentId: segment.id,
        message:
          `scene ${scene.id} is ${scene.durationSec}s in the plan but speaks for ${segment.durationSec}s ` +
          `(+${driftSec}s): the composition has to stretch, trim, or the narration has to be tightened`,
      });
    }
    out.push({
      sceneId: scene.id,
      index,
      type: scene.type,
      segmentId: segment.id,
      plannedStartSec: round(scene.startSec),
      plannedDurationSec: round(scene.durationSec),
      spokenStartSec: round(segment.startSec),
      spokenDurationSec: round(segment.durationSec),
      driftSec,
      verdict,
    });
  }

  return out;
}

// ── The track document ────────────────────────────────────────────────────

function buildTrack(args: {
  input: AudioPipelineInput;
  now: string;
  segments: readonly AudioSegment[];
  sentences: readonly SentenceTiming[];
  scenes: readonly SceneTiming[];
  issues: readonly AudioIssue[];
  failedSegments: number;
  tuning: AudioTuning;
  adapterId: string;
  adapterMode: string;
}): AudioTrack {
  const { input, segments, scenes } = args;
  const spokenMs = segments.reduce((sum, segment) => sum + segment.audio.durationMs, 0);
  const spokenDurationSec = round(
    (spokenMs + args.tuning.gapSec * Math.max(0, segments.length - 1) * 1_000) / 1_000,
  );
  const totalWords = segments.reduce((sum, segment) => sum + segment.words, 0);
  const totalCharacters = segments.reduce((sum, segment) => sum + segment.characters, 0);

  const warnings: string[] = [];
  if (args.adapterMode !== "real") {
    warnings.push(
      `voice was synthesized by the "${args.adapterId}" adapter (${args.adapterMode}): no voice account was contacted`,
    );
  }

  return {
    version: 1,
    generatedAt: args.now,
    language: input.casting.language,
    scriptHash: /^[0-9a-f]{64}$/u.test(input.manifest.scriptHash) ? input.manifest.scriptHash : "",
    manifestHash: input.manifestHash,
    casting: {
      narrator: {
        voiceId: input.casting.narrator.voiceId,
        label: input.casting.narrator.label ?? "Narrator",
        language: input.casting.narrator.language ?? input.casting.language,
        rate: input.casting.narrator.rate ?? input.casting.rate,
      },
      cast: input.casting.cast.map((member) => ({
        characterId: member.characterId,
        voiceId: member.voiceId,
      })),
      format: input.casting.format,
      sampleRate: input.casting.sampleRate,
    },
    segments: segments.map((segment) => ({
      ...segment,
      startSec: round(segment.startSec),
      durationSec: round(segment.durationSec),
    })),
    sentences: [...args.sentences],
    scenes: [...scenes],
    totals: {
      scenes: input.manifest.scenes.length,
      segments: segments.length,
      words: totalWords,
      characters: totalCharacters,
      wordsPerSecond: spokenMs === 0 ? 0 : round((totalWords / spokenMs) * 1_000, 2),
      plannedDurationSec: round(input.manifest.totalDurationSec),
      spokenDurationSec,
      driftSec: round(spokenDurationSec - input.manifest.totalDurationSec),
      cachedSegments: segments.filter((segment) => segment.cached).length,
      operatorSegments: segments.filter((segment) => segment.provider === "operator").length,
      estimatedSegments: segments.filter((segment) => segment.durationMethod === "estimated")
        .length,
      failedSegments: args.failedSegments,
    },
    issues: [...args.issues],
    warnings,
    provenance: {
      name: AUDIO_ENGINE_NAME,
      version: AUDIO_ENGINE_VERSION,
      steps: ["voice.segments", "voice.synthesize", "voice.timings"],
      aiSteps: ["voice.synthesize"],
      deterministicSteps: ["voice.segments", "voice.timings"],
    },
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────

const systemNow: Clock = systemClock;

function safeVoices(tts: TTSProvider): readonly { id: string; label: string; language: string }[] {
  try {
    return tts.voices();
  } catch {
    return [];
  }
}

function withScene(issue: AudioIssue, plan: SegmentPlan): AudioIssue {
  return { ...issue, sceneId: plan.sceneId, segmentId: plan.id };
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

function normalizeWordTimings(timings: readonly WordTiming[]): WordTiming[] {
  return timings.map((timing) => ({
    word: timing.word,
    startMs: Math.max(0, Math.round(timing.startMs)),
    endMs: Math.max(0, Math.round(timing.endMs)),
  }));
}

/** Deterministic backoff: no jitter, so a run's delays are reproducible. */
export function backoffMs(tuning: AudioTuning, retryIndex: number): number {
  return Math.min(tuning.maxDelayMs, Math.round(tuning.baseDelayMs * tuning.factor ** retryIndex));
}

async function wait(deps: AudioPipelineDeps, ms: number): Promise<void> {
  if (deps.sleep !== undefined) {
    await deps.sleep(ms);
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
