import type { LLMMessage } from "@nexus/providers";
import { z } from "zod";

import { ScriptAssertionSchema, ScriptSectionRoleSchema, ScriptVisualKindSchema } from "@nexus/db";

import type { ClaimBrief } from "./claims.js";
import { preview } from "./text.js";

/**
 * Prompt templates and the *model-facing* script schema.
 *
 * The model writes prose and chooses what each sentence is doing (asserting,
 * reporting, or plain context). It never assigns ids, never decides whether a
 * claim is clearable, never touches the claim ledger and never writes the
 * quality report — all of that is derived from the draft by code, so a model
 * cannot promote an unverified claim by asking nicely.
 */
export const SCRIPT_TEMPLATES = {
  write: "script.write@1",
  revise: "script.revise@1",
} as const;

export const ScriptDraftSentenceSchema = z.object({
  /** The words a narrator says. Plain text only — no markup, no labels. */
  narration: z.string().min(1),
  assertion: ScriptAssertionSchema.default("context"),
  /** Research claim ids this sentence states or attributes. */
  claimRefs: z.array(z.string().min(1)).default([]),
  /** Research source ids for `attributed` sentences (the source being reported). */
  sourceRefs: z.array(z.string().min(1)).default([]),
  // Optional fields stay optional in the *input* contract too: a model may omit
  // the kind or the search hint, and the engine fills the defaults in.
  visual: z
    .object({
      kind: ScriptVisualKindSchema.optional(),
      description: z.string().min(1),
      searchHint: z.string().optional(),
    })
    .optional(),
});

export const ScriptDraftSectionSchema = z.object({
  role: ScriptSectionRoleSchema,
  title: z.string().min(1),
  /** Spoken bridge from the previous section ("" on the hook). */
  transition: z.string().default(""),
  sentences: z.array(ScriptDraftSentenceSchema).min(1),
});

export const ScriptDraftSchema = z.object({
  workingTitle: z.string().min(1).max(120),
  logline: z.string().default(""),
  sections: z.array(ScriptDraftSectionSchema).min(4),
});
export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;

export const SCRIPT_SCHEMA_HINT =
  '{"workingTitle":"...","logline":"one sentence","sections":[' +
  '{"role":"hook","title":"...","transition":"","sentences":[{"narration":"...","assertion":"context|fact|attributed","claimRefs":["cl_…"],"sourceRefs":["src_…"],"visual":{"kind":"broll|image|text|chart|quote|none","description":"...","searchHint":"..."}}]},' +
  '{"role":"introduction",…},{"role":"narrative",…},{"role":"conclusion",…}]}';

const CRAFT = [
  "Craft rules, in priority order:",
  "1. The hook is the first thing the listener hears: open on a concrete fact, image or question from the research — never on a greeting, a definition or a promise about the video.",
  "2. Earn curiosity with the material itself. Never manufacture suspense or tease a revelation you do not deliver.",
  "3. Explain clearly: short sentences, one idea each, active voice, no jargon without an immediate plain-language gloss.",
  "4. Escalate: each narrative section should build on the previous one and raise the stakes, the scale or the implications.",
  "5. Use concrete examples, numbers and named places from the research instead of generalities.",
  "6. Pay off the hook in the conclusion — answer what you opened with, and say what it means.",
  "7. Write for the ear: contractions, spoken rhythm, varied sentence lengths. No bullet lists, no headings read aloud, no markup, no stage directions.",
].join("\n");

const FORBIDDEN = [
  "Never do these:",
  "- No filler ('in this video', 'let's dive in', 'it's important to note', 'at the end of the day').",
  "- No fake suspense ('what happened next', 'you won't believe', 'stay tuned', 'little did they know').",
  "- No repetitive AI phrasing: do not reuse the same opener, the same four-word phrase, or a string of 'moreover/furthermore/additionally'.",
  "- No facts you were not given. If it is not in the FACT list, do not assert it.",
  "- No invented quotations and no invented dialogue. Quotation marks are only for text copied verbatim from the EVIDENCE lines.",
  "- No invented sources or experts. Name a source only if it appears in the SOURCES list.",
].join("\n");

const ASSERTION_RULES = [
  "How to cite the research (this is enforced by code, so follow it exactly):",
  "- assertion 'fact': only for a claim id from the FACT list, which research cleared. Every 'fact' sentence must cite at least one FACT claim id.",
  '- assertion "attributed": for a claim id from the REPORT list. It must cite that claim id, name the source it reports (sourceRefs), and say in the words that it is reporting — e.g. "According to <source> …", "<source> estimates that …", "Reports put it at …". Never present a REPORT claim as your own statement of fact.',
  "- assertion 'context': explanation, scene-setting, transitions and the conclusion's framing, with no factual assertion at all. Keep it free of numbers or claims.",
  "- Never cite a claim id that is not in the FACT or REPORT list.",
  "- Every sentence with a factual content must carry a visual cue describing what the audience should see.",
].join("\n");

function factsBlock(brief: ClaimBrief): string {
  if (brief.facts.length === 0)
    return "(none cleared — write the script without direct factual assertions)";
  return brief.facts
    .map(
      (fact) =>
        `- ${fact.claimId}: ${fact.statement}${fact.sourceDomains.length > 0 ? ` [via ${fact.sourceDomains.join(", ")}]` : ""}`,
    )
    .join("\n");
}

function reportsBlock(brief: ClaimBrief): string {
  if (brief.attributed.length === 0) return "(none — nothing needs attribution)";
  return brief.attributed
    .map(
      (item) =>
        `- ${item.claimId}: ${item.statement} [${item.reason}; sources: ${item.sourceIds.join(", ")}${item.sourceDomains.length > 0 ? ` (${item.sourceDomains.join(", ")})` : ""}]`,
    )
    .join("\n");
}

function sourcesBlock(brief: ClaimBrief): string {
  const sources = [...brief.sources.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (sources.length === 0) return "(none)";
  return sources
    .map(
      (source) =>
        `- ${source.id}: ${source.domain}${source.title !== "" ? ` — ${preview(source.title, 80)}` : ""}`,
    )
    .join("\n");
}

export function writeMessages(input: {
  readonly topic: string;
  readonly outline: readonly string[];
  readonly direction: string;
  readonly brief: ClaimBrief;
  readonly targetWords: number;
  readonly narrativeSections: number;
  readonly evidence: readonly { readonly sourceId: string; readonly excerpt: string }[];
}): readonly LLMMessage[] {
  const outline =
    input.outline.length > 0
      ? `\nOutline beats (use as a guide, not as headings):\n- ${input.outline.join("\n- ")}`
      : "";
  const direction = input.direction !== "" ? `\nEditor's direction: ${input.direction}` : "";
  const evidence =
    input.evidence.length > 0
      ? input.evidence
          .slice(0, 24)
          .map((item) => `- [${item.sourceId}] ${preview(item.excerpt, 220)}`)
          .join("\n")
      : "(no quotations were extracted)";

  return [
    {
      role: "system",
      content: [
        "You are the writer for a fact-checked explanatory video channel.",
        `Write the complete narration script for a ${Math.round(input.targetWords / 2.5 / 60)}-minute episode in roughly ${input.targetWords} words.`,
        `Structure it as exactly one hook, one introduction, ${input.narrativeSections} narrative sections and one conclusion, in that order.`,
        CRAFT,
        FORBIDDEN,
        ASSERTION_RULES,
        'Return one JSON object matching the requested shape. Section transitions go in each section\'s "transition" field (empty for the hook).',
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `TOPIC: ${input.topic}${outline}${direction}`,
        `FACT list (may be stated as fact):\n${factsBlock(input.brief)}`,
        `REPORT list (may only be attributed):\n${reportsBlock(input.brief)}`,
        `SOURCES you may name:\n${sourcesBlock(input.brief)}`,
        `EVIDENCE you may quote verbatim (quotation marks are only for these):\n${evidence}`,
        "Write the script now.",
      ].join("\n\n"),
    },
  ];
}

export function reviseMessages(input: {
  readonly topic: string;
  readonly brief: ClaimBrief;
  readonly targetWords: number;
  readonly draft: unknown;
  readonly issues: readonly {
    readonly severity: string;
    readonly sentenceId: string;
    readonly message: string;
    readonly detail: string;
  }[];
}): readonly LLMMessage[] {
  const issues = input.issues
    .slice(0, 40)
    .map(
      (issue) =>
        `- [${issue.severity}${issue.sentenceId !== "" ? ` ${issue.sentenceId}` : ""}] ${issue.message}${issue.detail !== "" ? ` (${preview(issue.detail, 100)})` : ""}`,
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "You are revising a narration script that failed automatic quality and fact checks.",
        "Fix every listed issue and change nothing else: keep the structure, the order, the claim citations and the good lines.",
        "A 'fact' citation must come from the FACT list; a claim from the REPORT list must be attributed in the words and name its source; quotation marks are only for verbatim EVIDENCE text.",
        FORBIDDEN,
        ASSERTION_RULES,
        "Return the corrected JSON object.",
      ].join("\n\n"),
    },
    {
      role: "user",
      content: [
        `TOPIC: ${input.topic}`,
        `FACT list:\n${factsBlock(input.brief)}`,
        `REPORT list:\n${reportsBlock(input.brief)}`,
        `SOURCES you may name:\n${sourcesBlock(input.brief)}`,
        `ISSUES TO FIX:\n${issues || "(none)"}`,
        `CURRENT DRAFT (JSON):\n${JSON.stringify(input.draft)}`,
        `Target length: about ${input.targetWords} words.`,
      ].join("\n\n"),
    },
  ];
}
