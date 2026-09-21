import { ProviderContentError } from "../errors.js";
import type { InvokeRuntime } from "../runtime.js";
import type { LLMProvider, LLMRequest, StructuredOutput } from "../llm.js";
import { validateStructured } from "../llm.js";
import type { CallContext, ProviderResult } from "../types.js";
import { sampleForSchema } from "./sampler.js";
import { canonicalize } from "../util.js";

/**
 * Deterministic offline LLM.
 *
 * Default behaviour is derived purely from the request (schema + messages), so
 * the same prompt yields the same answer on every run and every machine —
 * which is what makes the whole pipeline testable at $0 and what `--dry-run`
 * is built on. Tests that need specific content (a script outline, a list of
 * claims) inject a `respond` function instead of hoping.
 */
export interface FakeLLMOptions {
  /** Explicit answers by task name, template version or a catch-all. */
  readonly respond?: FakeLLMResponder;
  readonly id?: string;
  /** Simulated latency in ms (0 = instant). */
  readonly latencyMs?: number;
  /** Force the first N attempts to fail, to exercise retry paths. */
  readonly failFirst?: number;
  readonly failWith?: (attempt: number) => Error;
}

export interface FakeLLMRequestView {
  readonly task?: string;
  readonly templateVersion: string;
  readonly model: string;
  readonly attempt: number;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly repairs: number;
  /** Raw text of the previous, schema-invalid answer (repair round only). */
  readonly previousReply?: string;
}

export type FakeLLMResponder = (
  request: FakeLLMRequestView & { readonly schema: unknown },
) => unknown;

export class FakeLLMProvider implements LLMProvider {
  readonly id: string;
  readonly kind = "llm" as const;
  readonly mode = "fake" as const;
  readonly label = "Fake LLM (deterministic, offline)";

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: FakeLLMOptions = {},
  ) {
    this.id = options.id ?? "fake";
  }

  async chat<T>(
    request: LLMRequest<T>,
    ctx?: CallContext,
  ): Promise<ProviderResult<StructuredOutput<T>>> {
    const model = request.model ?? this.runtime.defaultModel ?? "fake-model";
    const maxRepairs = request.maxRepairAttempts ?? 1;
    const inputs = {
      task: request.task ?? null,
      templateVersion: request.templateVersion,
      model,
      temperature: request.temperature ?? null,
      schemaHint: request.schemaHint ?? null,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };

    return this.runtime.invoke<StructuredOutput<T>>({
      operation: "llm.chat",
      ...(ctx !== undefined ? { context: ctx } : {}),
      cache: {
        inputs,
        toJson: (value) => value,
        fromJson: (json) => json as StructuredOutput<T>,
      },
      usage: (value) => ({
        units: estimateTokens(canonicalize(inputs).length + value.raw.length + value.repairs * 64),
        unit: "tokens",
      }),
      execute: async (_signal, attempt) => {
        const simulated = await this.simulate(attempt);
        if (simulated) throw simulated;

        let repairs = 0;
        let previousReply: string | undefined;
        for (;;) {
          const reply = this.answer(request, {
            ...(request.task !== undefined ? { task: request.task } : {}),
            templateVersion: request.templateVersion,
            model,
            attempt,
            repairs,
            messages: request.messages,
            ...(previousReply !== undefined ? { previousReply } : {}),
          });
          const validated = validateStructured(request.schema, reply);
          if (validated.ok) {
            return {
              data: validated.data,
              raw: JSON.stringify(reply),
              model,
              templateVersion: request.templateVersion,
              repairs,
            };
          }
          if (repairs >= maxRepairs) {
            throw new ProviderContentError(
              `fake LLM could not satisfy the schema after ${repairs + 1} attempt(s): ${validated.issues}`,
              {
                provider: this.id,
                operation: "llm.chat",
                details: { issues: validated.issues },
              },
            );
          }
          repairs += 1;
          previousReply = JSON.stringify(reply);
        }
      },
    });
  }

  private answer<T>(request: LLMRequest<T>, view: FakeLLMRequestView): unknown {
    const responder = this.options.respond;
    if (responder) {
      return responder({ ...view, schema: request.schema });
    }
    return sampleForSchema(request.schema, request.task ?? "value");
  }

  private async simulate(attempt: number): Promise<Error | undefined> {
    if (this.options.latencyMs !== undefined && this.options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }
    const failFirst = this.options.failFirst ?? 0;
    if (attempt <= failFirst) {
      return (
        this.options.failWith?.(attempt) ?? new Error(`fake LLM simulated failure #${attempt}`)
      );
    }
    return undefined;
  }
}

/** Rough token estimate: ~4 characters per token, the usual rule of thumb. */
export function estimateTokens(characters: number): number {
  return Math.max(1, Math.ceil(characters / 4));
}
