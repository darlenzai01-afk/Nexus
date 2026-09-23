/**
 * Provider-layer vocabulary (AD-06).
 *
 * Two rules shape everything here:
 *
 * 1. **No vendor types cross this boundary.** A capability interface mentions
 *    only our own shapes, so swapping an adapter never ripples into domain
 *    code.
 * 2. **Every call is metered and enveloped.** Providers return
 *    `ProviderResult<T>` (never a bare value), because the caller needs to know
 *    which adapter answered, whether it came from cache, how many attempts it
 *    took and what it consumed — that is what makes the free-tier budget
 *    (AD-13) and the audit trail real rather than aspirational.
 */

/** The capabilities the system depends on. One interface per kind. */
export type ProviderKind = "llm" | "research" | "tts" | "media" | "storage" | "publishing";

/**
 * How a capability is currently satisfied. `offline` is the honest state of an
 * unconfigured capability: it exists, it is reachable in code, and it refuses
 * to pretend it can do the work.
 */
export type ProviderMode = "live" | "fake" | "manual" | "offline";

/** Identity + provenance of an adapter implementation. */
export interface ProviderMeta {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly mode: ProviderMode;
  /** Human-readable name for the dashboard and logs. */
  readonly label: string;
}

/** What a call consumed, in the unit that provider is billed in. */
export type UnitKind = "tokens" | "characters" | "requests" | "bytes" | "uploads" | "seconds";

export interface Usage {
  readonly units: number;
  readonly unit: UnitKind;
}

/**
 * Per-call options. `signal` is how a worker shutdown propagates into a
 * provider call; `timeoutMs` overrides the policy deadline for this call only.
 */
export interface CallContext {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Job id / episode id — carried into provider logs for tracing. */
  readonly correlationId?: string;
}

/**
 * The structured result envelope every provider method returns.
 *
 * `cached` is not cosmetic: a cache hit costs nothing and must not be metered,
 * so the envelope makes the difference explicit to callers and dashboards.
 */
export interface ProviderResult<T> {
  readonly value: T;
  /** Adapter id that produced the value (or served it from cache). */
  readonly provider: string;
  readonly operation: string;
  readonly cached: boolean;
  readonly attempts: number;
  readonly durationMs: number;
  readonly usage: Usage;
}

/**
 * Retry/backoff shape for provider calls. Deliberately the same shape as the
 * job runner's policy (packages/jobs) so a stage retry and an in-call retry
 * cannot drift into two different notions of "backoff".
 */
export interface ProviderRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
}

/**
 * Everything the call pipeline needs. Values come from validated environment
 * configuration (`AppConfig.providerPolicy`) unless a test or an operator
 * overrides them.
 */
export interface ProviderPolicy extends ProviderRetryPolicy {
  readonly timeoutMs: number;
  readonly cacheEnabled: boolean;
  /** Fraction of a free-tier budget at which we degrade to manual (AD-06/AD-13). */
  readonly degradeRatio: number;
  /** Client-side safety valve: max calls per minute per adapter (0 = unlimited). */
  readonly rateLimitPerMinute: number;
}

export const DEFAULT_PROVIDER_POLICY: ProviderPolicy = {
  timeoutMs: 30_000,
  maxAttempts: 3,
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 60_000,
  jitter: 0.2,
  cacheEnabled: true,
  degradeRatio: 0.9,
  rateLimitPerMinute: 0,
};

export interface ProviderLogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly [key: string]: unknown;
}

/** Operational logging (stdout). Durable per-call metering lives in the DB. */
export type ProviderLogger = (entry: ProviderLogEntry) => void;

export const silentProviderLogger: ProviderLogger = () => {};

/** Records every provider log entry — used by tests to assert on behaviour. */
export class RecordingProviderLogger {
  readonly entries: ProviderLogEntry[] = [];

  readonly log: ProviderLogger = (entry) => {
    this.entries.push(entry);
  };

  events(): string[] {
    return this.entries.map((entry) => entry.event);
  }

  find(event: string): ProviderLogEntry | undefined {
    return this.entries.find((entry) => entry.event === event);
  }
}

/**
 * Minimal structural schema contract (satisfied by zod schemas). Structural
 * rather than a zod generic so a schema-library upgrade cannot break the
 * provider layer's type checking.
 */
export interface SchemaLike<T> {
  parse(input: unknown): T;
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly path: readonly (string | number)[];
            readonly message: string;
          }[];
        };
      };
}

/** Environment lookup, injectable so tests never touch `process.env`. */
export type EnvLike = Readonly<Record<string, string | undefined>>;
