import { MemoryBlobStore, synthesizeWav, type TTSProvider } from "@nexus/providers";
import type { SceneManifest } from "@nexus/scenes";
import { describe, expect, it } from "vitest";

import { MemorySegmentCache, segmentCacheKey, type SegmentAudioCache } from "./cache.js";
import { AudioError } from "./errors.js";
import {
  FIXTURE_CLOCK,
  ScriptedTtsProvider,
  audioManifest,
  audioScene,
  castingFixture,
  fakeTts,
  fixedClock,
  twoSceneManifest,
} from "./fixtures.js";
import { synthesizeNarration, type AudioRunReport, type AudioTuning } from "./pipeline.js";
import {
  AudioTrackSchema,
  audioTrackBytes,
  type OperatorAudio,
  type VoiceCasting,
} from "./schema.js";

/**
 * The voice engine, end to end against the deterministic fake TTS.
 *
 * Everything here runs offline: the fake writes a real WAV into the CAS, so
 * duration verification, probing and the timing document are exercised for real
 * rather than against a stub that returns numbers it made up. The scripted
 * adapter covers what a fake cannot — a failure, an empty clip, an oversized
 * clip, a capability that needs a human, an adapter that reports nothing.
 */

const MANIFEST_HASH = "d".repeat(64);

interface RunOptions {
  readonly manifest?: SceneManifest;
  readonly casting?: VoiceCasting;
  readonly tts?: (storage: MemoryBlobStore) => TTSProvider;
  readonly cache?: SegmentAudioCache;
  readonly tuning?: Partial<AudioTuning>;
  readonly operatorAudio?: readonly OperatorAudio[];
  readonly storage?: MemoryBlobStore;
}

interface Run {
  readonly report: AudioRunReport;
  readonly storage: MemoryBlobStore;
  readonly sleeps: number[];
  readonly events: string[];
}

async function runAudio(options: RunOptions = {}): Promise<Run> {
  const storage = options.storage ?? new MemoryBlobStore();
  const sleeps: number[] = [];
  const events: string[] = [];
  const report = await synthesizeNarration(
    {
      manifest: options.manifest ?? twoSceneManifest(),
      manifestHash: MANIFEST_HASH,
      casting: options.casting ?? castingFixture(),
      ...(options.operatorAudio !== undefined ? { operatorAudio: options.operatorAudio } : {}),
      now: FIXTURE_CLOCK,
    },
    {
      tts: options.tts?.(storage) ?? fakeTts(storage),
      storage,
      clock: fixedClock(),
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
      ...(options.tuning !== undefined ? { tuning: options.tuning } : {}),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (event) => {
        events.push(event);
      },
    },
  );
  return { report, storage, sleeps, events };
}

/** Every track this engine produces has to be a document downstream stages can load. */
function expectValidTrack(report: AudioRunReport): void {
  expect(() => AudioTrackSchema.parse(report.track)).not.toThrow();
}

/** One scene, so a scripted adapter's calls line up with the scenes. */
function oneScene(
  options: { readonly durationSec?: number; readonly narration?: string } = {},
): SceneManifest {
  return audioManifest([
    audioScene({
      id: "scn_one",
      index: 0,
      durationSec: options.durationSec ?? 4,
      ...(options.narration !== undefined ? { narration: options.narration } : {}),
    }),
  ]);
}

describe("voicing a manifest", () => {
  it("synthesizes one clip per scene, measured from the bytes", async () => {
    const { report, events } = await runAudio();

    expect(report.waiting).toBe(false);
    expect(report.calls).toEqual({
      scenes: 2,
      segments: 2,
      providerCalls: 2,
      cacheHits: 0,
      retries: 0,
      operatorSegments: 0,
      failedSegments: 0,
    });
    expect(report.issues).toEqual([]);
    expectValidTrack(report);

    const [first, second] = report.track.segments;
    // 8 words at the fake's 320 ms/word, and the fake's claim is the WAV's real
    // length, so the stage records it as the provider's duration with no warning.
    expect(first).toMatchObject({
      id: "seg_scn_one",
      sceneId: "scn_one",
      provider: "fake",
      attempts: 1,
      cached: false,
      durationMethod: "provider",
      voice: { voiceId: "fake-narrator", label: "Maya" },
    });
    expect(first?.audio.durationMs).toBe(2_560);
    expect(first?.wordTimings).toHaveLength(8);
    expect(second?.startSec).toBe(2.56);
    expect(report.track.totals).toMatchObject({
      scenes: 2,
      segments: 2,
      words: 16,
      spokenDurationSec: 5.12,
      plannedDurationSec: 9,
      driftSec: -3.88,
      estimatedSegments: 0,
      failedSegments: 0,
    });
    expect(events).toContain("voice.segment.completed");
  });

  it("places the spoken timeline by the clips, not by the plan", async () => {
    const { report } = await runAudio({ manifest: oneScene({ durationSec: 1 }) });

    // Planned: 0–1 s. Spoken: 2.56 s, so the timeline says so and the verdict says
    // the composition has to stretch (or the narration tighten).
    expect(report.track.segments[0]?.startSec).toBe(0);
    expect(report.track.scenes[0]).toMatchObject({
      sceneId: "scn_one",
      plannedDurationSec: 1,
      spokenDurationSec: 2.56,
      driftSec: 1.56,
      verdict: "over",
    });
    expect(report.issues.map((issue) => issue.code)).toContain("spoken_overflow");
    expect(report.waiting).toBe(false);
  });

  it("calls a scene that fits what it fits", async () => {
    const { report } = await runAudio({ manifest: oneScene({ durationSec: 2.56 }) });
    expect(report.track.scenes[0]).toMatchObject({ verdict: "fits", driftSec: 0 });
    expect(report.issues).toEqual([]);
  });

  it("windows each sentence from the provider's word timings", async () => {
    const { report } = await runAudio();
    const sentences = report.track.sentences;

    expect(sentences.map((sentence) => sentence.sentenceId)).toEqual(["snt_1", "snt_2", "snt_3"]);
    expect(sentences.every((sentence) => sentence.method === "word_timings")).toBe(true);
    expect(sentences.every((sentence) => sentence.startSec >= 0 && sentence.endSec <= 5.12)).toBe(
      true,
    );
    // The second scene's two sentences tile its clip: the second ends where the
    // segment does, and neither crosses the other.
    const [second, third] = sentences.slice(1);
    expect(second?.sceneId).toBe("scn_two");
    expect(third?.startSec).toBe(second?.endSec);
    expect(third?.endSec).toBe(5.12);
  });

  it("shares the window out when the adapter reports no timings", async () => {
    const { report } = await runAudio({
      tts: (storage) =>
        new ScriptedTtsProvider(storage, [{ kind: "ok" }], {
          durationMs: 2_560,
          withTimings: false,
        }),
    });

    expect(report.track.segments.every((segment) => segment.wordTimings === undefined)).toBe(true);
    expect(report.track.sentences.every((sentence) => sentence.method === "proportional")).toBe(
      true,
    );
    // Proportional windows still tile the clip exactly: nothing is left uncaptioned.
    expect(report.track.sentences[0]?.startSec).toBe(0);
    expect(report.track.sentences[report.track.sentences.length - 1]?.endSec).toBe(5.12);
  });

  it("produces the same document twice", async () => {
    const first = await runAudio();
    const second = await runAudio();

    const bytes = (run: Run): string => new TextDecoder().decode(audioTrackBytes(run.report.track));
    expect(bytes(first)).toBe(bytes(second));
    expect(first.report.track.segments.map((segment) => segment.audio.hash)).toEqual(
      second.report.track.segments.map((segment) => segment.audio.hash),
    );
  });
});

describe("duration metadata", () => {
  it("believes the bytes when the provider's claim is wrong", async () => {
    const { report } = await runAudio({
      manifest: oneScene(),
      tts: (storage) =>
        new ScriptedTtsProvider(storage, [{ kind: "ok" }], {
          durationMs: 1_000,
          claimMs: 1_400,
          withTimings: false,
        }),
    });

    expect(report.track.segments[0]?.audio.durationMs).toBe(1_000);
    expect(report.track.segments[0]?.durationMethod).toBe("provider");
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "duration_mismatch", severity: "warning" }),
    ]);
    expect(report.waiting).toBe(false);
  });

  it("estimates only when nothing measured the clip, and says so", async () => {
    const { report } = await runAudio({
      manifest: oneScene(),
      tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "opaque" }]),
    });

    // 8 words at the manifest's 2.5 words/second.
    expect(report.track.segments[0]?.audio.durationMs).toBe(3_200);
    expect(report.track.segments[0]?.durationMethod).toBe("estimated");
    expect(report.track.totals.estimatedSegments).toBe(1);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "duration_missing", severity: "warning" }),
    ]);
    expectValidTrack(report);
  });
});

describe("retries", () => {
  it("tries again on a retryable failure, with a deterministic backoff", async () => {
    const { report, sleeps } = await runAudio({
      manifest: oneScene(),
      tts: (storage) =>
        new ScriptedTtsProvider(storage, [{ kind: "throw" }, { kind: "throw" }, { kind: "ok" }], {
          durationMs: 1_000,
        }),
    });

    expect(report.track.segments).toHaveLength(1);
    expect(report.track.segments[0]?.attempts).toBe(3);
    expect(report.calls).toMatchObject({ providerCalls: 3, retries: 2, failedSegments: 0 });
    expect(sleeps).toEqual([250, 500]);
    expect(report.waiting).toBe(false);
  });

  it("gives up after the attempt budget, and reports the scene", async () => {
    const { report, sleeps } = await runAudio({
      manifest: oneScene(),
      tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "throw" }]),
    });

    expect(report.track.segments).toEqual([]);
    expect(report.calls).toMatchObject({ providerCalls: 3, retries: 2, failedSegments: 1 });
    expect(sleeps).toEqual([250, 500]);
    expect(report.waiting).toBe(true);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "provider_failed", severity: "error", sceneId: "scn_one" }),
    ]);
    // The scene is still in the timing document, and it says it is silent.
    expect(report.track.scenes[0]).toMatchObject({
      verdict: "silent",
      spokenDurationSec: 0,
      segmentId: "",
    });
    expect(report.track.totals.failedSegments).toBe(1);
    expectValidTrack(report);
  });

  it("does not retry a failure the provider calls permanent", async () => {
    const { report, sleeps } = await runAudio({
      manifest: oneScene(),
      tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "throw", retryable: false }]),
    });

    expect(report.calls).toMatchObject({ providerCalls: 1, retries: 0, failedSegments: 1 });
    expect(sleeps).toEqual([]);
    expect(report.track.segments).toEqual([]);
  });

  it("refuses an empty clip and an oversized one", async () => {
    const empty = await runAudio({
      manifest: oneScene(),
      tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "empty" }]),
    });
    expect(empty.report.issues[0]).toMatchObject({ code: "empty_audio", severity: "error" });
    // A rejected clip is a failed attempt, so the budget applies to it too.
    expect(empty.report.calls.providerCalls).toBe(3);

    const oversize = await runAudio({
      manifest: oneScene(),
      tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "oversize" }]),
    });
    expect(oversize.report.issues[0]).toMatchObject({ code: "bytes_too_large", severity: "error" });
    expect(oversize.report.waiting).toBe(true);
  });

  it("reports a capability that needs a human as the manual hand-off it is", async () => {
    const { report, sleeps } = await runAudio({
      manifest: oneScene(),
      tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "manual" }]),
    });

    expect(report.issues[0]).toMatchObject({ code: "manual_required", severity: "error" });
    expect(report.calls).toMatchObject({ providerCalls: 1, retries: 0 });
    expect(sleeps).toEqual([]);
    expect(report.waiting).toBe(true);
  });
});

describe("failing loudly vs. parking", () => {
  it("throws instead of parking when the tuning says a failure is fatal", async () => {
    await expect(
      runAudio({
        manifest: oneScene(),
        tuning: { onFailure: "fail" },
        tts: (storage) => new ScriptedTtsProvider(storage, [{ kind: "throw", retryable: false }]),
      }),
    ).rejects.toThrow(AudioError);
  });

  it("refuses a manifest with no scenes to voice", async () => {
    // A manifest loaded from the CAS always has scenes (its own schema requires
    // one), so this is the engine defending the documents it is handed in memory.
    const empty = { ...twoSceneManifest(), scenes: [] } as SceneManifest;
    await expect(runAudio({ manifest: empty })).rejects.toThrow(/no scenes/u);
  });

  it("never swaps a voice the adapter does not offer", async () => {
    const listening = audioManifest([
      audioScene({
        id: "scn_one",
        index: 0,
        characters: [{ characterId: "maya", state: "listening" }],
      }),
    ]);
    const { report } = await runAudio({
      manifest: listening,
      casting: castingFixture({
        narrator: { voiceId: "not-a-voice", label: "Narrator", language: "en", rate: 1 },
      }),
    });

    expect(report.track.segments).toEqual([]);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "voice_unavailable", severity: "error", sceneId: "scn_one" }),
    ]);
    expect(report.waiting).toBe(true);
    expectValidTrack(report);
  });
});

describe("reusing clips", () => {
  it("serves a repeated segment from the cache, and re-voices only what changed", async () => {
    const cache = new MemorySegmentCache();
    const first = await runAudio({ cache });
    const second = await runAudio({ cache, storage: first.storage });

    expect(second.report.calls).toMatchObject({
      cacheHits: 2,
      providerCalls: 0,
      failedSegments: 0,
    });
    expect(second.report.track.segments.map((segment) => segment.cached)).toEqual([true, true]);
    expect(second.report.track.segments.map((segment) => segment.attempts)).toEqual([0, 0]);
    expect(second.report.track.segments.map((segment) => segment.audio.hash)).toEqual(
      first.report.track.segments.map((segment) => segment.audio.hash),
    );
    expectValidTrack(second.report);

    // Edit one scene's narration: that scene is voiced again, the other is reused.
    const edited = audioManifest([
      audioScene({ id: "scn_one", index: 0, durationSec: 4 }),
      audioScene({
        id: "scn_two",
        index: 1,
        startSec: 4,
        durationSec: 5,
        type: "HYBRID",
        narration: "A completely different second scene.",
        sentenceIds: ["snt_2"],
      }),
    ]);
    const third = await runAudio({ cache, storage: first.storage, manifest: edited });
    expect(third.report.calls).toMatchObject({ cacheHits: 1, providerCalls: 1 });
    expect(third.report.track.segments.map((segment) => segment.cached)).toEqual([true, false]);
  });

  it("re-synthesizes when the cache points at bytes that are gone", async () => {
    const cache = new MemorySegmentCache();
    const key = segmentCacheKey({
      provider: "fake",
      text: "The bridge carries forty thousand crossings a day.",
      voiceId: "fake-narrator",
      format: "wav",
      sampleRate: 8_000,
      rate: 1,
    });
    cache.set(key, {
      hash: "f".repeat(64),
      bytes: 100,
      mime: "audio/wav",
      format: "wav",
      sampleRate: 8_000,
      durationMs: 500,
      voiceId: "fake-narrator",
      provider: "fake",
    });

    const { report } = await runAudio({ manifest: oneScene(), cache });
    expect(report.issues.map((issue) => issue.code)).toEqual(["cache_stale"]);
    expect(report.calls).toMatchObject({ cacheHits: 0, providerCalls: 1 });
    expect(report.track.segments[0]?.cached).toBe(false);
  });
});

describe("operator-supplied clips", () => {
  it("adopts a clip a human supplied, and reads its duration from the bytes", async () => {
    const storage = new MemoryBlobStore();
    const wav = synthesizeWav({
      text: "The bridge carries forty thousand crossings a day.",
      voiceId: "fake-warm",
      sampleRate: 8_000,
      durationMs: 1_500,
    });
    const put = storage.put(wav.bytes);

    const { report } = await runAudio({
      storage,
      manifest: oneScene(),
      operatorAudio: [{ sceneId: "scn_one", hash: put.hash, durationMs: 1_500 }],
    });

    expect(report.track.segments[0]).toMatchObject({
      provider: "operator",
      attempts: 0,
      durationMethod: "probed",
      audio: { hash: put.hash, durationMs: 1_500 },
    });
    expect(report.calls).toMatchObject({ operatorSegments: 1, providerCalls: 0 });
    expect(report.track.totals.operatorSegments).toBe(1);
    expect(report.waiting).toBe(false);
    expectValidTrack(report);
  });

  it("reports a clip that is not in the store instead of voicing over it", async () => {
    const { report } = await runAudio({
      manifest: oneScene(),
      operatorAudio: [{ sceneId: "scn_one", hash: "e".repeat(64) }],
    });

    expect(report.issues).toEqual([
      expect.objectContaining({ code: "operator_audio_missing", severity: "error" }),
    ]);
    expect(report.track.segments).toEqual([]);
    expect(report.waiting).toBe(true);
  });
});
