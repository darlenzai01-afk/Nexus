import { sha256Hex } from "@nexus/providers";

/**
 * Deterministic text and URL handling for the research engine (AD-07: code
 * does parsing, validation, deduplication and storage; AI only synthesises).
 *
 * The load-bearing function here is `findQuote`: it is what makes "never invent
 * quotations" a mechanical property instead of a prompt request. The model
 * supplies a candidate quote; the engine locates it in the retrieved text and
 * then stores *the source's own characters* as the excerpt. A quote that cannot
 * be located is discarded, so a hallucinated sentence cannot reach the package.
 */

/** Longest excerpt the engine will store (a verbatim prefix if the quote is longer). */
export const MAX_EVIDENCE_CHARS = 400;

/** Longest single quote accepted from a model before the match is truncated. */
export const MAX_QUOTE_CHARS = 1_200;

const QUOTE_GROUPS: readonly (readonly string[])[] = [
  ["'", "\u2018", "\u2019", "\u201a", "\u201b"],
  ['"', "\u201c", "\u201d", "\u201e", "\u201f"],
  ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212"],
];

const escapeRegExp = (char: string): string =>
  /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;

const charClass = (chars: readonly string[]): string => `[${chars.map(escapeRegExp).join("")}]`;

/** Collapse every whitespace run (including NBSP and newlines) to one space. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Build a whitespace- and typography-tolerant matcher for a model-supplied
 * quote. Deliberately *not* fuzzy: only whitespace layout, quote glyphs and
 * dashes are normalised, and matching is case-insensitive. Word order and word
 * choice must be the source's own.
 */
export function quotePattern(quote: string): RegExp | undefined {
  const collapsed = normalizeWhitespace(quote).slice(0, MAX_QUOTE_CHARS);
  if (collapsed === "") return undefined;
  let pattern = "";
  for (const char of collapsed) {
    const group = QUOTE_GROUPS.find((candidates) => candidates.includes(char));
    if (group !== undefined) {
      pattern += charClass(group);
      continue;
    }
    pattern += char === " " ? "\\s+" : escapeRegExp(char);
  }
  return new RegExp(pattern, "iu");
}

export interface QuoteMatch {
  readonly start: number;
  readonly end: number;
  /** `content.slice(start, end)` — verbatim, and what gets stored. */
  readonly excerpt: string;
}

/**
 * Locate `quote` inside `content`. Returns offsets into `content` (never into a
 * normalised copy), so the stored excerpt is exactly the source's text.
 */
export function findQuote(
  content: string,
  quote: string,
  maxChars = MAX_EVIDENCE_CHARS,
): QuoteMatch | undefined {
  const pattern = quotePattern(quote);
  if (pattern === undefined) return undefined;
  const match = pattern.exec(content);
  if (match === null) return undefined;

  const start = match.index;
  const fullLength = match[0].length;
  let excerpt = content.slice(start, Math.min(start + fullLength, start + maxChars));
  if (start + fullLength > start + maxChars) {
    // Truncated: back off to the last word boundary so the excerpt does not end
    // mid-word (it stays a verbatim prefix of the source either way).
    const lastSpace = excerpt.lastIndexOf(" ");
    if (lastSpace > maxChars / 2) excerpt = excerpt.slice(0, lastSpace);
  }
  if (excerpt.trim() === "") return undefined;
  return { start, end: start + excerpt.length, excerpt };
}

/** Dedup key for claim statements: case/punctuation-insensitive, stable. */
export function normalizeStatement(statement: string): string {
  return normalizeWhitespace(statement)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d\u201e]/gu, "'")
    .replace(/[.!?\u2026]+$/u, "")
    .replace(/\s*([,;:])\s*/gu, "$1 ");
}

/**
 * Query/tracking parameters that never change which page is meant. Dropped when
 * canonicalising so two search hits for the same article collapse into one
 * source (duplicate detection is deterministic, not heuristic).
 */
const TRACKING_PARAMS: readonly string[] = [
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "referrer",
  "source",
  "spm",
  "yclid",
];

/** `utm_*` covers a family, so it is matched by prefix. */
const isTrackingParam = (key: string): boolean =>
  key.startsWith("utm_") || TRACKING_PARAMS.includes(key);

/**
 * Canonical form of a URL for deduplication and storage: lowercase scheme/host,
 * no fragment, no default port, no tracking parameters, no trailing slash.
 * Returns `undefined` when the input is not an absolute URL.
 */
export function canonicalUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  // The SSRF guard (`assertPublicHttpUrl`) is the security boundary; this is
  // the shape check, and it also keeps `javascript:`/`file:` out of storage.
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

/** Registrable-ish domain used as source metadata (www is noise). */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** Deterministic, content-derived id: `src_1a2b3c4d`, `cl_…`, `ev_…`, `cf_…`. */
export function shortId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${sha256Hex(parts.join("|")).slice(0, 8)}`;
}

/** Truncate for logs/drop records — never for stored content. */
export function preview(text: string, max = 160): string {
  const collapsed = normalizeWhitespace(text);
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}\u2026`;
}
