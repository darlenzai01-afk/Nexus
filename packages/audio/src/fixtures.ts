import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FAKE_VOICES,
  FakeTTSProvider,
  FixedClock,
  ManualRequiredError,
  MemoryProviderCache,
  ProviderError,
  createRuntime,
  invoke,
  silentProviderLogger,
  synthesizeWav,
  unlimitedRateLimiter,
  type InvokeRuntime,
  type ProviderLogger,
  type ProviderPolicy,
  type ProviderResult,
  type SynthesisRequest,
  type SynthesisResult,
  type TTSProvider,
  type VoiceProfile,
} from "@nexus/providers";
import {
  SceneSchema,
  parseSceneManifest,
  type Scene,
  type SceneCastEntry,
  type SceneManifest,
  type SceneType,
} from "@nexus/scenes";
import { sha256, type BlobStore } from "@nexus/storage";

import type { AudioSegment, AudioTrack, VoiceCasting } from "./schema.js";

/**
 * Fixtures for the audio engine.
 *
 * The default is the **deterministic fake TTS**: it writes a real WAV (derived
 * from a hash of the text and voice) into the CAS and reports real word timings,
 * so duration math, probing and cueing are exercised for real with no account, no
 * network and no paid call. `ScriptedTtsProvider` covers what a fake cannot:
 * failures, empty clips, oversized clips, a wrong container, an adapter that
 * reports no duration, and a capability that degrades to a human.
 */

export const FIXTURE_CLOCK = "2024-05-01T00:00:00.000Z";
export const FIXTURE_SCRIPT_HASH = "c".repeat(64);
export const FIXTURE_FPS = 30;
export const FIXTURE_RESOLUTION = { width: 1920, height: 1080 };

/**
 * The retry policy the *provider* layer runs with. One attempt: the audio
 * pipeline has its own segment-level retry loop, and a test that wants to see it
 * must not have `invoke` swallow the first failure.
 */
const POLICY: ProviderPolicy = {
  ...DEFAULT_PROVIDER_POLICY,
  timeoutMs: 1_000,
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitter: 0,
  degradeRatio: 1,
  rateLimitPerMinute: 0,
};

/** The clock every audio fixture runs on: fixed, so timestamps are reproducible. */
export function fixedClock(): FixedClock {
  return new FixedClock(FIXTURE_CLOCK);
}

/** Runtime plumbing so a provider goes through the real `invoke` pipeline. */
export function ttsRuntime(
  storage: BlobStore,
  id = "fake",
  logger: ProviderLogger = silentProviderLogger,
): InvokeRuntime {
  const clock = fixedClock();
  const budget = new BudgetGuard({ clock });
  const cache = new MemoryProviderCache();
  const invokeDeps = {
    adapterId: id,
    kind: "tts" as const,
    policy: POLICY,
    budget,
    cache,
    logger,
    clock,
    sleep: async (): Promise<void> => undefined,
  };
  return createRuntime({
    adapterId: id,
    kind: "tts",
    storage,
    clock,
    logger,
    env: {},
    policy: POLICY,
    budget,
    limiter: unlimitedRateLimiter,
    cache,
    credentialsEnv: "NEXUS_TTS_API_KEY",
    transport: (): Promise<never> => Promise.reject(new Error("the mocks never touch the network")),
    invoke: (spec) => invoke(invokeDeps, spec),
  });
}

export interface FakeTtsOptions {
  readonly id?: string;
  readonly msPerWord?: number;
  readonly withTimings?: boolean;
}

export function fakeTts(storage: BlobStore, options: FakeTtsOptions = {}): FakeTTSProvider {
  return new FakeTTSProvider(ttsRuntime(storage, options.id ?? "fake"), options);
}

// ── Scene fixtures ────────────────────────────────────────────────────────

export interface AudioSceneOptions {
  readonly id?: string;
  readonly index?: number;
  readonly type?: SceneType;
  readonly startSec?: number;
  readonly durationSec?: number;
  readonly narration?: string;
  readonly sentenceIds?: readonly string[];
  readonly characters?: readonly SceneCastEntry[];
}

/** One valid scene whose narration reads as `sentenceIds.length` sentences. */
export function audioScene(options: AudioSceneOptions = {}): Scene {
  const id = options.id ?? "scn_fixture";
  const text = options.narration ?? "The bridge carries forty thousand crossings a day.";
  const words = text.split(/\s+/u).filter((word) => word !== "").length;
  return SceneSchema.parse({
    id,
    index: options.index ?? 0,
    type: options.type ?? "CHARACTER",
    sectionId: "sec_fixture",
    role: "narrative",
    startSec: options.startSec ?? 0,
    durationSec: options.durationSec ?? 4,
    narration: {
      kind: "sentence",
      text,
      sectionId: "sec_fixture",
      role: "narrative",
      sentenceIds: [...(options.sentenceIds ?? ["snt_1"])],
      words,
      estimatedDurationSec: Math.round((words / 2.5) * 10) / 10,
    },
    characters: [...(options.characters ?? [{ characterId: "maya", state: "talking" }])],
    camera: { shot: "medium", movement: "static", angle: "eye_level", focus: "presenter" },
    animation: [],
    transition: { kind: "cut", durationSec: 0, toSceneId: "", audio: "none" },
  });
}

/** A valid manifest around a set of scenes, with the cast and transition chain wired. */
export function audioManifest(scenes: readonly Scene[]): SceneManifest {
  const total = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const cast = new Map<string, { id: string; name: string; role: string; description: string }>();
  for (const scene of scenes) {
    for (const entry of scene.characters) {
      if (cast.has(entry.characterId)) continue;
      cast.set(entry.characterId, {
        id: entry.characterId,
        name: entry.characterId === "maya" ? "Maya Okonkwo" : entry.characterId,
        role: entry.characterId === "maya" ? "host" : "character",
        description: "",
      });
    }
  }
  const wired = scenes.map((scene, position) => ({
    ...scene,
    transition: { ...scene.transition, toSceneId: scenes[position + 1]?.id ?? "" },
  }));

  return parseSceneManifest({
    version: 1,
    topic: "Audio fixture",
    workingTitle: "Audio Fixture",
    scriptId: "",
    scriptHash: FIXTURE_SCRIPT_HASH,
    generatedAt: FIXTURE_CLOCK,
    fps: FIXTURE_FPS,
    aspect: "16:9",
    resolution: FIXTURE_RESOLUTION,
    wordsPerSecond: 2.5,
    totalDurationSec: Math.round(total * 10) / 10,
    cast: [...cast.values()],
    scenes: wired,
    assets: [],
    warnings: [],
    provenance: {
      engine: { name: "nexus-audio-fixtures", version: "1.0.0" },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
      generatedAt: FIXTURE_CLOCK,
    },
  });
}

/** Two scenes with narration to speak, wired end to end. */
export function twoSceneManifest(): SceneManifest {
  return audioManifest([
    audioScene({ id: "scn_one", index: 0, durationSec: 4 }),
    audioScene({
      id: "scn_two",
      index: 1,
      startSec: 4,
      durationSec: 5,
      type: "HYBRID",
      narration: "Two sentences here. The second one is shorter.",
      sentenceIds: ["snt_2", "snt_3"],
      characters: [{ characterId: "maya", state: "talking" }],
    }),
  ]);
}

export function castingFixture(overrides: Partial<VoiceCasting> = {}): VoiceCasting {
  return {
    version: 1,
    language: "en",
    format: "wav",
    sampleRate: 8_000,
    rate: 1,
    narrator: { voiceId: "fake-warm", label: "Narrator", language: "en", rate: 1 },
    cast: [{ characterId: "maya", voiceId: "fake-narrator", label: "Maya", rate: 1 }],
    ...overrides,
  } as VoiceCasting;
}

// ── A valid track document, built by hand ─────────────────────────────────

/**
 * A minimal *valid* track. Schema tests need a document that parses without
 * running synthesis, and this is exactly the shape the pipeline produces: one
 * segment, its sentence window, its scene verdict and its totals.
 */
export function fixtureTrack(overrides: Partial<AudioTrack> = {}): AudioTrack {
  const segment: AudioSegment = {
    id: "seg_scn_one",
    sceneId: "scn_one",
    index: 0,
    sceneType: "CHARACTER",
    startSec: 0,
    durationSec: 1,
    plannedStartSec: 0,
    plannedDurationSec: 4,
    text: "The bridge carries forty thousand crossings a day.",
    sentenceIds: ["snt_1"],
    words: 8,
    characters: 50,
    voice: {
      voiceId: "fake-narrator",
      label: "Maya",
      language: "en",
      rate: 1,
      format: "wav",
      sampleRate: 8_000,
    },
    provider: "fake",
    attempts: 1,
    cached: false,
    durationMethod: "provider",
    audio: {
      hash: "b".repeat(64),
      bytes: 16_044,
      mime: "audio/wav",
      format: "wav",
      sampleRate: 8_000,
      durationMs: 1_000,
    },
  };

  return {
    version: 1,
    generatedAt: FIXTURE_CLOCK,
    language: "en",
    scriptHash: FIXTURE_SCRIPT_HASH,
    manifestHash: "d".repeat(64),
    casting: {
      narrator: { voiceId: "fake-warm", label: "Narrator", language: "en", rate: 1 },
      cast: [{ characterId: "maya", voiceId: "fake-narrator" }],
      format: "wav",
      sampleRate: 8_000,
    },
    segments: [segment],
    sentences: [
      {
        sentenceId: "snt_1",
        sceneId: "scn_one",
        segmentId: "seg_scn_one",
        startSec: 0,
        endSec: 1,
        durationSec: 1,
        words: 8,
        characters: 50,
        method: "proportional",
      },
    ],
    scenes: [
      {
        sceneId: "scn_one",
        index: 0,
        type: "CHARACTER",
        segmentId: "seg_scn_one",
        plannedStartSec: 0,
        plannedDurationSec: 4,
        spokenStartSec: 0,
        spokenDurationSec: 1,
        driftSec: -3,
        verdict: "short",
      },
    ],
    totals: {
      scenes: 1,
      segments: 1,
      words: 8,
      characters: 50,
      wordsPerSecond: 8,
      plannedDurationSec: 4,
      spokenDurationSec: 1,
      driftSec: -3,
      cachedSegments: 0,
      operatorSegments: 0,
      estimatedSegments: 0,
      failedSegments: 0,
    },
    issues: [
      {
        code: "spoken_overflow",
        severity: "warning",
        sceneId: "scn_one",
        segmentId: "seg_scn_one",
        message: "scene scn_one speaks longer than its plan",
      },
    ],
    warnings: [],
    provenance: {
      name: "nexus-audio",
      version: "1.0.0",
      steps: ["voice.segments", "voice.synthesize", "voice.timings"],
      aiSteps: ["voice.synthesize"],
      deterministicSteps: ["voice.segments", "voice.timings"],
    },
    ...overrides,
  };
}

// ── A provider that does what a test tells it to ──────────────────────────

export type TtsBehavior =
  | { readonly kind: "ok" }
  /** A clip with no bytes at all. */
  | { readonly kind: "empty" }
  /** A clip far larger than the stage's ceiling. */
  | { readonly kind: "oversize" }
  /** A clip whose duration the adapter does not report and no header reveals. */
  | { readonly kind: "opaque" }
  /** A failure: `retryable` decides whether the stage may try again. */
  | { readonly kind: "throw"; readonly retryable?: boolean; readonly message?: string }
  /** A capability that needs a human (AD-06 manual fallback). */
  | { readonly kind: "manual" };

/**
 * A scripted TTS adapter.
 *
 * It answers `behaviors[n]` for the n-th call and repeats the last entry after
 * that, so a test can say "fail twice, then succeed" in one line. Every call is
 * recorded, which is how the retry, retry-exhausted and cache tests count what
 * actually reached the provider.
 */
export class ScriptedTtsProvider implements TTSProvider {
  readonly id: string;
  readonly kind = "tts" as const;
  readonly mode = "fake" as const;
  readonly label = "Scripted TTS (test double)";
  readonly calls: SynthesisRequest[] = [];

  constructor(
    private readonly storage: BlobStore,
    private readonly behaviors: readonly TtsBehavior[] = [{ kind: "ok" }],
    options: {
      readonly id?: string;
      /** How long the clip *is*. */
      readonly durationMs?: number;
      /** A duration the adapter *claims*, when that should differ from the clip. */
      readonly claimMs?: number;
      readonly withTimings?: boolean;
    } = {},
  ) {
    this.id = options.id ?? "scripted";
    this.durationMs = options.durationMs ?? 1_000;
    this.claimedMs = options.claimMs;
    this.withTimings = options.withTimings ?? true;
  }

  private readonly durationMs: number;
  private readonly claimedMs: number | undefined;
  private readonly withTimings: boolean;

  voices(): readonly VoiceProfile[] {
    return FAKE_VOICES;
  }

  async synthesize(request: SynthesisRequest): Promise<ProviderResult<SynthesisResult>> {
    const index = Math.min(this.calls.length, this.behaviors.length - 1);
    const behavior = this.behaviors[index] ?? { kind: "ok" };
    this.calls.push(request);

    if (behavior.kind === "throw") {
      throw new ProviderError(behavior.message ?? "the adapter failed", {
        kind: behavior.retryable === false ? "invalid_request" : "unavailable",
        provider: this.id,
        operation: "tts.synthesize",
        retryable: behavior.retryable ?? true,
      });
    }
    if (behavior.kind === "manual") {
      throw new ManualRequiredError({
        capability: "tts",
        operation: "tts.synthesize",
        summary: "the voice account is out of quota",
        instructions: [
          "supply a clip for the scene through params.operatorAudio, or",
          "point NEXUS_TTS_* at another voice account and retry the stage",
        ],
      });
    }

    const value = this.resultFor(request, behavior);
    return {
      value,
      provider: this.id,
      operation: "tts.synthesize",
      cached: false,
      attempts: 1,
      durationMs: 0,
      usage: { units: request.text.length, unit: "characters" },
    };
  }

  private resultFor(request: SynthesisRequest, behavior: TtsBehavior): SynthesisResult {
    const sampleRate = request.sampleRate ?? 8_000;

    if (behavior.kind === "empty") {
      return {
        audio: { hash: sha256(new Uint8Array(0)), bytes: 0, mime: "audio/wav", durationMs: 0 },
        characters: request.text.length,
      };
    }
    if (behavior.kind === "oversize") {
      const bytes = new Uint8Array(64);
      const put = this.storage.put(bytes);
      return {
        audio: {
          hash: put.hash,
          bytes: 999_999_999,
          mime: "audio/wav",
          durationMs: this.durationMs,
        },
        characters: request.text.length,
      };
    }
    if (behavior.kind === "opaque") {
      // Not a WAV and no duration claimed: nothing can measure it but the words.
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const put = this.storage.put(bytes);
      return {
        audio: {
          hash: put.hash,
          bytes: put.bytes,
          mime: "application/octet-stream",
          durationMs: 0,
        },
        characters: request.text.length,
      };
    }

    const wav = synthesizeWav({
      text: request.text,
      voiceId: request.voice.id,
      sampleRate,
      durationMs: this.durationMs,
    });
    const put = this.storage.put(wav.bytes);
    return {
      audio: {
        hash: put.hash,
        bytes: put.bytes,
        mime: "audio/wav",
        durationMs: this.claimedMs ?? this.durationMs,
      },
      ...(this.withTimings
        ? {
            wordTimings: request.text
              .split(/\s+/u)
              .filter((word) => word !== "")
              .map((word, index, all) => {
                const span = Math.floor(this.durationMs / all.length);
                return { word, startMs: index * span, endMs: (index + 1) * span };
              }),
          }
        : {}),
      characters: request.text.length,
    };
  }
}
