import { GeneratedBySchema } from "@nexus/db";
import { z } from "zod";

/**
 * The research package: the structured document a research run produces and
 * every later stage consumes (discovery §6.1, §11).
 *
 * Three rules from the phase brief are encoded in the *shape* of this document
 * rather than in prose, so they cannot be forgotten downstream:
 *
 * 1. **Sources are never invented.** A source only exists here because a
 *    provider's search returned its URL and the engine accepted it
 *    (`RetrievalSchema` records where the text came from). `dropped[]` keeps
 *    every rejection with a reason, so an empty package is visibly empty
 *    instead of quietly plausible.
 * 2. **Quotations are never invented.** Every `excerpt` is a slice of its
 *    source's own `content` (`EvidenceLocatorSchema` holds the offsets), never
 *    model-written text. A model quote that cannot be located is dropped.
 * 3. **Uncertainty is never presented as fact.** A claim carries a
 *    verification `status`, a deterministic `confidence`, its corroboration and
 *    `mayStateAsFact` — the last one true only for a corroborated, uncontested
 *    claim. Disagreement is *preserved* in `conflicts[]` (never resolved) and
 *    marks both sides `contested`.
 */

/** Provenance record for AI-generated content (AD-07: every artifact is tagged). */
export type GeneratedBy = z.infer<typeof GeneratedBySchema>;

export const RESEARCH_PACKAGE_VERSION = 1;

/** Engine identity, stamped into every package (provenance). */
export const RESEARCH_ENGINE = { name: "nexus-research", version: "1.0.0" } as const;

/** How a claim is related to one source's material (the claim/source edge). */
export const StanceSchema = z.enum(["supports", "contradicts", "mentions"]);
export type Stance = z.infer<typeof StanceSchema>;

/** Verification status — the same vocabulary as `claims.status` in the DB. */
export const VerificationStatusSchema = z.enum([
  "supported",
  "contradicted",
  "unverified",
  "unsupportable",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * The operator-facing reading of a claim. `mayStateAsFact` is exactly
 * `certainty === "established"`; a script may assert nothing weaker.
 */
export const CertaintySchema = z.enum([
  "established",
  "likely",
  "disputed",
  "uncertain",
  "unsupported",
]);
export type Certainty = z.infer<typeof CertaintySchema>;

/** Where a source's text came from — the honesty tag on retrieved content. */
export const RetrievalSchema = z.enum([
  /** The search provider's snippet; the only text we hold for that source. */
  "provider_snippet",
  /** Content pasted by an operator (manual degradation path, AD-06). */
  "operator_text",
  /** No text: the source is recorded, but nothing can be quoted from it. */
  "unavailable",
]);
export type Retrieval = z.infer<typeof RetrievalSchema>;

// ── Research questions ───────────────────────────────────────────────────

export const ResearchQuestionSchema = z.object({
  /** Stable, positional: `q1`, `q2`, … (part of every claim's provenance). */
  id: z.string().min(1),
  question: z.string().min(1),
  rationale: z.string().default(""),
  priority: z.enum(["primary", "supporting"]).default("primary"),
  /** Search queries issued for this question (deduplicated, deterministic). */
  queries: z.array(z.string().min(1)).default([]),
});
export type ResearchQuestion = z.infer<typeof ResearchQuestionSchema>;

// ── Sources + metadata ───────────────────────────────────────────────────

export const ResearchSourceSchema = z.object({
  /** `src_<hash8>` of the canonical URL — stable across runs. */
  id: z.string().min(1),
  /** Canonical URL: what is stored, deduplicated and linked to the episode. */
  url: z.string().min(1),
  /** Exactly what the provider returned, kept for traceability. */
  originalUrl: z.string().min(1),
  domain: z.string().default(""),
  title: z.string().default(""),
  /** Adapter-reported provenance of the row (`WebSearchResult.source`). */
  publisher: z.string().default(""),
  publishedAt: z.string().optional(),
  retrievedAt: z.string().min(1),
  /** Research adapter id that produced the row. */
  provider: z.string().min(1),
  /** Questions whose queries surfaced this source. */
  questionIds: z.array(z.string()).default([]),
  /** The retrieved text — the only text any quotation may come from. */
  content: z.string().default(""),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "expected sha256 hex"),
  contentLength: z.number().int().nonnegative(),
  retrieval: RetrievalSchema,
});
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

// ── Evidence (verbatim) ──────────────────────────────────────────────────

export const EvidenceLocatorSchema = z.object({
  kind: z.literal("source_content"),
  /** `excerpt === source.content.slice(start, end)` — verifiable by slicing. */
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

export const EvidenceSchema = z.object({
  /** `ev_<hash8>` of (source, offsets) — stable and collision-free in practice. */
  id: z.string().min(1),
  sourceId: z.string().min(1),
  /** Verbatim text from the source's content. Never model prose. */
  excerpt: z.string().min(1),
  locator: EvidenceLocatorSchema,
  /** Why the extractor thinks this passage is relevant (model prose, labelled). */
  relevance: z.string().default(""),
  questionIds: z.array(z.string()).default([]),
  /** Which AI produced this extraction (AD-07: every AI artifact is tagged). */
  extractedBy: GeneratedBySchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ── Claims + claim/source relationships ──────────────────────────────────

export const ClaimLinkSchema = z.object({
  sourceId: z.string().min(1),
  evidenceId: z.string().min(1),
  stance: StanceSchema,
  /** Model-reported strength of the relationship, 0–1 (clamped, validated). */
  strength: z.number().min(0).max(1),
  /** Model prose explaining the relationship (kept as data, never rendered raw). */
  rationale: z.string().default(""),
});
export type ClaimLink = z.infer<typeof ClaimLinkSchema>;

export const CorroborationSchema = z.object({
  supportingSources: z.array(z.string()).default([]),
  contradictingSources: z.array(z.string()).default([]),
  mentioningSources: z.array(z.string()).default([]),
  /** Distinct sources backing the claim (`supportingSources.length`). */
  independentSources: z.number().int().nonnegative().default(0),
});

export const ResearchClaimSchema = z.object({
  /** `cl_<hash8>` of the canonical statement — stable across runs. */
  id: z.string().min(1),
  /** Canonical wording; chosen deterministically from the merged variants. */
  statement: z.string().min(1),
  /** Other wordings of the same fact, preserved (never silently discarded). */
  variants: z.array(z.string()).default([]),
  questionId: z.string().optional(),
  questionIds: z.array(z.string()).default([]),
  /**
   * The claim/source relationships. Empty means *nothing* the model offered for
   * this claim could be verified against a source: the claim is kept as
   * `unverified` (so the operator sees what was asserted) and can never be
   * stated as fact.
   */
  links: z.array(ClaimLinkSchema).default([]),
  status: VerificationStatusSchema,
  certainty: CertaintySchema,
  /** Deterministic score in 0–1 (`evaluate.ts`), not a model opinion. */
  confidence: z.number().min(0).max(1),
  corroboration: CorroborationSchema,
  /** True when a conflict involves this claim — the disagreement stands. */
  contested: z.boolean().default(false),
  /** True only for corroborated, uncontested claims. The script may assert it. */
  mayStateAsFact: z.boolean().default(false),
  provenance: z.object({
    /** AI calls that produced the claim's material (primary one first). */
    extractedBy: z.array(GeneratedBySchema).default([]),
    reconciledBy: GeneratedBySchema.optional(),
  }),
});
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;

// ── Conflicting information (preserved, never resolved) ──────────────────

export const ConflictKindSchema = z.enum([
  "direct_contradiction",
  "numeric_disagreement",
  "attribution",
  "scope",
]);
export type ConflictKind = z.infer<typeof ConflictKindSchema>;

export const ConflictSideSchema = z.object({
  kind: z.enum(["claim", "source"]),
  /** Claim id (`kind: "claim"`) or source id (`kind: "source"`). */
  id: z.string().min(1),
  /** The claim's statement, or the verbatim excerpt that dissents. */
  statement: z.string().min(1),
  claimId: z.string().optional(),
  sourceIds: z.array(z.string()).default([]),
});
export type ConflictSide = z.infer<typeof ConflictSideSchema>;

export const ConflictSchema = z.object({
  id: z.string().min(1),
  kind: ConflictKindSchema,
  explanation: z.string().default(""),
  /** `model` = proposed by the conflict pass; `evidence_stance` = deterministic. */
  detectedBy: z.enum(["model", "evidence_stance"]),
  sides: z.array(ConflictSideSchema).min(2),
  /** Always true: the engine records disagreement, it never picks a winner. */
  preserved: z.literal(true),
});
export type Conflict = z.infer<typeof ConflictSchema>;

// ── Verification summary (drives the FACT_REVIEW gate, discovery §11) ────

export const VerificationSummarySchema = z.object({
  claims: z.number().int().nonnegative(),
  byStatus: z.record(VerificationStatusSchema, z.number().int().nonnegative()),
  /** Claims that may be stated as fact (`mayStateAsFact`). */
  established: z.number().int().nonnegative(),
  contested: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  /**
   * True when something in this package cannot pass a fact gate by itself:
   * unsupported/disputed/uncertain claims, a contested claim, or no claims or
   * sources at all. The `fact_check` stage owns the actual gate.
   */
  reviewRequired: z.boolean(),
  /** Claims that must not be asserted downstream until a human resolves them. */
  blockingClaimIds: z.array(z.string()).default([]),
});
export type VerificationSummary = z.infer<typeof VerificationSummarySchema>;

// ── Provenance ───────────────────────────────────────────────────────────

export const ResearchStepNameSchema = z.enum([
  "plan",
  "discover",
  "extract",
  "reconcile",
  "conflicts",
  "evaluate",
]);
export type ResearchStepName = z.infer<typeof ResearchStepNameSchema>;

export const ResearchStepSchema = z.object({
  step: ResearchStepNameSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  /** `none` for the deterministic steps (no model was consulted). */
  engine: z.enum(["llm", "research", "none"]),
  provider: z.string().optional(),
  model: z.string().optional(),
  templateVersion: z.string().optional(),
  /** Provider calls the step made (all of them — cached or not). */
  calls: z.number().int().nonnegative().default(0),
  cached: z.number().int().nonnegative().default(0),
  units: z.number().nonnegative().default(0),
  outcome: z.enum(["ok", "partial", "skipped"]),
  notes: z.array(z.string()).default([]),
});
export type ResearchStep = z.infer<typeof ResearchStepSchema>;

export const ProvenanceSchema = z.object({
  engine: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  schemaVersion: z.literal(RESEARCH_PACKAGE_VERSION),
  topic: z.string().min(1),
  projectId: z.string().optional(),
  episodeId: z.string().optional(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  /** Which adapter served each capability during this run (AD-06). */
  providers: z.object({
    llm: z.string().min(1),
    research: z.string().min(1),
  }),
  /** Per-step trace, including which steps used AI and which were code. */
  steps: z.array(ResearchStepSchema),
  aiSteps: z.array(ResearchStepNameSchema),
  deterministicSteps: z.array(ResearchStepNameSchema),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ── Rejections (never silent) ────────────────────────────────────────────

export const DropReasonSchema = z.enum([
  "invalid_url",
  "malformed_result",
  "duplicate_url",
  "duplicate_content",
  "source_limit",
  "no_content",
  "quote_not_found",
  "unknown_reference",
  "claim_without_evidence",
  "malformed_extraction",
]);
export type DropReason = z.infer<typeof DropReasonSchema>;

export const DroppedItemSchema = z.object({
  stage: z.enum(["discover", "extract", "reconcile", "conflicts"]),
  reason: DropReasonSchema,
  detail: z.string().default(""),
  /** Offending value, truncated (a URL, a quote, an id). */
  value: z.string().default(""),
});
export type DroppedItem = z.infer<typeof DroppedItemSchema>;

// ── The package ──────────────────────────────────────────────────────────

export const ResearchPackageSchema = z.object({
  version: z.literal(RESEARCH_PACKAGE_VERSION),
  topic: z.string().min(1),
  createdAt: z.string().min(1),
  questions: z.array(ResearchQuestionSchema).min(1),
  sources: z.array(ResearchSourceSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  claims: z.array(ResearchClaimSchema).default([]),
  conflicts: z.array(ConflictSchema).default([]),
  verification: VerificationSummarySchema,
  provenance: ProvenanceSchema,
  /** Everything the engine refused to accept, with the reason. */
  dropped: z.array(DroppedItemSchema).default([]),
  /** Operator-facing notes: failed queries, degraded steps, empty results. */
  warnings: z.array(z.string()).default([]),
  /** True when the run completed but something is missing (see warnings). */
  partial: z.boolean().default(false),
});
export type ResearchPackage = z.infer<typeof ResearchPackageSchema>;

/** Canonical bytes of a package — what the CAS artifact holds. */
export function researchPackageBytes(pkg: ResearchPackage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(pkg, null, 2)}\n`);
}

/** Parse + validate a package read back from CAS or a JSON column. */
export function parseResearchPackage(input: unknown): ResearchPackage {
  return ResearchPackageSchema.parse(input);
}
