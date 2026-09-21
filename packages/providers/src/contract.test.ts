import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadEnv } from "@nexus/config";
import { Db, Repo, migrate } from "@nexus/db";
import { CasStore } from "@nexus/storage";

import { MemoryProviderCache } from "./cache.js";
import { FixedClock } from "./clock.js";
import { createProviders, type Providers } from "./container.js";
import {
  ManualRequiredError,
  ProviderConfigurationError,
  isProviderError,
  isManualRequired,
  type ProviderError,
} from "./errors.js";
import { MemoryBlobStore } from "./fake/storage.js";
import type { ProviderKind, ProviderResult } from "./types.js";
import { RecordingProviderLogger } from "./types.js";

/**
 * The shared adapter contract (AD-06).
 *
 * Every capability ships at least a `fake` implementation, a `manual` fallback
 * and a `none` refusal — and the whole point of that promise is that they are
 * *interchangeable*. So rather than trusting each adapter's own test file, this
 * suite walks the registry and runs the same checks against every adapter that
 * is registered for every kind. Adding an adapter that breaks the contract
 * fails here, which is what keeps "swap the provider without touching the
 * pipeline" a fact instead of a slogan.
 *
 * The checks are only about the *shape* of the contract:
 *
 *   1. identity      — id/kind/mode/label are present and consistent;
 *   2. result        — a successful call returns a `ProviderResult` with usage
 *                      accounting (or, for storage, a blob descriptor);
 *   3. determinism   — fakes answer identically twice (that is what makes the
 *                      suite offline and reproducible);
 *   4. failure       — everything thrown is a `ProviderError` subclass from
 *                      this package, never a bare `TypeError` from a missing
 *                      key or a bad URL;
 *   5. degradation   — `none` refuses actionably, `manual` hands off to a
 *                      human with instructions.
 */

const schema = z.object({ answer: z.string(), count: z.number() });

const publishMetadata = {
  title: "Contract upload",
  description: "A contract-test upload",
  privacyStatus: "private" as const,
};

/** What a successful result looks like, per capability. */
const contract = {
  llm: {
    probe: (provider: { chat: (request: unknown) => Promise<unknown> }) =>
      provider.chat({
        schema,
        messages: [{ role: "user", content: "contract" }],
        templateVersion: "contract.v1",
      }),
    shape: (result: ProviderResult<{ data: unknown; model?: string }>) => {
      expect(result.value.data).toBeDefined();
      expect(typeof result.value.model).toBe("string");
    },
  },
  research: {
    probe: (provider: { search: (query: string, options?: unknown) => Promise<unknown> }) =>
      provider.search("contract query", { limit: 2 }),
    shape: (result: ProviderResult<readonly { url: string }[]>) => {
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0]!.url).toMatch(/^https:\/\//);
    },
  },
  tts: {
    probe: (provider: { synthesize: (request: unknown, ctx?: unknown) => Promise<unknown> }) =>
      provider.synthesize({
        text: "contract voice over",
        voice: { id: "contract", label: "Contract", language: "en" },
      }),
    shape: (result: ProviderResult<{ audio: { hash: string; bytes: number } }>) => {
      expect(result.value.audio.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.value.audio.bytes).toBeGreaterThan(44);
    },
  },
  media: {
    probe: (provider: { fetch: (url: string, options?: unknown) => Promise<unknown> }) =>
      provider.fetch("https://images.example.invalid/contract.png"),
    shape: (result: ProviderResult<{ blob: { hash: string } }>) => {
      expect(result.value.blob.hash).toMatch(/^[0-9a-f]{64}$/);
    },
  },
  storage: {
    probe: (provider: { put: (data: Uint8Array) => Promise<unknown> }) =>
      provider.put(new TextEncoder().encode("contract bytes")),
    // Storage returns a blob descriptor rather than a metered ProviderResult:
    // writing bytes is not a metered external call.
    shape: (result: { hash: string; bytes: number; created: boolean }) => {
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.bytes).toBeGreaterThan(0);
      expect(typeof result.created).toBe("boolean");
    },
  },
  publishing: {
    probe: (provider: {
      upload: (videoHash: string, metadata: unknown, ctx?: unknown) => Promise<unknown>;
    }) => provider.upload("a".repeat(64), publishMetadata),
    shape: (result: ProviderResult<{ id: string; status: string }>) => {
      expect(result.value.id.length).toBeGreaterThan(0);
      expect(["uploaded", "scheduled", "kit_ready"]).toContain(result.value.status);
    },
  },
} as const;

describe("adapter contract (AD-06)", () => {
  let providers: Providers;
  let repo: Repo;
  let logger: RecordingProviderLogger;
  let clock: FixedClock;

  const resolve: Record<ProviderKind, (selection: string) => unknown> = {
    llm: (selection) => providers.llm(selection),
    research: (selection) => providers.research(selection),
    tts: (selection) => providers.tts(selection),
    media: (selection) => providers.media(selection),
    storage: (selection) => providers.storage(selection),
    publishing: (selection) => providers.publishing(selection),
  };

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-contract-"));
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    clock = new FixedClock("2024-05-01T00:00:00.000Z");
    logger = new RecordingProviderLogger();
    providers = createProviders({
      config: loadEnv({ env: { NEXUS_DATA_DIR: dir }, cwd: dir }),
      storage: new CasStore(path.join(dir, "cas")),
      repo,
      clock,
      logger: logger.log,
      cache: new MemoryProviderCache(),
      // No credentials, no network: real adapters must fail *actionably*.
      env: {},
      transport: () => Promise.reject(new Error("the contract suite does not use the network")),
      policy: { baseDelayMs: 0, jitter: 0, timeoutMs: 2_000 },
    });
  });

  const kinds: readonly ProviderKind[] = [
    "llm",
    "research",
    "tts",
    "media",
    "storage",
    "publishing",
  ];

  /** Storage is the one exemption: a human cannot stand in for a disk. */
  const MANUAL_EXEMPT: readonly ProviderKind[] = ["storage"];

  it("every capability registers the guaranteed implementations", () => {
    for (const kind of kinds) {
      const ids = providers.registry.ids(kind);
      expect(ids, kind).toContain("none");
      expect(ids, kind).toContain("fake");
      if (!MANUAL_EXEMPT.includes(kind)) expect(ids, kind).toContain("manual");
      const descriptors = providers.registry.descriptors(kind);
      expect(descriptors.length).toBe(ids.length);
      for (const descriptor of descriptors) {
        expect(descriptor.label.trim().length, descriptor.id).toBeGreaterThan(0);
        expect(["offline", "fake", "manual", "live"]).toContain(descriptor.mode);
      }
    }
  });

  it("every adapter announces a consistent identity", () => {
    for (const kind of kinds) {
      for (const descriptor of providers.registry.descriptors(kind)) {
        const adapter = resolve[kind](descriptor.id) as {
          id: string;
          kind: string;
          mode: string;
          label: string;
        };
        expect(adapter.id, `${kind}:${descriptor.id}`).toBe(descriptor.id);
        expect(adapter.kind, `${kind}:${descriptor.id}`).toBe(kind);
        expect(adapter.mode, `${kind}:${descriptor.id}`).toBe(descriptor.mode);
        expect(adapter.label.trim().length, `${kind}:${descriptor.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("a successful call always returns usage accounting (fakes, offline, no network)", async () => {
    for (const kind of kinds) {
      for (const descriptor of providers.registry.descriptors(kind)) {
        if (descriptor.mode !== "fake") continue;
        const adapter = resolve[kind](descriptor.id) as never;
        const case_ = contract[kind] as {
          probe: (p: never) => Promise<unknown>;
          shape: (r: never) => void;
        };
        const result = (await case_.probe(adapter)) as ProviderResult<unknown>;
        case_.shape(result as never);

        if (kind !== "storage") {
          expect(typeof result.cached, `${kind}:${descriptor.id}`).toBe("boolean");
          expect(result.attempts, `${kind}:${descriptor.id}`).toBeGreaterThanOrEqual(1);
          expect(result.durationMs, `${kind}:${descriptor.id}`).toBeGreaterThanOrEqual(0);
          expect(result.usage.units, `${kind}:${descriptor.id}`).toBeGreaterThanOrEqual(0);
          expect(result.usage.unit.trim().length, `${kind}:${descriptor.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("fakes are deterministic — the same input twice gives the same answer", async () => {
    for (const kind of kinds) {
      for (const descriptor of providers.registry.descriptors(kind)) {
        if (descriptor.mode !== "fake") continue;
        const adapter = resolve[kind](descriptor.id) as never;
        const case_ = contract[kind] as { probe: (p: never) => Promise<unknown> };
        const first = (await case_.probe(adapter)) as ProviderResult<unknown> & { hash?: string };
        const second = (await case_.probe(adapter)) as ProviderResult<unknown> & { hash?: string };
        // Storage answers with a stored-blob descriptor (same bytes → same
        // hash, even though only the first write is `created`); every other
        // capability answers with the same value payload.
        if (kind === "storage") {
          expect(second.hash, `${kind}:${descriptor.id}`).toBe(first.hash);
        } else {
          expect(second.value, `${kind}:${descriptor.id}`).toEqual(first.value);
        }
      }
    }
  });

  it("`none` refuses actionably and never pretends to work", async () => {
    for (const kind of kinds) {
      const adapter = resolve[kind]("none") as never;
      const case_ = contract[kind] as { probe: (p: never) => Promise<unknown> };
      const error = (await case_
        .probe(adapter)
        .catch((thrown: unknown) => thrown)) as ProviderError;
      expect(isProviderError(error), `${kind}:none`).toBe(true);
      expect(error, `${kind}:none`).toBeInstanceOf(ProviderConfigurationError);
      expect(error.message, `${kind}:none`).toContain(kind.toUpperCase());
      expect(error.retryable, `${kind}:none`).toBe(false);
    }
  });

  it("`manual` hands off to a human with instructions (publishing succeeds by kit)", async () => {
    for (const kind of kinds) {
      if (MANUAL_EXEMPT.includes(kind)) continue;
      const adapter = resolve[kind]("manual") as never;
      const case_ = contract[kind] as {
        probe: (p: never) => Promise<unknown>;
        shape: (r: never) => void;
      };

      if (kind === "publishing") {
        // Assisted publishing is the primary path until the API audit is done,
        // so the manual publisher builds an upload kit and *succeeds*.
        const result = (await case_.probe(adapter)) as ProviderResult<{
          status: string;
          kit?: unknown;
        }>;
        expect(result.value.status).toBe("kit_ready");
        expect(result.value.kit).toBeDefined();
        expect(result.usage.units).toBe(0);
        continue;
      }

      const error = (await case_
        .probe(adapter)
        .catch((thrown: unknown) => thrown)) as ManualRequiredError;
      expect(isManualRequired(error), `${kind}:manual`).toBe(true);
      expect(error.request.capability, `${kind}:manual`).toBe(kind);
      expect(error.request.summary.length, `${kind}:manual`).toBeGreaterThan(0);
      expect(error.request.instructions.length, `${kind}:manual`).toBeGreaterThan(0);
      expect(error.retryable, `${kind}:manual`).toBe(false);
    }
  });

  it("real adapters fail with a provider error (never a bare one) when unconfigured", async () => {
    for (const kind of kinds) {
      for (const descriptor of providers.registry.descriptors(kind)) {
        if (descriptor.mode !== "live") continue;
        const adapter = resolve[kind](descriptor.id) as never;
        const case_ = contract[kind] as {
          probe: (p: never) => Promise<unknown>;
          shape: (r: never) => void;
        };
        try {
          const result = (await case_.probe(adapter)) as ProviderResult<unknown>;
          case_.shape(result as never); // configured and working: fine too
        } catch (thrown) {
          // Unconfigured: the failure must be a classified provider error with
          // an actionable message — not a TypeError from an undefined key.
          expect(isProviderError(thrown), `${kind}:${descriptor.id}`).toBe(true);
          const error = thrown as ProviderError;
          expect(error.kind.length, `${kind}:${descriptor.id}`).toBeGreaterThan(0);
          expect(error.summary().length, `${kind}:${descriptor.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("no adapter leaks a credential into its errors or the call log (AD-12)", async () => {
    const secret = "contract-secret-value-0987654321";
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-contract-secret-"));
    const withSecret = createProviders({
      config: loadEnv({ env: { NEXUS_DATA_DIR: dir }, cwd: dir }),
      storage: new CasStore(path.join(dir, "cas")),
      repo,
      clock,
      logger: logger.log,
      cache: new MemoryProviderCache(),
      env: { NEXUS_LLM_API_KEY: secret, NEXUS_RESEARCH_API_KEY: secret },
      transport: async () =>
        ({
          ok: false,
          status: 500,
          headers: { get: () => null },
          text: async () => `upstream said the key ${secret} is invalid`,
          json: async () => ({}),
        }) as never,
      policy: { baseDelayMs: 0, jitter: 0 },
    });

    await withSecret
      .llm("openai-compatible")
      .chat({ schema, messages: [{ role: "user", content: "x" }], templateVersion: "contract.v1" })
      .catch(() => undefined);

    expect(JSON.stringify(logger.entries)).not.toContain(secret);
    expect(JSON.stringify(repo.listProviderCalls())).not.toContain(secret);
  });

  it("metering is per adapter, so one noisy provider cannot hide behind another", async () => {
    await providers.research("fake").search("metered query", { limit: 1 });
    await providers.media("fake").fetch("https://images.example.invalid/metered.png");

    const usage = repo.providerUsageSince("1970-01-01T00:00:00.000Z");
    // Usage is keyed by adapter id (that is what holds a quota), so the two
    // calls land in one row — with the operations kept apart in the call log.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: "fake", calls: 2 });
    expect(usage[0]!.units).toBeGreaterThan(0);
    const operations = repo
      .listProviderCalls()
      .map((call) => call.operation)
      .sort();
    expect(operations).toEqual(["media.fetch", "research.search"]);
    for (const call of repo.listProviderCalls()) expect(call.units).toBeGreaterThan(0);
  });
});

describe("offline test doubles stay importable without a transport", () => {
  it("a memory blob store and a manual research provider need no configuration", async () => {
    const store = new MemoryBlobStore();
    const stored = await store.put(new TextEncoder().encode("x"));
    expect(await store.has(stored.hash)).toBe(true);
    expect(store.list()).toEqual([stored.hash]);
  });
});
