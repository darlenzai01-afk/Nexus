import { readWavHeader } from "@nexus/providers";

import type { AudioProbe } from "./schema.js";

/**
 * Duration metadata straight from the bytes.
 *
 * A provider's reported duration is a *claim*; the file is the fact. The stage
 * asks the provider for the clip, then parses the container it actually got:
 *
 * - **WAV** — the `fmt `/`data` chunks give an exact duration (a header cannot
 *   lie without the file being corrupt), plus the sample rate and channel count.
 * - **MP3** — there is no duration field, so a constant-bitrate estimate is made
 *   from the first frame header. It is marked `exact: false` and is only used
 *   when the provider gave nothing, because a VBR file would drift.
 * - **Unknown** — nothing is guessed: the caller falls back to the word-count
 *   estimate it can defend, and says so with a `duration_missing` note.
 *
 * This module never reads a file or touches the network: it takes bytes, so it is
 * the same code path in a test and in production.
 */

const MP3_BITRATES: Readonly<Record<string, readonly number[]>> = {
  // MPEG 1 Layer III, then MPEG 2/2.5 Layer III, in kbps (index 0 = "free").
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const MP3_SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  1: [44_100, 48_000, 32_000, 0],
  2: [22_050, 24_000, 16_000, 0],
  25: [11_025, 12_000, 8_000, 0],
};

export function probeAudio(bytes: Uint8Array): AudioProbe {
  const wav = probeWav(bytes);
  if (wav !== undefined) return wav;
  const mp3 = probeMp3(bytes);
  if (mp3 !== undefined) return mp3;
  return { format: "unknown", mime: "application/octet-stream", exact: false };
}

function probeWav(bytes: Uint8Array): AudioProbe | undefined {
  try {
    const header = readWavHeader(bytes);
    const durationMs = Math.round(header.durationMs);
    if (durationMs <= 0) return undefined;
    return {
      format: "wav",
      mime: "audio/wav",
      durationMs,
      sampleRate: header.sampleRate,
      channels: header.channels,
      bitsPerSample: header.bitsPerSample,
      exact: true,
    };
  } catch {
    return undefined;
  }
}

function probeMp3(bytes: Uint8Array): AudioProbe | undefined {
  const offset = findFrameSync(bytes);
  if (offset < 0) return undefined;

  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const versionBits = (b1 >> 3) & 0b11;
  const layerBits = (b1 >> 1) & 0b11;
  if (layerBits !== 0b01) return undefined; // Layer III only.

  const version =
    versionBits === 0b11 ? 1 : versionBits === 0b10 ? 2 : versionBits === 0b00 ? 25 : 0;
  if (version === 0) return undefined;

  const bitrateIndex = (b2 >> 4) & 0b1111;
  const sampleRateIndex = (b2 >> 2) & 0b11;
  const bitrateKbps = MP3_BITRATES[version === 1 ? "1-3" : "2-3"]?.[bitrateIndex] ?? 0;
  const sampleRate = MP3_SAMPLE_RATES[version]?.[sampleRateIndex] ?? 0;
  if (bitrateKbps === 0 || sampleRate === 0) return undefined;

  const payloadBytes = bytes.byteLength - offset;
  const durationMs = Math.round((payloadBytes * 8) / bitrateKbps);
  if (durationMs <= 0) return undefined;

  // Channel mode is two bits: 11 is mono, everything else carries two channels.
  const channelMode = (b2 >> 6) & 0b11;

  return {
    format: "mp3",
    mime: "audio/mpeg",
    durationMs,
    sampleRate,
    channels: channelMode === 0b11 ? 1 : 2,
    exact: false,
  };
}

function findFrameSync(bytes: Uint8Array): number {
  for (let index = 0; index + 4 <= bytes.byteLength; index += 1) {
    if (bytes[index] === 0xff && ((bytes[index + 1] ?? 0) & 0xe0) === 0xe0) return index;
  }
  return -1;
}
