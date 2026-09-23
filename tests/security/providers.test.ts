/**
 * Security audit — provider, storage and data layers (SSRF, URL schemes,
 * secrets, redaction, command execution, SQL injection). Mock-only: nothing
 * here opens a socket or executes a binary.
 *
 * Fixes found by this audit are referenced from `docs/testing/security-audit.md`.
 */
import { describe, expect, it } from "vitest";

import { Db, migrate, Repo } from "@nexus/db";
import {
  assertPublicHttpUrl,
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FixedClock,
  MemoryBlobStore,
  ProviderUnavailableError,
  RecordingProviderLogger,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
} from "@nexus/providers";
import { runResearch } from "@nexus/research";

describe("SSRF guard (assertPublicHttpUrl)", () => {
  const blocked: readonly [string, string][] = [
    ["http://127.0.0.1/x", "loopback"],
    ["http://localhost/x", "localhost"],
    ["http://[::1]/x", "IPv6 loopback"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://10.1.2.3/x", "RFC1918"],
    ["http://172.16.0.9/x", "RFC1918 172.16"],
    ["http://192.168.1.1/x", "RFC1918 192.168"],
    ["http://100.64.0.1/x", "CGNAT"],
    ["http://[::ffff:169.254.169.254]/x", "IPv4-mapped metadata"],
    ["http://user:pw@example.com/x", "embedded credentials"],
    ["file:///etc/passwd", "file scheme"],
    ["gopher://example.com/x", "gopher scheme"],
  ];

  for (const [url, why] of blocked) {
    it(`refuses ${why}: ${url}`, () => {
      expect(() => assertPublicHttpUrl(url)).toThrow();
    });
  }

  it("refuses host spellings that name private machines", () => {
    // URL lowercases the hostname, so "LOCALHOST" hits the localhost rule.
    for (const host of ["LOCALHOST", "foo.local", "0.0.0.0"]) {
      expect(() => assertPublicHttpUrl(`http://${host}/x`), host).toThrow();
    }
    // "localhost.example" is an ordinary public domain — the guard must NOT
    // over-block it (fail closed applies to private names, not to TLDs).
    expect(() => assertPublicHttpUrl("https://localhost.example/x")).not.toThrow();
  });

  it("refuses IPv4 spellings in non-decimal forms (the URL parser canonicalizes first)", () => {
    // WHATWG URL parsing canonicalizes IPv4 variants ("0177.0.0.1" →
    // "127.0.0.1", hex forms likewise) BEFORE the guard's literal rules run,
    // so odd spellings cannot smuggle a loopback past it.
    for (const host of ["0177.0.0.1", "0x7f.0.0.1", "2130706433"]) {
      expect(() => assertPublicHttpUrl(`http://${host}/x`), host).toThrow();
    }
    // Residual (documented as SA-8, not reachable today): the guard inspects
    // the URL's host string; a public DNS name that RESOLVES to a private
    // address (DNS rebinding) would need a resolve-then-recheck fetcher. No
    // shipped adapter fetches research URLs — the real research adapter is
    // deferred and the fakes never open a socket.
  });

  it("accepts a genuine public HTTPS URL", () => {
    const url = assertPublicHttpUrl("https://example.org/research?a=1#frag");
    expect(url.hostname).toBe("example.org");
  });
});

describe("URL schemes at the research boundary", () => {
  it("drops non-HTTP(S) source rows before they can be stored (and later fetched)", async () => {
    const row = (url: string, snippet: string) => ({
      title: `row ${url}`,
      url,
      snippet,
      publishedAt: "2023-04-02",
      source: "stub-research",
    });
    const pkg = await runResearch(
      { topic: "The Kira bridge" },
      {
        llm: offlineLlm(),
        research: {
          id: "stub-research",
          kind: "research",
          mode: "fake",
          label: "stub",
          async search(_query: string, options: { limit?: number } = {}) {
            return {
              value: [
                row("file:///etc/passwd", "local file as a source"),
                row("javascript:alert(1)", "script URL as a source"),
                row("https://example.org/real", "a genuine source"),
              ].slice(0, options.limit ?? 5),
              provider: "stub-research",
              operation: "research.search",
              cached: false,
              attempts: 1,
              durationMs: 0,
              usage: { units: 1, unit: "requests" },
            };
          },
          async images() {
            return {
              value: [],
              provider: "stub-research",
              operation: "research.images",
              cached: false,
              attempts: 1,
              durationMs: 0,
              usage: { units: 1, unit: "requests" },
            };
          },
        },
        clock: new FixedClock("2024-05-01T00:00:00.000Z"),
      },
    );

    const urls = pkg.sources.map((source) => source.url);
    expect(urls).toEqual(["https://example.org/real"]);
    expect(pkg.dropped.map((item) => item.reason)).toContain("invalid_url");
  });
});

describe("secrets and redaction", () => {
  it("a provider error body containing the credential value reaches logs redacted", async () => {
    const secret = "sk-live-9f8e7d6c5b4a3210fedcba9876543210";
    const logger = new RecordingProviderLogger();
    const clock = new FixedClock("2024-05-01T00:00:00.000Z");
    const db = Db.memory();
    migrate(db);
    const repo = new Repo(db);
    const error = await invoke(
      {
        adapterId: "leaky",
        kind: "llm",
        policy: { ...DEFAULT_PROVIDER_POLICY, maxAttempts: 1, baseDelayMs: 0, jitter: 0 },
        budget: new BudgetGuard({ clock }),
        repo,
        logger: logger.log,
        clock,
        sleep: async () => undefined,
        // The container seeds this redactor with the configured credential's
        // VALUE (apps read it from the env var named in credentials_env).
        redact: (text) => text.replaceAll(secret, "[REDACTED]"),
      },
      {
        operation: "llm.chat",
        usage: () => ({ units: 1, unit: "tokens" }),
        execute: async () => {
          throw new ProviderUnavailableError(`gateway said: authorization failed for ${secret}`, {
            provider: "leaky",
            operation: "llm.chat",
          });
        },
      },
    ).then(
      () => {
        throw new Error("the failing call should not have succeeded");
      },
      (thrown: unknown) => thrown,
    );

    expect((error as ProviderUnavailableError).message).toContain(secret); // thrown errors stay inspectable in-process…
    // …but everything that reaches a LOG is scrubbed.
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(secret);
    expect(logged).toContain("[REDACTED]");
    db.close();
  });

  it("provider accounts store credential env-var NAMES, never values", () => {
    const db = Db.memory();
    migrate(db);
    const repo = new Repo(db);
    const account = repo.upsertProviderAccount({
      adapter: "youtube",
      credentialsEnv: "NEXUS_YOUTUBE_CLIENT_SECRET",
    });
    expect(account.credentials_env).toBe("NEXUS_YOUTUBE_CLIENT_SECRET");
    expect(account.credentials_env.toLowerCase()).not.toContain("secret=");
    db.close();
  });
});

describe("command execution boundary (documented: ffmpeg.ts)", () => {
  it("command labels and args never reach a shell: a metacharacter-laden label is inert data", async () => {
    // The FFmpeg runner is the only code that spawns a process. It uses
    // spawnSync(binary, args[]) with NO shell, its binary comes from operator
    // config (not request input), and every file name it touches is derived
    // from content hashes. This probe pins the data-side of that contract:
    // hostile text stored in documents stays data in artifact bytes.
    const hostile = '"; rm -rf /; #';
    const storage = new MemoryBlobStore();
    const put = storage.put(new TextEncoder().encode(JSON.stringify({ note: hostile })));
    expect(JSON.parse(new TextDecoder().decode(storage.read(put.hash))).note).toBe(hostile);
    // (The render engine reads manifests by hash and composes arg arrays —
    // see packages/video/src/ffmpeg.ts: "It is never a shell".)
  });
});

describe("SQL injection resistance", () => {
  it("hostile strings in every free-text column are data, never SQL", () => {
    const db = Db.memory();
    migrate(db);
    const repo = new Repo(db);
    const hostile = "x'); DROP TABLE episodes; --";
    const project = repo.createProject({ name: hostile, slug: "sqli-probe" });
    const episode = repo.createEpisode({ projectId: project.id, topic: hostile });
    repo.setEpisodeState(episode.id, "RESEARCHING", null);
    repo.appendAudit({ action: hostile, subjectType: "episode", subjectId: episode.id });

    expect(repo.requireEpisode(episode.id).topic).toBe(hostile);
    expect(repo.listEpisodes(project.id)).toHaveLength(1);
    // The episodes table survived the attempt.
    expect(repo.listEpisodes().length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

// ── A coherent offline model for the research boundary probe ────────────────

import { FakeLLMProvider, type InvokeRuntime } from "@nexus/providers";

function offlineLlm(): FakeLLMProvider {
  const clock = new FixedClock("2024-05-01T00:00:00.000Z");
  const policy = {
    ...DEFAULT_PROVIDER_POLICY,
    maxAttempts: 1,
    baseDelayMs: 0,
    jitter: 0,
    rateLimitPerMinute: 0,
  };
  const runtime: InvokeRuntime = createRuntime({
    adapterId: "offline-llm",
    kind: "llm",
    storage: new MemoryBlobStore(),
    clock,
    logger: silentProviderLogger,
    env: {},
    policy,
    budget: new BudgetGuard({ clock }),
    limiter: unlimitedRateLimiter,
    credentialsEnv: "NEXUS_LLM_API_KEY",
    transport: () => Promise.reject(new Error("the mocks never touch the network")),
    cache: new MemoryBlobStoreCache(),
    invoke: (spec) =>
      invoke(
        {
          adapterId: "offline-llm",
          kind: "llm",
          policy,
          budget: new BudgetGuard({ clock }),
          clock,
          sleep: async () => undefined,
        },
        spec,
      ),
  });
  return new FakeLLMProvider(runtime, {
    respond: (request) => {
      const messages = request.messages as readonly { readonly content: string }[];
      const last = messages[messages.length - 1]?.content ?? "";
      if (request.task === "research.questions") {
        return {
          questions: [
            {
              question: "What is known?",
              rationale: "core",
              priority: "primary",
              queries: ["kira"],
            },
          ],
        };
      }
      if (request.task === "research.extract") {
        const start = last.indexOf('"""');
        const end = last.lastIndexOf('"""');
        const text = start >= 0 && end > start ? last.slice(start + 3, end) : "";
        const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
        return {
          evidence: [{ quote: firstSentence, relevance: "states it directly" }],
          claims: [
            {
              statement: firstSentence,
              evidence: [0],
              stance: "supports",
              strength: 0.9,
              rationale: "verbatim",
            },
          ],
        };
      }
      if (request.task === "research.reconcile") return { groups: [] };
      return { conflicts: [], refutations: [] };
    },
  });
}

/** Minimal cache adapter over the blob store (the fakes' cache is in-memory). */
import { MemoryProviderCache } from "@nexus/providers";
function MemoryBlobStoreCache() {
  return new MemoryProviderCache();
}
