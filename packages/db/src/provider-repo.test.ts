import { beforeEach, describe, expect, it } from "vitest";

import { Db, migrate } from "./index.js";
import { NotFoundError, Repo, ValidationError } from "./repo.js";

/**
 * The provider metering write path (AD-13). Phase 2 created the tables and the
 * call log; Phase 4's budget guard needs to *charge* usage and park a provider,
 * which is what these methods add. Nothing here can be reached without the
 * repository, so the schema stays the single source of truth.
 */
describe("provider metering repository API", () => {
  let db: Db;
  let repo: Repo;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
  });

  it("creates and updates an account idempotently by (adapter, scope)", () => {
    const created = repo.upsertProviderAccount({
      adapter: "openai-compatible",
      credentialsEnv: "NEXUS_LLM_API_KEY",
      quotaWindow: "daily",
      quotaLimit: 200_000,
    });
    expect(created.quota_used).toBe(0);
    expect(created.window_started_at).toBeNull();
    expect(created.enabled).toBe(1);

    const updated = repo.upsertProviderAccount({
      adapter: "openai-compatible",
      quotaWindow: "daily",
      quotaLimit: 100_000,
      enabled: false,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.quota_limit).toBe(100_000);
    expect(updated.enabled).toBe(0);
    expect(repo.listProviderAccounts()).toHaveLength(1);

    // Scoped accounts are separate rows (per-operation budgets).
    repo.upsertProviderAccount({ adapter: "openai-compatible", operationScope: "llm.chat" });
    expect(repo.listProviderAccounts()).toHaveLength(2);
    expect(repo.getProviderAccount("openai-compatible", "llm.chat")).toBeDefined();
    expect(repo.getProviderAccount("openai-compatible")).toBeDefined();
  });

  it("rejects an invalid credentials reference (AD-12: env-var names only)", () => {
    expect(() =>
      repo.upsertProviderAccount({ adapter: "x", credentialsEnv: "not a name" }),
    ).toThrow(ValidationError);
    expect(() =>
      repo.upsertProviderAccount({ adapter: "x", credentialsEnv: "sk-live-secret" }),
    ).toThrow(ValidationError);
    expect(() => repo.upsertProviderAccount({ adapter: "" })).toThrow(ValidationError);
    expect(() => repo.upsertProviderAccount({ adapter: "x", quotaLimit: -1 })).toThrow(
      ValidationError,
    );
  });

  it("charges usage and reads it back", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 100,
    });
    const afterFirst = repo.recordProviderUsage(account.id, 12.5);
    expect(afterFirst.quota_used).toBe(12.5);
    const afterSecond = repo.recordProviderUsage(account.id, 7.5);
    expect(afterSecond.quota_used).toBe(20);
    expect(afterSecond.updated_at >= account.updated_at).toBe(true);
  });

  it("refuses nonsensical usage and unknown accounts", () => {
    const account = repo.upsertProviderAccount({ adapter: "fake" });
    expect(() => repo.recordProviderUsage(account.id, -1)).toThrow(ValidationError);
    expect(() => repo.recordProviderUsage(account.id, Number.NaN)).toThrow(ValidationError);
    expect(() => repo.recordProviderUsage(account.id, Number.POSITIVE_INFINITY)).toThrow(
      ValidationError,
    );
    expect(() => repo.recordProviderUsage("missing", 1)).toThrow(NotFoundError);
    expect(() => repo.resetProviderQuotaWindow("missing")).toThrow(NotFoundError);
    expect(() => repo.stampProviderWindow("missing")).toThrow(NotFoundError);
    expect(() => repo.setProviderCooldown("missing", null)).toThrow(NotFoundError);
  });

  it("stamps a window without touching usage, and resets one that has rolled over", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 6);

    const stamped = repo.stampProviderWindow(account.id, "2024-05-15T00:00:00.000Z");
    expect(stamped.window_started_at).toBe("2024-05-15T00:00:00.000Z");
    expect(stamped.quota_used).toBe(6); // usage survives the stamp

    const reset = repo.resetProviderQuotaWindow(account.id, "2024-06-01T00:00:00.000Z");
    expect(reset.quota_used).toBe(0);
    expect(reset.window_started_at).toBe("2024-06-01T00:00:00.000Z");
    // Without an explicit start the repo stamps "now" (its own clock).
    expect(repo.resetProviderQuotaWindow(account.id).window_started_at).not.toBe(
      "2024-06-01T00:00:00.000Z",
    );
    expect(() => repo.resetProviderQuotaWindow(account.id, "soon")).toThrow(ValidationError);

    expect(() => repo.stampProviderWindow(account.id, "not-a-date")).toThrow(ValidationError);
  });

  it("sets and clears a cooldown", () => {
    const account = repo.upsertProviderAccount({ adapter: "fake" });
    const until = "2024-05-15T12:00:00.000Z";
    expect(repo.setProviderCooldown(account.id, until).cooldown_until).toBe(until);
    expect(repo.setProviderCooldown(account.id, null).cooldown_until).toBeNull();
    expect(() => repo.setProviderCooldown(account.id, "soon")).toThrow(ValidationError);
  });

  it("logs calls and aggregates usage per provider since a timestamp", () => {
    const account = repo.upsertProviderAccount({ adapter: "fake" });
    repo.logProviderCall({
      provider: "fake",
      operation: "llm.chat",
      units: 120,
      durationMs: 900,
      accountId: account.id,
    });
    repo.logProviderCall({
      provider: "fake",
      operation: "tts.synthesize",
      units: 30,
      durationMs: 40,
    });
    repo.logProviderCall({
      provider: "other",
      operation: "research.search",
      units: 1,
      status: "error",
      error: "429",
      cacheKey: "abc",
    });

    const calls = repo.listProviderCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      provider: "other",
      status: "error",
      error: "429",
      cache_key: "abc",
    });

    const usage = repo.providerUsageSince("1970-01-01T00:00:00.000Z");
    expect(usage).toContainEqual({ provider: "fake", units: 150, calls: 2 });
    expect(usage).toContainEqual({ provider: "other", units: 1, calls: 1 });

    // A cutoff in the future sees nothing — the window is honoured.
    expect(repo.providerUsageSince("2999-01-01T00:00:00.000Z")).toHaveLength(0);

    // The provider layer stamps its own clock into the durable row.
    repo.logProviderCall({
      provider: "fake",
      operation: "llm.chat",
      units: 5,
      createdAt: "2024-05-15T00:00:00.000Z",
    });
    expect(repo.listProviderCalls(1)[0]!.created_at).toBe("2024-05-15T00:00:00.000Z");
    expect(() =>
      repo.logProviderCall({ provider: "x", operation: "y", createdAt: "soon" }),
    ).toThrow(ValidationError);

    expect(repo.listProviderCalls(1)).toHaveLength(1);
    expect(() => repo.logProviderCall({ provider: "", operation: "x" })).toThrow(ValidationError);
    expect(() => repo.logProviderCall({ provider: "x", operation: "" })).toThrow(ValidationError);
  });
});
