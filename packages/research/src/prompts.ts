import type { LLMMessage } from "@nexus/providers";
import { z } from "zod";

import { ConflictKindSchema, StanceSchema, type ResearchQuestion } from "./types.js";
import { preview } from "./text.js";

/**
 * Prompt templates and the *model-facing* schemas.
 *
 * These schemas are intentionally flatter than the package schema: a model is
 * asked for quotes, statements and references — never for statuses, confidence,
 * ids or conflicts resolution, which the engine derives deterministically. The
 * template version is part of every cache key (OD-3) and of the provenance
 * record, so a prompt change can never silently reuse old output.
 */
export const RESEARCH_TEMPLATES = {
  questions: "research.questions@1",
  extract: "research.extract@1",
  reconcile: "research.reconcile@1",
  conflicts: "research.conflicts@1",
} as const;

export const QuestionPlanSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        rationale: z.string().default(""),
        priority: z.enum(["primary", "supporting"]).default("primary"),
        /** Search queries to issue for this question (1–3 short phrases). */
        queries: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});
export type QuestionPlan = z.infer<typeof QuestionPlanSchema>;

export const SourceExtractionSchema = z.object({
  evidence: z
    .array(
      z.object({
        /** Copied character-for-character from SOURCE. */
        quote: z.string().min(1),
        relevance: z.string().default(""),
      }),
    )
    .default([]),
  claims: z
    .array(
      z.object({
        /** One factual assertion the SOURCE makes, in one sentence. */
        statement: z.string().min(1),
        /** 0-based indexes into `evidence`; at least one is required. */
        evidence: z.array(z.number().int().nonnegative()).default([]),
        stance: StanceSchema.default("supports"),
        strength: z.number().min(0).max(1).default(0.5),
        rationale: z.string().default(""),
      }),
    )
    .default([]),
});
export type SourceExtraction = z.infer<typeof SourceExtractionSchema>;

export const ReconciliationSchema = z.object({
  /** Groups of claim ids that assert the same fact, worded differently. */
  groups: z
    .array(
      z.object({
        claims: z.array(z.string().min(1)).min(2),
      }),
    )
    .default([]),
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

export const ConflictReportSchema = z.object({
  conflicts: z
    .array(
      z.object({
        claims: z.array(z.string().min(1)).min(2),
        kind: ConflictKindSchema.default("direct_contradiction"),
        explanation: z.string().default(""),
      }),
    )
    .default([]),
  /** A quote from one source that disputes another source's claim. */
  refutations: z
    .array(
      z.object({
        claim: z.string().min(1),
        source: z.string().min(1),
        quote: z.string().min(1),
        explanation: z.string().default(""),
      }),
    )
    .default([]),
});
export type ConflictReport = z.infer<typeof ConflictReportSchema>;

export const SCHEMA_HINTS = {
  questions:
    '{"questions":[{"question":"...","rationale":"...","priority":"primary|supporting","queries":["short search query"]}]}',
  extract:
    '{"evidence":[{"quote":"exact text copied from the source","relevance":"why it matters"}],"claims":[{"statement":"one factual assertion","evidence":[0],"stance":"supports|contradicts|mentions","strength":0.8,"rationale":"..."}]}',
  reconcile: '{"groups":[{"claims":["cl_1","cl_2"]}]}',
  conflicts:
    '{"conflicts":[{"claims":["cl_1","cl_2"],"kind":"direct_contradiction|numeric_disagreement|attribution|scope","explanation":"..."}],"refutations":[{"claim":"cl_1","source":"src_1","quote":"exact text from that source","explanation":"..."}]}',
} as const;

const NO_INVENTION = [
  "Hard rules you must never break:",
  "- Use only the text provided in this message. Never use outside knowledge.",
  "- Never invent a source, a quotation, a number, a date or a name.",
  "- When you quote, copy the characters exactly. Never paraphrase inside a quotation.",
  "- If the material does not support a statement, omit the statement.",
].join("\n");

export function planMessages(input: {
  readonly topic: string;
  readonly outline: readonly string[];
  readonly maxQuestions: number;
  readonly maxQueriesPerQuestion: number;
}): readonly LLMMessage[] {
  const outline =
    input.outline.length > 0
      ? `\nProposed outline (context only):\n- ${input.outline.join("\n- ")}`
      : "";
  return [
    {
      role: "system",
      content: [
        "You plan research for a fact-checked explainer video.",
        `Produce at most ${input.maxQuestions} research questions that together answer the topic,`,
        `each with at most ${input.maxQueriesPerQuestion} short web search queries.`,
        "Questions must be answerable from documents, not opinions.",
        NO_INVENTION,
      ].join("\n"),
    },
    {
      role: "user",
      content: `TOPIC: ${input.topic}${outline}\n\nReturn the questions as JSON.`,
    },
  ];
}

export function extractMessages(input: {
  readonly topic: string;
  readonly questions: readonly ResearchQuestion[];
  readonly source: { readonly url: string; readonly title: string; readonly provider: string };
  readonly text: string;
  readonly maxEvidence: number;
}): readonly LLMMessage[] {
  const questions = input.questions.map((q) => `- ${q.id}: ${q.question}`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You extract evidence and factual claims from ONE source document.",
        `Return at most ${input.maxEvidence} evidence passages.`,
        "A claim is one factual assertion the document makes; group what it says, do not add to it.",
        "A claim with no supporting quote in this document must not be returned at all, and every claim must reference at least one evidence index (0-based).",
        'Use stance "supports" when the quote backs the claim, "contradicts" when the quote disputes it, and "mentions" when the document only touches the subject.',
        'Set "strength" to how directly the quote supports the claim (0 = barely, 1 = explicitly).',
        NO_INVENTION,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `TOPIC: ${input.topic}`,
        `RESEARCH QUESTIONS:\n${questions}`,
        `SOURCE: ${input.source.title === "" ? "(untitled)" : input.source.title} — ${input.source.url}`,
        `SOURCE TEXT (the only text you may quote):\n"""\n${input.text}\n"""`,
        "Return the JSON object.",
      ].join("\n\n"),
    },
  ];
}

export function reconcileMessages(
  claims: readonly { readonly id: string; readonly statement: string }[],
): readonly LLMMessage[] {
  const list = claims.map((claim) => `${claim.id}: ${preview(claim.statement, 220)}`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You group claims that assert the SAME fact in different words.",
        "Two claims that disagree (20% vs 30%, rising vs falling) are NOT the same fact — never group them.",
        "Claims that are merely about the same subject are NOT the same fact.",
        "Group only exact restatements. Return groups of two or more claim ids, each id at most once. It is fine to return no groups.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `CLAIMS:\n${list}\n\nReturn the groups as JSON.`,
    },
  ];
}

export function conflictMessages(input: {
  readonly claims: readonly { readonly id: string; readonly statement: string }[];
  readonly sources: readonly {
    readonly id: string;
    readonly url: string;
    readonly domain: string;
  }[];
}): readonly LLMMessage[] {
  const claims = input.claims
    .map((claim) => `${claim.id}: ${preview(claim.statement, 220)}`)
    .join("\n");
  const sources = input.sources
    .map((source) => `${source.id}: ${source.domain} ${source.url}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "You look for disagreement between factual claims.",
        'Report a conflict when two claims cannot both be true; classify it as "direct_contradiction", "numeric_disagreement" (different figures), "attribution" (different who) or "scope" (different where/when/who it applies to).',
        "Do NOT decide who is right — both sides are kept and shown.",
        "Also report a refutation only when you can quote the exact characters from one of the listed sources that disputes a claim.",
        NO_INVENTION,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `CLAIMS:\n${claims}`,
        `SOURCES:\n${sources}`,
        "Return the conflicts (and any quoted refutations) as JSON.",
      ].join("\n\n"),
    },
  ];
}
