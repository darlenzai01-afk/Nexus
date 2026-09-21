/**
 * Time is injected everywhere in this layer.
 *
 * Quota windows, cooldowns, cache ages and retry delays are all clock
 * dependent, and a test that has to `sleep(60_000)` to prove a daily window
 * rolls over is a test nobody runs. `FixedClock` makes those paths instant and
 * deterministic instead.
 */
export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

/** A clock that only moves when a test says so. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: string | Date = "2024-01-01T00:00:00.000Z") {
    this.current = typeof start === "string" ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  nowIso(): string {
    return this.current.toISOString();
  }

  /** Advance by milliseconds (may be negative to travel back). */
  advance(ms: number): this {
    this.current = new Date(this.current.getTime() + ms);
    return this;
  }

  set(instant: string | Date): this {
    this.current = typeof instant === "string" ? new Date(instant) : new Date(instant.getTime());
    return this;
  }
}
