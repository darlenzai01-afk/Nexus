import { describe, expect, it } from "vitest";

import { canonicalize, hashInputs, stageFingerprint } from "./fingerprint.js";
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  decideRetry,
  resolveRetryPolicy,
} from "./retry.js";

describe("fingerprints", () => {
  it("canonicalizes objects by sorted key, dropping undefined", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize([1, "two", null, true])).toBe('[1,"two",null,true]');
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(undefined)).toBe("null");
  });

  it("keeps array order significant (outline order matters)", () => {
    expect(hashInputs(["a", "b"])).not.toBe(hashInputs(["b", "a"]));
    expect(hashInputs(["a", "b"])).toBe(hashInputs(["a", "b"]));
  });

  it("refuses values it cannot fingerprint deterministically", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(() => 1)).toThrow(/type function/);
  });

  it("is stable across key insertion order and across processes (hash value pinned)", () => {
    expect(hashInputs({ a: 1, b: [2, 3] })).toBe(hashInputs({ b: [2, 3], a: 1 }));
    // Pinned so a change to canonicalization is a deliberate, visible change.
    expect(hashInputs({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });
});

describe("stage fingerprints", () => {
  const base = {
    pipeline: "longform_v1",
    stageKey: "script",
    inputs: { topic: "Sky", outline: ["intro"] },
    config: { llm: "fake" },
  };

  it("is identical for identical work and differs when content differs", () => {
    expect(stageFingerprint(base)).toBe(stageFingerprint({ ...base }));
    expect(stageFingerprint(base)).not.toBe(stageFingerprint({ ...base, stageKey: "voice" }));
    expect(stageFingerprint(base)).not.toBe(stageFingerprint({ ...base, pipeline: "longform_v2" }));
    expect(stageFingerprint(base)).not.toBe(
      stageFingerprint({ ...base, inputs: { topic: "Grass", outline: ["intro"] } }),
    );
  });

  it("changes when cache-affecting configuration changes (provider swap)", () => {
    expect(stageFingerprint(base)).not.toBe(
      stageFingerprint({ ...base, config: { llm: "groq/llama-3.1-8b" } }),
    );
  });

  it("ignores nothing that affects output — upstream outputs are inputs", () => {
    const withUpstream = {
      ...base,
      inputs: { ...base.inputs, upstream: { research: { sources: 3 } } },
    };
    expect(stageFingerprint(base)).not.toBe(stageFingerprint(withUpstream));
  });
});

describe("retry policy", () => {
  it("backs off exponentially with a ceiling and no jitter by default in tests", () => {
    const policy = {
      ...DEFAULT_RETRY_POLICY,
      baseDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 8_000,
      jitter: 0,
    };
    expect(computeBackoffMs(policy, 1)).toBe(1_000);
    expect(computeBackoffMs(policy, 2)).toBe(2_000);
    expect(computeBackoffMs(policy, 3)).toBe(4_000);
    expect(computeBackoffMs(policy, 9)).toBe(8_000); // capped
  });

  it("applies bounded jitter", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1_000, factor: 1, jitter: 0.5 };
    expect(computeBackoffMs(policy, 1, () => 0)).toBe(500);
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(1_500);
    expect(computeBackoffMs(policy, 1, () => 0.5)).toBe(1_000);
  });

  it("retries retryable failures until the ceiling, then stops", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, baseDelayMs: 10, jitter: 0 };
    expect(decideRetry({ policy, attemptsUsed: 1, kind: "retryable" })).toMatchObject({
      retry: true,
      nextAttempt: 2,
    });
    expect(decideRetry({ policy, attemptsUsed: 2, kind: "retryable" })).toMatchObject({
      retry: true,
      nextAttempt: 3,
    });
    expect(decideRetry({ policy, attemptsUsed: 3, kind: "retryable" })).toEqual({
      retry: false,
      reason: "exhausted",
    });
  });

  it("never retries a permanent failure", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 };
    expect(decideRetry({ policy, attemptsUsed: 1, kind: "permanent" })).toEqual({
      retry: false,
      reason: "permanent",
    });
  });

  it("derives the ceiling from the job when the stage has no override, and validates input", () => {
    expect(resolveRetryPolicy(undefined, 7).maxAttempts).toBe(7);
    expect(resolveRetryPolicy({ maxAttempts: 2 }, 7).maxAttempts).toBe(2);
    expect(() => resolveRetryPolicy({ maxAttempts: 0 }, 3)).toThrow(/maxAttempts/);
    expect(() => resolveRetryPolicy({ factor: 0.5 }, 3)).toThrow(/factor/);
  });
});
