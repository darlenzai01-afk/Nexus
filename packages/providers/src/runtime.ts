import type { Repo } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import type { ProviderCache } from "./cache.js";
import type { Clock } from "./clock.js";
import { ProviderAuthError } from "./errors.js";
import type { FetchLike } from "./http.js";

import type { InvokeSpec } from "./invoke.js";
import type { BudgetGuard } from "./quota.js";
import type { RateLimiter } from "./ratelimit.js";
import { redactSecrets } from "./util.js";
import type {
  EnvLike,
  ProviderKind,
  ProviderLogger,
  ProviderPolicy,
  ProviderResult,
} from "./types.js";

/**
 * What every adapter receives at construction time.
 *
 * This is the dependency-injection seam: adapters get their collaborators
 * (storage, repo, clock, transport, credentials, policy) as *data*, never by
 * importing them, so an adapter can be constructed in a test with a memory
 * store and a stub transport — and the same adapter constructed in production
 * with the CAS and the platform fetch. Nothing in an adapter reaches for a
 * global.
 */
export interface InvokeRuntime {
  readonly adapterId: string;
  readonly kind: ProviderKind;
  /** The part after `:` in `NEXUS_LLM_PROVIDER=openai-compatible:model`. */
  readonly variant?: string;
  readonly storage: BlobStore;
  readonly repo?: Repo;
  readonly clock: Clock;
  readonly logger: ProviderLogger;
  readonly env: EnvLike;
  readonly policy: ProviderPolicy;
  readonly transport: FetchLike;
  readonly budget: BudgetGuard;
  readonly limiter: RateLimiter;
  readonly cache?: ProviderCache;
  /** Default model/base URL for HTTP adapters (from config). */
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  /** Env-var *name* holding this adapter's credential (AD-12). */
  readonly credentialsEnv: string;
  /** Whether the credential is present — never the value. */
  credential(): { readonly envVar: string; readonly present: boolean };
  /** The credential value, or a `ProviderAuthError` naming the missing variable. */
  requireCredential(): string;
  /** Scrub provider text (logs, errors, call rows) of anything secret-looking. */
  redact(text: string): string;
  invoke<T>(spec: InvokeSpec<T>): Promise<ProviderResult<T>>;
}

export interface RuntimeOptions {
  readonly adapterId: string;
  readonly kind: ProviderKind;
  readonly variant?: string;
  readonly storage: BlobStore;
  readonly repo?: Repo;
  readonly clock: Clock;
  readonly logger: ProviderLogger;
  readonly env: EnvLike;
  readonly policy: ProviderPolicy;
  readonly transport: FetchLike;
  readonly budget: BudgetGuard;
  readonly limiter: RateLimiter;
  readonly cache?: ProviderCache;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly credentialsEnv: string;
  readonly redact?: (text: string) => string;
  readonly invoke: <T>(spec: InvokeSpec<T>) => Promise<ProviderResult<T>>;
}

/**
 * Build the runtime handed to an adapter factory. `credentialsEnv` is a
 * variable *name*; the value is read here and only here, and never logged,
 * cached or persisted by this layer.
 */
export function createRuntime(options: RuntimeOptions): InvokeRuntime {
  const envVar = options.credentialsEnv;
  return {
    adapterId: options.adapterId,
    kind: options.kind,
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
    storage: options.storage,
    ...(options.repo !== undefined ? { repo: options.repo } : {}),
    clock: options.clock,
    logger: options.logger,
    env: options.env,
    policy: options.policy,
    transport: options.transport,
    budget: options.budget,
    limiter: options.limiter,
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
    credentialsEnv: envVar,
    credential: () => {
      const value = options.env[envVar];
      return { envVar, present: typeof value === "string" && value.trim() !== "" };
    },
    redact: options.redact ?? redactSecrets,
    requireCredential: () => {
      const value = options.env[envVar];
      if (typeof value !== "string" || value.trim() === "") {
        throw new ProviderAuthError(
          `Missing credential for '${options.adapterId}': set the ${envVar} environment variable ` +
            "(the value is never stored in the database or repo)",
          { provider: options.adapterId, operation: "auth" },
        );
      }
      return value;
    },
    invoke: options.invoke,
  };
}
