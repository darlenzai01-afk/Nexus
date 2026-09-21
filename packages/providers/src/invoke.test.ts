import { beforeEach, describe, expect, it, vi } from "vitest";

import { Db, Repo, migrate } from "@nexus/db";

import { MemoryProviderCache, providerCacheKey } from "./cache.js";
import { FixedClock } from "./clock.js";
import {
  ProviderAuthError,
  ProviderContentError,
  ProviderError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "./errors.js";
import { invoke } from "./invoke.js";
import { BudgetGuard } from "./quota.js";
import { TokenBucket } from "./ratelimit.js";
import { DEFAULT_PROVIDER_POLICY, RecordingProviderLogger, type ProviderPolicy } from "./types.js";

/**
 * The call pipeline: deadline, retry, cache, metering and quota are tested once
 * here, because every adapter inherits them by going through `invoke`.
 */
describe("invoke pipeline", () => {
  let db: Db;
  let repo: Repo;
  let clock: FixedClock;
  let logger: RecordingProviderLogger;

  const policy = (overrides: Partial<ProviderPolicy> = {}): ProviderPolicy => ({
    ...DEFAULT_PROVIDER_POLICY,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    jitter: 0,
    ...overrides,
  });

  const deps = (overrides: Partial<Parameters<typeof invoke>[0]> = {}) => ({
    adapterId: "fake",
    kind: "llm" as const,
    policy: policy(),
    budget: new BudgetGuard({ repo, clock }),
    repo,
    logger: logger.log,
    clock,
    ...overrides,
  });

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    clock = new FixedClock("2024-05-01T12:00:00.000Z");
    logger = new RecordingProviderLogger();
  });

  const usage = { units: 10, unit: "tokens" as const };

  it("returns a structured envelope and meters the call", async () => {
    const result = await invoke(deps(), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => ({ answer: 42 }),
    });

    expect(result).toMatchObject({
      value: { answer: 42 },
      provider: "fake",
      operation: "llm.chat",
      cached: false,
      attempts: 1,
      usage: { units: 10, unit: "tokens" },
    });
    expect(typeof result.durationMs).toBe("number");

    const calls = repo.listProviderCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "fake",
      operation: "llm.chat",
      units: 10,
      status: "ok",
    });
    expect(logger.events()).toContain("provider.call.ok");
  });

  it("charges usage to the account's quota window", async () => {
    repo.upsertProviderAccount({ adapter: "fake", quotaWindow: "daily", quotaLimit: 100 });
    await invoke(deps(), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => "ok",
    });
    await invoke(deps(), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => "ok",
    });
    expect(repo.getProviderAccount("fake")?.quota_used).toBe(20);
  });

  it("serves a repeat call from cache without executing or charging quota", async () => {
    const cache = new MemoryProviderCache();
    let executions = 0;
    const spec = {
      operation: "llm.chat",
      cache: {
        inputs: { prompt: "hello" },
        toJson: (v: string) => v,
        fromJson: (j: unknown) => j as string,
      },
      usage: () => usage,
      execute: async () => {
        executions += 1;
        return "deterministic answer";
      },
    };

    const first = await invoke(deps({ cache, policy: policy({ cacheEnabled: true }) }), spec);
    const second = await invoke(deps({ cache, policy: policy({ cacheEnabled: true }) }), spec);

    expect(executions).toBe(1);
    expect(first.cached).toBe(false);
    expect(second).toMatchObject({
      cached: true,
      attempts: 0,
      usage: { units: 0, unit: "tokens" },
    });
    expect(second.value).toBe("deterministic answer");

    // Cache hits are logged (units 0) so the dashboard can show the savings.
    const calls = repo.listProviderCalls();
    expect(calls.filter((call) => call.units === 0)).toHaveLength(1);
    const hits = logger.entries.filter((entry) => entry.event === "provider.call.cached");
    expect(hits).toHaveLength(1);
  });

  it("skips the cache entirely when caching is disabled", async () => {
    const cache = new MemoryProviderCache();
    let executions = 0;
    const spec = {
      operation: "llm.chat",
      cache: {
        inputs: { prompt: "x" },
        toJson: (v: number) => v,
        fromJson: (j: unknown) => j as number,
      },
      usage: () => usage,
      execute: async () => {
        executions += 1;
        return executions;
      },
    };
    await invoke(deps({ cache, policy: policy({ cacheEnabled: false }) }), spec);
    await invoke(deps({ cache, policy: policy({ cacheEnabled: false }) }), spec);
    expect(executions).toBe(2);
  });

  it("ignores a corrupt cache entry and calls the provider instead", async () => {
    const cache = new MemoryProviderCache();
    const inputs = { prompt: "corrupt me" };
    const key = providerCacheKey({ provider: "fake", operation: "llm.chat", inputs });
    await cache.set(key, new TextEncoder().encode("{not json"));
    let executions = 0;

    const result = await invoke(deps({ cache }), {
      operation: "llm.chat",
      cache: { inputs, toJson: (v: string) => v, fromJson: (j: unknown) => j as string },
      usage: () => usage,
      execute: async () => {
        executions += 1;
        return "fresh";
      },
    });

    expect(executions).toBe(1);
    expect(result.value).toBe("fresh");
    expect(logger.events()).toContain("provider.cache.corrupt");
  });

  it("retries a transient failure, records the backoff and reports the attempt count", async () => {
    const slept: number[] = [];
    const result = await invoke(deps({ sleep: async (ms) => void slept.push(ms) }), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async (_signal, attempt) => {
        if (attempt < 3) throw new ProviderUnavailableError("upstream 503");
        return "recovered";
      },
    });

    expect(result.value).toBe("recovered");
    expect(result.attempts).toBe(3);
    expect(slept).toEqual([100, 200]); // exponential, no jitter in tests
    expect(logger.events().filter((event) => event === "provider.call.retry")).toHaveLength(2);
    // Every attempt is visible: two failures (0 units) and one metered success.
    expect(repo.listProviderCalls().filter((call) => call.status === "error")).toHaveLength(2);
    expect(repo.listProviderCalls().filter((call) => call.status === "ok")).toHaveLength(1);
  });

  it("never retries a permanent failure (bad credentials are not transient)", async () => {
    let executions = 0;
    await expect(
      invoke(deps({ sleep: async () => {} }), {
        operation: "llm.chat",
        usage: () => usage,
        execute: async () => {
          executions += 1;
          throw new ProviderAuthError("invalid API key");
        },
      }),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    expect(executions).toBe(1);
  });

  it("does retry a content failure (a fresh sample often satisfies the schema)", async () => {
    let executions = 0;
    const result = await invoke(deps({ sleep: async () => {} }), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => {
        executions += 1;
        if (executions === 1) throw new ProviderContentError("not valid JSON");
        return "valid now";
      },
    });
    expect(result.value).toBe("valid now");
    expect(executions).toBe(2);
  });

  it("stops after the attempt ceiling even for retryable errors", async () => {
    let executions = 0;
    const error = await invoke(deps({ sleep: async () => {} }), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => {
        executions += 1;
        throw new ProviderUnavailableError("still down");
      },
    }).catch((thrown: unknown) => thrown as ProviderError);

    expect(executions).toBe(3);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it("honours Retry-After instead of its own backoff, and cools the account down when exhausted", async () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    const slept: number[] = [];
    await expect(
      invoke(deps({ sleep: async (ms) => void slept.push(ms) }), {
        operation: "llm.chat",
        usage: () => usage,
        execute: async () => {
          throw new ProviderRateLimitError("429 slow down", { retryAfterMs: 4_000 });
        },
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);

    expect(slept).toEqual([4_000, 4_000]); // two waits, then the ceiling is reached
    const cooled = repo.getProviderAccount("fake");
    expect(cooled?.id).toBe(account.id);
    expect(Date.parse(cooled!.cooldown_until!)).toBe(
      Date.parse("2024-05-01T12:00:00.000Z") + 4_000,
    );
  });

  it("hands a too-long retry to the job scheduler rather than sleeping through it", async () => {
    let executions = 0;
    const slept: number[] = [];
    await expect(
      invoke(deps({ sleep: async (ms) => void slept.push(ms) }), {
        operation: "llm.chat",
        usage: () => usage,
        execute: async () => {
          executions += 1;
          throw new ProviderRateLimitError("quota wall", { retryAfterMs: 60 * 60 * 1000 });
        },
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);

    expect(executions).toBe(1);
    expect(slept).toEqual([]);
  });

  it("turns a deadline overrun into a timeout error (retryable)", async () => {
    const error = await invoke(
      deps({ policy: policy({ timeoutMs: 10, maxAttempts: 1 }), sleep: async () => {} }),
      {
        operation: "llm.chat",
        usage: () => usage,
        execute: async (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const abort = new Error("aborted");
              abort.name = "AbortError";
              reject(abort);
            });
          }),
      },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    if (!(error instanceof ProviderError)) throw new Error("expected a ProviderError");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("deadline");
  });

  it("does not retry when the worker is shutting down (cancellation is not a failure)", async () => {
    const controller = new AbortController();
    let executions = 0;
    const promise = invoke(deps({ sleep: async () => {} }), {
      operation: "llm.chat",
      context: { signal: controller.signal },
      usage: () => usage,
      execute: async () => {
        executions += 1;
        controller.abort();
        const abort = new Error("aborted");
        abort.name = "AbortError";
        throw abort;
      },
    });
    const error = (await promise.catch((thrown: unknown) => thrown)) as ProviderError;
    expect(error.kind).toBe("canceled");
    expect(executions).toBe(1);
  });

  it("refuses to call a provider once its quota window is exhausted (fail-closed)", async () => {
    repo.upsertProviderAccount({ adapter: "fake", quotaWindow: "daily", quotaLimit: 5 });
    repo.recordProviderUsage(repo.getProviderAccount("fake")!.id, 5);
    let executions = 0;

    const error = (await invoke(deps(), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => {
        executions += 1;
        return "should never run";
      },
    }).catch((thrown: unknown) => thrown)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect(executions).toBe(0);
    expect(error.message).toContain("quota exhausted");
    expect(logger.events()).toContain("provider.quota.blocked");
  });

  it("refuses a disabled account with an actionable configuration error", async () => {
    repo.upsertProviderAccount({ adapter: "fake", enabled: false });
    const error = (await invoke(deps(), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => "no",
    }).catch((thrown: unknown) => thrown)) as ProviderError;
    expect(error.kind).toBe("configuration");
    expect(error.message).toContain("disabled");
  });

  it("waits for a self-imposed rate-limit permit instead of hammering", async () => {
    // Two calls/minute: the third call must wait for the bucket to refill.
    const bucket = new TokenBucket(2, () => clock.now().getTime());
    const slept: number[] = [];
    const runtimeDeps = deps({
      limiter: bucket,
      policy: policy({ rateLimitPerMinute: 2 }),
      sleep: async (ms) => {
        slept.push(ms);
        clock.advance(ms); // time passes while we wait, so the permit arrives
      },
    });

    const results: string[] = [];
    for (const label of ["one", "two", "three"]) {
      const result = await invoke(runtimeDeps, {
        operation: "llm.chat",
        usage: () => usage,
        execute: async () => label,
      });
      results.push(result.value);
    }

    expect(results).toEqual(["one", "two", "three"]);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(0);
    expect(logger.events()).toContain("provider.rate_limit.wait");
  });

  it("records a failed call in provider_call_log for the dashboard", async () => {
    await invoke(deps({ sleep: async () => {} }), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => {
        throw new ProviderContentError("bad json", { details: { issues: "a.b: required" } });
      },
    }).catch(() => undefined);

    // The content error is retried to the ceiling, so all three attempts are
    // visible in the log — that is how a flaky provider becomes diagnosable.
    const calls = repo.listProviderCalls();
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.status === "error" && call.units === 0)).toBe(true);
    expect(calls[0]!.error).toContain("bad json");
    expect(logger.entries.some((entry) => entry.event === "provider.call.error")).toBe(true);
  });

  it("does not require a repository (the layer works repository-less)", async () => {
    const result = await invoke(
      {
        adapterId: "fake",
        kind: "tts",
        policy: policy(),
        budget: new BudgetGuard({ clock }),
        clock,
      },
      {
        operation: "tts.synthesize",
        usage: () => ({ units: 3, unit: "characters" }),
        execute: async () => "ok",
      },
    );
    expect(result.value).toBe("ok");
    expect(result.usage.units).toBe(3);
  });

  it("records cache keys against the call log so a hit is explainable", async () => {
    const cache = new MemoryProviderCache();
    const inputs = { text: "narration", voice: "fake-narrator" };
    await invoke(deps({ cache }), {
      operation: "tts.synthesize",
      cache: { inputs, toJson: (v: string) => v, fromJson: (j: unknown) => j as string },
      usage: () => usage,
      execute: async () => "audio-hash",
    });
    const [call] = repo.listProviderCalls();
    expect(call!.cache_key).toBe(
      providerCacheKey({ provider: "fake", operation: "tts.synthesize", inputs }),
    );
  });

  it("lets a test inject randomness without changing behaviour", async () => {
    const random = vi.fn(() => 0.5);
    const slept: number[] = [];
    await invoke(
      deps({ random, sleep: async (ms) => void slept.push(ms), policy: policy({ jitter: 0.5 }) }),
      {
        operation: "llm.chat",
        usage: () => usage,
        execute: async (_signal, attempt) => {
          if (attempt === 1) throw new ProviderUnavailableError("blip");
          return "ok";
        },
      },
    );
    expect(random).toHaveBeenCalled();
    expect(slept).toEqual([100]); // 100ms base, jitter 0.5, random 0.5 → exactly base
  });
});
