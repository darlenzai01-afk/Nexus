import type { Repo } from "@nexus/db";
import type { AppConfig } from "@nexus/config";
import type { BlobStore } from "@nexus/storage";

import { FileProviderCache, NullProviderCache, type ProviderCache } from "./cache.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { ProviderConfigurationError } from "./errors.js";
import { FakeLLMProvider, type FakeLLMResponder } from "./fake/llm.js";
import { FakeMediaProvider } from "./fake/media.js";
import { FakePublishProvider } from "./fake/publishing.js";
import { FakeResearchProvider } from "./fake/research.js";
import { MemoryBlobStore, MemoryStorageProvider } from "./fake/storage.js";
import { FakeTTSProvider } from "./fake/tts.js";
import type { FetchLike } from "./http.js";
import { platformFetch } from "./http.js";
import type { InvokeSpec } from "./invoke.js";
import { invoke } from "./invoke.js";
import type { LLMProvider } from "./llm.js";
import {
  ManualLLMProvider,
  ManualMediaProvider,
  ManualPublishProvider,
  ManualResearchProvider,
  ManualTTSProvider,
} from "./manual.js";
import type { MediaProvider } from "./media.js";
import {
  OfflineLLMProvider,
  OfflineMediaProvider,
  OfflinePublishProvider,
  OfflineResearchProvider,
  OfflineStorageProvider,
  OfflineTTSProvider,
} from "./offline.js";
import type { PublishProvider } from "./publishing.js";
import { BudgetGuard } from "./quota.js";
import { TokenBucket, unlimitedRateLimiter, type RateLimiter } from "./ratelimit.js";
import { OpenAICompatibleLLMProvider } from "./real/openai-compatible.js";
import { LocalStorageProvider } from "./real/local-storage.js";
import type { AdapterDescriptor, Capability } from "./registry.js";
import { ProviderRegistry } from "./registry.js";
import type { ResearchProvider } from "./research.js";
import type { InvokeRuntime } from "./runtime.js";
import { createRuntime } from "./runtime.js";
import type { StorageProvider } from "./storage.js";
import type { TTSProvider } from "./tts.js";
import type {
  EnvLike,
  ProviderKind,
  ProviderLogger,
  ProviderPolicy,
  ProviderResult,
} from "./types.js";
import { DEFAULT_PROVIDER_POLICY, silentProviderLogger } from "./types.js";
import { makeRedactor } from "./util.js";

/**
 * The dependency-injection container: everything the pipeline needs to reach
 * the outside world, constructed once from validated configuration.
 *
 *   ```ts
 *   const providers = createProviders({ config, storage: cas, repo, logger });
 *   const llm = providers.llm();          // whatever NEXUS_LLM_PROVIDER says
 *   const { data } = (await llm.chat({...})).value;
 *   ```
 *
 * Nothing in the domain layer imports a vendor module or reaches for a global;
 * tests call `createProviders({ config, storage: new MemoryBlobStore(), env: {
 * NEXUS_LLM_PROVIDER: "fake" } })` and get the whole stack offline.
 */
export interface CreateProvidersOptions {
  readonly config: AppConfig;
  /** The CAS (or any BlobStore) artifact bytes go to. */
  readonly storage: BlobStore & { list(): string[] };
  readonly repo?: Repo;
  readonly logger?: ProviderLogger;
  readonly clock?: Clock;
  readonly cache?: ProviderCache;
  /** Root for the durable provider cache (defaults to `<dataDir>/cache/providers`). */
  readonly cacheRoot?: string;
  /** HTTP transport for real adapters (defaults to the platform fetch). */
  readonly transport?: FetchLike;
  /** Environment holding credentials (defaults to `process.env`). */
  readonly env?: EnvLike;
  /** Overrides on top of `config.providerPolicy` (tests use this most). */
  readonly policy?: Partial<ProviderPolicy>;
  /**
   * Answers for the `fake` LLM adapter. The default fake derives its output
   * from the request schema alone, which can never quote real source content;
   * a responder lets a caller (the offline dashboard demo, tests) make the
   * whole chain coherent — e.g. quote exactly the text the fake search row
   * carried, so evidence verifies and claims become writable.
   */
  readonly fakeLLMRespond?: FakeLLMResponder;
}

export interface Providers {
  readonly registry: ProviderRegistry;
  readonly policy: ProviderPolicy;
  readonly budget: BudgetGuard;
  capability(kind: ProviderKind, selection?: string): Capability;
  listCapabilities(): readonly Capability[];
  llm(selection?: string): LLMProvider;
  research(selection?: string): ResearchProvider;
  tts(selection?: string): TTSProvider;
  media(selection?: string): MediaProvider;
  storage(selection?: string): StorageProvider;
  publishing(selection?: string): PublishProvider;
}

/** Credential env-var names used when `provider_accounts` has no row (AD-12). */
export const DEFAULT_CREDENTIALS_ENV: Readonly<Record<ProviderKind, string>> = {
  llm: "NEXUS_LLM_API_KEY",
  research: "NEXUS_RESEARCH_API_KEY",
  tts: "NEXUS_TTS_API_KEY",
  media: "NEXUS_MEDIA_API_KEY",
  storage: "NEXUS_STORAGE_API_KEY",
  publishing: "NEXUS_YOUTUBE_CLIENT_SECRET",
};

export function createProviders(options: CreateProvidersOptions): Providers {
  const { config, storage, repo } = options;
  const logger = options.logger ?? silentProviderLogger;
  const clock = options.clock ?? systemClock;
  const env: EnvLike = options.env ?? process.env;
  const transport = options.transport ?? platformFetch;

  const policy: ProviderPolicy = {
    ...DEFAULT_PROVIDER_POLICY,
    timeoutMs: config.providerPolicy.timeoutMs,
    maxAttempts: config.providerPolicy.maxAttempts,
    cacheEnabled: config.providerPolicy.cacheEnabled,
    degradeRatio: config.providerPolicy.degradeRatio,
    rateLimitPerMinute: config.providerPolicy.rateLimitPerMinute,
    ...options.policy,
  };

  const budget = new BudgetGuard({
    ...(repo !== undefined ? { repo } : {}),
    clock,
    degradeRatio: policy.degradeRatio,
  });
  const registry = new ProviderRegistry({ budget, logger });

  const cache: ProviderCache = policy.cacheEnabled
    ? (options.cache ??
      new FileProviderCache(options.cacheRoot ?? `${config.dataDir}/cache/providers`))
    : new NullProviderCache();

  // One bucket per kind would be finer-grained; one per container is enough
  // for a single-worker process and keeps the limit honest across kinds.
  const limiter: RateLimiter =
    policy.rateLimitPerMinute > 0
      ? new TokenBucket(policy.rateLimitPerMinute, () => clock.now().getTime())
      : unlimitedRateLimiter;

  const credentialsEnvFor = (kind: ProviderKind, adapterId: string): string => {
    const account = repo?.getProviderAccount(adapterId);
    if (account && account.credentials_env.trim() !== "") return account.credentials_env;
    return DEFAULT_CREDENTIALS_ENV[kind];
  };

  const runtimeFor = (selection: {
    readonly kind: ProviderKind;
    readonly adapterId: string;
    readonly variant?: string;
  }): InvokeRuntime => {
    const adapterId = selection.adapterId;
    const invokeBound = <T>(spec: InvokeSpec<T>): Promise<ProviderResult<T>> =>
      invoke(
        {
          adapterId,
          kind: selection.kind,
          policy,
          budget,
          ...(repo !== undefined ? { repo } : {}),
          cache,
          logger,
          clock,
          limiter,
          redact,
        },
        spec,
      );

    const credentialsEnv = credentialsEnvFor(selection.kind, adapterId);
    // The runtime knows which variable holds the key, so it can scrub that
    // exact value out of anything a provider echoes back (AD-12).
    const redact = makeRedactor([env[credentialsEnv]]);
    return createRuntime({
      adapterId,
      kind: selection.kind,
      ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
      storage,
      ...(repo !== undefined ? { repo } : {}),
      clock,
      logger,
      env,
      policy,
      transport,
      budget,
      limiter,
      cache,
      ...(config.providerPolicy.llmBaseUrl !== undefined
        ? { baseUrl: config.providerPolicy.llmBaseUrl }
        : {}),
      defaultModel: selection.variant ?? config.providerPolicy.defaultLlmModel,
      credentialsEnv,
      redact,
      invoke: invokeBound,
    });
  };

  registerBuiltins(registry, options.fakeLLMRespond);

  // One instance per resolved adapter: real clients keep their state, and a
  // degradation to `manual` (or a different variant) yields a different key,
  // so the switch actually switches.
  const instances = new Map<string, unknown>();
  const resolve = <T>(kind: ProviderKind, selection?: string): T => {
    const capability = registry.capability(kind, selection ?? defaultSelection(config, kind));
    const key = `${kind}:${capability.adapterId}:${capability.variant ?? ""}`;
    const existing = instances.get(key);
    if (existing !== undefined) return existing as T;
    const built = registry.resolve<T>(
      runtimeFor,
      kind,
      selection ?? defaultSelection(config, kind),
    );
    instances.set(key, built);
    return built;
  };

  return {
    registry,
    policy,
    budget,
    capability: (kind, selection) =>
      registry.capability(kind, selection ?? defaultSelection(config, kind)),
    listCapabilities: () =>
      (["llm", "research", "tts", "media", "storage", "publishing"] as const).map((kind) =>
        registry.capability(kind, defaultSelection(config, kind)),
      ),
    llm: (selection) => resolve<LLMProvider>("llm", selection),
    research: (selection) => resolve<ResearchProvider>("research", selection),
    tts: (selection) => resolve<TTSProvider>("tts", selection),
    media: (selection) => resolve<MediaProvider>("media", selection),
    storage: (selection) => resolve<StorageProvider>("storage", selection),
    publishing: (selection) => resolve<PublishProvider>("publishing", selection),
  };
}

function defaultSelection(config: AppConfig, kind: ProviderKind): string {
  switch (kind) {
    case "llm":
      return config.providers.llm;
    case "tts":
      return config.providers.tts;
    case "research":
      return config.providers.research;
    case "media":
      return config.providers.media;
    case "storage":
      return config.providers.storage;
    case "publishing":
      return config.providers.publishing;
    default:
      throw new ProviderConfigurationError(`Unhandled provider kind: ${String(kind)}`);
  }
}

/**
 * The adapters that ship with the system.
 *
 * Every kind gets three guaranteed implementations — `none` (refuse),
 * `fake` (deterministic, offline) and `manual` (human-in-the-loop) — which is
 * what makes "the capability layer is never a blocker" true rather than
 * aspirational. Real adapters are added per kind as their phase arrives.
 */
function registerBuiltins(registry: ProviderRegistry, fakeLLMRespond?: FakeLLMResponder): void {
  const { llm, tts } = { llm: "llm" as const, tts: "tts" as const };
  // A single shared memory store for the storage fake, so `put` then `read`
  // works within one container instance.
  const memoryStore = new MemoryBlobStore();

  const descriptors: AdapterDescriptor[] = [
    // ── llm ─────────────────────────────────────────────────────────────
    {
      id: "none",
      kind: llm,
      mode: "offline",
      label: "Not configured",
      create: () => new OfflineLLMProvider(),
    },
    {
      id: "fake",
      kind: llm,
      mode: "fake",
      label: "Fake LLM (deterministic, offline)",
      create: (runtime) =>
        new FakeLLMProvider(runtime, fakeLLMRespond ? { respond: fakeLLMRespond } : {}),
    },
    {
      id: "manual",
      kind: llm,
      mode: "manual",
      label: "Manual LLM (operator writes the answer)",
      create: () => new ManualLLMProvider(),
    },
    {
      id: "openai-compatible",
      kind: llm,
      mode: "live",
      label: "OpenAI-compatible LLM",
      create: (runtime) =>
        new OpenAICompatibleLLMProvider(runtime, {
          baseUrl: runtime.baseUrl ?? "https://openrouter.ai/api/v1",
          model: runtime.defaultModel ?? "meta-llama/llama-3.1-8b-instruct",
          credentialsEnv: runtime.credentialsEnv,
        }),
    },
    // ── research ────────────────────────────────────────────────────────
    {
      id: "none",
      kind: "research",
      mode: "offline",
      label: "Not configured",
      create: () => new OfflineResearchProvider(),
    },
    {
      id: "fake",
      kind: "research",
      mode: "fake",
      label: "Fake research (deterministic, offline)",
      create: (runtime) => new FakeResearchProvider(runtime),
    },
    {
      id: "manual",
      kind: "research",
      mode: "manual",
      label: "Manual research (operator pastes sources)",
      create: () => new ManualResearchProvider(),
    },
    // ── tts ─────────────────────────────────────────────────────────────
    {
      id: "none",
      kind: tts,
      mode: "offline",
      label: "Not configured",
      create: () => new OfflineTTSProvider(),
    },
    {
      id: "fake",
      kind: tts,
      mode: "fake",
      label: "Fake TTS (deterministic WAV, offline)",
      create: (runtime) => new FakeTTSProvider(runtime),
    },
    {
      id: "manual",
      kind: tts,
      mode: "manual",
      label: "Manual TTS (operator records or uploads audio)",
      create: () => new ManualTTSProvider(),
    },
    // ── media ───────────────────────────────────────────────────────────
    {
      id: "none",
      kind: "media",
      mode: "offline",
      label: "Not configured",
      create: () => new OfflineMediaProvider(),
    },
    {
      id: "fake",
      kind: "media",
      mode: "fake",
      label: "Fake media fetcher (deterministic bytes, offline)",
      create: (runtime) => new FakeMediaProvider(runtime),
    },
    {
      id: "manual",
      kind: "media",
      mode: "manual",
      label: "Manual media (operator supplies files)",
      create: () => new ManualMediaProvider(),
    },
    // ── storage ─────────────────────────────────────────────────────────
    {
      id: "none",
      kind: "storage",
      mode: "offline",
      label: "Not configured",
      create: () => new OfflineStorageProvider(),
    },
    {
      id: "local",
      kind: "storage",
      mode: "live",
      label: "Local content-addressed store",
      create: (runtime) =>
        new LocalStorageProvider(runtime.storage as BlobStore & { list(): string[] }),
    },
    {
      id: "fake",
      kind: "storage",
      mode: "fake",
      label: "In-memory storage (not durable)",
      create: () => new MemoryStorageProvider(memoryStore, { id: "fake" }),
    },
    // ── publishing ──────────────────────────────────────────────────────
    {
      id: "none",
      kind: "publishing",
      mode: "offline",
      label: "Not configured",
      create: () => new OfflinePublishProvider(),
    },
    {
      id: "fake",
      kind: "publishing",
      mode: "fake",
      label: "Fake publisher (deterministic, no upload)",
      create: (runtime) => new FakePublishProvider(runtime),
    },
    {
      id: "manual",
      kind: "publishing",
      mode: "manual",
      label: "Manual publish (upload kit)",
      create: (runtime) => new ManualPublishProvider(runtime),
    },
  ];

  registry.registerAll(descriptors);
}
