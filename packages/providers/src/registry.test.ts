import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { Db, Repo, migrate } from "@nexus/db";
import { loadEnv } from "@nexus/config";

import { MemoryBlobStore } from "./fake/storage.js";
import { FixedClock } from "./clock.js";
import { ProviderConfigurationError } from "./errors.js";
import { createProviders } from "./container.js";
import { RecordingProviderLogger } from "./types.js";

/**
 * Selection and wiring: which adapter serves a capability, what happens when
 * the configuration is wrong, and how quota pressure degrades a *live* adapter
 * to the manual one without any code change.
 */
describe("provider registry and container", () => {
  let db: Db;
  let repo: Repo;
  let clock: FixedClock;
  let logger: RecordingProviderLogger;
  let dataDir: string;

  const providers = (env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) =>
    createProviders({
      config: loadEnv({ env: { NEXUS_DATA_DIR: dataDir, ...env }, cwd: dataDir }),
      storage: new MemoryBlobStore(),
      repo,
      clock,
      logger: logger.log,
      ...overrides,
    });

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    clock = new FixedClock("2024-05-01T00:00:00.000Z");
    logger = new RecordingProviderLogger();
    dataDir = mkdtempSync(path.join(tmpdir(), "nexus-providers-"));
  });

  it("resolves nothing into an offline provider that explains how to configure it", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "none" });
    const capability = p.capability("llm");
    expect(capability).toMatchObject({ adapterId: "none", mode: "offline", degraded: false });

    expect(() => p.llm()).not.toThrow(); // resolution is lazy-safe; calling is not
    const llm = p.llm();
    return expect(
      llm.chat({
        schema: {
          parse: (v: unknown) => v,
          safeParse: (v: unknown) => ({ success: true, data: v }),
        },
        messages: [],
        templateVersion: "v1",
      } as never),
    ).rejects.toThrow(/NEXUS_LLM_PROVIDER/);
  });

  it("selects the configured adapter per capability", () => {
    const p = providers({
      NEXUS_LLM_PROVIDER: "fake",
      NEXUS_TTS_PROVIDER: "fake",
      NEXUS_RESEARCH_PROVIDER: "manual",
      NEXUS_MEDIA_PROVIDER: "none",
    });
    expect(p.llm().id).toBe("fake");
    expect(p.tts().id).toBe("fake");
    expect(p.research().id).toBe("manual");
    expect(p.media().id).toBe("none");
    // Storage defaults to the local CAS-backed adapter.
    expect(p.storage()).toMatchObject({ id: "local", mode: "live" });
    expect(p.capability("publishing")).toMatchObject({ adapterId: "none", mode: "offline" });
  });

  it("lets a call site override the configured adapter", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "none" });
    expect(p.llm("fake").id).toBe("fake");
    expect(p.capability("llm", "fake")).toMatchObject({ requestedId: "fake", adapterId: "fake" });
  });

  it("parses a variant selection (model after the first colon)", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "openai-compatible:meta-llama/llama-3.1-8b" });
    const capability = p.capability("llm");
    expect(capability.adapterId).toBe("openai-compatible");
    expect(capability.variant).toBe("meta-llama/llama-3.1-8b");
    expect(capability.mode).toBe("live");
  });

  it("fails fast on an unknown adapter and lists the registered ones", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "gpt-5" });
    expect(() => p.capability("llm")).toThrow(ProviderConfigurationError);
    expect(() => p.capability("llm")).toThrow(/Registered: .*fake.*manual.*none/);
    expect(p.registry.ids("llm").sort()).toEqual(["fake", "manual", "none", "openai-compatible"]);
  });

  it("degrades a live adapter to manual once its quota window is nearly spent", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "openai-compatible" });
    expect(p.capability("llm")).toMatchObject({ adapterId: "openai-compatible", degraded: false });

    const account = repo.upsertProviderAccount({
      adapter: "openai-compatible",
      quotaWindow: "daily",
      quotaLimit: 100,
    });
    repo.recordProviderUsage(account.id, 95);

    const degraded = p.capability("llm");
    expect(degraded).toMatchObject({
      adapterId: "manual",
      mode: "manual",
      degraded: true,
      requestedId: "openai-compatible",
    });
    expect(degraded.reason).toContain("95%");
    // The degradation is announced once, not on every call.
    expect(logger.entries.filter((entry) => entry.event === "provider.degraded")).toHaveLength(1);
    p.capability("llm");
    expect(logger.entries.filter((entry) => entry.event === "provider.degraded")).toHaveLength(1);

    // When the window rolls over, the live adapter comes back automatically.
    clock.set("2024-05-02T00:00:01.000Z");
    expect(p.capability("llm")).toMatchObject({ adapterId: "openai-compatible", degraded: false });
  });

  it("does not degrade a fake or offline adapter (there is nothing to save)", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "fake", NEXUS_TTS_PROVIDER: "none" });
    repo.upsertProviderAccount({ adapter: "fake", quotaWindow: "daily", quotaLimit: 1 });
    repo.recordProviderUsage(repo.getProviderAccount("fake")!.id, 1);
    expect(p.capability("llm")).toMatchObject({ adapterId: "fake", degraded: false });
    expect(p.capability("tts")).toMatchObject({ adapterId: "none", degraded: false });
  });

  it("returns the same instance for a stable selection, and a new one after degrading", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "fake" });
    expect(p.llm()).toBe(p.llm());

    const live = providers({ NEXUS_LLM_PROVIDER: "openai-compatible" });
    const before = live.llm();
    expect(before.id).toBe("openai-compatible");
    const account = repo.upsertProviderAccount({
      adapter: "openai-compatible",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 10);
    const after = live.llm();
    expect(after.id).toBe("manual");
    expect(after).not.toBe(before);
  });

  it("lists every capability for the dashboard, with its mode", () => {
    const p = providers({ NEXUS_LLM_PROVIDER: "fake", NEXUS_PUBLISHING_PROVIDER: "manual" });
    const rows = p.listCapabilities();
    expect(rows.map((row) => row.kind)).toEqual([
      "llm",
      "research",
      "tts",
      "media",
      "storage",
      "publishing",
    ]);
    expect(rows.find((row) => row.kind === "storage")?.mode).toBe("live");
    expect(rows.find((row) => row.kind === "publishing")?.adapterId).toBe("manual");
  });

  it("honours policy overrides and disables the cache when configured off", () => {
    const p = providers(
      {
        NEXUS_PROVIDER_CACHE: "off",
        NEXUS_PROVIDER_TIMEOUT_MS: "1234",
        NEXUS_PROVIDER_MAX_ATTEMPTS: "5",
      },
      { policy: { degradeRatio: 0.5 } },
    );
    expect(p.policy).toMatchObject({
      timeoutMs: 1_234,
      maxAttempts: 5,
      cacheEnabled: false,
      degradeRatio: 0.5,
    });
  });

  it("builds a durable provider cache under the data dir by default", () => {
    const p = providers({ NEXUS_PROVIDER_CACHE: "on" });
    expect(p.policy.cacheEnabled).toBe(true);
    // A resolved fake still works end-to-end (cache object is wired, not null).
    expect(p.llm("fake").id).toBe("fake");
  });

  it("keeps a fresh container free of another container's state", () => {
    const first = providers({ NEXUS_STORAGE_PROVIDER: "fake" });
    const second = providers({ NEXUS_STORAGE_PROVIDER: "fake" });
    return (async () => {
      const stored = await first.storage().put(new TextEncoder().encode("artifact"));
      expect(await first.storage().has(stored.hash)).toBe(true);
      expect(await second.storage().has(stored.hash)).toBe(false);
    })();
  });
});
