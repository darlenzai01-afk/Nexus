import type { AudioTrack } from "@nexus/audio";

import type { FFmpegRunner } from "./ffmpeg.js";

/**
 * Assembling the narration track.
 *
 * Phase 10 leaves the voice as **one clip per scene** plus a timing document —
 * the shape that makes re-voicing and reuse cheap — and a video needs one
 * continuous audio stream. This module does that assembly in code, not in a
 * filter graph, because it is arithmetic: place each clip at its recorded start
 * time, in a silent buffer the length of the video.
 *
 * That choice buys three things: the result is deterministic sample for sample,
 * it needs no decoder for the clips the pipeline itself produced (PCM WAV), and a
 * missing or unusable clip is a *reported* gap rather than a shifted soundtrack —
 * a scene with no audio keeps its silence exactly where the scene is.
 */

export interface WavData {
  readonly sampleRate: number;
  readonly channels: number;
  /** Interleaved samples, −1…1, `frames * channels` long. */
  readonly samples: Float32Array;
  readonly frames: number;
  readonly durationSec: number;
}

export interface NarrationClip {
  readonly hash: string;
  readonly startSec: number;
  /** What the clip is, for the log: a scene id, an operator's file, … */
  readonly label: string;
}

export interface AudioAssemblyOptions {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  /** Length of the video; the track is padded or trimmed to exactly this. */
  readonly durationSec: number;
}

export interface AudioAssemblyResult {
  readonly wav: WavData;
  readonly clips: number;
  readonly skipped: readonly string[];
  readonly placements: readonly {
    readonly label: string;
    readonly hash: string;
    readonly startSec: number;
    readonly durationSec: number;
  }[];
}

/**
 * Place every readable clip on a silent timeline.
 *
 * A clip that cannot be read is skipped and named; one that runs past the end of
 * the video is trimmed, because a longer soundtrack would stretch the container's
 * duration past the frames.
 */
export function assembleNarration(
  clips: readonly NarrationClip[],
  read: (hash: string) => Uint8Array,
  options: AudioAssemblyOptions,
): AudioAssemblyResult {
  const frames = Math.max(1, Math.round(options.durationSec * options.sampleRate));
  const samples = new Float32Array(frames * options.channels);
  const skipped: string[] = [];
  const placements: { label: string; hash: string; startSec: number; durationSec: number }[] = [];
  let placed = 0;

  for (const clip of [...clips].sort((left, right) => left.startSec - right.startSec)) {
    let decoded: WavData;
    try {
      decoded = decodeWav(read(clip.hash));
    } catch (error) {
      skipped.push(`${clip.label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const startFrame = Math.round(clip.startSec * options.sampleRate);
    if (startFrame >= frames) {
      skipped.push(`${clip.label}: starts at ${clip.startSec}s, past the end of the video`);
      continue;
    }
    place(samples, frames, options, decoded, startFrame);
    placements.push({
      label: clip.label,
      hash: clip.hash,
      startSec: clip.startSec,
      durationSec: decoded.durationSec,
    });
    placed += 1;
  }

  return {
    wav: { ...options, samples, frames, durationSec: frames / options.sampleRate },
    clips: placed,
    skipped,
    placements,
  };
}

function place(
  target: Float32Array,
  frames: number,
  options: AudioAssemblyOptions,
  source: WavData,
  startFrame: number,
): void {
  const step = source.sampleRate / options.sampleRate;
  for (let frame = 0; frame < frames - startFrame; frame += 1) {
    const position = frame * step;
    const index = Math.floor(position);
    if (index >= source.frames) break;
    const next = Math.min(source.frames - 1, index + 1);
    const mix = position - index;
    for (let channel = 0; channel < options.channels; channel += 1) {
      const sourceChannel = source.channels === 1 ? 0 : Math.min(channel, source.channels - 1);
      const a = source.samples[index * source.channels + sourceChannel] ?? 0;
      const b = source.samples[next * source.channels + sourceChannel] ?? 0;
      const value = a + (b - a) * mix;
      const targetIndex = (startFrame + frame) * options.channels + channel;
      // Clips never overlap by construction (one per scene, in order), so the
      // placement is a write; summing would be needed only for an overlay.
      target[targetIndex] = clampSample((target[targetIndex] ?? 0) + value);
    }
  }
}

function clampSample(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Decode the PCM WAV forms the voice stage produces. */
export function decodeWav(bytes: Uint8Array): WavData {
  if (bytes.byteLength < 44) throw new TypeError("the file is too short to be a WAV");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new TypeError("the file is not a RIFF/WAVE container (an MP3 clip needs transcoding)");
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; encoding: number } | undefined;
  let data: Uint8Array | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === "data") {
      data = bytes.subarray(start, Math.min(start + size, bytes.byteLength));
    }
    offset = start + size + (size % 2);
  }
  if (format === undefined) throw new TypeError("the WAV has no fmt chunk");
  if (data === undefined) throw new TypeError("the WAV has no data chunk");
  if (format.encoding !== 1) {
    throw new TypeError(`the WAV is not PCM (format ${format.encoding})`);
  }
  if (format.bits !== 16) {
    throw new TypeError(`only 16-bit PCM is supported, got ${format.bits}-bit`);
  }
  const frameBytes = format.channels * 2;
  const frames = Math.floor(data.byteLength / frameBytes);
  const samples = new Float32Array(frames * format.channels);
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < frames * format.channels; index += 1) {
    samples[index] = dataView.getInt16(index * 2, true) / 32_768;
  }
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    samples,
    frames,
    durationSec: format.sampleRate === 0 ? 0 : frames / format.sampleRate,
  };
}

export function encodeWav(wav: WavData): Uint8Array {
  const dataBytes = wav.samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, wav.channels, true);
  view.setUint32(24, wav.sampleRate, true);
  view.setUint32(28, wav.sampleRate * wav.channels * 2, true);
  view.setUint16(32, wav.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < wav.samples.length; index += 1) {
    const value = clampSample(wav.samples[index] ?? 0);
    view.setInt16(44 + index * 2, Math.round(value * 32_767), true);
  }
  return bytes;
}

/** Peak absolute sample value: a silent track is a reportable fact. */
export function peakOf(wav: WavData): number {
  let peak = 0;
  for (const sample of wav.samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/**
 * Every clip the voice track names, with the moment it starts.
 *
 * The track's segments already carry their start times; an operator's clip is a
 * segment like any other, so nothing here needs to know where a voice came from.
 */
export function narrationClips(track: AudioTrack): NarrationClip[] {
  return track.segments.map((segment) => ({
    hash: segment.audio.hash,
    startSec: segment.startSec,
    label: `${segment.sceneId}/${segment.id}`,
  }));
}

export interface Loudness {
  readonly inputI: number;
  readonly inputTp: number;
  readonly inputLra: number;
  readonly targetI?: number;
}

/** Measure EBU R128 loudness with FFmpeg's own analyser (`loudnorm`). */
export function measureLoudness(runner: FFmpegRunner, wavFile: string): Loudness | undefined {
  const result = runner.run({
    label: "measure loudness",
    args: [
      "-hide_banner",
      "-nostdin",
      "-i",
      wavFile,
      "-af",
      "loudnorm=print_format=json",
      "-f",
      "null",
      "-",
    ],
  });
  const match = /\{[\s\S]*\}/u.exec(result.stderr.slice(result.stderr.lastIndexOf("{")));
  if (match === null) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, string>;
    const inputI = Number(parsed.input_i);
    const inputTp = Number(parsed.input_tp);
    const inputLra = Number(parsed.input_lra);
    if (![inputI, inputTp, inputLra].every((value) => Number.isFinite(value))) return undefined;
    return { inputI, inputTp, inputLra };
  } catch {
    return undefined;
  }
}

/** The audio filter chain the mux step applies, when normalisation is on. */
export function audioFilters(normalize: boolean): string | undefined {
  return normalize ? "loudnorm=I=-16:TP=-1.5:LRA=11" : undefined;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}
