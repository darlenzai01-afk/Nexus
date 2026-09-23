import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileProviderCache,
  MemoryProviderCache,
  NullProviderCache,
  decodeJson,
  encodeJson,
  providerCacheKey,
} from "./cache.js";
import { FixedClock } from "./clock.js";
import {
  canonicalize,
  hashInputs,
  redactSecrets,
  sha256Hex,
  slug,
  truncate,
  withDeadline,
} from "./util.js";

describe("canonicalization and hashing", () => {
  it("is order-insensitive for object keys (one cache entry, not two)", () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
    expect(hashInputs({ b: 2, a: 1 })).toBe(hashInputs({ a: 1, b: 2 }));
  });

  it("distinguishes genuinely different inputs", () => {
    expect(hashInputs({ prompt: "a" })).not.toBe(hashInputs({ prompt: "b" }));
    expect(hashInputs({ a: [1, 2] })).not.toBe(hashInputs({ a: [2, 1] }));
  });

  it("drops undefined but keeps null distinct from missing", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(hashInputs({ a: null })).not.toBe(hashInputs({}));
  });

  it("normalises non-finite numbers and dates deterministically", () => {
    expect(canonicalize({ n: Number.NaN })).toBe('{"n":"NaN"}');
    expect(canonicalize({ when: new Date(0) })).toBe('{"when":"1970-01-01T00:00:00.000Z"}');
  });

  it("produces 64-char lowercase hex for providers to log", () => {
    expect(sha256Hex("nexus")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("nexus")).toBe(sha256Hex("nexus"));
  });

  it("builds cache keys bound to provider, operation and inputs", () => {
    const base = { provider: "fake", operation: "llm.chat", inputs: { prompt: "hi" } };
    expect(providerCacheKey(base)).toBe(providerCacheKey({ ...base, operation: "llm.chat" }));
    expect(providerCacheKey(base)).not.toBe(providerCacheKey({ ...base, provider: "other" }));
    expect(providerCacheKey(base)).not.toBe(
      providerCacheKey({ ...base, operation: "tts.synthesize" }),
    );
    expect(providerCacheKey(base)).not.toBe(
      providerCacheKey({ ...base, inputs: { prompt: "ho" } }),
    );
  });
});

describe("secret redaction (AD-12)", () => {
  it("scrubs bearer tokens, key shapes and key-value pairs", () => {
    const text = [
      "Authorization: Bearer abcdef1234567890",
      "using sk-proj-abcdefghijklmnop",
      '{"api_key":"super-secret-value"}',
      "AIzaSyA1234567890abcdefghijklmnopq",
    ].join("\n");
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("abcdef1234567890");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnop");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("AIzaSyA1234567890abcdefghijklmnopq");
    expect(redacted).toContain("[redacted]");
  });

  it("leaves harmless text alone", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(redactSecrets(text)).toBe(text);
  });

  it("truncates long text with an ellipsis, and slugs queries", () => {
    expect(truncate("abcdefghij", 4)).toBe("abcd…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(slug("Why the Sky is Blue?")).toBe("why-the-sky-is-blue");
    expect(slug("!!!")).toBe("item");
  });
});

describe("withDeadline", () => {
  it("aborts when the deadline passes and reports it", async () => {
    const deadline = withDeadline(10);
    expect(deadline.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(true);
    deadline.dispose();
  });

  it("aborts as soon as the outer signal does, without claiming a timeout", async () => {
    const outer = new AbortController();
    const deadline = withDeadline(5_000, outer.signal);
    outer.abort(new Error("worker shutting down"));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(false);
    deadline.dispose();
  });

  it("propagates an already-aborted outer signal", () => {
    const outer = new AbortController();
    outer.abort();
    const deadline = withDeadline(1_000, outer.signal);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it("stops the timer on dispose (no leak into the next call)", async () => {
    const deadline = withDeadline(5);
    deadline.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deadline.signal.aborted).toBe(false);
  });
});

describe("FixedClock", () => {
  it("only moves when told to", () => {
    const clock = new FixedClock("2024-03-01T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2024-03-01T00:00:00.000Z");
    clock.advance(3_600_000);
    expect(clock.nowIso()).toBe("2024-03-01T01:00:00.000Z");
    clock.set("2024-04-01T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2024-04-01T00:00:00.000Z");
  });
});

describe("provider caches", () => {
  it("round-trips JSON values in memory and on disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-cache-"));
    try {
      for (const cache of [new MemoryProviderCache(), new FileProviderCache(dir)]) {
        const key = providerCacheKey({ provider: "fake", operation: "llm.chat", inputs: { p: 1 } });
        expect(await cache.get(key)).toBeUndefined();
        await cache.set(key, encodeJson({ answer: 42 }));
        const hit = await cache.get(key);
        expect(hit).toBeDefined();
        expect(decodeJson(hit!)).toEqual({ answer: 42 });
      }
      const fileCache = new FileProviderCache(dir);
      const key = providerCacheKey({ provider: "fake", operation: "llm.chat", inputs: { p: 1 } });
      expect(fileCache.pathFor(key)).toContain(dir);
      // A second instance reads the same durable entry (cache survives restart).
      expect(await new FileProviderCache(dir).get(key)).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NullProviderCache is a miss every time and swallows writes", async () => {
    const cache = new NullProviderCache();
    await cache.set("k", encodeJson({ a: 1 }));
    expect(await cache.get("k")).toBeUndefined();
  });
});
