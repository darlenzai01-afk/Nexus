import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadEnv } from "@nexus/config";
import { Db, Repo, migrate } from "@nexus/db";

import { FileProviderCache, MemoryProviderCache } from "./cache.js";
import { createProviders } from "./container.js";
import { FixedClock } from "./clock.js";
import { FakeLLMProvider } from "./fake/llm.js";
import { sampleForSchema } from "./fake/sampler.js";
import { MemoryBlobStore } from "./fake/storage.js";
import { ProviderConfigurationError, ProviderContentError, ProviderError } from "./errors.js";
import type { FetchLike, FetchResponseLike } from "./http.js";
import { validateStructured } from "./llm.js";
import { BudgetGuard } from "./quota.js";
import { OpenAICompatibleLLMProvider, parseJsonObject } from "./real/openai-compatible.js";
import { createRuntime } from "./runtime.js";
import { RecordingProviderLogger, DEFAULT_PROVIDER_POLICY, type ProviderPolicy } from "./types.js";

const policy: ProviderPolicy = {
  ...DEFAULT_PROVIDER_POLICY,
  baseDelayMs: 10,
  jitter: 0,
  maxDelayMs: 5_000,
};

/** Build a runtime around a stub transport — the whole point of the DI seam. */
function makeRuntime(options: {
  transport?: FetchLike;
  env?: Record<string, string | undefined>;
  repo?: Repo;
  clock?: FixedClock;
  cache?: MemoryProviderCache;
  logger?: RecordingProviderLogger;
  credentialsEnv?: string;
  adapterId?: string;
  defaultModel?: string;
}): {
  runtime: ReturnType<typeof createRuntime>;
  logger: RecordingProviderLogger;
  slept: number[];
} {
  const logger = options.logger ?? new RecordingProviderLogger();
  const slept: number[] = [];
  const clock = options.clock ?? new FixedClock("2024-05-01T00:00:00.000Z");
  const runtime = createRuntime({
    adapterId: options.adapterId ?? "openai-compatible",
    kind: "llm",
    ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
    storage: new MemoryBlobStore(),
    ...(options.repo !== undefined ? { repo: options.repo } : {}),
    clock,
    logger: logger.log,
    env: options.env ?? {},
    policy,
    transport: options.transport ?? (() => Promise.reject(new Error("no transport configured"))),
    budget: new BudgetGuard({
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      clock,
    }),
    limiter: { tryAcquire: () => true, msUntilAvailable: () => 0 },
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    credentialsEnv: options.credentialsEnv ?? "NEXUS_LLM_API_KEY",
    invoke: async (spec) => {
      // A minimal inline pipeline for these unit tests: cache + budget + retry.
      const { invoke } = await import("./invoke.js");
      return invoke(
        {
          adapterId: options.adapterId ?? "openai-compatible",
          kind: "llm",
          policy,
          budget: new BudgetGuard({
            ...(options.repo !== undefined ? { repo: options.repo } : {}),
            clock,
          }),
          ...(options.repo !== undefined ? { repo: options.repo } : {}),
          ...(options.cache !== undefined ? { cache: options.cache } : {}),
          logger: logger.log,
          clock,
          sleep: async (ms) => void slept.push(ms),
        },
        spec,
      );
    },
  });
  return { runtime, logger, slept };
}

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => body,
});

const completion = (content: string, tokens = 42) =>
  jsonResponse({
    model: "test-model",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: tokens - 10, total_tokens: tokens },
  });

describe("schema sampler (deterministic structured output)", () => {
  it("synthesises schema-valid data from the field paths", () => {
    const schema = z.object({
      title: z.string(),
      count: z.number(),
      ready: z.boolean(),
      tags: z.array(z.string()),
      kind: z.enum(["short", "long"]),
      nested: z.object({ note: z.string().optional() }),
      maybe: z.string().nullable(),
    });
    const sample = sampleForSchema(schema);
    expect(schema.safeParse(sample).success).toBe(true);
    expect(sample.title).toBe("fake:title");
    expect(sample.kind).toBe("short");
    expect(sample.tags).toEqual(["fake:tags.0"]);
    // Deterministic: same schema, same sample.
    expect(sampleForSchema(schema)).toEqual(sample);
  });

  it("unwraps optional/default/union wrappers", () => {
    expect(sampleForSchema(z.object({ a: z.string().default("x") }))).toEqual({ a: "fake:a" });
    expect(sampleForSchema(z.union([z.object({ n: z.number() }), z.string()]))).toEqual({ n: 1 });
  });

  it("fails loudly rather than emitting invalid data for an unsupported schema", () => {
    const impossible = z.string().regex(/^[A-Z]{10}$/);
    expect(() => sampleForSchema(impossible)).toThrow(ProviderConfigurationError);
    expect(() => sampleForSchema(impossible)).toThrow(/explicit `respond` function/);
  });
});

describe("FakeLLMProvider", () => {
  let db: Db;
  let repo: Repo;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
  });

  it("answers deterministically and validates against the caller's schema", async () => {
    const { runtime } = makeRuntime({ repo, adapterId: "fake", cache: new MemoryProviderCache() });
    const provider = new FakeLLMProvider(runtime);
    const schema = z.object({
      outline: z.array(z.object({ heading: z.string(), seconds: z.number() })),
    });

    const first = await provider.chat({
      schema,
      messages: [{ role: "user", content: "outline" }],
      templateVersion: "v1",
      task: "script.outline",
    });
    const second = await provider.chat({
      schema,
      messages: [{ role: "user", content: "outline" }],
      templateVersion: "v1",
      task: "script.outline",
    });

    expect(schema.safeParse(first.value.data).success).toBe(true);
    expect(first.value.repairs).toBe(0);
    expect(first.value.model).toBe("fake-model");
    // Same prompt → same answer → a cache hit on the second call (0 executions, 0 units).
    expect(second.value.data).toEqual(first.value.data);
    expect(second.cached).toBe(true);
    expect(second.usage.units).toBe(0);
    expect(repo.listProviderCalls()).toHaveLength(2);
  });

  it("accepts an injected responder for content the test cares about", async () => {
    const { runtime } = makeRuntime({ adapterId: "fake" });
    const provider = new FakeLLMProvider(runtime, {
      respond: (request) => ({
        echoes: request.messages.at(-1)?.content,
        attempt: request.attempt,
      }),
    });
    const schema = z.object({ echoes: z.string().optional(), attempt: z.number() });
    const result = await provider.chat({
      schema,
      messages: [{ role: "user", content: "hello" }],
      templateVersion: "v2",
    });
    expect(result.value.data).toEqual({ echoes: "hello", attempt: 1 });
  });

  it("repairs a bad answer up to the bound, then fails as a content error", async () => {
    const { runtime } = makeRuntime({ adapterId: "fake" });
    let calls = 0;
    const provider = new FakeLLMProvider(runtime, {
      respond: () => {
        calls += 1;
        return { wrong: true };
      },
    });
    const schema = z.object({ right: z.string() });
    await expect(
      provider.chat({ schema, messages: [], templateVersion: "v1", maxRepairAttempts: 2 }),
    ).rejects.toBeInstanceOf(ProviderContentError);
    // Two layers bound the damage: 1 initial + 2 repairs per call, and the
    // call pipeline retries a content failure up to maxAttempts (3).
    expect(calls).toBe(9);
  });

  it("retries a simulated transport failure and reports the attempts", async () => {
    const { runtime, slept } = makeRuntime({ adapterId: "fake" });
    const provider = new FakeLLMProvider(runtime, { failFirst: 1 });
    const schema = z.object({ ok: z.boolean() });
    const result = await provider.chat({ schema, messages: [], templateVersion: "v1" });
    expect(result.attempts).toBe(2);
    expect(slept).toEqual([10]);
  });
});

describe("OpenAICompatibleLLMProvider (real adapter, stub transport)", () => {
  let db: Db;
  let repo: Repo;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
  });

  const make = (options: Parameters<typeof makeRuntime>[0] = {}) => {
    const context = makeRuntime(options);
    const provider = new OpenAICompatibleLLMProvider(context.runtime, {
      baseUrl: "https://llm.example.invalid/api/v1",
      model: "test-model",
      credentialsEnv: "NEXUS_LLM_API_KEY",
    });
    return { ...context, provider };
  };

  it("sends an OpenAI-compatible request and validates the structured reply", async () => {
    const requests: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "test-key-not-a-real-secret" },
      transport: async (url, init) => {
        requests.push({
          url,
          body: JSON.parse(init?.body ?? "{}"),
          headers: { ...(init?.headers ?? {}) },
        });
        return completion(JSON.stringify({ scenes: [{ id: "s1" }] }), 120);
      },
    });

    const schema = z.object({ scenes: z.array(z.object({ id: z.string() })) });
    const result = await provider.chat({
      schema,
      messages: [{ role: "user", content: "plan scenes" }],
      templateVersion: "plan.v3",
      task: "plan.scenes",
    });

    expect(result.value.data).toEqual({ scenes: [{ id: "s1" }] });
    expect(result.value.tokens).toBe(120);
    expect(result.usage).toEqual({ units: 120, unit: "tokens" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://llm.example.invalid/api/v1/chat/completions");
    expect(requests[0]!.headers.authorization).toBe("Bearer test-key-not-a-real-secret");
    const body = requests[0]!.body as {
      model: string;
      response_format: unknown;
      messages: { role: string }[];
    };
    expect(body.model).toBe("test-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]!.role).toBe("system"); // JSON-only instruction
  });

  it("prefers a per-request model over the container default (template pinning)", async () => {
    let seenModel = "";
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      transport: async (_url, init) => {
        seenModel = (JSON.parse(init?.body ?? "{}") as { model: string }).model;
        return completion('{"ok":true}');
      },
    });
    await provider.chat({
      schema: z.object({ ok: z.boolean() }),
      messages: [],
      templateVersion: "v1",
      model: "pinned-model-per-template",
    });
    expect(seenModel).toBe("pinned-model-per-template");
  });

  it("repairs invalid JSON with a corrective prompt, then succeeds", async () => {
    const sent: string[] = [];
    let call = 0;
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      transport: async (_url, init) => {
        const body = JSON.parse(init?.body ?? "{}") as { messages: { content: string }[] };
        sent.push(body.messages.map((message) => message.content).join("\n"));
        call += 1;
        return call === 1 ? completion("I think the answer is 42!") : completion('{"answer":42}');
      },
    });

    const result = await provider.chat({
      schema: z.object({ answer: z.number() }),
      messages: [{ role: "user", content: "answer?" }],
      templateVersion: "v1",
    });

    expect(result.value.data).toEqual({ answer: 42 });
    expect(result.value.repairs).toBe(1);
    expect(sent[1]).toContain("did not satisfy the required JSON schema");
  });

  it("fails as a content error once repair attempts are spent", async () => {
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      transport: async () => completion("not json at all"),
    });
    const error = (await provider
      .chat({
        schema: z.object({ answer: z.number() }),
        messages: [],
        templateVersion: "v1",
        maxRepairAttempts: 1,
      })
      .catch((thrown: unknown) => thrown)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderContentError);
    expect(error.kind).toBe("content");
  });

  it("maps 401 to a permanent auth error and never retries it", async () => {
    let calls = 0;
    const { provider, slept } = make({
      env: { NEXUS_LLM_API_KEY: "wrong" },
      transport: async () => {
        calls += 1;
        return jsonResponse({ error: "invalid api key" }, 401);
      },
    });
    const error = (await provider
      .chat({ schema: z.object({}), messages: [], templateVersion: "v1" })
      .catch((thrown: unknown) => thrown)) as ProviderError;
    expect(error.kind).toBe("auth");
    expect(error.retryable).toBe(false);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("honours Retry-After on 429 and retries within the deadline", async () => {
    let calls = 0;
    const { provider, slept } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      transport: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" });
        return completion('{"ok":true}');
      },
    });
    const result = await provider.chat({
      schema: z.object({ ok: z.boolean() }),
      messages: [],
      templateVersion: "v1",
    });
    expect(result.value.data).toEqual({ ok: true });
    expect(result.attempts).toBe(2);
    expect(slept).toEqual([2_000]);
  });

  it("retries a 5xx as unavailable", async () => {
    let calls = 0;
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      transport: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse("upstream exploded", 503) : completion('{"ok":true}');
      },
    });
    const result = await provider.chat({
      schema: z.object({ ok: z.boolean() }),
      messages: [],
      templateVersion: "v1",
    });
    expect(result.attempts).toBe(2);
  });

  it("fails with an actionable auth error when the credential variable is missing", async () => {
    const { provider } = make({ env: {}, transport: async () => completion('{"ok":true}') });
    const error = (await provider
      .chat({ schema: z.object({}), messages: [], templateVersion: "v1" })
      .catch((thrown: unknown) => thrown)) as ProviderError;
    expect(error.kind).toBe("auth");
    expect(error.message).toContain("NEXUS_LLM_API_KEY");
    // The message names the variable; it never contains a value.
    expect(error.message).not.toContain("Bearer");
  });

  it("records the call (provider, operation, tokens, duration) for the budget guard", async () => {
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      repo,
      transport: async () => completion('{"ok":true}', 77),
    });
    await provider.chat({
      schema: z.object({ ok: z.boolean() }),
      messages: [],
      templateVersion: "v1",
    });
    const [call] = repo.listProviderCalls();
    expect(call).toMatchObject({
      provider: "openai-compatible",
      operation: "llm.chat",
      units: 77,
      status: "ok",
    });
    expect(call!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("never stores or logs the credential value, even when the provider echoes it (AD-12)", async () => {
    const secret = "test-secret-value-1234567890";
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-redact-"));
    const logger = new RecordingProviderLogger();
    // Build the whole container, so this covers the real wiring: the runtime
    // learns the key from the process env and scrubs that exact value.
    const p = createProviders({
      config: loadEnv({
        env: {
          NEXUS_DATA_DIR: dir,
          NEXUS_LLM_PROVIDER: "openai-compatible",
          NEXUS_LLM_BASE_URL: "https://llm.example.invalid/api/v1",
          NEXUS_LLM_MODEL: "test-model",
        },
        cwd: dir,
      }),
      storage: new MemoryBlobStore(),
      repo,
      clock: new FixedClock("2024-05-01T00:00:00.000Z"),
      logger: logger.log,
      cache: new MemoryProviderCache(),
      env: { NEXUS_LLM_API_KEY: secret },
      transport: async () => jsonResponse({ error: `bad key: ${secret}` }, 500),
    });

    await p
      .llm()
      .chat({ schema: z.object({}), messages: [], templateVersion: "v1", maxRepairAttempts: 0 })
      .catch(() => undefined);

    expect(logger.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(logger.entries)).not.toContain(secret);
    expect(repo.listProviderCalls().length).toBeGreaterThan(0);
    expect(JSON.stringify(repo.listProviderCalls())).not.toContain(secret);
    // The failure is still diagnosable: the redaction marker is present.
    expect(repo.listProviderCalls()[0]!.error).toContain("[redacted]");
  });

  it("reads a per-adapter credential variable recorded by the operator", async () => {
    const { provider } = make({
      env: { MY_GROQ_KEY: "env-name-driven" },
      credentialsEnv: "MY_GROQ_KEY",
      transport: async (_url, init) => {
        expect(init?.headers?.authorization).toBe("Bearer env-name-driven");
        return completion('{"ok":true}');
      },
    });
    const result = await provider.chat({
      schema: z.object({ ok: z.boolean() }),
      messages: [],
      templateVersion: "v1",
    });
    expect(result.value.data).toEqual({ ok: true });
  });

  it("caches by prompt content, so a re-run of the same stage costs nothing", async () => {
    const cache = new MemoryProviderCache();
    let calls = 0;
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      cache,
      transport: async () => {
        calls += 1;
        return completion('{"ok":true}', 100);
      },
    });
    const request = {
      schema: z.object({ ok: z.boolean() }),
      messages: [{ role: "user" as const, content: "same prompt" }],
      templateVersion: "v1",
      task: "same.task",
    };
    const first = await provider.chat(request);
    const second = await provider.chat(request);
    expect(calls).toBe(1);
    expect(first.value.tokens).toBe(100);
    expect(second.cached).toBe(true);
    expect(second.usage.units).toBe(0);
  });

  it("treats a different template version as a different cache entry", async () => {
    const cache = new MemoryProviderCache();
    let calls = 0;
    const { provider } = make({
      env: { NEXUS_LLM_API_KEY: "k" },
      cache,
      transport: async () => {
        calls += 1;
        return completion('{"ok":true}');
      },
    });
    const base = {
      schema: z.object({ ok: z.boolean() }),
      messages: [{ role: "user" as const, content: "p" }],
    };
    await provider.chat({ ...base, templateVersion: "v1" });
    await provider.chat({ ...base, templateVersion: "v2" });
    expect(calls).toBe(2);
  });
});

describe("parseJsonObject", () => {
  it("accepts plain JSON, fenced JSON and JSON wrapped in prose", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('Sure! Here you go: {"a":1} — hope that helps')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("rejects arrays, scalars and invalid JSON", () => {
    expect(parseJsonObject("[1,2]").ok).toBe(false);
    expect(parseJsonObject("42").ok).toBe(false);
    expect(parseJsonObject("nope").ok).toBe(false);
  });
});

describe("validateStructured", () => {
  it("reports issues with field paths for the repair prompt", () => {
    const schema = z.object({ title: z.string(), count: z.number() });
    const result = validateStructured(schema, { title: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("title");
      expect(result.issues).toContain("count");
    }
  });

  it("returns the parsed data on success", () => {
    const schema = z.object({ n: z.number() });
    expect(validateStructured(schema, { n: 3 })).toEqual({ ok: true, data: { n: 3 } });
  });
});

describe("provider cache on disk", () => {
  it("survives a new cache instance (results outlive the process)", async () => {
    const dir = `${process.cwd()}/.nexus-test-cache-${process.pid}`;
    const first = new FileProviderCache(dir);
    await first.set("key-1", new TextEncoder().encode("value-1"));
    const second = new FileProviderCache(dir);
    expect(new TextDecoder().decode((await second.get("key-1"))!)).toBe("value-1");
    await import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }));
  });
});
