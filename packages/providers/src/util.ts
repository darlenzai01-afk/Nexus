import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, `undefined` dropped, arrays preserved in
 * order. Everything that becomes a cache key or a fingerprint goes through
 * here, so `{a:1,b:2}` and `{b:2,a:1}` are one cache entry rather than two —
 * and two different prompts can never collide by accident.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (value === undefined) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString("base64") };
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]));
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable identity of a call's inputs — the basis of every cache key. */
export function hashInputs(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** URL/log-safe slug of free text (queries, titles). */
export function slug(text: string, max = 48): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "item").slice(0, max);
}

export const REDACTED = "[redacted]";

const SECRET_PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer <token>
  /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // Common key shapes: OpenAI/Anthropic-style, Google-style
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{16,}/g,
  // key=value / "key": "value" pairs for secret-ish names
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password)"?\s*[:=]\s*")([^"\s,}]{8,})/gi,
];

/**
 * Best-effort secret scrubbing for anything that leaves the process (log
 * lines, provider_call_log.error, error messages surfaced to the dashboard).
 * AD-12: secrets live in the environment and must not be echoed back out.
 */
export function redactSecrets(text: string): string {
  let output = text.replace(SECRET_PATTERNS[0]!, "$1 " + REDACTED);
  output = output.replace(SECRET_PATTERNS[1]!, REDACTED);
  output = output.replace(SECRET_PATTERNS[2]!, REDACTED);
  output = output.replace(SECRET_PATTERNS[3]!, "$1" + REDACTED);
  return output;
}

/**
 * Build a redactor for text coming back from a provider.
 *
 * Pattern matching alone cannot catch a provider that echoes a bare,
 * unrecognisable token back at us — so when the caller knows the credential
 * values (the runtime does), those exact strings are scrubbed too. Short
 * values are ignored: redacting every occurrence of a 3-character string
 * would mangle ordinary text.
 */
export function makeRedactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const known = [...new Set(secrets.filter((value): value is string => typeof value === "string"))]
    .filter((value) => value.trim().length >= 8)
    .sort((a, b) => b.length - a.length); // longest first, so overlaps fully match
  return (text: string): string => {
    let output = redactSecrets(text);
    for (const secret of known) output = output.split(secret).join(REDACTED);
    return output;
  };
}

export const truncate = (text: string, max = 500): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/**
 * A deadline that composes with an outer signal (worker shutdown):
 *   `withDeadline(5_000, ctx.signal)` → aborts after 5s, or as soon as the
 *   outer signal aborts, whichever comes first.
 */
export interface Deadline {
  readonly signal: AbortSignal;
  /** True when this deadline (not the outer signal) fired. */
  timedOut(): boolean;
  dispose(): void;
}

export function withDeadline(timeoutMs?: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timeoutFired = false;

  const onOuterAbort = (): void => controller.abort(outer?.reason);

  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutFired = true;
      controller.abort(new Error(`provider call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Never keep the process alive for a deadline.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    signal: controller.signal,
    timedOut: () => timeoutFired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onOuterAbort);
    },
  };
}

/** Abortable sleep. Rejects with an AbortError when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      const error = new Error("sleep aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
