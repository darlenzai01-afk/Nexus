import type { ManualRequest } from "./errors.js";
import { ManualRequiredError } from "./errors.js";
import type { FetchedMedia, MediaFetchOptions, MediaProvider } from "./media.js";
import type {
  PublishMetadata,
  PublishProvider,
  PublishRef,
  PublisherQuota,
  UploadKit,
  UploadKitFile,
} from "./publishing.js";
import type {
  ImageSearchOptions,
  ImageSearchResult,
  ResearchProvider,
  SearchOptions,
  WebSearchResult,
} from "./research.js";
import type { InvokeRuntime } from "./runtime.js";
import { storageUsage } from "./storage.js";
import type { SynthesisRequest, SynthesisResult, TTSProvider, VoiceProfile } from "./tts.js";
import type { CallContext, ProviderResult } from "./types.js";
import { hashInputs } from "./util.js";
import type { LLMProvider, LLMRequest, StructuredOutput } from "./llm.js";

/**
 * Manual (human-in-the-loop) fallbacks — AD-06.
 *
 * Free tiers run out. When they do, the pipeline must **pause at a human**,
 * not crash and not silently produce worse output. Every manual provider
 * therefore raises `ManualRequiredError` carrying the exact instructions the
 * operator needs; tasks convert that into a job gate (`{ waiting: ... }`), so
 * the work already done is preserved and the episode simply waits for a person.
 *
 * Publishing is the exception, and deliberately so: the manual path *succeeds*.
 * Assisted publishing (an upload kit) is the primary path until the YouTube
 * audit is done, so `ManualPublishProvider.upload()` builds the kit, stores its
 * manifest as an artifact and returns a `kit_ready` result.
 */
export class ManualLLMProvider implements LLMProvider {
  readonly id: string;
  readonly kind = "llm" as const;
  readonly mode = "manual" as const;
  readonly label = "Manual LLM (operator writes the answer)";

  constructor(options: { readonly id?: string } = {}) {
    this.id = options.id ?? "manual";
  }

  async chat<T>(request: LLMRequest<T>): Promise<ProviderResult<StructuredOutput<T>>> {
    throw new ManualRequiredError({
      capability: "llm",
      operation: `llm.${request.task ?? "chat"}`,
      summary: "this step needs an LLM answer, but no AI provider is available",
      instructions: [
        "Open the episode in the dashboard (or run the CLI helper) and paste the JSON for this step.",
        "The answer must validate against the step's schema; the dashboard shows the fields it expects.",
        "Then resolve the waiting gate to let the pipeline continue from this stage.",
      ],
      expectedFormat: request.schemaHint ?? "JSON matching the step schema",
    });
  }
}

export class ManualResearchProvider implements ResearchProvider {
  readonly id: string;
  readonly kind = "research" as const;
  readonly mode = "manual" as const;
  readonly label = "Manual research (operator pastes sources)";

  constructor(options: { readonly id?: string } = {}) {
    this.id = options.id ?? "manual";
  }

  async search(
    query: string,
    _options?: SearchOptions,
  ): Promise<ProviderResult<readonly WebSearchResult[]>> {
    throw manual("research", "research.search", `no search provider is available for "${query}"`, [
      "Paste source URLs (and a quote or two each) into the sources panel for this episode.",
      "Each source becomes a row in `sources` with its snapshot, so claims can cite it.",
      "Resolve the gate when the episode has enough evidence to write from.",
    ]);
  }

  async images(
    query: string,
    _options?: ImageSearchOptions,
  ): Promise<ProviderResult<readonly ImageSearchResult[]>> {
    throw manual(
      "research",
      "research.images",
      `no image search provider is available for "${query}"`,
      [
        "Add media by URL (or drop files into the data directory) with license details attached.",
        "Every media asset needs a license: unlicensed assets cannot be rendered by policy.",
        "Resolve the gate to continue with sourcing.",
      ],
    );
  }
}

export class ManualTTSProvider implements TTSProvider {
  readonly id: string;
  readonly kind = "tts" as const;
  readonly mode = "manual" as const;
  readonly label = "Manual TTS (operator records or uploads audio)";

  constructor(options: { readonly id?: string } = {}) {
    this.id = options.id ?? "manual";
  }

  voices(): readonly VoiceProfile[] {
    return [];
  }

  async synthesize(request: SynthesisRequest): Promise<ProviderResult<SynthesisResult>> {
    throw manual(
      "tts",
      "tts.synthesize",
      `no voice provider is available for ${request.text.length} characters`,
      [
        "Record the narration (or run a local TTS) and attach the file to this episode.",
        "Attach word timings if you have them — otherwise the caption engine will fall back to estimates.",
        "Resolve the gate to continue with captions.",
      ],
      "an audio file (WAV/MP3) plus optional word timings",
    );
  }
}

export class ManualMediaProvider implements MediaProvider {
  readonly id: string;
  readonly kind = "media" as const;
  readonly mode = "manual" as const;
  readonly label = "Manual media (operator supplies files)";

  constructor(options: { readonly id?: string } = {}) {
    this.id = options.id ?? "manual";
  }

  async fetch(url: string, _options?: MediaFetchOptions): Promise<ProviderResult<FetchedMedia>> {
    throw manual("media", "media.fetch", `cannot fetch ${url} automatically`, [
      "Download the file yourself and add it to the episode's media library.",
      "Include the license and attribution so the policy engine can approve it.",
      "Resolve the gate to continue with sourcing.",
    ]);
  }
}

/**
 * Assisted publishing: the operator uploads, the system does everything else.
 */
export class ManualPublishProvider implements PublishProvider {
  readonly id: string;
  readonly kind = "publishing" as const;
  readonly mode = "manual" as const;
  readonly label = "Manual publish (upload kit)";

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: { readonly id?: string } = {},
  ) {
    this.id = options.id ?? "manual";
  }

  async upload(
    videoHash: string,
    metadata: PublishMetadata,
    ctx?: CallContext,
  ): Promise<ProviderResult<PublishRef>> {
    return this.runtime.invoke<PublishRef>({
      operation: "publish.upload",
      ...(ctx !== undefined ? { context: ctx } : {}),
      usage: (value) =>
        value.status === "kit_ready" ? { units: 0, unit: "uploads" } : storageUsage(0),
      execute: async () => {
        const files: UploadKitFile[] = [
          {
            role: "video",
            hash: videoHash,
            suggestedName: `${slugName(metadata.title)}.mp4`,
            mime: "video/mp4",
          },
          ...(metadata.thumbnailHash !== undefined
            ? [
                {
                  role: "thumbnail" as const,
                  hash: metadata.thumbnailHash,
                  suggestedName: `${slugName(metadata.title)}.jpg`,
                  mime: "image/jpeg",
                },
              ]
            : []),
          {
            role: "metadata",
            hash: "",
            suggestedName: `${slugName(metadata.title)}.json`,
            mime: "application/json",
          },
        ];
        const manifest = {
          version: 1,
          videoHash,
          metadata,
          files: files.filter((file) => file.hash !== ""),
          generatedAt: this.runtime.clock.nowIso(),
          instructions: instructionsFor(metadata),
        };
        const stored = this.runtime.storage.put(
          new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        );
        const kit: UploadKit = {
          manifestHash: stored.hash,
          instructions: manifest.instructions,
          files: [
            ...files.filter((file) => file.hash !== ""),
            {
              role: "metadata",
              hash: stored.hash,
              suggestedName: `${slugName(metadata.title)}-kit.json`,
              mime: "application/json",
            },
          ],
        };
        return {
          id: `kit-${hashInputs({ videoHash, title: metadata.title }).slice(0, 12)}`,
          provider: this.id,
          mode: "manual",
          status: "kit_ready",
          kit,
        };
      },
    });
  }

  async quota(ctx?: CallContext): Promise<ProviderResult<PublisherQuota>> {
    return this.runtime.invoke<PublisherQuota>({
      operation: "publish.quota",
      ...(ctx !== undefined ? { context: ctx } : {}),
      usage: () => ({ units: 0, unit: "requests" }),
      execute: async () => ({
        provider: this.id,
        window: "none",
        limit: null,
        used: null,
        remaining: null,
        note: "manual publishing is not quota-limited (only API uploads are)",
      }),
    });
  }
}

function manual(
  capability: ManualRequest["capability"],
  operation: string,
  summary: string,
  instructions: readonly string[],
  expectedFormat?: string,
): ManualRequiredError {
  return new ManualRequiredError({
    capability,
    operation,
    summary,
    instructions,
    ...(expectedFormat !== undefined ? { expectedFormat } : {}),
  });
}

function instructionsFor(metadata: PublishMetadata): readonly string[] {
  return [
    `Upload the video file with title: "${metadata.title}"`,
    `Visibility: ${metadata.privacyStatus}${metadata.scheduledAt ? ` (scheduled for ${metadata.scheduledAt})` : ""}`,
    "Paste the description from the manifest; keep the attribution lines intact.",
    "Add the tags from the manifest (YouTube limits total tag length).",
    `Set the thumbnail if one is included${metadata.madeForKids ? "; mark as made for kids" : ""}.`,
    "Record the published URL back in the episode so the audit trail is complete.",
  ];
}

const slugName = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "episode";
