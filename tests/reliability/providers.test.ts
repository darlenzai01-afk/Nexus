/**
 * Hostile reliability probes — the provider/invoke layer (scenarios 1–7, 22,
 * 23, 25 of the reliability brief).
 *
 * Every test reproduces a failure against mock providers only (no network, no
 * keys, nothing paid) and pins the behavior an operator depends on: bounded
 * retries, fail-closed quota, garbage never parsed as truth, failures always
 * recorded.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeLLMProvider,
  FakeTTSProvider,
  FixedClock,
  MemoryBlobStore,
  MemoryProviderCache,
  ProviderContentError,
  ProviderQuotaError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RecordingProviderLogger,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type InvokeRuntime,
  type ProviderPolicy,
} from "@nexus/providers";
import { castingFor, synthesizeNarration } from "@nexus/audio";
import { Db, Repo, migrate } from "@nexus/db";
import { runResearch } from "@nexus/research";
import { SceneManifestSchema, type SceneManifest } from "@nexus/scenes";
import { QA_SECTION_ROLES, planFixture } from "@nexus/qa";
import type { TTSProvider } from "@nexus/providers";

const CLOCK_ISO = "2024-05-01T12:00:00.000Z";

/** A sleep that honors the caller's abort signal (what a well-behaved adapter does). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("the call was aborted"));
      },
      { once: true },
    );
  });
}

describe("provider reliability (hostile)", () => {
  let db: Db;
  let repo: InstanceType<typeof Repo>;
  let clock: FixedClock;
  let logger: RecordingProviderLogger;

  const policy = (overrides: Partial<ProviderPolicy> = {}): ProviderPolicy => ({
    ...DEFAULT_PROVIDER_POLICY,
    baseDelayMs: 1,
    factor: 1,
    maxDelayMs: 2,
    jitter: 0,
    rateLimitPerMinute: 0,
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
    sleep: async () => undefined,
    ...overrides,
  });

  const usage = { units: 10, unit: "tokens" as const };

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    clock = new FixedClock(CLOCK_ISO);
    logger = new RecordingProviderLogger();
  });

  // ── 1. AI provider timeout ──────────────────────────────────────────────

  it("1. times a slow AI provider out, retries within the ceiling, then fails retryable", async () => {
    let calls = 0;
    const error = await invoke(deps({ policy: policy({ timeoutMs: 25, maxAttempts: 2 }) }), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async (signal) => {
        calls += 1;
        await abortableSleep(2_000, signal);
        return { ok: true };
      },
    }).then(
      () => {
        throw new Error("the slow provider call should not have succeeded");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    const providerError = error as ProviderTimeoutError;
    expect(providerError.kind).toBe("timeout");
    expect(providerError.retryable).toBe(true);
    // Bounded: exactly the policy ceiling, not an unbounded hang.
    expect(calls).toBe(2);
    // Every attempt is visible in the call log: the first failure is logged
    // as a retry, the last as an error.
    expect(logger.events().filter((event) => event === "provider.call.retry")).toHaveLength(1);
    expect(logger.events().filter((event) => event === "provider.call.error")).toHaveLength(1);
  });

  // ── 2. AI quota exhaustion ──────────────────────────────────────────────

  it("2. refuses at the quota wall before any call, fail-closed and non-retryable", async () => {
    repo.upsertProviderAccount({ adapter: "fake", quotaWindow: "daily", quotaLimit: 10 });
    // Burn the window with one successful call.
    await invoke(deps(), {
      operation: "llm.chat",
      usage: () => ({ units: 10, unit: "tokens" as const }),
      execute: async () => ({ ok: true }),
    });
    let calls = 0;
    const error = await invoke(deps(), {
      operation: "llm.chat",
      usage: () => usage,
      execute: async () => {
        calls += 1;
        return { ok: true };
      },
    }).then(
      () => {
        throw new Error("the exhausted quota should not have let a call through");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect((error as ProviderQuotaError).kind).toBe("quota");
    // Fail-closed: the refusal is not retryable, and no provider call happened.
    expect((error as ProviderQuotaError).retryable).toBe(false);
    expect(calls).toBe(0);
    expect(logger.find("provider.quota.blocked")).toBeDefined();
  });

  // ── 3. Malformed AI JSON ────────────────────────────────────────────────

  it("3. refuses garbage model output: bounded repairs, retryable content error, no partial truth", async () => {
    const storage = new MemoryBlobStore();
    const llm = new FakeLLMProvider(
      llmRuntime(storage, logger),
      {
        // A model that answers, but never in the shape the schema demands.
        respond: () => ({ completely: "wrong", questions: 42 }),
      },
      "broken-llm",
    );
    const error = await llm
      .chat({
        messages: [{ role: "user", content: "plan the research" }],
        templateVersion: "t1",
        task: "research.questions",
        schema: {
          safeParse: (value: unknown) =>
            value !== null &&
            typeof value === "object" &&
            Array.isArray((value as { questions?: unknown }).questions)
              ? { success: true, data: value }
              : {
                  success: false,
                  error: {
                    issues: [{ path: ["questions"], message: "expected a list of questions" }],
                  },
                },
        },
      } as never)
      .then(
        () => {
          throw new Error("garbage output should not have been accepted");
        },
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(ProviderContentError);
    expect((error as ProviderContentError).kind).toBe("content");
    // A fresh sample often succeeds, so the kind is retryable — but the repair
    // loop is bounded (one repair by default), so the failure surfaces.
    expect((error as ProviderContentError).retryable).toBe(true);
    expect(String((error as ProviderContentError).message)).toMatch(
      /could not satisfy the schema/u,
    );
  });

  // ── 4. Research provider failure ────────────────────────────────────────

  it("4. surfaces a dead research provider as a recorded, retryable failure — never silence", async () => {
    const offline = offlineLlm();
    const error = await runResearch(
      { topic: "Why the Kira bridge hums at dusk" },
      {
        llm: offline,
        research: {
          id: "dead-research",
          kind: "research",
          mode: "fake",
          label: "dead research",
          async search() {
            throw new ProviderUnavailableError("search provider unreachable", {
              provider: "dead-research",
              operation: "research.search",
            });
          },
          async images() {
            throw new ProviderUnavailableError("search provider unreachable", {
              provider: "dead-research",
              operation: "research.images",
            });
          },
        },
        clock: new FixedClock(CLOCK_ISO),
      },
    ).then(
      () => {
        throw new Error("research against a dead provider should not have succeeded");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
    // The failure is recorded, not swallowed: the run names the step that died.
    // (The app's research task turns this into a job failure with the step name.)
  });

  // ── 5. Duplicate source ─────────────────────────────────────────────────

  it("5. keeps one copy of a duplicated source and records why the copy was dropped", async () => {
    const row = (url: string, snippet: string) => ({
      title: `About ${url}`,
      url,
      snippet,
      publishedAt: "2023-04-02",
      source: "stub-research",
    });
    const pkg = await runResearch(
      { topic: "The Kira bridge" },
      {
        llm: offlineLlm(),
        research: stubResearch([
          row("https://a.example.org/bridge", "The bridge hums at 92 hertz."),
          // Same URL twice (mirrors/pagination): one source, one drop.
          row("https://a.example.org/bridge", "The bridge hums at 92 hertz."),
          // Different URL, identical text (syndication): dropped as duplicate content.
          row("https://b.example.org/syndicated", "The bridge hums at 92 hertz."),
          // Genuinely different content: kept.
          row("https://c.example.org/history", "The bridge opened in 1973."),
        ]),
        clock: new FixedClock(CLOCK_ISO),
      },
    );

    const urls = pkg.sources.map((source) => source.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain("https://a.example.org/bridge");
    expect(urls).toContain("https://c.example.org/history");
    expect(urls).not.toContain("https://b.example.org/syndicated");
    expect(pkg.dropped.map((item) => item.reason)).toContain("duplicate_url");
    expect(pkg.dropped.map((item) => item.reason)).toContain("duplicate_content");
  });

  // ── 6. Conflicting sources ──────────────────────────────────────────────

  it("6. preserves source conflict: claims capped below fact strength, human review demanded", async () => {
    const row = (url: string, snippet: string) => ({
      title: `About ${url}`,
      url,
      snippet,
      publishedAt: "2023-04-02",
      source: "stub-research",
    });
    // A model that extracts each source's claim verbatim, then reports the
    // numeric disagreement between the two sources it was shown.
    const pkg = await runResearch(
      { topic: "The Kira bridge crossing count" },
      {
        llm: countingConflictLlm(),
        research: stubResearch([
          row("https://a.example.org/count", "The bridge carries 40,000 vehicles a day."),
          row("https://b.example.org/count", "The bridge carries 55,000 vehicles a day."),
        ]),
        clock: new FixedClock(CLOCK_ISO),
      },
    );

    expect(pkg.conflicts.length).toBeGreaterThan(0);
    expect(pkg.verification.reviewRequired).toBe(true);
    const contested = pkg.claims.filter((claim) => claim.contested);
    expect(contested.length).toBeGreaterThan(0);
    for (const claim of contested) {
      // A disputed number must never be stateable as fact.
      expect(claim.mayStateAsFact).toBe(false);
      expect(claim.confidence).toBeLessThanOrEqual(0.4);
    }
  });

  // ── 7. TTS failure ──────────────────────────────────────────────────────

  it("7. records a dead TTS per segment: the run waits, nothing is fabricated, attempts are bounded", async () => {
    const { manifest, casting } = narrationFixture();
    const storage = new MemoryBlobStore();
    const healthy = new FakeTTSProvider(llmRuntime(storage, logger), {}, "tts-fake");
    // Delegate explicitly: spreading a class instance drops its prototype
    // methods (voices() included), which would fail the run before synthesis.
    const dead = {
      id: healthy.id,
      kind: healthy.kind,
      mode: healthy.mode,
      label: healthy.label,
      voices: () => healthy.voices(),
      synthesize: async () => {
        throw new ProviderUnavailableError("tts cluster unreachable", {
          provider: "tts-fake",
          operation: "tts.synthesize",
        });
      },
    } as TTSProvider;

    const report = await synthesizeNarration(
      { manifest, manifestHash: "a".repeat(64), casting, now: CLOCK_ISO },
      {
        tts: dead,
        storage,
        clock: (() => new Date(CLOCK_ISO)) as never,
        tuning: { baseDelayMs: 1, factor: 1, maxDelayMs: 2 },
      },
    );

    // The voice stage must WAIT (park) for an operator/provider, not fail the
    // run and not emit fabricated silence.
    expect(report.waiting).toBe(true);
    expect(report.calls.failedSegments).toBe(manifest.scenes.length);
    // The failures were retried, bounded, and recorded as issues per scene.
    expect(report.calls.retries).toBeGreaterThan(0);
    expect(report.issues.map((issue) => issue.code)).toContain("provider_failed");
    expect(report.track.segments).toHaveLength(0);
  });

  // ── 22. YouTube upload failure ──────────────────────────────────────────

  it("22. an upload refusal surfaces as a bounded retryable failure with no ref and no record", async () => {
    // The publish task re-checks QA/approval itself (pinned elsewhere); here we
    // pin what an upload REFUSAL from the provider does at the boundary.
    const error = await invoke(
      deps({
        adapterId: "fake-publish",
        kind: "publishing",
        policy: policy({ maxAttempts: 2 }),
      }),
      {
        operation: "publish.upload",
        usage: () => ({ units: 1, unit: "uploads" as const }),
        execute: async () => {
          throw new ProviderUnavailableError("resumable session refused (503)", {
            provider: "fake-publish",
            operation: "publish.upload",
          });
        },
      },
    ).then(
      () => {
        throw new Error("a refused upload should not have produced a ref");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
    // Bounded: the failing upload ran exactly maxAttempts times, then stopped
    // (one logged retry + one logged final error).
    expect(logger.entries.filter((entry) => entry.event === "provider.call.retry")).toHaveLength(1);
    expect(logger.entries.filter((entry) => entry.event === "provider.call.error")).toHaveLength(1);
  });

  // ── 23. Network interruption ────────────────────────────────────────────

  it("23. classifies a raw network break as retryable unavailability and bounds the retries", async () => {
    let calls = 0;
    const error = await invoke(deps({ policy: policy({ maxAttempts: 3 }) }), {
      operation: "research.search",
      usage: () => ({ units: 1, unit: "requests" as const }),
      execute: async () => {
        calls += 1;
        // What an interrupted socket looks like to a fetch-based adapter.
        throw new TypeError("fetch failed: ECONNRESET");
      },
    }).then(
      () => {
        throw new Error("a broken network call should not have succeeded");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
    expect(calls).toBe(3);
  });

  // ── 25. Provider recovery ───────────────────────────────────────────────

  it("25. recovers when the provider comes back: first call fails, the retry succeeds and meters once", async () => {
    const storage = new MemoryBlobStore();
    const recovering = new FakeLLMProvider(
      llmRuntime(storage, logger),
      {
        failFirst: 1,
        failWith: () =>
          new ProviderUnavailableError("blip", { provider: "flaky", operation: "llm.chat" }),
        respond: () => ({
          questions: [{ question: "q?", rationale: "r", priority: "primary", queries: ["x"] }],
        }),
      },
      "flaky",
    );
    const result = await recovering.chat({
      messages: [{ role: "user", content: "plan" }],
      templateVersion: "t1",
      task: "research.questions",
      schema: acceptAnything(),
    } as never);

    expect(result.value.data).toBeDefined();
    expect(result.attempts).toBe(2);
    // The failed attempt is on the record (as a retry), followed by the
    // recovery.
    expect(logger.events()).toContain("provider.call.retry");
    expect(logger.events()).toContain("provider.call.ok");
  });

  // ── Shared fixtures ─────────────────────────────────────────────────────

  function llmRuntime(storage: MemoryBlobStore, log: RecordingProviderLogger): InvokeRuntime {
    const innerPolicy = policy({ maxAttempts: 3 });
    return createRuntime({
      adapterId: "fake",
      kind: "llm",
      storage,
      clock,
      logger: log.log,
      env: {},
      policy: innerPolicy,
      budget: new BudgetGuard({ clock }),
      limiter: unlimitedRateLimiter,
      credentialsEnv: "NEXUS_LLM_API_KEY",
      transport: () => Promise.reject(new Error("the mocks never touch the network")),
      cache: new MemoryProviderCache(),
      invoke: (spec) =>
        invoke(
          {
            adapterId: "fake",
            kind: "llm",
            policy: innerPolicy,
            budget: new BudgetGuard({ clock }),
            clock,
            logger: log.log,
            sleep: async () => undefined,
          },
          spec,
        ),
    });
  }

  /** A schema stub that accepts anything (the shape is not the test's subject). */
  function acceptAnything() {
    return { safeParse: (value: unknown) => ({ success: true, data: value }) };
  }

  function narrationFixture(): { manifest: SceneManifest; casting: ReturnType<typeof castingFor> } {
    const draft = planFixture({ sections: QA_SECTION_ROLES, width: 640, height: 360 });
    const manifest = SceneManifestSchema.parse(draft) as unknown as SceneManifest;
    return {
      manifest,
      casting: castingFor(manifest, { language: "en", sampleRate: 8_000, rate: 1 }),
    };
  }
});

// ── Research fakes (mirrors of the research suite's own harness) ────────────

function stubResearch(
  rows: readonly {
    title: string;
    url: string;
    snippet: string;
    publishedAt: string;
    source: string;
  }[],
) {
  const envelope = <T>(value: T, operation: string) => ({
    value,
    provider: "stub-research",
    operation,
    cached: false,
    attempts: 1,
    durationMs: 0,
    usage: { units: 1, unit: "requests" as const },
  });
  return {
    id: "stub-research",
    kind: "research" as const,
    mode: "fake" as const,
    label: "stub research",
    async search(_query: string, options: { limit?: number } = {}) {
      return envelope(rows.slice(0, options.limit ?? 5), "research.search");
    },
    async images() {
      return envelope([], "research.images");
    },
  };
}

/**
 * A deterministic offline model for the research engine: plans one question,
 * extracts each source's first sentence verbatim (never inventing quotes), and
 * reports the two numeric claims as a conflict when it sees both of them.
 */
function offlineLlm(): ReturnType<typeof FakeLLMProvider extends never ? never : FakeLLMProvider> {
  const storage = new MemoryBlobStore();
  return new FakeLLMProvider(
    plainRuntime(storage),
    {
      respond: (request) => {
        const messages = request.messages as readonly { readonly content: string }[];
        const last = messages[messages.length - 1]?.content ?? "";
        if (request.task === "research.questions") {
          return {
            questions: [
              {
                question: "What is known about this?",
                rationale: "core",
                priority: "primary",
                queries: ["kira"],
              },
            ],
          };
        }
        if (request.task === "research.extract") {
          const text = between(last, '"""', '"""');
          const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
          return {
            evidence: [{ quote: firstSentence, relevance: "states it directly" }],
            claims: [
              {
                statement: firstSentence,
                evidence: [0],
                stance: "supports",
                strength: 0.9,
                rationale: "the sentence asserts it",
              },
            ],
          };
        }
        if (request.task === "research.reconcile") return { groups: [] };
        return { conflicts: [], refutations: [] };
      },
    },
    "offline-llm",
  );
}

function countingConflictLlm() {
  const storage = new MemoryBlobStore();
  return new FakeLLMProvider(
    plainRuntime(storage),
    {
      respond: (request) => {
        const messages = request.messages as readonly { readonly content: string }[];
        const last = messages[messages.length - 1]?.content ?? "";
        if (request.task === "research.questions") {
          return {
            questions: [
              { question: "How many?", rationale: "core", priority: "primary", queries: ["count"] },
            ],
          };
        }
        if (request.task === "research.extract") {
          const text = between(last, '"""', '"""');
          const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
          return {
            evidence: [{ quote: firstSentence, relevance: "states it directly" }],
            claims: [
              {
                statement: firstSentence,
                evidence: [0],
                stance: "supports",
                strength: 1,
                rationale: "verbatim",
              },
            ],
          };
        }
        if (request.task === "research.reconcile") return { groups: [] };
        // Conflict pass: pair the two differing counts the sources state.
        const entries = [...last.matchAll(/^(cl_[0-9a-f]{8}|p\d+): (.+)$/gm)].map((match) => ({
          id: match[1]!,
          statement: match[2]!,
        }));
        const forty = entries.find((entry) => entry.statement.includes("40,000"));
        const fiftyFive = entries.find((entry) => entry.statement.includes("55,000"));
        if (forty === undefined || fiftyFive === undefined)
          return { conflicts: [], refutations: [] };
        return {
          conflicts: [
            {
              claims: [forty.id, fiftyFive.id],
              kind: "numeric_disagreement",
              explanation: "the counts differ",
            },
          ],
          refutations: [],
        };
      },
    },
    "conflict-llm",
  );
}

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start + open.length, end) : "";
}

function plainRuntime(storage: MemoryBlobStore): InvokeRuntime {
  const innerPolicy: ProviderPolicy = {
    ...DEFAULT_PROVIDER_POLICY,
    maxAttempts: 1,
    baseDelayMs: 0,
    jitter: 0,
    rateLimitPerMinute: 0,
  };
  const clock = new FixedClock("2024-05-01T00:00:00.000Z");
  return createRuntime({
    adapterId: "stub-llm",
    kind: "llm",
    storage,
    clock,
    logger: silentProviderLogger,
    env: {},
    policy: innerPolicy,
    budget: new BudgetGuard({ clock }),
    limiter: unlimitedRateLimiter,
    credentialsEnv: "NEXUS_LLM_API_KEY",
    transport: () => Promise.reject(new Error("the mocks never touch the network")),
    cache: new MemoryProviderCache(),
    invoke: (spec) =>
      invoke(
        {
          adapterId: "stub-llm",
          kind: "llm",
          policy: innerPolicy,
          budget: new BudgetGuard({ clock }),
          clock,
          sleep: async () => undefined,
        },
        spec,
      ),
  });
}
