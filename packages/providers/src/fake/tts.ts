import type { InvokeRuntime } from "../runtime.js";
import { synthesizeWav } from "./wav.js";
import type { CallContext, ProviderResult } from "../types.js";
import type { SynthesisRequest, SynthesisResult, TTSProvider, VoiceProfile } from "../tts.js";
import { distributeWordTimings } from "../tts.js";

/**
 * Deterministic offline TTS.
 *
 * It writes a real, playable WAV (derived from a hash of the text and voice)
 * into the CAS, so everything downstream — duration math, caption cueing,
 * loudness checks, muxing — is exercised for real without a voice account.
 * Identical input produces identical bytes, hence an identical CAS hash, hence
 * a free cache hit on every re-run.
 */
export const FAKE_VOICES: readonly VoiceProfile[] = [
  { id: "fake-narrator", label: "Fake Narrator", language: "en", gender: "neutral" },
  { id: "fake-warm", label: "Fake Warm", language: "en", gender: "feminine" },
  { id: "fake-deep", label: "Fake Deep", language: "en", gender: "masculine" },
];

export const DEFAULT_FAKE_VOICE = FAKE_VOICES[0]!;

export interface FakeTTSOptions {
  readonly id?: string;
  /** Milliseconds per word — drives the synthetic duration. */
  readonly msPerWord?: number;
  /** Omit word timings to simulate a provider that returns none. */
  readonly withTimings?: boolean;
}

export class FakeTTSProvider implements TTSProvider {
  readonly id: string;
  readonly kind = "tts" as const;
  readonly mode = "fake" as const;
  readonly label = "Fake TTS (deterministic WAV, offline)";

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: FakeTTSOptions = {},
  ) {
    this.id = options.id ?? "fake";
  }

  voices(): readonly VoiceProfile[] {
    return FAKE_VOICES;
  }

  async synthesize(
    request: SynthesisRequest,
    ctx?: CallContext,
  ): Promise<ProviderResult<SynthesisResult>> {
    const voice = request.voice ?? DEFAULT_FAKE_VOICE;
    const sampleRate = request.sampleRate ?? 8_000;
    const words = request.text.split(/\s+/).filter((word) => word.length > 0);
    const durationMs = Math.max(200, words.length * (this.options.msPerWord ?? 320));

    return this.runtime.invoke<SynthesisResult>({
      operation: "tts.synthesize",
      ...(ctx !== undefined ? { context: ctx } : {}),
      cache: {
        inputs: {
          text: request.text,
          voice: voice.id,
          language: voice.language,
          format: request.format ?? "wav",
          sampleRate,
          rate: request.rate ?? null,
        },
        toJson: (value) => value,
        // Cached values carry their CAS hash, so a hit still points at real bytes.
        fromJson: (json) => json as SynthesisResult,
      },
      usage: (value) => ({ units: value.characters, unit: "characters" }),
      execute: async () => {
        const wav = synthesizeWav({
          text: request.text,
          voiceId: voice.id,
          sampleRate,
          durationMs,
        });
        const stored = this.runtime.storage.put(wav.bytes);
        const result: SynthesisResult = {
          audio: {
            hash: stored.hash,
            bytes: stored.bytes,
            mime: "audio/wav",
            durationMs,
          },
          ...(this.options.withTimings === false
            ? {}
            : { wordTimings: distributeWordTimings(request.text, durationMs) }),
          characters: request.text.length,
        };
        return result;
      },
    });
  }
}
