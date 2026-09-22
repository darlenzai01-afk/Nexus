import { loadAudioTrack } from "@nexus/audio";
import { Db, Repo, migrate } from "@nexus/db";
import { MemoryBlobStore, synthesizeWav } from "@nexus/providers";
import { describe, expect, it } from "vitest";

import {
  assembleNarration,
  audioFilters,
  decodeWav,
  encodeWav,
  measureLoudness,
  narrationClips,
  peakOf,
} from "./audio.js";
import { fixtureAudio, fixtureManifest } from "./fixtures.js";
import { createScriptedFFmpeg } from "./scripted-ffmpeg.js";

/**
 * Assembling the narration.
 *
 * The clips are real: `synthesizeWav` writes PCM, `decodeWav` reads it, and the
 * placement is checked sample by sample — silence where the plan has no speech,
 * signal exactly where it does. That is the property a mux depends on.
 */

function wavOf(text: string, durationMs: number, sampleRate = 8_000): Uint8Array {
  return synthesizeWav({ text, voiceId: "fixture", sampleRate, durationMs, amplitude: 0.5 }).bytes;
}

function storeOf(entries: Readonly<Record<string, Uint8Array>>): MemoryBlobStore {
  const storage = new MemoryBlobStore();
  for (const bytes of Object.values(entries)) storage.put(bytes);
  return storage;
}

const sampleRate = 8_000;

describe("decodeWav / encodeWav", () => {
  it("decodes a PCM WAV the voice stage would write", () => {
    const decoded = decodeWav(wavOf("hello", 500));
    expect(decoded.sampleRate).toBe(8_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.frames).toBe(4_000);
    expect(decoded.durationSec).toBeCloseTo(0.5, 3);
    expect(peakOf(decoded)).toBeGreaterThan(0.4);
  });

  it("round-trips through encode without losing the signal", () => {
    const original = decodeWav(wavOf("hello", 250));
    const again = decodeWav(encodeWav(original));
    expect(again.frames).toBe(original.frames);
    expect(peakOf(again)).toBeCloseTo(peakOf(original), 3);
    for (let index = 0; index < 500; index += 1) {
      expect(again.samples[index] ?? 0).toBeCloseTo(original.samples[index] ?? 0, 3);
    }
  });

  it("refuses something that is not a WAV", () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow(/too short/u);
    const notRiff = new Uint8Array(64);
    expect(() => decodeWav(notRiff)).toThrow(/RIFF/u);
  });

  it("refuses a compressed WAV rather than guessing at it", () => {
    const bytes = wavOf("hello", 100);
    // A WAV whose format tag is not PCM (1) — the shape an MP3-in-WAV clip has.
    new DataView(bytes.buffer).setUint16(20, 55, true);
    expect(() => decodeWav(bytes)).toThrow(/not PCM/u);
  });
});

describe("assembleNarration", () => {
  it("places clips where their segments start and pads the rest with silence", () => {
    const first = wavOf("one", 1_000);
    const second = wavOf("two", 1_000);
    const storage = storeOf({ first, second });
    const firstHash = storage.put(first).hash;
    const secondHash = storage.put(second).hash;
    const result = assembleNarration(
      [
        { hash: firstHash, startSec: 0, label: "scene_1/seg_1" },
        { hash: secondHash, startSec: 2, label: "scene_2/seg_2" },
      ],
      (hash) => storage.read(hash),
      { sampleRate, channels: 1, durationSec: 3 },
    );

    expect(result.clips).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.wav.frames).toBe(24_000);
    // Speech at t=0, silence at t=1.5, speech again at t=2.
    expect(peak(sliceOf(result.wav.samples, 0, 800))).toBeGreaterThan(0.3);
    expect(peak(sliceOf(result.wav.samples, 12_000, 800))).toBe(0);
    expect(peak(sliceOf(result.wav.samples, 16_000, 800))).toBeGreaterThan(0.3);
  });

  it("names a clip it cannot read, and keeps the rest", () => {
    const good = wavOf("good", 500);
    const storage = storeOf({ good });
    const goodHash = storage.put(good).hash;
    const result = assembleNarration(
      [
        { hash: "f".repeat(64), startSec: 0, label: "scene_1/seg_1" },
        { hash: goodHash, startSec: 0.2, label: "scene_2/seg_2" },
      ],
      (hash) => storage.read(hash),
      { sampleRate, channels: 1, durationSec: 1 },
    );
    expect(result.clips).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("scene_1/seg_1");
  });

  it("trims a clip that runs past the end of the video rather than stretching it", () => {
    const long = wavOf("long", 4_000);
    const storage = storeOf({ long });
    const hash = storage.put(long).hash;
    const result = assembleNarration(
      [{ hash, startSec: 0, label: "s/1" }],
      (h) => storage.read(h),
      {
        sampleRate,
        channels: 1,
        durationSec: 1,
      },
    );
    expect(result.wav.frames).toBe(8_000);
    expect(result.placements[0]?.durationSec).toBeCloseTo(4, 2);
  });

  it("skips a clip that starts after the video has ended", () => {
    const clip = wavOf("late", 200);
    const storage = storeOf({ clip });
    const hash = storage.put(clip).hash;
    const result = assembleNarration(
      [{ hash, startSec: 5, label: "s/late" }],
      (h) => storage.read(h),
      {
        sampleRate,
        channels: 1,
        durationSec: 1,
      },
    );
    expect(result.clips).toBe(0);
    expect(result.skipped[0]).toContain("past the end");
  });

  it("fills both channels when the video carries stereo audio", () => {
    const clip = wavOf("stereo", 500);
    const storage = storeOf({ clip });
    const hash = storage.put(clip).hash;
    const result = assembleNarration(
      [{ hash, startSec: 0, label: "s/1" }],
      (h) => storage.read(h),
      {
        sampleRate,
        channels: 2,
        durationSec: 0.5,
      },
    );
    expect(result.wav.channels).toBe(2);
    // Frame 100, left then right: the mono clip is duplicated, not panned.
    expect(result.wav.samples[200]).toBeCloseTo(result.wav.samples[201] ?? 0, 5);
  });
});

describe("narrationClips", () => {
  it("reads every clip's start time off a real voice track", async () => {
    const storage = new MemoryBlobStore();
    const manifest = fixtureManifest({ seconds: 2 });
    const db = Db.memory();
    migrate(db);
    const repo = new Repo(db);
    const fixture = await fixtureAudio(storage, repo, manifest);
    const track = loadAudioTrack(storage, fixture.trackHash);
    const clips = narrationClips(track);
    expect(fixture.clips).toBeGreaterThan(0);
    expect(clips).toHaveLength(track.segments.length);
    expect(clips[0]?.label).toContain("/");
    expect(clips.every((clip) => /^[0-9a-f]{64}$/u.test(clip.hash))).toBe(true);
    expect(clips[0]?.startSec).toBe(0);
  });
});

describe("loudness and audio filters", () => {
  it("reads EBU R128 numbers out of FFmpeg's own analysis", () => {
    const ffmpeg = createScriptedFFmpeg();
    const loudness = measureLoudness(ffmpeg, "/tmp/narration.wav");
    expect(loudness).toEqual({ inputI: -17.42, inputTp: -1.85, inputLra: 3.1 });
  });

  it("only adds a filter chain when normalisation is asked for", () => {
    expect(audioFilters(false)).toBeUndefined();
    expect(audioFilters(true)).toContain("loudnorm");
  });
});

function sliceOf(samples: Float32Array, start: number, length: number): Float32Array {
  return samples.subarray(start, start + length);
}

/** Peak of a raw sample window: 0 means silence, which is what "no speech here" is. */
function peak(samples: Float32Array): number {
  let highest = 0;
  for (const sample of samples) highest = Math.max(highest, Math.abs(sample));
  return highest;
}
