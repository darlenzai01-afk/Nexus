/**
 * Audio-stage failures.
 *
 * The distinction that matters to the runner is `retryable`: a synthesis call
 * that lost its connection is worth another attempt (and the provider layer may
 * already have retried it), while a track that is missing a scene's audio because
 * the adapter refuses that voice is not — retrying would spend quota to fail
 * again. `toJobError` in `@nexus/providers` translates both into the vocabulary
 * the orchestrator persists.
 */
export type AudioErrorCode =
  /** A segment could not be synthesized, and the tuning says that is fatal. */
  | "provider_failed"
  /** The configured voice is not one the adapter offers. */
  | "voice_unavailable"
  /** The request itself is impossible (an empty manifest, no scenes with audio). */
  | "invalid_input"
  /** The adapter cannot produce the container the casting asks for. */
  | "unsupported_format";

export class AudioError extends Error {
  readonly code: AudioErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      readonly code: AudioErrorCode;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AudioError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export function isAudioError(error: unknown): error is AudioError {
  return error instanceof AudioError;
}

/** `AudioError` → job error vocabulary, without importing the whole bridge. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
