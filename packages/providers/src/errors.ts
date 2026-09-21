import type { ProviderKind } from "./types.js";

/**
 * Provider error taxonomy.
 *
 * The point of naming failures is *policy*: rate limits and timeouts are worth
 * another attempt, a bad API key is not, a quota wall must park the job at a
 * human gate instead of burning the remaining budget, and an operator
 * cancellation must never be retried. Every adapter funnels its failures
 * through `classifyProviderError`, so an adapter author cannot accidentally
 * make "invalid API key" retryable.
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "invalid_request"
  | "unavailable"
  | "content"
  | "canceled"
  | "configuration"
  | "manual";

export interface ProviderErrorInit {
  readonly kind: ProviderErrorKind;
  readonly provider?: string;
  readonly operation?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Kind → retryable default. A specific error may override it. */
const RETRYABLE: Readonly<Record<ProviderErrorKind, boolean>> = {
  auth: false,
  rate_limit: true,
  // A quota wall is fail-closed: retrying inside the same window cannot help.
  // The *job* is parked at a gate (or its next attempt lands in a new window).
  quota: false,
  timeout: true,
  invalid_request: false,
  unavailable: true,
  // The model produced unusable output; a fresh sample often succeeds, so this
  // is retryable — but always bounded by the attempt ceiling.
  content: true,
  canceled: false,
  configuration: false,
  manual: false,
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly operation: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, init: ProviderErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ProviderError";
    this.kind = init.kind;
    this.provider = init.provider ?? "unknown";
    this.operation = init.operation ?? "unknown";
    this.retryable = init.retryable ?? RETRYABLE[init.kind];
    this.retryAfterMs = init.retryAfterMs;
    this.status = init.status;
    this.details = init.details;
  }

  /** One-line summary used in logs and in the persisted provider_call_log row. */
  summary(): string {
    const retryIn = this.retryAfterMs !== undefined ? `, retry in ${this.retryAfterMs}ms` : "";
    return `[${this.kind}] ${this.provider}.${this.operation}: ${this.message}${retryIn}`;
  }
}

const subclass = (
  kind: ProviderErrorKind,
  defaults: Partial<ProviderErrorInit> = {},
): new (message: string, init?: Omit<ProviderErrorInit, "kind">) => ProviderError =>
  class extends ProviderError {
    constructor(message: string, init: Omit<ProviderErrorInit, "kind"> = {}) {
      super(message, { kind, ...defaults, ...init });
    }
  };

/** Missing/invalid credentials (401/403, no API key). Never retried. */
export const ProviderAuthError = subclass("auth");
/** 429 / local rate-limit guard. Retryable, honours `retryAfterMs`. */
export const ProviderRateLimitError = subclass("rate_limit");
/** Free-tier window exhausted, or the account is disabled. Fails closed. */
export const ProviderQuotaError = subclass("quota");
/** Deadline exceeded. Retryable. */
export const ProviderTimeoutError = subclass("timeout");
/** The request was malformed or unsupported (400/404/422). Never retried. */
export const ProviderInvalidRequestError = subclass("invalid_request");
/** Network/5xx. Retryable. */
export const ProviderUnavailableError = subclass("unavailable");
/** The provider answered, but its content could not satisfy the contract. */
export const ProviderContentError = subclass("content");
/** Operator/worker cancellation (shutdown). Never retried. */
export const ProviderCanceledError = subclass("canceled");
/** Broken wiring or configuration — a programming error, never retried. */
export const ProviderConfigurationError = subclass("configuration");

/**
 * Raised by a `Manual*` provider: the capability has degraded to
 * human-in-the-loop, and these instructions describe what the operator must
 * supply. Tasks convert this into a job gate (`{ waiting: ... }`) so nothing is
 * lost while a human works.
 */
export class ManualRequiredError extends ProviderError {
  readonly request: ManualRequest;

  constructor(request: ManualRequest) {
    super(`${request.capability}.${request.operation} needs an operator: ${request.summary}`, {
      kind: "manual",
      provider: "manual",
      operation: request.operation,
      retryable: false,
      details: { instructions: request.instructions },
    });
    this.name = "ManualRequiredError";
    this.request = request;
  }
}

export interface ManualRequest {
  readonly capability: ProviderKind;
  readonly operation: string;
  readonly summary: string;
  readonly instructions: readonly string[];
  readonly expectedFormat?: string;
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** HTTP status → provider error kind (the mapping every HTTP adapter shares). */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 425) return "timeout";
  if (status === 409) return "unavailable";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid_request";
  return "unavailable";
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Both are accepted;
 * anything unparseable is ignored (the caller falls back to backoff).
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Node/libuv/undici error codes worth treating as transient. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Normalise anything thrown by an adapter into a `ProviderError`.
 *
 * Unknown errors become **retryable** ("unavailable"), mirroring the job
 * runner's rule: an unrecognised failure is worth a bounded number of attempts,
 * and the attempt ceiling prevents a bug from burning a quota forever.
 */
export function classifyProviderError(
  error: unknown,
  context: { provider?: string; operation?: string } = {},
): ProviderError {
  if (error instanceof ProviderError) return error;
  const provider = context.provider;
  const operation = context.operation;

  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderCanceledError(error.message || "call aborted", {
      provider,
      operation,
      cause: error,
    });
  }
  const code = errorCode(error);
  if (code !== undefined) {
    if (code === "ABORT_ERR") {
      return new ProviderCanceledError("call aborted", { provider, operation, cause: error });
    }
    if (TRANSIENT_CODES.has(code)) {
      return new ProviderUnavailableError(
        `network failure (${code}): ${error instanceof Error ? error.message : String(error)}`,
        { provider, operation, cause: error, details: { code } },
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderUnavailableError(message, { provider, operation, cause: error });
}

/** Narrow an unknown throw to a manual hand-off, if that is what it is. */
export function isManualRequired(error: unknown): error is ManualRequiredError {
  return error instanceof ManualRequiredError;
}
