import { z } from "zod";

import { ArtifactKindSchema, ClaimStatusSchema, Sha256Schema } from "./types.js";

/**
 * Schemas for the JSON documents stored in CAS artifacts and JSON columns.
 * These are the typed contracts pipeline stages exchange (discovery §5):
 * validated on write, validated again on read.
 */

// ── Project configuration (projects.config) ──────────────────────────────

export const AspectSpecSchema = z.object({
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  fps: z.number().int().min(1).max(60),
});
export type AspectSpec = z.infer<typeof AspectSpecSchema>;

export const ProjectConfigSchema = z.object({
  styleGuide: z.string().default(""),
  voiceProfile: z
    .object({
      id: z.string().default("narrator"),
      description: z.string().default(""),
    })
    .default({}),
  /** Licenses the media policy engine accepts for this project (AD-09). */
  allowedLicenses: z.array(z.string().min(1)).default(["original", "CC0", "CC-BY", "CC-BY-SA"]),
  aspects: z
    .object({
      horizontal: AspectSpecSchema.default({ width: 640, height: 360, fps: 12 }),
      vertical: AspectSpecSchema.default({ width: 540, height: 960, fps: 12 }),
    })
    .default({}),
  publishingDefaults: z
    .object({
      privacy: z.enum(["private", "unlisted", "public"]).default("private"),
      aiDisclosure: z.boolean().default(true),
    })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ── Episode outline (episodes.outline) ───────────────────────────────────

export const OutlineSchema = z.array(z.string().min(1));
export type Outline = z.infer<typeof OutlineSchema>;

// ── Script documents (CAS artifact, kind='script') ───────────────────────
//
// The narration contract (Phase 6). A script is a list of role-tagged sections
// of *sentences* — never loose prose — because every later stage works at
// sentence granularity: scenes reference `section_id`/`sentence_id`, captions
// time individual sentences, and each sentence carries the research claim ids
// it states so the claim/evidence chain survives all the way to the video.
//
// `version: 2` replaced the Phase-2 draft shape (which had no hook, transitions,
// visuals or claim assertions) before any script had ever been generated; the
// `scripts` table itself is unchanged, so this is a contract change, not a
// migration.

export const ScriptSectionRoleSchema = z.enum(["hook", "introduction", "narrative", "conclusion"]);
export type ScriptSectionRole = z.infer<typeof ScriptSectionRoleSchema>;

/** Visual direction attached to a sentence. Data only — nothing renders it yet. */
export const ScriptVisualKindSchema = z.enum(["broll", "image", "text", "chart", "quote", "none"]);
export type ScriptVisualKind = z.infer<typeof ScriptVisualKindSchema>;

export const ScriptVisualCueSchema = z.object({
  kind: ScriptVisualKindSchema,
  /** What should be on screen (a direction for the scene/media stages). */
  description: z.string().min(1),
  /** Optional hint for the media search stage (AD-09 licence rules apply there). */
  searchHint: z.string().default(""),
});
export type ScriptVisualCue = z.infer<typeof ScriptVisualCueSchema>;

/**
 * How a sentence relates to fact:
 * - `fact` — states a claim the research phase cleared to be stated as fact;
 * - `attributed` — reports what a named source says (the only way a disputed,
 *   single-source or contested claim may appear);
 * - `context` — no factual assertion (explanation, scene-setting, transition).
 */
export const ScriptAssertionSchema = z.enum(["fact", "attributed", "context"]);
export type ScriptAssertion = z.infer<typeof ScriptAssertionSchema>;

export const ScriptSentenceSchema = z.object({
  /** Stable id used by claims, captions, and scenes (discovery §6.1). */
  id: z.string().min(1),
  /** Spoken words only: no markup, no stage directions, no speaker labels. */
  narration: z.string().min(1),
  assertion: ScriptAssertionSchema.default("context"),
  /** Research claim ids this sentence states or attributes. */
  claimRefs: z.array(z.string().min(1)).default([]),
  /** Research source ids backing an `attributed` sentence. */
  sourceRefs: z.array(z.string().min(1)).default([]),
  visual: ScriptVisualCueSchema.optional(),
});
export type ScriptSentence = z.infer<typeof ScriptSentenceSchema>;

export const ScriptSectionSchema = z.object({
  id: z.string().min(1),
  role: ScriptSectionRoleSchema,
  title: z.string().min(1),
  /** Spoken bridge from the previous section (empty on the first section). */
  transition: z.string().default(""),
  sentences: z.array(ScriptSentenceSchema).min(1),
});
export type ScriptSection = z.infer<typeof ScriptSectionSchema>;

/** Verbatim evidence behind a claim as the script artifact records it. */
export const ScriptEvidenceRefSchema = z.object({
  /** Research-package source id (`src_…`); storage maps it to the `sources` row. */
  sourceId: z.string().min(1),
  url: z.string().default(""),
  excerpt: z.string().min(1),
  /** `"<start>:<end>"` offsets into that source's `content`; empty when unknown. */
  locator: z.string().default(""),
});
export type ScriptEvidenceRef = z.infer<typeof ScriptEvidenceRefSchema>;

/**
 * One factual claim the script leans on, with the evidence it came from and the
 * sentences that use it. This is the artifact half of the claim/evidence chain;
 * `claims` + `claim_evidence` rows are the SQL half (OD-15).
 */
export const ScriptClaimEntrySchema = z.object({
  claimId: z.string().min(1),
  statement: z.string().min(1),
  status: ClaimStatusSchema,
  /** Research certainty vocabulary (`established`/`likely`/`disputed`/…). */
  certainty: z.string().min(1),
  confidence: z.number().min(0).max(1),
  mayStateAsFact: z.boolean(),
  usage: z.enum(["fact", "attributed"]),
  sentenceIds: z.array(z.string().min(1)).min(1),
  evidence: z.array(ScriptEvidenceRefSchema).default([]),
});
export type ScriptClaimEntry = z.infer<typeof ScriptClaimEntrySchema>;

/** Deterministic writing-quality findings (filler, repetition, invented quotes…). */
export const ScriptIssueCodeSchema = z.enum([
  "filler",
  "repetition",
  "fake_suspense",
  "unverified_quote",
  "fabricated_source",
  "long_sentence",
  "markup",
  "unsupported_assertion",
  "unknown_claim",
  "missing_attribution",
  "unknown_source",
  "unlinked_source",
  "missing_section",
]);
export type ScriptIssueCode = z.infer<typeof ScriptIssueCodeSchema>;

export const ScriptQualityIssueSchema = z.object({
  code: ScriptIssueCodeSchema,
  severity: z.enum(["hard", "soft"]),
  message: z.string().min(1),
  sectionId: z.string().default(""),
  sentenceId: z.string().default(""),
  detail: z.string().default(""),
  /** True when the corrective round fixed it (kept so the loop is auditable). */
  resolvedByRepair: z.boolean().default(false),
});
export type ScriptQualityIssue = z.infer<typeof ScriptQualityIssueSchema>;

export const ScriptQualitySchema = z.object({
  issues: z.array(ScriptQualityIssueSchema).default([]),
  repairRounds: z.number().int().nonnegative().default(0),
  /** True when a hard issue survived, or the gate had to drop narration. */
  reviewRequired: z.boolean().default(false),
  /** Narration removed by the deterministic gate (kept visible, never silent). */
  droppedSentences: z.array(z.string()).default([]),
});
export type ScriptQuality = z.infer<typeof ScriptQualitySchema>;

export const ScriptStatsSchema = z.object({
  sections: z.number().int().nonnegative(),
  sentences: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  /** Words ÷ 2.5 words-per-second — an estimate for planning, not a render. */
  estimatedDurationSec: z.number().nonnegative(),
});
export type ScriptStats = z.infer<typeof ScriptStatsSchema>;

export const ScriptStepSchema = z.object({
  step: z.enum(["select", "write", "validate", "revise", "finalize"]),
  engine: z.enum(["llm", "none"]),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  provider: z.string().optional(),
  model: z.string().optional(),
  templateVersion: z.string().optional(),
  calls: z.number().int().nonnegative().default(0),
  cached: z.number().int().nonnegative().default(0),
  units: z.number().nonnegative().default(0),
  outcome: z.enum(["ok", "partial", "skipped"]),
  notes: z.array(z.string()).default([]),
});
export type ScriptStep = z.infer<typeof ScriptStepSchema>;

export const ScriptProvenanceSchema = z.object({
  engine: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  /** The research package this script was written from (traceability). */
  researchPackageHash: Sha256Schema,
  providers: z.object({ llm: z.string().min(1) }),
  steps: z.array(ScriptStepSchema),
  aiSteps: z.array(z.string()).default([]),
  deterministicSteps: z.array(z.string()).default([]),
  /** Corrective rounds actually executed (0 = the first draft passed). */
  repairRounds: z.number().int().nonnegative().default(0),
  generatedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
});
export type ScriptProvenance = z.infer<typeof ScriptProvenanceSchema>;

export const ScriptDocSchema = z.object({
  version: z.literal(2),
  topic: z.string().min(1),
  workingTitle: z.string().min(1),
  logline: z.string().default(""),
  /**
   * Ordered sections. Role order is hook → introduction → narrative… →
   * conclusion. The shape requirement is deliberately loose here (a document
   * must stay storable and reviewable even when it is wrong); `@nexus/script`
   * owns the structure rule and reports a missing role as a hard
   * `missing_section` issue, which flips `reviewRequired` on.
   */
  sections: z.array(ScriptSectionSchema).min(1),
  /** Every claim the narration rests on, with its evidence and its sentences. */
  claims: z.array(ScriptClaimEntrySchema).default([]),
  quality: ScriptQualitySchema.default({}),
  stats: ScriptStatsSchema,
  provenance: ScriptProvenanceSchema,
  warnings: z.array(z.string()).default([]),
});
export type ScriptDoc = z.infer<typeof ScriptDocSchema>;

/** Canonical bytes of a script document — what the CAS artifact holds. */
export function scriptDocBytes(doc: ScriptDoc): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
}

/** Parse + validate a script document read back from CAS. */
export function parseScriptDoc(input: unknown): ScriptDoc {
  return ScriptDocSchema.parse(input);
}

/** Flatten a script's narration in spoken order (TTS/caption input). */
export function scriptNarration(doc: ScriptDoc): string[] {
  return doc.sections.flatMap((section) => section.sentences.map((sentence) => sentence.narration));
}

// ── Scene payloads (scenes.data) ─────────────────────────────────────────

export const SceneCharacterSchema = z.object({
  name: z.string().min(1),
  expression: z.enum(["idle", "talk", "point", "react"]),
});

export const SceneDataSchema = z.object({
  title: z.string().default(""),
  body: z.string().default(""),
  character: SceneCharacterSchema.optional(),
  claimId: z.string().optional(),
  mediaHash: z.string().optional(),
  paletteIndex: z.number().int().min(0).default(0),
});
export type SceneData = z.infer<typeof SceneDataSchema>;

// ── Artifact references (pipeline_job_steps.artifacts) ───────────────────

/**
 * A pointer to an artifact, never the bytes. `role` describes what the
 * artifact *is* to the producing stage (e.g. "master", "captions", "audio"),
 * which keeps multi-output stages (render → video + thumbnail + captions)
 * machine-readable for later stages and for the upload kit.
 */
export const ArtifactRefSchema = z.object({
  hash: Sha256Schema,
  kind: ArtifactKindSchema,
  role: z.string().default(""),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactRefListSchema = z.array(ArtifactRefSchema).default([]);

// ── Artifact metadata (artifacts.meta) ───────────────────────────────────

export const GeneratedBySchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  templateVersion: z.string().optional(),
});

export const ArtifactMetaSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  codec: z.string().optional(),
  /** Provenance for generated content (AD-07: every AI artifact is tagged). */
  generatedBy: GeneratedBySchema.optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;
