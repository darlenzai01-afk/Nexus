import type { CallContext, ProviderMeta, ProviderResult, SchemaLike } from "./types.js";

/**
 * AI/LLM capability (discovery §8: `chat(schema, messages)`).
 *
 * Two contracts make this safe to depend on:
 *
 * - **Structured output only.** A provider never hands back prose that the
 *   pipeline has to parse. The caller supplies a schema and receives validated
 *   data (AD-12: never let raw LLM text flow into rendering; AD-07: AI for
 *   semantics, deterministic code for everything else).
 * - **Repair is bounded.** An invalid answer triggers at most
 *   `maxRepairAttempts` corrective re-prompts inside the call, then the call
 *   fails as `content` — the stage retry ceiling stops it there.
 */
export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LLMRequest<T> {
  readonly schema: SchemaLike<T>;
  readonly messages: readonly LLMMessage[];
  /**
   * Prompt-template version. Part of the cache key and the model-pinning
   * policy (OD-3): bumping the template must never silently reuse old output.
   */
  readonly templateVersion: string;
  /** Short label for the cache key/logs, e.g. `script.outline`. */
  readonly task?: string;
  /** Human-readable schema description appended to the instructions. */
  readonly schemaHint?: string;
  readonly model?: string;
  readonly temperature?: number;
  /** Corrective re-prompts after an invalid answer (default 1). */
  readonly maxRepairAttempts?: number;
}

/** The validated answer plus what produced it (kept for the audit trail). */
export interface StructuredOutput<T> {
  readonly data: T;
  /** Raw provider text. Stored with the artifact; never parsed by callers. */
  readonly raw: string;
  readonly model: string;
  readonly templateVersion: string;
  /** How many corrective re-prompts were needed (0 = first answer valid). */
  readonly repairs: number;
  /** Provider-reported token usage, when it reports any (metering input). */
  readonly tokens?: number;
}

export interface LLMProvider extends ProviderMeta {
  readonly kind: "llm";
  chat<T>(request: LLMRequest<T>, ctx?: CallContext): Promise<ProviderResult<StructuredOutput<T>>>;
}

/**
 * Render a schema's issues as a compact, human-readable list for the repair
 * prompt and for `ProviderContentError` details.
 */
export function describeIssues(
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
  max = 8,
): string {
  return issues
    .slice(0, max)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Validate a candidate answer against the caller's schema. */
export function validateStructured<T>(
  schema: SchemaLike<T>,
  candidate: unknown,
): { readonly ok: true; readonly data: T } | { readonly ok: false; readonly issues: string } {
  const result = schema.safeParse(candidate);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: describeIssues(result.error.issues) };
}
