import { createHash } from "node:crypto";

/**
 * Fingerprints. One idea, applied twice:
 *
 * 1. **Stage fingerprint** — `sha256(pipeline | stage | canonical(inputs))`.
 *    Identical inputs to the same stage of the same pipeline produce the same
 *    hash on any machine. It is the idempotency key for a *stage run*: it is
 *    stored as the step's `input_hash`, and a completed step with a matching
 *    hash is not re-executed (discovery §6.2/§7.2).
 * 2. **Job input fingerprint** — the same function over the episode content
 *    and configuration the pipeline will consume, stored on the job row for
 *    triage ("what exactly did this run see?").
 *
 * Canonicalization matters more than hashing: object keys are sorted, arrays
 * keep their order (order is meaningful in an outline), and `undefined` is
 * dropped so `{a: 1}` and `{a: 1, b: undefined}` hash identically.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number))
      throw new TypeError("Cannot fingerprint non-finite numbers");
    return JSON.stringify(value);
  }
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot fingerprint value of type ${type}`);
}

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

export function hashInputs(inputs: unknown): string {
  return sha256Hex(canonicalize(inputs));
}

export interface StageFingerprintInput {
  /** Pipeline id, including its version (`longform_v1`). */
  readonly pipeline: string;
  readonly stageKey: string;
  /** Content inputs: episode content, upstream stage outputs, params. */
  readonly inputs: unknown;
  /**
   * Cache-affecting configuration (provider ids, template versions, render
   * settings). Changing a provider must invalidate a stage, so it is part of
   * the fingerprint.
   */
  readonly config?: unknown;
}

/**
 * The stage fingerprint. Includes the *content* the stage consumes and the
 * configuration that affects its output — deliberately excludes ids,
 * timestamps and worker identity, which is what makes the output reusable
 * across episodes that happen to need the same work done.
 */
export function stageFingerprint(input: StageFingerprintInput): string {
  return hashInputs({
    v: 1,
    pipeline: input.pipeline,
    stage: input.stageKey,
    inputs: input.inputs ?? null,
    config: input.config ?? null,
  });
}
