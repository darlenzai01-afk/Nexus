import type { CallContext, ProviderMeta, ProviderResult } from "./types.js";

/**
 * Text-to-speech capability.
 *
 * Word timings are optional *at the interface* because provider support varies
 * (some return them, some need whisper as a fallback), but the caller is told
 * explicitly whether they are present — the caption engine must never assume
 * timing quality it did not receive.
 */
export interface VoiceProfile {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly gender?: "feminine" | "masculine" | "neutral";
}

export interface WordTiming {
  readonly word: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SynthesisRequest {
  readonly text: string;
  readonly voice: VoiceProfile;
  readonly format?: "wav" | "mp3";
  readonly sampleRate?: number;
  /** Playback rate multiplier (1 = provider default). */
  readonly rate?: number;
}

/** Reference to audio that is *already stored* in the CAS. */
export interface AudioRef {
  readonly hash: string;
  readonly bytes: number;
  readonly mime: string;
  readonly durationMs: number;
}

export interface SynthesisResult {
  readonly audio: AudioRef;
  readonly wordTimings?: readonly WordTiming[];
  /** Characters billed/consumed — the meter for this capability. */
  readonly characters: number;
}

export interface TTSProvider extends ProviderMeta {
  readonly kind: "tts";
  synthesize(
    request: SynthesisRequest,
    ctx?: CallContext,
  ): Promise<ProviderResult<SynthesisResult>>;
  /** Voices this adapter can offer (used by the dashboard picker). */
  voices(): readonly VoiceProfile[];
}

/**
 * Deterministic word timings for a text of known duration: words are split
 * proportionally to their length, which is exactly what a real provider's
 * timings approximate and what the caption engine needs to be testable.
 */
export function distributeWordTimings(
  text: string,
  durationMs: number,
  minWordMs = 80,
): readonly WordTiming[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0 || durationMs <= 0) return [];
  const totalChars = words.reduce((sum, word) => sum + word.length, 0);
  const timings: WordTiming[] = [];
  let cursor = 0;
  for (const [index, word] of words.entries()) {
    const share = (word.length / totalChars) * durationMs;
    const span =
      index === words.length - 1 ? durationMs - cursor : Math.max(minWordMs, Math.round(share));
    const end = Math.min(durationMs, cursor + span);
    timings.push({ word, startMs: cursor, endMs: end });
    cursor = end;
  }
  return timings;
}
