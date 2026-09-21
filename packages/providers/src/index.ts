/**
 * `@nexus/providers` — the provider abstraction layer (AD-06).
 *
 * Public surface, grouped by what a caller is doing:
 *
 * - **Wiring:** `createProviders`, `Providers`, `ProviderRegistry`,
 *   `createRuntime`, `InvokeRuntime`.
 * - **Capability interfaces:** `LLMProvider`, `ResearchProvider`, `TTSProvider`,
 *   `MediaProvider`, `StorageProvider`, `PublishProvider` — the only types
 *   domain code should mention.
 * - **Deterministic fakes:** `FakeLLMProvider`, `FakeResearchProvider`,
 *   `FakeTTSProvider`, `FakeMediaProvider`, `MemoryStorageProvider`,
 *   `FakePublishProvider` (+ `synthesizeWav`/`readWavHeader`).
 * - **Manual fallbacks:** `ManualRequiredError` and the `Manual*` providers.
 * - **Real adapters:** `OpenAICompatibleLLMProvider`, `LocalStorageProvider`.
 * - **Call policy:** `invoke`, `BudgetGuard`, `ProviderCache` implementations,
 *   `TokenBucket`, `classifyProviderError`, `toJobError`.
 */

// ── Wiring ────────────────────────────────────────────────────────────────
export {
  createProviders,
  DEFAULT_CREDENTIALS_ENV,
  type CreateProvidersOptions,
  type Providers,
} from "./container.js";
export {
  ProviderRegistry,
  type AdapterDescriptor,
  type Capability,
  type ProviderSelection,
  type RuntimeFactory,
} from "./registry.js";
export { createRuntime, type InvokeRuntime, type RuntimeOptions } from "./runtime.js";

// ── Vocabulary ────────────────────────────────────────────────────────────
export {
  DEFAULT_PROVIDER_POLICY,
  RecordingProviderLogger,
  silentProviderLogger,
  type CallContext,
  type EnvLike,
  type ProviderKind,
  type ProviderLogEntry,
  type ProviderLogger,
  type ProviderMeta,
  type ProviderMode,
  type ProviderPolicy,
  type ProviderResult,
  type ProviderRetryPolicy,
  type SchemaLike,
  type UnitKind,
  type Usage,
} from "./types.js";
export { FixedClock, systemClock, type Clock } from "./clock.js";

// ── Errors ────────────────────────────────────────────────────────────────
export {
  ManualRequiredError,
  ProviderAuthError,
  ProviderCanceledError,
  ProviderConfigurationError,
  ProviderContentError,
  ProviderError,
  ProviderInvalidRequestError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  classifyProviderError,
  isManualRequired,
  isProviderError,
  kindForStatus,
  parseRetryAfterMs,
  type ManualRequest,
  type ProviderErrorInit,
  type ProviderErrorKind,
} from "./errors.js";
export { MANUAL_INPUT_GATE, QUOTA_GATE, toJobError } from "./jobs-bridge.js";

// ── Dry-run mode ──────────────────────────────────────────────────────────
export { DRY_RUN_ENV, dryRunConfig } from "./dry-run.js";

// ── Call policy (invoke pipeline) ─────────────────────────────────────────
export {
  NullProviderCache,
  FileProviderCache,
  MemoryProviderCache,
  providerCacheKey,
  type ProviderCache,
} from "./cache.js";
export { BudgetGuard, type BudgetDecision, type BudgetGuardOptions } from "./quota.js";
export { TokenBucket, unlimitedRateLimiter, type RateLimiter } from "./ratelimit.js";
export { invoke, type InvokeDeps, type InvokeSpec } from "./invoke.js";
export {
  canonicalize,
  hashInputs,
  redactSecrets,
  sha256Hex,
  slug,
  truncate,
  withDeadline,
} from "./util.js";
export {
  mergeHeaders,
  platformFetch,
  readResponse,
  type FetchLike,
  type FetchRequestInit,
  type FetchResponseLike,
} from "./http.js";

// ── Capability interfaces ─────────────────────────────────────────────────
export {
  describeIssues,
  validateStructured,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type StructuredOutput,
} from "./llm.js";
export {
  filterByLicense,
  type ImageSearchOptions,
  type ImageSearchResult,
  type ResearchProvider,
  type SearchOptions,
  type WebSearchResult,
} from "./research.js";
export {
  distributeWordTimings,
  type AudioRef,
  type SynthesisRequest,
  type SynthesisResult,
  type TTSProvider,
  type VoiceProfile,
  type WordTiming,
} from "./tts.js";
export {
  DEFAULT_MAX_MEDIA_BYTES,
  assertPublicHttpUrl,
  isPrivateAddress,
  type FetchedMedia,
  type MediaBlob,
  type MediaFetchOptions,
  type MediaProvider,
} from "./media.js";
export { storageUsage, type StorageProvider, type StoredBlob } from "./storage.js";
export type {
  PrivacyStatus,
  PublishMetadata,
  PublishProvider,
  PublishRef,
  PublisherQuota,
  UploadKit,
  UploadKitFile,
} from "./publishing.js";
export {
  PERMISSIVE_LICENSES,
  isAttributionRequired,
  licenseInfo,
  type LicenseInfo,
  type LicenseKind,
} from "./license.js";

// ── Offline (unconfigured) ────────────────────────────────────────────────
export {
  OfflineLLMProvider,
  OfflineMediaProvider,
  OfflinePublishProvider,
  OfflineResearchProvider,
  OfflineStorageProvider,
  OfflineTTSProvider,
  offlineError,
} from "./offline.js";

// ── Manual fallbacks ──────────────────────────────────────────────────────
export {
  ManualLLMProvider,
  ManualMediaProvider,
  ManualPublishProvider,
  ManualResearchProvider,
  ManualTTSProvider,
} from "./manual.js";

// ── Deterministic fakes ───────────────────────────────────────────────────
export {
  FakeLLMProvider,
  estimateTokens,
  type FakeLLMOptions,
  type FakeLLMResponder,
} from "./fake/llm.js";
export { sampleForSchema, sampleFrom } from "./fake/sampler.js";
export { FakeResearchProvider } from "./fake/research.js";
export { FAKE_VOICES, FakeTTSProvider, type FakeTTSOptions } from "./fake/tts.js";
export { readWavHeader, synthesizeWav, type WavOptions } from "./fake/wav.js";
export { FakeMediaProvider, deterministicBytes, mimeForUrl } from "./fake/media.js";
export { MemoryBlobStore, MemoryStorageProvider } from "./fake/storage.js";
export { FakePublishProvider, type FakePublisherOptions } from "./fake/publishing.js";

// ── Real adapters (the non-paid, dependency-free ones) ────────────────────
export {
  OpenAICompatibleLLMProvider,
  parseJsonObject,
  type OpenAICompatibleOptions,
} from "./real/openai-compatible.js";
export { LocalStorageProvider } from "./real/local-storage.js";
