/**
 * Client-side rate limiting.
 *
 * Server-side 429s are handled by the call pipeline (honour `Retry-After`,
 * then cooldown). This is the *self-imposed* limit: free tiers often do not
 * publish a hard request budget, they simply start failing, so the polite
 * thing to do is stay under a configured rate instead of discovering the wall.
 * A token bucket is enough — no dependency, no distributed state, and the
 * worker pool is a single process by design (OD-6).
 */
export interface RateLimiter {
  /** Take one permit if available; false means "call `msUntilAvailable`". */
  tryAcquire(cost?: number): boolean;
  msUntilAvailable(cost?: number): number;
}

export const unlimitedRateLimiter: RateLimiter = {
  tryAcquire: () => true,
  msUntilAvailable: () => 0,
};

export class TokenBucket implements RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(perMinute) || perMinute <= 0) {
      throw new TypeError("TokenBucket requires a positive per-minute rate");
    }
    this.tokens = perMinute;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.lastRefillMs;
    if (elapsed <= 0) return;
    const gained = (elapsed / 60_000) * this.perMinute;
    this.tokens = Math.min(this.perMinute, this.tokens + gained);
    this.lastRefillMs = current;
  }

  tryAcquire(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  msUntilAvailable(cost = 1): number {
    this.refill();
    const missing = cost - this.tokens;
    if (missing <= 0) return 0;
    return Math.ceil((missing / this.perMinute) * 60_000);
  }
}
