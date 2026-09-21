import { ProviderConfigurationError, type ProviderError } from "./errors.js";
import type { LLMProvider, LLMRequest, StructuredOutput } from "./llm.js";
import type { FetchedMedia, MediaFetchOptions, MediaProvider } from "./media.js";
import type { PublishMetadata, PublishProvider, PublishRef, PublisherQuota } from "./publishing.js";
import type {
  ImageSearchOptions,
  ImageSearchResult,
  ResearchProvider,
  SearchOptions,
  WebSearchResult,
} from "./research.js";
import type { StorageProvider, StoredBlob } from "./storage.js";
import type { SynthesisRequest, SynthesisResult, TTSProvider, VoiceProfile } from "./tts.js";
import type { CallContext, ProviderKind, ProviderResult } from "./types.js";

/**
 * `none` — the honest unconfigured capability.
 *
 * The default for every capability is "not configured", and using one must fail
 * *immediately and actionably* rather than at some later point with a network
 * error. One place decides the message: the environment variable to set and the
 * adapters that are registered for it.
 */
export function offlineError(kind: ProviderKind, how: string): ProviderError {
  return new ProviderConfigurationError(
    `The '${kind}' capability is not configured (tried to ${how}). ` +
      `Set NEXUS_${kind.toUpperCase()}_PROVIDER to an adapter id such as 'fake', ` +
      `'manual' or a real adapter, or run with --dry-run to use fakes.`,
    { provider: "none", operation: `${kind}.${how}` },
  );
}

export class OfflineLLMProvider implements LLMProvider {
  readonly id = "none";
  readonly kind = "llm" as const;
  readonly mode = "offline" as const;
  readonly label = "Not configured";

  async chat<T>(_request: LLMRequest<T>): Promise<ProviderResult<StructuredOutput<T>>> {
    throw offlineError("llm", "chat");
  }
}

export class OfflineResearchProvider implements ResearchProvider {
  readonly id = "none";
  readonly kind = "research" as const;
  readonly mode = "offline" as const;
  readonly label = "Not configured";

  async search(
    _query: string,
    _options?: SearchOptions,
  ): Promise<ProviderResult<readonly WebSearchResult[]>> {
    throw offlineError("research", "search");
  }

  async images(
    _query: string,
    _options?: ImageSearchOptions,
  ): Promise<ProviderResult<readonly ImageSearchResult[]>> {
    throw offlineError("research", "images");
  }
}

export class OfflineTTSProvider implements TTSProvider {
  readonly id = "none";
  readonly kind = "tts" as const;
  readonly mode = "offline" as const;
  readonly label = "Not configured";

  voices(): readonly VoiceProfile[] {
    return [];
  }

  async synthesize(_request: SynthesisRequest): Promise<ProviderResult<SynthesisResult>> {
    throw offlineError("tts", "synthesize");
  }
}

export class OfflineMediaProvider implements MediaProvider {
  readonly id = "none";
  readonly kind = "media" as const;
  readonly mode = "offline" as const;
  readonly label = "Not configured";

  async fetch(_url: string, _options?: MediaFetchOptions): Promise<ProviderResult<FetchedMedia>> {
    throw offlineError("media", "fetch");
  }
}

/** Storage is never "unconfigured" in practice, but the type must be total. */
export class OfflineStorageProvider implements StorageProvider {
  readonly id = "none";
  readonly kind = "storage" as const;
  readonly mode = "offline" as const;
  readonly label = "Not configured";

  async put(_data: Uint8Array): Promise<StoredBlob> {
    throw offlineError("storage", "put");
  }

  async putFromFile(_filePath: string): Promise<StoredBlob> {
    throw offlineError("storage", "putFromFile");
  }

  async has(_hash: string): Promise<boolean> {
    throw offlineError("storage", "has");
  }

  async read(_hash: string): Promise<Uint8Array> {
    throw offlineError("storage", "read");
  }

  async getPath(_hash: string): Promise<string | undefined> {
    throw offlineError("storage", "getPath");
  }

  async list(): Promise<readonly string[]> {
    throw offlineError("storage", "list");
  }
}

export class OfflinePublishProvider implements PublishProvider {
  readonly id = "none";
  readonly kind = "publishing" as const;
  readonly mode = "offline" as const;
  readonly label = "Not configured";

  async upload(
    _videoHash: string,
    _metadata: PublishMetadata,
    _ctx?: CallContext,
  ): Promise<ProviderResult<PublishRef>> {
    throw offlineError("publishing", "upload");
  }

  async quota(_ctx?: CallContext): Promise<ProviderResult<PublisherQuota>> {
    throw offlineError("publishing", "quota");
  }
}
