import type { LicenseInfo, LicenseKind } from "./license.js";
import type { CallContext, ProviderMeta, ProviderResult } from "./types.js";

/**
 * Research/search capability. One interface for "find sources" and "find
 * usable media", because both are quota-limited free tiers that must be
 * swappable (Brave/Serper/Tavily/SearXNG today, something else tomorrow) and
 * both must degrade to operator-pasted input when exhausted.
 */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  /** Excerpt text used as evidence; treated strictly as data (AD-12). */
  readonly snippet: string;
  /** Provider-reported publication date, when it gives one. */
  readonly publishedAt?: string;
  /** Which adapter returned this row (provenance for the sources table). */
  readonly source: string;
}

export interface ImageSearchResult {
  readonly title: string;
  readonly imageUrl: string;
  /** Page the image was found on (attribution target). */
  readonly pageUrl: string;
  readonly license: LicenseInfo;
  readonly width?: number;
  readonly height?: number;
  readonly source: string;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Only results newer than N days, when the provider supports it. */
  readonly freshnessDays?: number;
}

export interface ImageSearchOptions extends SearchOptions {
  /** Required license kinds; other rows must be filtered out by the adapter. */
  readonly licenseFilter?: readonly LicenseKind[];
  readonly minWidth?: number;
}

export interface ResearchProvider extends ProviderMeta {
  readonly kind: "research";
  search(
    query: string,
    options?: SearchOptions,
    ctx?: CallContext,
  ): Promise<ProviderResult<readonly WebSearchResult[]>>;
  images(
    query: string,
    options?: ImageSearchOptions,
    ctx?: CallContext,
  ): Promise<ProviderResult<readonly ImageSearchResult[]>>;
}

/** Keep only the rows whose license the caller is willing to use. */
export function filterByLicense(
  rows: readonly ImageSearchResult[],
  allowed: readonly LicenseKind[] | undefined,
): readonly ImageSearchResult[] {
  if (allowed === undefined || allowed.length === 0) return rows;
  const permitted = new Set(allowed);
  return rows.filter((row) => permitted.has(row.license.kind));
}
