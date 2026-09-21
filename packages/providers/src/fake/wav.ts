import { hashInputs } from "../util.js";

/**
 * Minimal deterministic WAV writer.
 *
 * The fake TTS output must be *real audio container bytes* — a stage that
 * muxes or probes it should behave exactly as it will with a provider's file.
 * Samples are a low-amplitude square-ish tone derived from the text hash, so
 * the content is deterministic and the file is small (8 kHz mono by default).
 */
export interface WavOptions {
  readonly text: string;
  readonly voiceId: string;
  readonly sampleRate: number;
  readonly durationMs: number;
  /** Peak amplitude 0–1 (kept low so nothing is ever painfully loud). */
  readonly amplitude?: number;
}

export interface WavBytes {
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly samples: number;
}

const HEADER_BYTES = 44;

export function synthesizeWav(options: WavOptions): WavBytes {
  const { sampleRate, durationMs } = options;
  const samples = Math.max(1, Math.round((durationMs / 1_000) * sampleRate));
  const bytes = new Uint8Array(HEADER_BYTES + samples * 2);
  const view = new DataView(bytes.buffer);

  const dataBytes = samples * 2;
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);

  const seed = hashInputs({ text: options.text, voice: options.voiceId });
  const amplitude = Math.round((options.amplitude ?? 0.2) * 32_767);
  // Two deterministic tones: the fundamental comes from the text hash.
  const freqA = 180 + (parseInt(seed.slice(0, 4), 16) % 220);
  const freqB = 260 + (parseInt(seed.slice(4, 8), 16) % 260);

  for (let index = 0; index < samples; index += 1) {
    const t = index / sampleRate;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.8 * t); // gentle fade in/out
    const wave = Math.sin(2 * Math.PI * freqA * t) * 0.7 + Math.sin(2 * Math.PI * freqB * t) * 0.3;
    const value = Math.max(-1, Math.min(1, wave * envelope));
    view.setInt16(HEADER_BYTES + index * 2, Math.round(value * amplitude), true);
  }

  return { bytes, durationMs, sampleRate, samples };
}

/** Parse the format/duration back out of a WAV — used by tests and QA checks. */
export function readWavHeader(bytes: Uint8Array): {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly durationMs: number;
} {
  if (bytes.byteLength < HEADER_BYTES) throw new Error("Not a WAV file: too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const wave = String.fromCharCode(...bytes.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Not a WAV file: missing RIFF/WAVE");
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const durationMs = (dataBytes / (sampleRate * channels * (bitsPerSample / 8))) * 1_000;
  return { sampleRate, channels, bitsPerSample, durationMs };
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}
