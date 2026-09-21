import type { ScriptDoc, ScriptIssueCode, ScriptQualityIssue, ScriptSectionRole } from "@nexus/db";

import {
  MAX_SPOKEN_SENTENCE_WORDS,
  mentionedDomains,
  ngrams,
  normalizeWhitespace,
  preview,
  quotedSpans,
  wordCount,
} from "./text.js";

/**
 * The writing lint: deterministic checks for the failure modes the brief names —
 * filler, repetitive AI phrasing, fake suspense, invented dialogue and
 * fabricated sources — plus the two properties that make a script speakable
 * (sentence length, no markup).
 *
 * The lint never rewrites prose (that would be an AI job, and a risky one). It
 * reports, the writer gets one corrective round with the findings, and whatever
 * survives is recorded in the artifact so a human sees it.
 */

/** Phrases that pad a script without adding information. */
export const FILLER_PHRASES: readonly string[] = [
  "in this video",
  "in today's video",
  "let's dive in",
  "let's dive into",
  "without further ado",
  "it's important to note",
  "it is important to note",
  "it's worth noting",
  "it is worth noting",
  "as we can see",
  "as you can see",
  "at the end of the day",
  "when it comes to",
  "in today's world",
  "in this day and age",
  "let's take a look",
  "take a look at",
  "first and foremost",
  "last but not least",
  "needless to say",
  "the fact of the matter is",
  "in conclusion",
  "to sum up",
  "all in all",
  "at this point in time",
  "a lot of things",
  "the world of",
  "delve into",
  "unpack this",
  "that being said",
  "having said that",
  "it goes without saying",
  "in order to",
  "due to the fact that",
  "for all intents and purposes",
  "each and every",
  "very unique",
  "basically",
  "essentially",
  "actually",
  "literally",
  "simply put",
  "so, without",
];

/** Manufactured tension: the brief calls it out by name. */
export const FAKE_SUSPENSE_PHRASES: readonly string[] = [
  "stay tuned",
  "you won't believe",
  "you will not believe",
  "what happened next",
  "the answer may surprise you",
  "the answer will surprise you",
  "little did they know",
  "but little did",
  "here's the kicker",
  "here is the kicker",
  "but wait",
  "but that's not all",
  "and that's when everything changed",
  "and then everything changed",
  "buckle up",
  "spoiler alert",
  "plot twist",
  "mind blowing",
  "mind-blowing",
  "shocking truth",
  "the shocking",
  "secret they don't want",
  "nobody talks about",
  "what nobody tells you",
  "what they don't tell you",
  "you've been lied to",
  "the truth will",
  "brace yourself",
];

/** Connectives that make machine-written prose sound machine-written. */
export const OVERUSED_CONNECTIVES: readonly string[] = [
  "moreover",
  "furthermore",
  "additionally",
  "in addition",
  "consequently",
  "nevertheless",
  "nonetheless",
  "thus",
  "hence",
  "indeed",
  "notably",
];

export interface StyleFinding {
  /** Any issue code: claim violations and structure problems share the vocabulary. */
  readonly code: ScriptIssueCode;
  readonly severity: "hard" | "soft";
  readonly sectionId: string;
  readonly sentenceId: string;
  readonly message: string;
  readonly detail: string;
}

export interface StyleContext {
  /** Domains present in the research package — the only ones a script may name. */
  readonly knownDomains: readonly string[];
  /**
   * Verbatim excerpts from the research evidence. A quoted run in narration must
   * match one of these (whitespace/case-insensitively): a script may quote a
   * source, never invent a quotation or a line of dialogue.
   */
  readonly evidenceExcerpts: readonly string[];
}

export function knownSectionRoles(doc: ScriptDoc): ScriptSectionRole[] {
  return doc.sections.map((section) => section.role);
}

/**
 * Structural rules from the brief: a hook, an introduction, narrative sections,
 * a conclusion — in that order, each with narration.
 */
export function structureFindings(doc: ScriptDoc): StyleFinding[] {
  const findings: StyleFinding[] = [];
  const roles = doc.sections.map((section) => ({ id: section.id, role: section.role }));
  const countOf = (role: ScriptSectionRole): number =>
    roles.filter((entry) => entry.role === role).length;

  const add = (message: string, detail: string): void => {
    findings.push({
      code: "missing_section",
      severity: "hard",
      sectionId: "",
      sentenceId: "",
      message,
      detail,
    });
  };

  if (countOf("hook") !== 1)
    add("a script needs exactly one hook section", `found ${countOf("hook")}`);
  if (countOf("introduction") !== 1)
    add("a script needs exactly one introduction section", `found ${countOf("introduction")}`);
  if (countOf("narrative") < 2)
    add("a script needs at least two narrative sections", `found ${countOf("narrative")}`);
  if (countOf("conclusion") !== 1)
    add("a script needs exactly one conclusion section", `found ${countOf("conclusion")}`);

  const order: ScriptSectionRole[] = ["hook", "introduction", "narrative", "conclusion"];
  const rank = (role: ScriptSectionRole): number => order.indexOf(role);
  for (let index = 1; index < roles.length; index += 1) {
    const previous = roles[index - 1]!;
    const current = roles[index]!;
    if (rank(current.role) < rank(previous.role)) {
      add(
        "sections are out of order",
        `${previous.role} (${previous.id}) then ${current.role} (${current.id})`,
      );
    }
  }
  if (roles[0] !== undefined && roles[0].role !== "hook") {
    add("the first section must be the hook", roles[0].role);
  }
  if (doc.sections.some((section) => section.sentences.length === 0)) {
    add("every section needs narration", "an empty section reached the artifact");
  }
  return findings;
}

/** All deterministic writing-quality findings for a finished draft. */
export function lintScript(doc: ScriptDoc, context: StyleContext): StyleFinding[] {
  const findings: StyleFinding[] = [...structureFindings(doc)];
  const excerpts = context.evidenceExcerpts.map((excerpt) =>
    normalizeWhitespace(excerpt).toLowerCase(),
  );
  const knownDomains = new Set(context.knownDomains.map((domain) => domain.toLowerCase()));

  const openingCounts = new Map<string, string[]>();
  const connectiveSentences: { sectionId: string; sentenceId: string; words: string[] }[] = [];

  for (const section of doc.sections) {
    for (const sentence of section.sentences) {
      const narration = sentence.narration;
      const lower = narration.toLowerCase();
      const at = { sectionId: section.id, sentenceId: sentence.id };

      for (const phrase of FILLER_PHRASES) {
        if (lower.includes(phrase)) {
          findings.push({
            code: "filler",
            severity: "soft",
            ...at,
            message: `filler phrase: "${phrase}"`,
            detail: preview(narration),
          });
        }
      }

      for (const phrase of FAKE_SUSPENSE_PHRASES) {
        if (lower.includes(phrase)) {
          findings.push({
            code: "fake_suspense",
            severity: "soft",
            ...at,
            message: `manufactured suspense: "${phrase}"`,
            detail: preview(narration),
          });
        }
      }

      const usedConnectives = OVERUSED_CONNECTIVES.filter((connective) =>
        new RegExp("\\b" + connective + "\\b", "iu").test(narration),
      );
      if (usedConnectives.length > 0) {
        connectiveSentences.push({ ...at, words: usedConnectives });
      }

      const opening = normalizeWhitespace(narration).split(" ").slice(0, 3).join(" ").toLowerCase();
      if (wordCount(opening) === 3) {
        openingCounts.set(opening, [...(openingCounts.get(opening) ?? []), sentence.id]);
      }

      const count = wordCount(narration);
      if (count > MAX_SPOKEN_SENTENCE_WORDS) {
        findings.push({
          code: "long_sentence",
          severity: "soft",
          ...at,
          message: `sentence is ${count} words; spoken narration should stay under ${MAX_SPOKEN_SENTENCE_WORDS}`,
          detail: preview(narration),
        });
      }

      if (/[*_#`>]|\[[^\]]*\]\(|^\s*[-•]\s/u.test(narration)) {
        findings.push({
          code: "markup",
          severity: "soft",
          ...at,
          message: "narration contains markup; it is read aloud, so it must be plain text",
          detail: preview(narration),
        });
      }

      for (const quote of quotedSpans(narration)) {
        const normalized = normalizeWhitespace(quote).toLowerCase();
        const supported = excerpts.some((excerpt) => excerpt.includes(normalized));
        if (!supported) {
          findings.push({
            code: "unverified_quote",
            severity: "hard",
            ...at,
            message: "quoted text does not appear in the research evidence",
            detail: preview(quote),
          });
        }
      }

      for (const domain of mentionedDomains(narration)) {
        if (!knownDomains.has(domain)) {
          findings.push({
            code: "fabricated_source",
            severity: "hard",
            ...at,
            message: `names ${domain}, which is not one of the researched sources`,
            detail: preview(narration),
          });
        }
      }
    }
  }

  // Whole-script repetition: the same three-word opening, or a repeated phrase
  // of four words or more, is the signature of machine-generated padding.
  for (const [opening, ids] of openingCounts) {
    if (ids.length >= 3) {
      findings.push({
        code: "repetition",
        severity: "soft",
        sectionId: "",
        sentenceId: ids[0]!,
        message: `${ids.length} sentences start with the same three words: "${opening}"`,
        detail: ids.join(", "),
      });
    }
  }

  const phraseCounts = new Map<string, { count: number; sentenceId: string; sectionId: string }>();
  for (const section of doc.sections) {
    for (const sentence of section.sentences) {
      const seen = new Set(ngrams(sentence.narration, 4));
      for (const gram of seen) {
        const existing = phraseCounts.get(gram);
        if (existing === undefined) {
          phraseCounts.set(gram, { count: 1, sentenceId: sentence.id, sectionId: section.id });
        } else {
          existing.count += 1;
        }
      }
    }
  }
  for (const [gram, info] of phraseCounts) {
    if (info.count >= 3) {
      findings.push({
        code: "repetition",
        severity: "soft",
        sectionId: info.sectionId,
        sentenceId: info.sentenceId,
        message: `the phrase "${gram}" appears in ${info.count} sentences`,
        detail: gram,
      });
    }
  }
  // "Moreover… furthermore… additionally…" is the clearest signature of
  // machine-written prose, so it is measured across the script, not per word.
  if (connectiveSentences.length >= 3) {
    const first = connectiveSentences[0]!;
    const used = [...new Set(connectiveSentences.flatMap((entry) => entry.words))].sort();
    findings.push({
      code: "repetition",
      severity: "soft",
      sectionId: first.sectionId,
      sentenceId: first.sentenceId,
      message: `${connectiveSentences.length} sentences lean on academic connectives (${used.join(", ")})`,
      detail: connectiveSentences.map((entry) => entry.sentenceId).join(", "),
    });
  }

  return findings.sort(compareFindings);
}

export function toQualityIssues(
  findings: readonly StyleFinding[],
  resolvedByRepair = false,
): ScriptQualityIssue[] {
  return findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    sectionId: finding.sectionId,
    sentenceId: finding.sentenceId,
    detail: finding.detail,
    resolvedByRepair,
  }));
}

function compareFindings(a: StyleFinding, b: StyleFinding): number {
  if (a.severity !== b.severity) return a.severity === "hard" ? -1 : 1;
  if (a.sectionId !== b.sectionId) return a.sectionId < b.sectionId ? -1 : 1;
  if (a.sentenceId !== b.sentenceId) return a.sentenceId < b.sentenceId ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}
