import { licenseInfo } from "../license.js";
import type {
  ImageSearchOptions,
  ImageSearchResult,
  ResearchProvider,
  SearchOptions,
  WebSearchResult,
} from "../research.js";
import { filterByLicense } from "../research.js";
import type { InvokeRuntime } from "../runtime.js";
import type { CallContext, ProviderResult } from "../types.js";
import { hashInputs, slug } from "../util.js";

/**
 * Deterministic offline search.
 *
 * Results are derived from the query text alone, so the same research stage
 * always produces the same sources — no network, no quota, no flakiness. The
 * rows deliberately look like real search output (including image licenses),
 * because downstream stages must handle those fields for real.
 *
 * `publishedAt` is derived from a hash so a "recency" filter has something
 * meaningful to work with in tests, and image licenses vary deterministically
 * so the license-filter path is exercised rather than skipped.
 */
const IMAGE_LICENSES = ["cc0", "cc_by", "cc_by_sa", "public_domain"] as const;

export class FakeResearchProvider implements ResearchProvider {
  readonly id: string;
  readonly kind = "research" as const;
  readonly mode = "fake" as const;
  readonly label = "Fake research (deterministic, offline)";

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: { readonly id?: string } = {},
  ) {
    this.id = options.id ?? "fake";
  }

  async search(
    query: string,
    options: SearchOptions = {},
    ctx?: CallContext,
  ): Promise<ProviderResult<readonly WebSearchResult[]>> {
    const limit = clampLimit(options.limit, 3);
    return this.runtime.invoke<readonly WebSearchResult[]>({
      operation: "research.search",
      ...(ctx !== undefined ? { context: ctx } : {}),
      cache: {
        inputs: { query, limit, freshnessDays: options.freshnessDays ?? null },
        toJson: (value) => value,
        fromJson: (json) => json as readonly WebSearchResult[],
      },
      usage: () => ({ units: 1, unit: "requests" }),
      execute: async () => {
        const seed = hashInputs({ query, kind: "web" });
        return Array.from({ length: limit }, (_, index) => ({
          title: `${query} — reference ${index + 1}`,
          url: `https://example.invalid/${slug(query)}/${index + 1}`,
          snippet: `Deterministic excerpt ${index + 1} about "${query}" (fake provider; no network was used).`,
          publishedAt: publishDate(seed, index),
          source: this.id,
        }));
      },
    });
  }

  async images(
    query: string,
    options: ImageSearchOptions = {},
    ctx?: CallContext,
  ): Promise<ProviderResult<readonly ImageSearchResult[]>> {
    const limit = clampLimit(options.limit, 3);
    return this.runtime.invoke<readonly ImageSearchResult[]>({
      operation: "research.images",
      ...(ctx !== undefined ? { context: ctx } : {}),
      cache: {
        inputs: {
          query,
          limit,
          licenseFilter: options.licenseFilter ?? null,
          minWidth: options.minWidth ?? null,
        },
        toJson: (value) => value,
        fromJson: (json) => json as readonly ImageSearchResult[],
      },
      usage: () => ({ units: 1, unit: "requests" }),
      execute: async () => {
        const seed = hashInputs({ query, kind: "image" });
        const rows: readonly ImageSearchResult[] = Array.from({ length: limit }, (_, index) => {
          const kind = IMAGE_LICENSES[byteAt(seed, index) % IMAGE_LICENSES.length]!;
          const width = 640 + byteAt(seed, index + 8) * 8;
          return {
            title: `${query} — image ${index + 1}`,
            imageUrl: `https://example.invalid/${slug(query)}/image-${index + 1}.jpg`,
            pageUrl: `https://example.invalid/${slug(query)}/${index + 1}`,
            license: licenseInfo(kind, this.id, {
              attribution: kind === "cc0" || kind === "public_domain" ? undefined : "Fake Author",
              licenseUrl:
                kind === "cc0"
                  ? "https://creativecommons.org/publicdomain/zero/1.0/"
                  : `https://creativecommons.org/licenses/${kind.replace("_", "-")}/4.0/`,
            }),
            width,
            height: Math.round(width * 0.5625),
            source: this.id,
          };
        });
        const filtered = filterByLicense(rows, options.licenseFilter);
        const minWidth = options.minWidth ?? 0;
        return filtered.filter((row) => (row.width ?? 0) >= minWidth);
      },
    });
  }
}

const clampLimit = (limit: number | undefined, fallback: number): number => {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(20, Math.floor(limit)));
};

/** A deterministic ISO date, oldest-most-recent ordering preserved. */
function publishDate(seed: string, index: number): string {
  const day = 1 + (byteAt(seed, index) % 28);
  const month = 1 + (byteAt(seed, index + 4) % 12);
  const year = 2019 + (byteAt(seed, index + 12) % 6);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

const byteAt = (hex: string, index: number): number =>
  parseInt(hex.slice((index * 2) % 60, ((index * 2) % 60) + 2), 16);
