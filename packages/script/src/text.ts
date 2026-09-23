/**
 * Deterministic text handling for the script engine.
 *
 * The writing brief asks for natural spoken language and forbids filler,
 * repetition, fake suspense, invented dialogue and fabricated sources. Those are
 * judgements — but the *symptoms* are mechanical, so this module finds the
 * symptoms and hands them to the writer as corrections. Nothing here rewrites
 * prose; it only reports.
 */

/** Longest sentence (in words) that still reads naturally aloud. */
export const MAX_SPOKEN_SENTENCE_WORDS = 32;

/** Collapse every whitespace run (including NBSP and newlines) to one space. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Strip trailing punctuation for comparison purposes. */
export function normalizeStatement(statement: string): string {
  return normalizeWhitespace(statement)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d\u201e]/gu, "'")
    .replace(/[.!?\u2026]+$/u, "")
    .replace(/\s*([,;:])\s*/gu, "$1 ");
}

export function words(text: string): string[] {
  return normalizeWhitespace(text)
    .split(" ")
    .filter((word) => word !== "");
}

export function wordCount(text: string): number {
  return words(text).length;
}

/** Split a section's narration into sentences (used for style checks). */
export function sentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?\u2026])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** Lowercased word n-grams, punctuation-insensitive. */
export function ngrams(text: string, size: number): string[] {
  const tokens = words(text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ""));
  const out: string[] = [];
  for (let index = 0; index + size <= tokens.length; index += 1) {
    out.push(tokens.slice(index, index + size).join(" "));
  }
  return out;
}

/**
 * Quotations in narration, as written. Any quoted run is held to the research
 * evidence verbatim: the script is free to quote a source, never to invent one.
 */
export function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  const pattern = /["\u201c\u201d']([^"\u201c\u201d']{3,300})["\u201c\u201d']/gu;
  for (const match of text.matchAll(pattern)) {
    const span = match[1]?.trim() ?? "";
    if (span !== "") spans.push(span);
  }
  return spans;
}

/** Domains (and best-effort host-like tokens) mentioned in narration. */
export function mentionedDomains(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/giu)) {
    const candidate = match[1]!.toLowerCase();
    if (candidate.includes(".") && !candidate.endsWith(".")) found.add(candidate);
  }
  for (const match of text.matchAll(/\b(https?:\/\/\S+)/giu)) {
    try {
      found.add(new URL(match[1]!).hostname.toLowerCase().replace(/^www\./u, ""));
    } catch {
      // A malformed URL is just text; the domain scan above still applies.
    }
  }
  return [...found];
}

/** Deterministic, content-derived id: `sec3`, `s2_4`. */
export function sectionId(index: number): string {
  return `sec${index + 1}`;
}

export function sentenceId(sectionIndex: number, sentenceIndex: number): string {
  return `s${sectionIndex + 1}_${sentenceIndex + 1}`;
}

export function preview(text: string, max = 120): string {
  const collapsed = normalizeWhitespace(text);
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}\u2026`;
}
