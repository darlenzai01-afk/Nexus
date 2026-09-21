import { describe, expect, it } from "vitest";

import {
  ManualRequiredError,
  ProviderAuthError,
  ProviderConfigurationError,
  ProviderContentError,
  ProviderError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  classifyProviderError,
  isManualRequired,
  isProviderError,
  kindForStatus,
  parseRetryAfterMs,
} from "./errors.js";
import { toJobError } from "./jobs-bridge.js";
import { PermanentError, RetryableError } from "@nexus/jobs";

describe("provider error taxonomy", () => {
  it("defaults retryability per kind: transport failures retry, policy failures do not", () => {
    expect(new ProviderTimeoutError("slow").retryable).toBe(true);
    expect(new ProviderRateLimitError("429").retryable).toBe(true);
    expect(new ProviderAuthError("bad key").retryable).toBe(false);
    expect(new ProviderConfigurationError("misconfigured").retryable).toBe(false);
    // Quota is fail-closed: retrying inside the same window cannot help.
    expect(new ProviderQuotaError("window exhausted").retryable).toBe(false);
    // Content errors may be fixed by a fresh sample, so they are retryable.
    expect(new ProviderContentError("invalid JSON").retryable).toBe(true);
  });

  it("carries provider, operation, status and a one-line summary", () => {
    const error = new ProviderError("upstream said no", {
      kind: "rate_limit",
      provider: "openai-compatible",
      operation: "llm.chat",
      status: 429,
      retryAfterMs: 2_000,
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.summary()).toBe(
      "[rate_limit] openai-compatible.llm.chat: upstream said no, retry in 2000ms",
    );
    expect(error.status).toBe(429);
  });

  it("maps HTTP statuses to the policy-relevant kind", () => {
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(403)).toBe("auth");
    expect(kindForStatus(404)).toBe("invalid_request");
    expect(kindForStatus(408)).toBe("timeout");
    expect(kindForStatus(429)).toBe("rate_limit");
    expect(kindForStatus(500)).toBe("unavailable");
    expect(kindForStatus(503)).toBe("unavailable");
    expect(kindForStatus(422)).toBe("invalid_request");
  });

  it("parses Retry-After in both delta-seconds and HTTP-date form", () => {
    const now = Date.parse("2024-01-01T00:00:00.000Z");
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs("Mon, 01 Jan 2024 00:00:45 GMT", now)).toBe(45_000);
    // A date in the past means "retry now", never a negative sleep.
    expect(parseRetryAfterMs("Mon, 01 Jan 2024 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
    expect(parseRetryAfterMs("  ")).toBeUndefined();
  });

  it("wraps unknown errors as retryable-unavailable (bounded by the attempt ceiling)", () => {
    const wrapped = classifyProviderError(new Error("boom"), { provider: "x", operation: "y" });
    expect(wrapped.kind).toBe("unavailable");
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.provider).toBe("x");
    expect(wrapped.message).toBe("boom");
  });

  it("recognises transient network codes and cancellations", () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(classifyProviderError(reset).kind).toBe("unavailable");
    expect(classifyProviderError(reset).retryable).toBe(true);

    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyProviderError(aborted).kind).toBe("canceled");
    expect(classifyProviderError(aborted).retryable).toBe(false);
  });

  it("passes an existing ProviderError through untouched", () => {
    const original = new ProviderAuthError("nope", { provider: "p" });
    expect(classifyProviderError(original)).toBe(original);
  });

  it("represents a manual hand-off with operator instructions", () => {
    const error = new ManualRequiredError({
      capability: "research",
      operation: "research.search",
      summary: "no search provider",
      instructions: ["paste sources"],
      expectedFormat: "URLs",
    });
    expect(isManualRequired(error)).toBe(true);
    expect(error.kind).toBe("manual");
    expect(error.retryable).toBe(false);
    expect(error.request.instructions).toEqual(["paste sources"]);
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(new Error("x"))).toBe(false);
  });
});

describe("jobs bridge", () => {
  it("translates provider retryability into the runner's error vocabulary", () => {
    expect(toJobError(new ProviderTimeoutError("slow"))).toBeInstanceOf(RetryableError);
    expect(toJobError(new ProviderRateLimitError("429"))).toBeInstanceOf(RetryableError);
    expect(toJobError(new ProviderAuthError("bad key"))).toBeInstanceOf(PermanentError);
    expect(toJobError(new ProviderQuotaError("no budget"))).toBeInstanceOf(PermanentError);
  });

  it("treats an escaped manual hand-off as permanent (a human is not a retry)", () => {
    const escaped = new ManualRequiredError({
      capability: "tts",
      operation: "tts.synthesize",
      summary: "record it",
      instructions: [],
    });
    expect(toJobError(escaped)).toBeInstanceOf(PermanentError);
  });

  it("leaves non-provider errors alone so the runner classifies them", () => {
    const plain = new Error("someone else's problem");
    expect(toJobError(plain)).toBe(plain);
    const already = new RetryableError("stage retry");
    expect(toJobError(already)).toBe(already);
  });

  it("keeps the original error as the cause for triage", () => {
    const source = new ProviderAuthError("bad key", { provider: "openai-compatible" });
    const bridged = toJobError(source) as PermanentError;
    expect(bridged.cause).toBe(source);
    expect(bridged.message).toContain("bad key");
  });
});
