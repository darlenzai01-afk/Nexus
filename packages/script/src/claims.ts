import type { ScriptClaimEntry, ScriptDoc, ScriptIssueCode } from "@nexus/db";
import type { ResearchClaim, ResearchPackage, ResearchSource } from "@nexus/research";

import { normalizeStatement, normalizeWhitespace } from "./text.js";

/**
 * The claim brief: the only factual material a script may be written from, plus
 * the deterministic verification that the finished narration stayed inside it.
 *
 * This module is where "never present uncertain claims as established facts"
 * stops being a prompt instruction. The research package already decided, per
 * claim, whether it may be asserted (`mayStateAsFact`); here that decision turns
 * into (a) the lists the writer may draw on, and (b) a hard check that every
 * sentence marked `fact` cites only cleared claims, and every `attributed`
 * sentence names a source that actually backs it.
 */

/** A claim the writer may state as fact, with the evidence behind it. */
export interface FactBrief {
  readonly claimId: string;
  readonly statement: string;
  readonly confidence: number;
  readonly sourceDomains: readonly string[];
}

/** A claim that may only be attributed to a named source. */
export interface AttributedBrief {
  readonly claimId: string;
  readonly statement: string;
  readonly certainty: string;
  readonly status: string;
  readonly sourceIds: readonly string[];
  readonly sourceDomains: readonly string[];
  /** Why it is not cleared: sources disagree, only one source, … */
  readonly reason: string;
}

export interface BlockedBrief {
  readonly claimId: string;
  readonly statement: string;
  readonly reason: string;
}

/** Verbatim evidence, indexed by research evidence id. */
export interface EvidenceText {
  readonly excerpt: string;
  /** `"<start>:<end>"` offsets into the source's content. */
  readonly locator: string;
}

export interface ClaimBrief {
  /** Cleared for direct assertion (`mayStateAsFact`). */
  readonly facts: readonly FactBrief[];
  /** Usable only with attribution to one of `sourceIds`. */
  readonly attributed: readonly AttributedBrief[];
  /** Not usable at all: nothing in the research package supports them. */
  readonly blocked: readonly BlockedBrief[];
  readonly sources: ReadonlyMap<string, ResearchSource>;
  readonly claims: ReadonlyMap<string, ResearchClaim>;
  readonly evidence: ReadonlyMap<string, EvidenceText>;
}

/**
 * Split the research package into what may be asserted, what may be reported,
 * and what may not be used. A claim with no verified evidence link is blocked —
 * the writer never even sees it.
 */
export function buildClaimBrief(pkg: ResearchPackage): ClaimBrief {
  const sources = new Map(pkg.sources.map((source) => [source.id, source]));
  const claims = new Map(pkg.claims.map((claim) => [claim.id, claim]));
  const evidence = new Map<string, EvidenceText>(
    pkg.evidence.map((item) => [
      item.id,
      { excerpt: item.excerpt, locator: `${item.locator.start}:${item.locator.end}` },
    ]),
  );
  const facts: FactBrief[] = [];
  const attributed: AttributedBrief[] = [];
  const blocked: BlockedBrief[] = [];

  for (const claim of pkg.claims) {
    const sourceIds = unique(claim.links.map((link) => link.sourceId));
    const usableEvidence = claim.links.filter((link) => evidence.has(link.evidenceId));
    if (sourceIds.length === 0 || usableEvidence.length === 0) {
      blocked.push({
        claimId: claim.id,
        statement: claim.statement,
        reason: "no verified evidence: nothing in the research package quotes it",
      });
      continue;
    }
    const domains = unique(
      sourceIds.map((id) => sources.get(id)?.domain ?? "").filter((domain) => domain !== ""),
    ).sort();
    if (claim.mayStateAsFact) {
      facts.push({
        claimId: claim.id,
        statement: claim.statement,
        confidence: claim.confidence,
        sourceDomains: domains,
      });
      continue;
    }
    attributed.push({
      claimId: claim.id,
      statement: claim.statement,
      certainty: claim.certainty,
      status: claim.status,
      sourceIds,
      sourceDomains: domains,
      reason: claim.contested
        ? "sources disagree about it"
        : claim.status === "contradicted"
          ? "a source disputes it"
          : sourceIds.length < 2
            ? "only one source backs it"
            : "it is not corroborated strongly enough to state as fact",
    });
  }

  const byId = <T extends { claimId: string }>(a: T, b: T): number =>
    a.claimId < b.claimId ? -1 : 1;
  return {
    facts: [...facts].sort(byId),
    attributed: [...attributed].sort(byId),
    blocked: [...blocked].sort(byId),
    sources,
    claims,
    evidence,
  };
}

export interface ClaimViolation {
  readonly code: Extract<
    ScriptIssueCode,
    | "unknown_claim"
    | "unsupported_assertion"
    | "missing_attribution"
    | "unknown_source"
    | "unlinked_source"
  >;
  readonly sectionId: string;
  readonly sentenceId: string;
  readonly message: string;
  readonly detail: string;
}

/**
 * Attribution markers a sentence may use to report a source. Deliberately
 * broad: the check is "does this sentence tell the listener it is reporting
 * rather than asserting?", not a grammar lesson.
 */
const ATTRIBUTION_MARKERS: readonly RegExp[] = [
  /\baccording to\b/iu,
  /\breports?\b|\breported\b/iu,
  /\bsays?\b|\bsaid\b/iu,
  /\bclaims?\b|\bclaimed\b/iu,
  /\bestimates?\b|\bestimated\b|\bestimate\b/iu,
  /\bdisputes?\b|\bdisputed\b/iu,
  /\bmeasured\b|\bcounts?\b|\brecords?\b|\bfigures?\b/iu,
  /\bfound\b|\bsuggests?\b|\bputs? .{0,24}\bat\b/iu,
  /\bstud(?:y|ies)\b|\bresearchers?\b|\bofficials?\b|\bauthorit(?:y|ies)\b/iu,
];

/** Sentence-level cross-check of the narration against the claim brief. */
export function verifyScriptClaims(doc: ScriptDoc, brief: ClaimBrief): ClaimViolation[] {
  const violations: ClaimViolation[] = [];
  for (const section of doc.sections) {
    for (const sentence of section.sentences) {
      const narration = sentence.narration;
      const refs = sentence.claimRefs;
      let unknown = false;

      for (const ref of refs) {
        if (brief.claims.has(ref)) continue;
        unknown = true;
        violations.push({
          code: "unknown_claim",
          sectionId: section.id,
          sentenceId: sentence.id,
          message: `cites ${ref}, which is not in the research package`,
          detail: ref,
        });
      }

      if (sentence.assertion === "fact") {
        if (refs.length === 0) {
          // A "fact" with no claim behind it is an unsupported assertion by
          // definition: the writer must mark such narration as context.
          violations.push({
            code: "unsupported_assertion",
            sectionId: section.id,
            sentenceId: sentence.id,
            message: "is marked as a factual assertion but cites no research claim",
            detail: narration,
          });
        } else {
          for (const ref of refs) {
            const claim = brief.claims.get(ref);
            if (claim === undefined || claim.mayStateAsFact) continue;
            violations.push({
              code: "unsupported_assertion",
              sectionId: section.id,
              sentenceId: sentence.id,
              message: `states "${claim.statement}" as fact, but research did not clear it`,
              detail: `${ref} (${claim.certainty}, ${claim.status})`,
            });
          }
        }
      }

      if (sentence.assertion === "attributed") {
        if (refs.length === 0) {
          violations.push({
            code: "missing_attribution",
            sectionId: section.id,
            sentenceId: sentence.id,
            message: "is marked as attributed but cites no claim",
            detail: narration,
          });
        } else {
          let namedItsSource = true;
          for (const ref of refs) {
            const claim = brief.claims.get(ref);
            if (claim === undefined || claim.mayStateAsFact) continue;
            const allowed = new Set(claim.links.map((link) => link.sourceId));
            if (!sentence.sourceRefs.some((sourceId) => allowed.has(sourceId))) {
              namedItsSource = false;
              violations.push({
                code: "missing_attribution",
                sectionId: section.id,
                sentenceId: sentence.id,
                message: "attributes a claim without naming one of the sources behind it",
                detail: `${ref} ← ${[...allowed].join(", ") || "(no sources)"}`,
              });
              break;
            }
          }
          if (namedItsSource) {
            // The source is named; the sentence must also sound like reporting.
            const namesASource = sentence.sourceRefs.some((sourceId) => {
              const domain = brief.sources.get(sourceId)?.domain ?? "";
              if (domain === "") return false;
              const label = domain.split(".")[0] ?? "";
              const lower = narration.toLowerCase();
              return lower.includes(domain) || (label.length > 2 && lower.includes(label));
            });
            const hasMarker = ATTRIBUTION_MARKERS.some((marker) => marker.test(narration));
            if (!hasMarker && !namesASource) {
              violations.push({
                code: "missing_attribution",
                sectionId: section.id,
                sentenceId: sentence.id,
                message: "reports a source without telling the listener that it is reporting",
                detail: narration,
              });
            }
          }
        }
      }

      if (unknown) continue; // source checks need real claim links
      for (const sourceId of sentence.sourceRefs) {
        const source = brief.sources.get(sourceId);
        if (source === undefined) {
          violations.push({
            code: "unknown_source",
            sectionId: section.id,
            sentenceId: sentence.id,
            message: `cites ${sourceId}, which is not in the research package`,
            detail: sourceId,
          });
          continue;
        }
        if (refs.length === 0) continue;
        const linked = refs.some((ref) =>
          (brief.claims.get(ref)?.links ?? []).some((link) => link.sourceId === sourceId),
        );
        if (!linked) {
          violations.push({
            code: "unlinked_source",
            sectionId: section.id,
            sentenceId: sentence.id,
            message: `names ${source.domain}, which backs none of the claims in this sentence`,
            detail: sourceId,
          });
        }
      }
    }
  }
  return violations;
}

/**
 * The ledger: every claim the script actually leans on, the sentences that use
 * it, and the verbatim evidence behind it. This is what keeps the claim →
 * evidence link intact into the artifact and the database.
 */
export function buildClaimLedger(doc: ScriptDoc, brief: ClaimBrief): ScriptClaimEntry[] {
  const usage = new Map<string, { usage: "fact" | "attributed"; sentenceIds: Set<string> }>();
  for (const section of doc.sections) {
    for (const sentence of section.sentences) {
      if (sentence.assertion === "context") continue;
      for (const ref of sentence.claimRefs) {
        if (!brief.claims.has(ref)) continue;
        const existing = usage.get(ref) ?? {
          usage: sentence.assertion === "fact" ? ("fact" as const) : ("attributed" as const),
          sentenceIds: new Set<string>(),
        };
        if (sentence.assertion === "fact") existing.usage = "fact"; // asserting wins
        existing.sentenceIds.add(sentence.id);
        usage.set(ref, existing);
      }
    }
  }

  const entries: ScriptClaimEntry[] = [];
  for (const claimId of [...usage.keys()].sort()) {
    const used = usage.get(claimId);
    const claim = brief.claims.get(claimId);
    if (used === undefined || claim === undefined) continue;
    const evidence = claim.links
      .map((link) => {
        const text = brief.evidence.get(link.evidenceId);
        if (text === undefined) return undefined;
        return {
          sourceId: link.sourceId,
          url: brief.sources.get(link.sourceId)?.url ?? "",
          excerpt: text.excerpt,
          locator: text.locator,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    if (evidence.length === 0) continue; // a claim with no evidence is not part of the script
    entries.push({
      claimId,
      statement: claim.statement,
      status: claim.status,
      certainty: claim.certainty,
      confidence: claim.confidence,
      mayStateAsFact: claim.mayStateAsFact,
      usage: used.usage,
      sentenceIds: [...used.sentenceIds].sort(),
      evidence,
    });
  }
  return entries;
}

/** Normalised comparison used when a model paraphrases a claim back at us. */
export function sameStatement(a: string, b: string): boolean {
  return normalizeStatement(normalizeWhitespace(a)) === normalizeStatement(normalizeWhitespace(b));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
