import { ProviderConfigurationError } from "./errors.js";
import type { BudgetGuard } from "./quota.js";
import type { InvokeRuntime } from "./runtime.js";
import type { ProviderKind, ProviderLogger, ProviderMode } from "./types.js";
import { silentProviderLogger } from "./types.js";

/**
 * Registry + selection (AD-06).
 *
 * Provider choice is configuration, never code: `NEXUS_LLM_PROVIDER` names an
 * adapter id (`fake`, `manual`, `openai-compatible`) optionally with a variant
 * (`openai-compatible:meta-llama/llama-3.1-8b` → adapter `openai-compatible`,
 * variant `meta-llama/llama-3.1-8b`). Resolution is *dynamic* rather than
 * cached, because a capability can degrade mid-job (quota at 90% → manual).
 *
 * `none` is a first-class selection, not an error: an unconfigured capability
 * resolves to a provider that refuses with an actionable message naming the
 * environment variable to set. That is how "the app boots with zero
 * configuration" and "nothing silently hits a paid API" coexist.
 */
export interface AdapterDescriptor {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly mode: ProviderMode;
  readonly label: string;
  create(runtime: InvokeRuntime): unknown;
}

export interface Capability {
  readonly kind: ProviderKind;
  /** Adapter that will actually serve the call. */
  readonly adapterId: string;
  /** What configuration asked for (may differ after degradation). */
  readonly requestedId: string;
  readonly mode: ProviderMode;
  readonly degraded: boolean;
  readonly reason?: string;
  readonly variant?: string;
}

export interface ProviderSelection {
  readonly adapterId: string;
  readonly variant?: string;
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, AdapterDescriptor>();
  private readonly logger: ProviderLogger;
  private readonly budget: BudgetGuard;
  private readonly degradationLogged = new Set<string>();

  constructor(options: { readonly budget: BudgetGuard; readonly logger?: ProviderLogger }) {
    this.budget = options.budget;
    this.logger = options.logger ?? silentProviderLogger;
  }

  register(descriptor: AdapterDescriptor): this {
    const key = keyOf(descriptor.kind, descriptor.id);
    if (this.adapters.has(key)) {
      throw new ProviderConfigurationError(
        `Adapter '${descriptor.id}' is already registered for capability '${descriptor.kind}'`,
      );
    }
    this.adapters.set(key, descriptor);
    return this;
  }

  registerAll(descriptors: readonly AdapterDescriptor[]): this {
    for (const descriptor of descriptors) this.register(descriptor);
    return this;
  }

  ids(kind: ProviderKind): string[] {
    return [...this.adapters.values()]
      .filter((descriptor) => descriptor.kind === kind)
      .map((descriptor) => descriptor.id)
      .sort();
  }

  descriptors(kind?: ProviderKind): readonly AdapterDescriptor[] {
    const all = [...this.adapters.values()];
    return (kind === undefined ? all : all.filter((descriptor) => descriptor.kind === kind)).sort(
      (a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)),
    );
  }

  has(kind: ProviderKind, id: string): boolean {
    return this.adapters.has(keyOf(kind, id));
  }

  /**
   * `"openai-compatible:meta-llama/llama-3.1-8b"` → adapter + variant. Only the
   * first colon separates them, so variants may contain slashes and colons.
   */
  parseSelection(selection: string): ProviderSelection {
    const trimmed = selection.trim();
    if (trimmed === "") return { adapterId: "none" };
    const separator = trimmed.indexOf(":");
    if (separator < 0) return { adapterId: trimmed };
    const adapterId = trimmed.slice(0, separator);
    const variant = trimmed.slice(separator + 1);
    return variant === "" ? { adapterId } : { adapterId, variant };
  }

  /** Resolve a selection (default from config) into a capability description. */
  capability(kind: ProviderKind, selection?: string): Capability {
    const requested = this.parseSelection(selection ?? "none");
    const requestedId = requested.adapterId === "none" ? "none" : requested.adapterId;
    const descriptor = this.adapters.get(keyOf(kind, requested.adapterId));
    if (!descriptor) {
      throw new ProviderConfigurationError(
        `Unknown ${kind} provider '${requested.adapterId}'. Registered: ${[
          ...this.ids(kind),
          "none",
        ].join(", ")}. Set NEXUS_${kind.toUpperCase()}_PROVIDER to one of them.`,
      );
    }

    const base: Capability = {
      kind,
      adapterId: descriptor.id,
      requestedId,
      mode: descriptor.mode,
      degraded: false,
      ...(requested.variant !== undefined ? { variant: requested.variant } : {}),
    };

    // Quota-driven degradation (AD-06/AD-13): only *live* adapters degrade, and
    // only towards a manual one — a fake is already free and an offline
    // capability has nothing to degrade from.
    if (descriptor.mode !== "live") return base;

    const decision = this.budget.evaluate(descriptor.id);
    if (!decision.degraded) return base;

    const manual = this.adapters.get(keyOf(kind, "manual"));
    if (!manual) {
      return {
        ...base,
        degraded: true,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
    }

    const capability: Capability = {
      kind,
      adapterId: manual.id,
      requestedId,
      mode: manual.mode,
      degraded: true,
      reason: decision.reason ?? `degraded to manual provider '${manual.id}'`,
    };
    const logKey = `${kind}:${descriptor.id}`;
    if (!this.degradationLogged.has(logKey)) {
      this.degradationLogged.add(logKey);
      this.logger({
        level: "warn",
        event: "provider.degraded",
        kind,
        from: descriptor.id,
        to: manual.id,
        reason: capability.reason,
      });
    }
    return capability;
  }

  /**
   * Build the adapter for a capability. Each call constructs a runtime for the
   * resolved adapter (including the degraded one), so the adapter — not the
   * caller — sees its own identity and policy.
   */
  resolve<T>(runtime: RuntimeFactory, kind: ProviderKind, selection?: string): T {
    const capability = this.capability(kind, selection);
    const descriptor = this.adapters.get(keyOf(kind, capability.adapterId));
    if (!descriptor) {
      throw new ProviderConfigurationError(
        `No adapter '${capability.adapterId}' registered for capability '${kind}'`,
      );
    }
    const built = descriptor.create(
      runtime({
        kind,
        adapterId: descriptor.id,
        ...(capability.variant !== undefined ? { variant: capability.variant } : {}),
      }),
    );
    return built as T;
  }
}

/** Builds the adapter-specific runtime (see `container.ts`). */
export type RuntimeFactory = (selection: {
  readonly kind: ProviderKind;
  readonly adapterId: string;
  readonly variant?: string;
}) => InvokeRuntime;

const keyOf = (kind: ProviderKind, id: string): string => `${kind}:${id}`;
