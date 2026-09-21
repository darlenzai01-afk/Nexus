import { beforeEach, describe, expect, it } from "vitest";

import { Db, Repo, migrate } from "@nexus/db";

import { FixedClock } from "./clock.js";
import { BudgetGuard } from "./quota.js";

/**
 * The free-tier budget guard (AD-13): fail closed at the cap, degrade before
 * it, meter everything, and roll windows over in UTC.
 */
describe("BudgetGuard", () => {
  let db: Db;
  let repo: Repo;
  let clock: FixedClock;
  let guard: BudgetGuard;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    clock = new FixedClock("2024-05-15T10:00:00.000Z");
    guard = new BudgetGuard({ repo, clock, degradeRatio: 0.9 });
  });

  it("allows an unmetered adapter (no account row) without degrading", () => {
    const decision = guard.evaluate("unnknown-adapter");
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(false);
    expect(decision.account).toBeUndefined();
  });

  it("allows a finite window below the degrade threshold", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 100,
    });
    repo.recordProviderUsage(account.id, 50);
    const decision = guard.evaluate("fake");
    expect(decision).toMatchObject({ allowed: true, degraded: false });
    expect(decision.usedRatio).toBeCloseTo(0.5);
    expect(decision.remaining).toBe(50);
  });

  it("flags degradation at the configured ratio (before the wall, not after)", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 100,
    });
    repo.recordProviderUsage(account.id, 90);
    const decision = guard.evaluate("fake");
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.reason).toContain("90%");
    expect(decision.remaining).toBe(10);
  });

  it("fails closed once the window is exhausted", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 10);
    const decision = guard.evaluate("fake");
    expect(decision.allowed).toBe(false);
    expect(decision.degraded).toBe(true);
    expect(decision.remaining).toBe(0);
    expect(decision.reason).toContain("quota exhausted");
  });

  it("refuses a disabled account until the operator enables it", () => {
    repo.upsertProviderAccount({ adapter: "fake", enabled: false });
    expect(guard.evaluate("fake")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("disabled"),
    });
    repo.upsertProviderAccount({ adapter: "fake", enabled: true });
    expect(guard.evaluate("fake").allowed).toBe(true);
  });

  it("honours a cooldown and reports how long is left", () => {
    repo.upsertProviderAccount({ adapter: "fake" });
    guard.cooldown("fake", 30_000);
    const decision = guard.evaluate("fake");
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(30_000);
    expect(decision.reason).toContain("cooling down");

    clock.advance(30_001);
    expect(guard.evaluate("fake").allowed).toBe(true);
  });

  it("meters consumption into the account and the call log", () => {
    repo.upsertProviderAccount({ adapter: "fake", quotaWindow: "daily", quotaLimit: 100 });
    guard.record("fake", 25);
    guard.record("fake", 5);
    expect(repo.getProviderAccount("fake")?.quota_used).toBe(30);
    // record() is a no-op for adapters with no account, so nothing explodes.
    expect(() => guard.record("no-account", 10)).not.toThrow();
  });

  it("rolls a daily window over at UTC midnight", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 10);
    expect(guard.evaluate("fake").allowed).toBe(false);

    clock.set("2024-05-16T00:00:01.000Z"); // next UTC day
    const rolled = guard.evaluate("fake");
    expect(rolled.allowed).toBe(true);
    expect(rolled.account?.quota_used).toBe(0);
    expect(rolled.account?.window_started_at).toBe("2024-05-16T00:00:00.000Z");
  });

  it("keeps a daily window open across a within-day restart", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 4);
    clock.advance(6 * 60 * 60 * 1000); // six hours later, same UTC day
    const decision = guard.evaluate("fake");
    expect(decision.account?.quota_used).toBe(4);
    expect(decision.account?.window_started_at).toBe("2024-05-15T00:00:00.000Z");
  });

  it("rolls a monthly window over on the first of the month", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "monthly",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 10);
    expect(guard.evaluate("fake").allowed).toBe(false);

    clock.set("2024-06-01T00:00:01.000Z");
    expect(guard.evaluate("fake").allowed).toBe(true);
    expect(repo.getProviderAccount("fake")?.window_started_at).toBe("2024-06-01T00:00:00.000Z");
  });

  it("does not zero usage when it first stamps a window (pre-stamp usage counts)", () => {
    const account = repo.upsertProviderAccount({
      adapter: "fake",
      quotaWindow: "daily",
      quotaLimit: 10,
    });
    repo.recordProviderUsage(account.id, 7); // usage before any window was stamped
    const decision = guard.evaluate("fake");
    expect(decision.account?.quota_used).toBe(7);
    expect(decision.account?.window_started_at).not.toBeNull();
    expect(decision.degraded).toBe(false);
  });

  it("treats a null limit as unmetered and exposes a status view for the dashboard", () => {
    repo.upsertProviderAccount({ adapter: "fake", quotaWindow: "daily" }); // no limit set
    expect(guard.evaluate("fake")).toMatchObject({ allowed: true, degraded: false });
    const status = guard.status("fake");
    expect(status).toMatchObject({ allowed: true, window: "daily", used: 0 });
  });

  it("works without a repository at all (tests, --dry-run)", () => {
    const repoLess = new BudgetGuard({ clock });
    expect(repoLess.evaluate("fake").allowed).toBe(true);
    expect(() => repoLess.record("fake", 5)).not.toThrow();
    expect(() => repoLess.cooldown("fake", 1_000)).not.toThrow();
  });
});
