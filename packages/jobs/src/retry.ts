/**
 * Retry policy: bounded attempts with exponential backoff and a ceiling.
 *
 * The shape is deliberately boring. What matters for this system is that
 * (a) retries are *scheduled* (a persisted `next_attempt_at`, so a retry
 * survives a restart), (b) the delay is derived from the attempt number so a
 * flapping provider is not hammered, and (c) the ceiling is per-stage, so an
 * expensive render can be capped lower than a cheap lookup.
 */
export interface RetryPolicy {
  /** Total attempts allowed, including the first (>= 1). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  /**
   * Fraction of the delay applied as random jitter (0–1). Jitter keeps
   * several workers from retrying into the same quota window simultaneously.
   */
  readonly jitter?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  factor: 2,
  maxDelayMs: 300_000,
  jitter: 0.2,
};

export function resolveRetryPolicy(
  overrides: Partial<RetryPolicy> | undefined,
  fallbackMaxAttempts: number,
): RetryPolicy {
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: Math.max(1, Math.floor(fallbackMaxAttempts)),
    ...overrides,
  };
  if (!Number.isFinite(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypeError("RetryPolicy.maxAttempts must be >= 1");
  }
  if (policy.baseDelayMs < 0 || policy.maxDelayMs < 0 || policy.factor < 1) {
    throw new TypeError("RetryPolicy delays must be >= 0 and factor >= 1");
  }
  return policy;
}

/** Deterministic-with-jitter delay for the given 1-based attempt. */
export function computeBackoffMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(policy.baseDelayMs * policy.factor ** exponent, policy.maxDelayMs);
  const jitter = policy.jitter ?? 0;
  if (jitter <= 0) return Math.round(raw);
  const spread = raw * jitter;
  return Math.round(Math.max(0, raw - spread + random() * spread * 2));
}

/**
 * Decide what happens after a stage failure. `attemptsUsed` counts the attempt
 * that just failed (1 = first try).
 */
export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly nextAttempt: number }
  | { readonly retry: false; readonly reason: "exhausted" | "permanent" };

export function decideRetry(input: {
  policy: RetryPolicy;
  attemptsUsed: number;
  kind: "retryable" | "permanent";
  random?: () => number;
}): RetryDecision {
  if (input.kind === "permanent") return { retry: false, reason: "permanent" };
  if (input.attemptsUsed >= input.policy.maxAttempts) return { retry: false, reason: "exhausted" };
  return {
    retry: true,
    delayMs: computeBackoffMs(input.policy, input.attemptsUsed, input.random),
    nextAttempt: input.attemptsUsed + 1,
  };
}
