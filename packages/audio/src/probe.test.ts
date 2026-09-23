import { synthesizeWav } from "@nexus/providers";
import { describe, expect, it } from "vitest";

import { probeAudio } from "./probe.js";

/**
 * Duration metadata from the bytes.
 *
 * A provider's `durationMs` is a claim; a WAV header is not. These tests pin both
 * halves of that: the exact path (a real WAV, written by the same writer the fake
 * adapter uses) and the honest failure path (bytes nothing can measure, where the
 * caller must fall back to the word-count estimate and say so).
 */

describe("probing a clip", () => {
  it("reads a WAV's duration, rate, channels and depth exactly", () => {
    const wav = synthesizeWav({
      text: "hello there",
      voiceId: "fake-warm",
      sampleRate: 8_000,
      durationMs: 1_500,
    });
    const probe = probeAudio(wav.bytes);
    expect(probe).toMatchObject({
      format: "wav",
      mime: "audio/wav",
      durationMs: 1_500,
      sampleRate: 8_000,
      channels: 1,
      bitsPerSample: 16,
      exact: true,
    });
  });

  it("reads a different rate just as exactly", () => {
    const wav = synthesizeWav({
      text: "hello there",
      voiceId: "fake-deep",
      sampleRate: 22_050,
      durationMs: 900,
    });
    expect(probeAudio(wav.bytes)).toMatchObject({
      sampleRate: 22_050,
      durationMs: 900,
      exact: true,
    });
  });

  it("estimates an MP3 from its first frame header, and says it is an estimate", () => {
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 128 kbps = 16 kB/s, so a
    // 16 000-byte payload is 1 000 ms.
    const bytes = new Uint8Array(16_000);
    bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
    const probe = probeAudio(bytes);
    expect(probe).toMatchObject({
      format: "mp3",
      mime: "audio/mpeg",
      durationMs: 1_000,
      sampleRate: 44_100,
      exact: false,
    });
  });

  it("refuses to guess when the bytes are not audio it knows", () => {
    expect(probeAudio(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
      format: "unknown",
      mime: "application/octet-stream",
      exact: false,
    });
    expect(probeAudio(new Uint8Array(0)).format).toBe("unknown");
    expect(
      probeAudio(
        synthesizeWav({ text: "x", voiceId: "v", sampleRate: 8_000, durationMs: 500 }).bytes.slice(
          0,
          20,
        ),
      ).format,
    ).toBe("unknown");
  });

  it("ignores an MP3 frame that is not Layer III", () => {
    const bytes = new Uint8Array(4_000);
    // 0xFE = MPEG-1, Layer I: the bitrate table used for Layer III would be
    // wrong for this frame, so nothing is claimed.
    bytes.set([0xff, 0xfe, 0x90, 0x64], 0);
    expect(probeAudio(bytes).format).toBe("unknown");
  });
});
