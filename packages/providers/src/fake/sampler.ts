import { ProviderConfigurationError } from "../errors.js";
import type { SchemaLike } from "../types.js";

/**
 * Deterministic sample generation for schema-shaped fake output.
 *
 * The fake LLM promises "same prompt → same answer, forever, offline". To keep
 * that promise *and* satisfy the structured-output contract, it needs a value
 * that passes the caller's schema. Rather than guessing randomly and hoping,
 * this walks the schema's definition and derives a value from the field path —
 * so `title` is always `fake:title`, and two runs on two machines agree.
 *
 * Supported: object, string, number, boolean, array, enum, literal, optional,
 * nullable, default, union (first branch), record/map. Anything else fails
 * loudly: a fake that silently emits invalid data would be worse than no fake.
 */
export function sampleForSchema<T>(schema: SchemaLike<T>, path = "value"): T {
  const candidate = sampleFrom(schema, path, 0);
  const result = schema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ProviderConfigurationError(
      `Fake LLM cannot synthesise a valid sample for this schema (${issues}). ` +
        "Pass an explicit `respond` function to FakeLLMProvider for this request.",
      { provider: "fake", operation: "llm.sample" },
    );
  }
  return result.data;
}

/** Depth guard so a recursive schema cannot spin forever. */
const MAX_DEPTH = 6;

export function sampleFrom(schema: unknown, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return null;
  const definition = defOf(schema);
  if (!definition) return null;
  const typeName = String(definition.typeName ?? "");

  switch (typeName) {
    case "ZodString":
      return `fake:${path}`;
    case "ZodNumber":
      return 1;
    case "ZodBigInt":
      return 1n;
    case "ZodBoolean":
      return true;
    case "ZodDate":
      return new Date(0);
    case "ZodNull":
      return null;
    case "ZodUndefined":
    case "ZodVoid":
      return undefined;
    case "ZodAny":
    case "ZodUnknown":
      return {};
    case "ZodLiteral":
      return definition.value;
    case "ZodEnum":
      return (definition.values as readonly unknown[])[0];
    case "ZodNativeEnum":
      return Object.values(definition.values as Record<string, unknown>)[0];
    case "ZodArray": {
      const element = sampleFrom(definition.type, `${path}.0`, depth + 1);
      return element === undefined ? [] : [element];
    }
    case "ZodObject": {
      const shape = (definition.shape as () => Record<string, unknown>)();
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        out[key] = sampleFrom(field, key, depth + 1);
      }
      return out;
    }
    case "ZodRecord":
    case "ZodMap":
      return {};
    case "ZodTuple": {
      const items = definition.items as readonly unknown[];
      return items.map((item, index) => sampleFrom(item, `${path}.${index}`, depth + 1));
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
    case "ZodBranded":
    case "ZodEffects":
      return sampleFrom(
        definition.innerType ?? definition.type ?? definition.schema,
        path,
        depth + 1,
      );
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options =
        (definition.options as readonly unknown[]) ??
        (typeof definition.options === "function"
          ? (definition.options as () => readonly unknown[])()
          : []);
      const first = options[0];
      return first === undefined ? null : sampleFrom(first, path, depth + 1);
    }
    case "ZodPipeline":
      return sampleFrom(definition.in ?? definition.out, path, depth + 1);
    case "ZodLazy":
      return sampleFrom((definition.getter as () => unknown)(), path, depth + 1);
    default:
      throw new ProviderConfigurationError(
        `Fake LLM cannot synthesise a sample for schema type '${typeName || "unknown"}' at '${path}'. ` +
          "Pass an explicit `respond` function to FakeLLMProvider for this request.",
        { provider: "fake", operation: "llm.sample" },
      );
  }
}

function defOf(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const def = (schema as { _def?: unknown })._def;
  if (typeof def !== "object" || def === null) return undefined;
  return def as Record<string, unknown>;
}
