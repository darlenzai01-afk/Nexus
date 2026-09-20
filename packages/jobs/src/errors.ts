import type { ErrorKind } from "@nexus/db";

/**
 * Error taxonomy for stages. The distinction is the operator's, not the
 * stack trace's: a `RetryableError` is worth another attempt (rate limit,
 * network blip, provider 5xx), a `PermanentError` is not (invalid input,
 * missing artifact, bad configuration). Anything unrecognised is treated as
 * retryable-but-bounded: the job retries up to its ceiling, then fails
 * `exhausted`, so a bug cannot silently burn a quota forever.
 */
export class RetryableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "RetryableError";
  }
}

export class PermanentError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "PermanentError";
  }
}

/**
 * Thrown when the *orchestration wiring itself* is wrong (unknown pipeline,
 * missing task handler, artifact not registered). These are programming
 * errors: they fail the stage immediately and are never retried, because
 * retrying cannot fix them.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** A requested state transition the machine forbids. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly subject: string,
    readonly from: string,
    readonly to: string,
    allowed: readonly string[],
  ) {
    super(
      `Invalid ${subject} transition ${from} → ${to}. Allowed from ${from}: ` +
        `${allowed.length > 0 ? allowed.join(", ") : "(terminal state)"}`,
    );
    this.name = "InvalidTransitionError";
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Classify a thrown error into the persisted `error_kind` vocabulary. */
export function classifyError(error: unknown): Extract<ErrorKind, "permanent" | "retryable"> {
  if (error instanceof PermanentError || error instanceof ConfigurationError) return "permanent";
  if (error instanceof RetryableError) return "retryable";
  // Unknown errors: retry, but the attempt ceiling bounds the damage.
  return "retryable";
}
