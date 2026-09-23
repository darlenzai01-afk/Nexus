import type { Repo } from "@nexus/db";
import { computeBackoffMs } from "@nexus/jobs";

import type { ProviderCache } from "./cache.js";
import { decodeJson, encodeJson, providerCacheKey } from "./cache.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { ProviderError } from "./errors.js";
import {
  ProviderCanceledError,
  ProviderConfigurationError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  classifyProviderError,
} from "./errors.js";
import type { BudgetGuard } from "./quota.js";
import type { RateLimiter } from "./ratelimit.js";
import { unlimitedRateLimiter } from "./ratelimit.js";
import type {
  CallContext,
  ProviderKind,
  ProviderLogger,
  ProviderPolicy,
  ProviderResult,
  Usage,
} from "./types.js";
import { silentProviderLogger } from "./types.js";
import { redactSecrets, truncate, withDeadline } from "./util.js";

/**
 * The one place every provider call goes through.
 *
 * Adapters implement *transport only*: send a request, return a value, throw
 * when the provider refuses. Everything that the operator depends on — the
 * deadline, the retry decision, the quota check, metering, the cache, the
 * structured envelope — happens here, once, identically for fakes, manual
 * fallbacks and real APIs. That is what makes "swap the provider" a config
 * change instead of a rewrite.
 */
export interface InvokeSpec<T> {
  readonly operation: string;
  readonly context?: CallContext;
  /**
   * When present the call is cacheable. `inputs` must contain everything that
   * changes the answer (prompt, model, voice, url, …) and nothing else.
   */
  readonly cache?: {
    readonly inputs: unknown;
    readonly toJson: (value: T) => unknown;
    readonly fromJson: (json: unknown) => T;
  };
  /** What the call consumed, derived from its own result. */
  readonly usage: (value: T) => Usage;
  /** Perform the call. Receives the composed deadline signal. */
  readonly execute: (signal: AbortSignal, attempt: number) => Promise<T>;
  /** Escape hatch for a different quota scope than the adapter default. */
  readonly accountScope?: string;
}

export interface InvokeDeps {
  readonly adapterId: string;
  readonly kind: ProviderKind;
  readonly policy: ProviderPolicy;
  readonly budget: BudgetGuard;
  readonly repo?: Repo;
  readonly cache?: ProviderCache;
  readonly logger?: ProviderLogger;
  readonly clock?: Clock;
  readonly limiter?: RateLimiter;
  /** Injectable sleep: tests record the delays without waiting for them. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  /** Scrubber for provider text (the container passes one that knows the key). */
  readonly redact?: (text: string) => string;
}

export async function invoke<T>(deps: InvokeDeps, spec: InvokeSpec<T>): Promise<ProviderResult<T>> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? silentProviderLogger;
  const limiter = deps.limiter ?? unlimitedRateLimiter;
  const startedMs = clock.now().getTime();
  const context = spec.context ?? {};
  const accountScope = spec.accountScope ?? "*";

  // ── Budget: fail closed, degrade early (AD-13) ─────────────────────────
  const decision = deps.budget.evaluate(deps.adapterId, accountScope);
  if (!decision.allowed) {
    const message = decision.reason ?? `provider '${deps.adapterId}' is not allowed to run`;
    logger({
      level: "warn",
      event: "provider.quota.blocked",
      provider: deps.adapterId,
      operation: spec.operation,
      reason: message,
    });
    if (decision.retryAfterMs !== undefined) {
      throw new ProviderRateLimitError(message, {
        provider: deps.adapterId,
        operation: spec.operation,
        retryAfterMs: decision.retryAfterMs,
      });
    }
    if (decision.account && decision.account.enabled !== 1) {
      throw new ProviderConfigurationError(message, {
        provider: deps.adapterId,
        operation: spec.operation,
      });
    }
    throw new ProviderQuotaError(message, {
      provider: deps.adapterId,
      operation: spec.operation,
      details: { usedRatio: decision.usedRatio, remaining: decision.remaining },
    });
  }

  const cacheKey =
    spec.cache !== undefined
      ? providerCacheKey({
          provider: deps.adapterId,
          operation: spec.operation,
          inputs: spec.cache.inputs,
        })
      : undefined;

  // ── Cache: a hit costs nothing and is logged as such ───────────────────
  if (cacheKey !== undefined && deps.cache !== undefined && deps.policy.cacheEnabled) {
    const bytes = await deps.cache.get(cacheKey);
    if (bytes !== undefined) {
      try {
        const value = spec.cache!.fromJson(decodeJson(bytes));
        const result: ProviderResult<T> = {
          value,
          provider: deps.adapterId,
          operation: spec.operation,
          cached: true,
          attempts: 0,
          durationMs: Math.max(0, clock.now().getTime() - startedMs),
          usage: { units: 0, unit: spec.usage(value).unit },
        };
        logger({
          level: "debug",
          event: "provider.call.cached",
          provider: deps.adapterId,
          operation: spec.operation,
          cacheKey,
        });
        logCall(deps, { spec, accountScope, cacheKey, result });
        return result;
      } catch {
        // Corrupt/undecodable entry: ignore it and do the real call.
        logger({
          level: "warn",
          event: "provider.cache.corrupt",
          provider: deps.adapterId,
          operation: spec.operation,
          cacheKey,
        });
      }
    }
  }

  const timeoutMs = context.timeoutMs ?? deps.policy.timeoutMs;
  let attempt = 0;
  let lastError: ProviderError | undefined;

  while (attempt < deps.policy.maxAttempts) {
    attempt += 1;

    // Self-imposed rate limit: wait for a permit inside the deadline.
    if (deps.policy.rateLimitPerMinute > 0 && !limiter.tryAcquire()) {
      const waitMs = Math.min(limiter.msUntilAvailable(), timeoutMs);
      logger({
        level: "debug",
        event: "provider.rate_limit.wait",
        provider: deps.adapterId,
        operation: spec.operation,
        waitMs,
      });
      await (deps.sleep ?? defaultSleep)(waitMs, context.signal);
      if (!limiter.tryAcquire()) {
        throw new ProviderRateLimitError(
          `local rate limit for '${deps.adapterId}' (${deps.policy.rateLimitPerMinute}/min) is saturated`,
          { provider: deps.adapterId, operation: spec.operation, retryAfterMs: waitMs },
        );
      }
    }

    const deadline = withDeadline(timeoutMs, context.signal);
    try {
      const value = await spec.execute(deadline.signal, attempt);
      const usage = spec.usage(value);
      const result: ProviderResult<T> = {
        value,
        provider: deps.adapterId,
        operation: spec.operation,
        cached: false,
        attempts: attempt,
        durationMs: Math.max(0, clock.now().getTime() - startedMs),
        usage,
      };

      if (cacheKey !== undefined && deps.cache !== undefined && deps.policy.cacheEnabled) {
        await deps.cache.set(cacheKey, encodeJson(spec.cache!.toJson(value)));
      }
      deps.budget.record(deps.adapterId, usage.units, accountScope);
      logCall(deps, { spec, accountScope, cacheKey, result });
      logger({
        level: "debug",
        event: "provider.call.ok",
        provider: deps.adapterId,
        operation: spec.operation,
        attempts: attempt,
        units: usage.units,
        unit: usage.unit,
        durationMs: result.durationMs,
      });
      return result;
    } catch (thrown) {
      const error = normalize(thrown, deps, spec, deadline.timedOut(), context.signal);
      // Every attempt is visible: a flaky provider must be diagnosable from
      // the call log, not just guessable from stage retries.
      logCall(deps, { spec, accountScope, cacheKey, error });

      if (!error.retryable || attempt >= deps.policy.maxAttempts) {
        lastError = error;
        logger({
          level: error.kind === "canceled" ? "info" : "error",
          event: "provider.call.error",
          provider: deps.adapterId,
          operation: spec.operation,
          attempt,
          kind: error.kind,
          error: safeSummary(deps, error),
        });
        break;
      }

      const delayMs = error.retryAfterMs ?? computeBackoffMs(deps.policy, attempt, deps.random);
      logger({
        level: "warn",
        event: "provider.call.retry",
        provider: deps.adapterId,
        operation: spec.operation,
        attempt,
        delayMs,
        kind: error.kind,
        error: safeSummary(deps, error),
      });
      if (delayMs > deps.policy.maxDelayMs) {
        // Too long to sit on: hand the job's own retry scheduler the problem.
        lastError = error;
        break;
      }
      try {
        await (deps.sleep ?? defaultSleep)(delayMs, context.signal);
      } catch {
        lastError = new ProviderCanceledError("canceled while waiting to retry", {
          provider: deps.adapterId,
          operation: spec.operation,
        });
        break;
      }
    } finally {
      deadline.dispose();
    }
  }

  const error =
    lastError ??
    new ProviderCanceledError("provider call ended without a result", {
      provider: deps.adapterId,
      operation: spec.operation,
    });

  if (error.kind === "rate_limit" && error.retryAfterMs !== undefined) {
    deps.budget.cooldown(deps.adapterId, error.retryAfterMs, accountScope);
  }
  throw error;
}

function normalize<T>(
  thrown: unknown,
  deps: InvokeDeps,
  spec: InvokeSpec<T>,
  timedOut: boolean,
  outerSignal: AbortSignal | undefined,
): ProviderError {
  const context = { provider: deps.adapterId, operation: spec.operation };
  // Precedence matters: an operator/worker cancellation must never be reported
  // (or retried) as a slow provider, and our own deadline must never be
  // mistaken for a cancellation.
  if (outerSignal?.aborted) {
    return new ProviderCanceledError("call canceled (worker shutting down)", context);
  }
  if (timedOut) {
    return new ProviderTimeoutError(
      `provider '${deps.adapterId}' did not answer within the deadline (${spec.operation})`,
      { ...context, cause: thrown },
    );
  }
  return classifyProviderError(thrown, context);
}

function logCall<T>(
  deps: InvokeDeps,
  args: {
    spec: InvokeSpec<T>;
    accountScope: string;
    cacheKey: string | undefined;
    result?: ProviderResult<T>;
    error?: ProviderError;
  },
): void {
  if (!deps.repo) return;
  const account = deps.repo.getProviderAccount(deps.adapterId, args.accountScope);
  const usage = args.result?.usage ?? { units: 0, unit: "requests" as const };
  deps.repo.logProviderCall({
    ...(account ? { accountId: account.id } : {}),
    provider: deps.adapterId,
    operation: args.spec.operation,
    units: usage.units,
    durationMs: args.result?.durationMs ?? 0,
    status: args.result ? "ok" : "error",
    // Errors are redacted and truncated: the log is durable and operator-facing.
    ...(args.error !== undefined ? { error: safeSummary(deps, args.error) } : {}),
    ...(args.cacheKey !== undefined ? { cacheKey: args.cacheKey } : {}),
    // The clock that drove the call owns the timestamp; without one, the
    // repository stamps its own.
    ...(deps.clock !== undefined ? { createdAt: deps.clock.nowIso() } : {}),
  });
}

/** Provider text can echo credentials back; scrub before it reaches a log. */
const safeSummary = (deps: InvokeDeps, error: ProviderError): string =>
  truncate((deps.redact ?? redactSecrets)(error.summary()), 400);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      const error = new Error("sleep aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
