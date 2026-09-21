import type { Repo } from "@nexus/db";
import type { ProviderAccountRow } from "@nexus/db";

import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";

/**
 * The free-tier budget guard (AD-13).
 *
 * Three behaviours, in order of importance:
 *
 * 1. **Fail closed at the cap.** Once `quota_used >= quota_limit` no call is
 *    sent; the caller gets a `ProviderQuotaError` which a task turns into a
 *    parked job (`{ waiting: "QUOTA" }`), not a failed episode.
 * 2. **Degrade before the wall.** At `degradeRatio` (default 90%) of the
 *    window the capability is reported as `degraded`, and the registry switches
 *    that kind to its `Manual*` implementation — the operator finds out before
 *    the quota is gone, not after.
 * 3. **Meter everything.** Consumption is written to `provider_accounts`
 *    (window counter) and every call — including cache hits, at zero units — to
 *    `provider_call_log`, so "what did this cost?" is a query, not a guess.
 *
 * Window rollover is computed here rather than in the database: SQLite stays a
 * dumb store, policy stays in code where it is testable.
 */
export interface BudgetDecision {
  readonly allowed: boolean;
  readonly degraded: boolean;
  readonly reason?: string;
  readonly account?: ProviderAccountRow;
  readonly usedRatio?: number;
  readonly remaining?: number;
  readonly retryAfterMs?: number;
}

export interface BudgetGuardOptions {
  readonly repo?: Repo;
  readonly clock?: Clock;
  readonly degradeRatio?: number;
}

export class BudgetGuard {
  private readonly repo: Repo | undefined;
  private readonly clock: Clock;
  readonly degradeRatio: number;

  constructor(options: BudgetGuardOptions = {}) {
    this.repo = options.repo;
    this.clock = options.clock ?? systemClock;
    this.degradeRatio = options.degradeRatio ?? 0.9;
  }

  /**
   * Decide whether a call may proceed. Rolls the quota window over first, so a
   * daily limit really is daily even if the process ran through midnight.
   */
  evaluate(adapter: string, operationScope = "*"): BudgetDecision {
    const account = this.account(adapter, operationScope);
    if (!account) return { allowed: true, degraded: false };

    const rolled = this.rollWindowIfStale(account);
    if (rolled.enabled !== 1) {
      return {
        allowed: false,
        degraded: false,
        account: rolled,
        reason: `provider account '${adapter}' is disabled`,
      };
    }

    const cooldownUntil =
      rolled.cooldown_until === null ? undefined : Date.parse(rolled.cooldown_until);
    if (cooldownUntil !== undefined && cooldownUntil > this.nowMs()) {
      const retryAfterMs = cooldownUntil - this.nowMs();
      return {
        allowed: false,
        degraded: false,
        account: rolled,
        retryAfterMs,
        reason: `provider '${adapter}' is cooling down until ${rolled.cooldown_until}`,
      };
    }

    const limit = rolled.quota_limit;
    if (limit === null || limit <= 0) {
      return { allowed: true, degraded: false, account: rolled };
    }

    const usedRatio = rolled.quota_used / limit;
    const remaining = Math.max(0, limit - rolled.quota_used);
    if (rolled.quota_used >= limit) {
      return {
        allowed: false,
        degraded: true,
        account: rolled,
        usedRatio,
        remaining: 0,
        reason: `quota exhausted for '${adapter}' (${rolled.quota_used}/${limit} ${rolled.quota_window})`,
      };
    }
    if (usedRatio >= this.degradeRatio) {
      return {
        allowed: true,
        degraded: true,
        account: rolled,
        usedRatio,
        remaining,
        reason: `'${adapter}' is at ${Math.round(usedRatio * 100)}% of its ${rolled.quota_window} budget`,
      };
    }
    return { allowed: true, degraded: false, account: rolled, usedRatio, remaining };
  }

  /** Charge consumption to the account (no-op when the adapter is unmetered). */
  record(adapter: string, units: number, operationScope = "*"): void {
    if (!this.repo || units <= 0) return;
    const account = this.account(adapter, operationScope);
    if (!account) return;
    this.repo.recordProviderUsage(account.id, units);
  }

  /** Park a provider until `retryAfterMs` from now (rate-limit handling). */
  cooldown(adapter: string, retryAfterMs: number, operationScope = "*"): void {
    if (!this.repo || retryAfterMs <= 0) return;
    const account = this.account(adapter, operationScope);
    if (!account) return;
    this.repo.setProviderCooldown(account.id, new Date(this.nowMs() + retryAfterMs).toISOString());
  }

  /** Operator-facing budget view (the dashboard metric AD-13 asks for). */
  status(adapter: string, operationScope = "*"): BudgetDecision & { used: number; window: string } {
    const decision = this.evaluate(adapter, operationScope);
    return {
      ...decision,
      used: decision.account?.quota_used ?? 0,
      window: decision.account?.quota_window ?? "none",
    };
  }

  private account(adapter: string, operationScope: string): ProviderAccountRow | undefined {
    return this.repo?.getProviderAccount(adapter, operationScope);
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  /** Start of the current window, in UTC. */
  windowStart(window: ProviderAccountRow["quota_window"], now: Date): Date | undefined {
    if (window === "none") return undefined;
    if (window === "daily") {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private rollWindowIfStale(account: ProviderAccountRow): ProviderAccountRow {
    const now = this.clock.now();
    const start = this.windowStart(account.quota_window, now);
    if (!start || !this.repo) return account;

    // No window has ever been recorded: usage already charged belongs to the
    // current window, so stamp the start rather than zeroing the counter.
    if (account.window_started_at === null) {
      const stamp = new Date(Math.max(start.getTime(), 0)).toISOString();
      return this.repo.stampProviderWindow(account.id, stamp);
    }

    const startedAt = Date.parse(account.window_started_at);
    if (startedAt >= start.getTime()) return account;
    return this.repo.resetProviderQuotaWindow(account.id, start.toISOString());
  }
}
