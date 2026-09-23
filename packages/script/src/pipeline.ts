import type { ScriptDoc, ScriptStep, ScriptVisualCue } from "@nexus/db";
import { ScriptDocSchema } from "@nexus/db";
import {
  ProviderContentError,
  systemClock,
  type CallContext,
  type Clock,
  type LLMProvider,
  type ProviderResult,
} from "@nexus/providers";
import type { ResearchPackage } from "@nexus/research";

import {
  buildClaimBrief,
  buildClaimLedger,
  verifyScriptClaims,
  type ClaimBrief,
} from "./claims.js";
import {
  SCRIPT_SCHEMA_HINT,
  SCRIPT_TEMPLATES,
  ScriptDraftSchema,
  reviseMessages,
  writeMessages,
  type ScriptDraft,
} from "./prompts.js";
import { lintScript, toQualityIssues, type StyleFinding } from "./style.js";
import { sectionId, sentenceId, wordCount } from "./text.js";

/**
 * The script engine (Phase 6): a verified research package becomes a structured
 * narration script — working title, hook, introduction, narrative sections,
 * transitions, conclusion, narration, visual cues — where every factual sentence
 * still points at the claim and the verbatim evidence behind it.
 *
 * The writer is an AI; everything that decides *what may be said* is code. Three
 * mechanisms enforce the phase rules:
 *
 * 1. **The claim brief** (`claims.ts`) only exposes claims research cleared for
 *    assertion (`FACT`), claims that may be reported with attribution
 *    (`REPORT`), and nothing else. Claims with no verified evidence never reach
 *    the prompt.
 * 2. **Deterministic validation** checks the draft against that brief and against
 *    the writing brief (structure, filler, repetition, fake suspense, invented
 *    quotes, fabricated sources, sentence length, markup).
 * 3. **One corrective round**, then a gate: whatever still breaks a hard rule has
 *    its sentence dropped (visible, never silent) and the script is marked for
 *    review. A dropped line is recoverable; an unsupported fact is not.
 */

// ── Errors ────────────────────────────────────────────────────────────────

/** No claim in the package survived research verification, so nothing is writable. */
export class NoUsableClaimsError extends Error {
  readonly blocked: readonly {
    readonly claimId: string;
    readonly statement: string;
    readonly reason: string;
  }[];

  constructor(
    readonly topic: string,
    blocked: readonly {
      readonly claimId: string;
      readonly statement: string;
      readonly reason: string;
    }[],
  ) {
    super(
      `research produced no claim that can be written about "${topic}" ` +
        `(${blocked.length} claim(s) have no verified evidence)`,
    );
    this.name = "NoUsableClaimsError";
    this.blocked = blocked;
  }
}

// ── Inputs and tuning ─────────────────────────────────────────────────────

export interface ScriptInput {
  readonly topic: string;
  readonly outline?: readonly string[];
  /** Free-text steer from the operator (tone, angle, audience). */
  readonly direction?: string;
  /** The verified research package this script must be written from. */
  readonly research: ResearchPackage;
  /** CAS hash of that package (recorded in the artifact's provenance). */
  readonly packageHash: string;
  readonly episodeId?: string;
  readonly projectId?: string;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  /** Adapter id recorded in the artifact's provenance (set by the caller). */
  readonly llmProvider?: string;
}

export interface ScriptTuning {
  /** Target episode length; the word budget is derived from it. */
  readonly targetDurationSec: number;
  /** Narration pace used for every length estimate (2.5 words/s ≈ 150 wpm). */
  readonly wordsPerSecond: number;
  /** How many narrative sections the writer must produce. */
  readonly narrativeSections: number;
  /** Corrective rounds after a draft fails validation (default 1). */
  readonly maxRepairRounds: number;
  /** Evidence excerpts handed to the writer (bound the prompt). */
  readonly maxEvidenceInPrompt: number;
}

export const DEFAULT_SCRIPT_TUNING: ScriptTuning = {
  targetDurationSec: 300,
  wordsPerSecond: 2.5,
  narrativeSections: 3,
  maxRepairRounds: 1,
  maxEvidenceInPrompt: 24,
};

export interface ScriptDeps {
  readonly llm: LLMProvider;
  readonly clock?: Clock;
  readonly options?: Partial<ScriptTuning>;
}

const SCRIPT_ENGINE = { name: "nexus-script", version: "1.0.0" } as const;

// ── Internals ─────────────────────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface StepTally {
  calls: number;
  cached: number;
  units: number;
  outcome: "ok" | "partial" | "skipped";
  notes: string[];
  provider?: string;
  model?: string;
  templateVersion?: string;
}

/** A draft plus everything the validator found in it. */
interface Candidate {
  readonly draft: ScriptDraft;
  readonly doc: ScriptDoc;
  readonly hard: readonly StyleFinding[];
  readonly soft: readonly StyleFinding[];
}

type Issue = StyleFinding;

/** Validation turns claim violations into the same vocabulary as style findings. */
function claimFindings(doc: ScriptDoc, brief: ClaimBrief): StyleFinding[] {
  return verifyScriptClaims(doc, brief).map((violation) => ({
    code: violation.code,
    severity: "hard" as const,
    sectionId: violation.sectionId,
    sentenceId: violation.sentenceId,
    message: violation.message,
    detail: violation.detail,
  }));
}

function split(findings: readonly Issue[]): { hard: Issue[]; soft: Issue[] } {
  return {
    hard: findings.filter((finding) => finding.severity === "hard"),
    soft: findings.filter((finding) => finding.severity === "soft"),
  };
}

// ── The engine ────────────────────────────────────────────────────────────

export async function generateScript(
  input: ScriptInput,
  deps: ScriptDeps,
  options: Partial<ScriptTuning> = {},
): Promise<ScriptDoc> {
  const tuning: ScriptTuning = { ...DEFAULT_SCRIPT_TUNING, ...deps.options, ...options };
  const clock = deps.clock ?? systemClock;
  const ctx: CallContext = {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
  const engineInput: ScriptInput = { ...input, llmProvider: input.llmProvider ?? deps.llm.id };
  const startedMs = clock.now().getTime();
  const steps: ScriptStep[] = [];
  const warnings: string[] = [];
  const targetWords = Math.round(tuning.targetDurationSec * tuning.wordsPerSecond);

  /**
   * Run one step and record it. The entry is pushed *before* the step runs and
   * completed after, so a step that assembles the artifact (like `finalize`)
   * sees itself in the provenance it is writing.
   */
  const step = async <T>(
    name: ScriptStep["step"],
    engine: "llm" | "none",
    fn: (tally: StepTally) => Promise<T>,
  ): Promise<T> => {
    const stepStart = clock.nowIso();
    const stepStartMs = clock.now().getTime();
    const tally: StepTally = { calls: 0, cached: 0, units: 0, outcome: "ok", notes: [] };
    const entry: Mutable<ScriptStep> = {
      step: name,
      engine,
      startedAt: stepStart,
      finishedAt: stepStart,
      durationMs: 0,
      calls: 0,
      cached: 0,
      units: 0,
      outcome: "ok",
      notes: [],
    };
    steps.push(entry);
    const finish = (outcome: StepTally["outcome"]): void => {
      entry.finishedAt = clock.nowIso();
      entry.durationMs = clock.now().getTime() - stepStartMs;
      if (tally.provider !== undefined) entry.provider = tally.provider;
      if (tally.model !== undefined) entry.model = tally.model;
      if (tally.templateVersion !== undefined) entry.templateVersion = tally.templateVersion;
      entry.calls = tally.calls;
      entry.cached = tally.cached;
      entry.units = tally.units;
      entry.outcome = outcome;
      entry.notes = [...tally.notes];
    };
    try {
      const value = await fn(tally);
      finish(tally.outcome);
      return value;
    } catch (error) {
      tally.outcome = "partial";
      tally.notes.push(`failed: ${messageOf(error)}`);
      finish("partial");
      throw error;
    }
  };

  const tallyResult = <T>(tally: StepTally, result: ProviderResult<T>): void => {
    tally.calls += 1;
    if (result.cached) tally.cached += 1;
    tally.units += result.usage.units;
    tally.provider = result.provider;
  };

  // ── 1. select (code): what research cleared for writing ──────────────────
  const brief = await step("select", "none", async (tally) => {
    const built = buildClaimBrief(input.research);
    tally.notes.push(
      `${built.facts.length} fact(s), ${built.attributed.length} attributable claim(s), ${built.blocked.length} blocked`,
    );
    if (built.facts.length === 0 && built.attributed.length === 0) {
      throw new NoUsableClaimsError(engineInput.topic, built.blocked);
    }
    if (built.facts.length === 0) {
      warnings.push(
        "no claim was cleared to be stated as fact; every factual sentence is attributed to its source",
      );
    }
    for (const blocked of built.blocked) {
      warnings.push(`claim ${blocked.claimId} excluded from writing: ${blocked.reason}`);
    }
    return built;
  });

  const evidenceForPrompt = [...engineInput.research.evidence]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, tuning.maxEvidenceInPrompt)
    .map((item) => ({ sourceId: item.sourceId, excerpt: item.excerpt }));

  const context = {
    knownDomains: [...new Set(engineInput.research.sources.map((source) => source.domain))].filter(
      (domain) => domain !== "",
    ),
    evidenceExcerpts: engineInput.research.evidence.map((item) => item.excerpt),
  };

  const compose = (draft: ScriptDraft): Candidate => {
    const doc = assembleScriptDoc({
      draft,
      topic: engineInput.topic,
      brief,
      tuning,
      researchPackageHash: engineInput.packageHash,
      llmProvider: engineInput.llmProvider!,
      generatedAt: clock.nowIso(),
      durationMs: clock.now().getTime() - startedMs,
      warnings,
      provenanceSteps: steps,
    });
    const findings = [...lintScript(doc, context), ...claimFindings(doc, brief)];
    const { hard, soft } = split(findings);
    return { draft, doc, hard, soft };
  };

  // ── 2. write (AI) ────────────────────────────────────────────────────────
  const draft = await step("write", "llm", async (tally) => {
    const messages = writeMessages({
      topic: engineInput.topic,
      outline: engineInput.outline ?? [],
      direction: engineInput.direction ?? "",
      brief,
      targetWords,
      narrativeSections: tuning.narrativeSections,
      evidence: evidenceForPrompt,
    });
    const result = await deps.llm.chat<ScriptDraft>(
      {
        task: "script.write",
        templateVersion: SCRIPT_TEMPLATES.write,
        schema: ScriptDraftSchema,
        schemaHint: SCRIPT_SCHEMA_HINT,
        messages,
        maxRepairAttempts: 1,
      },
      ctx,
    );
    tallyResult(tally, result);
    tally.templateVersion = result.value.templateVersion;
    tally.model = result.value.model;
    tally.notes.push(`draft: ${result.value.data.sections.length} section(s)`);
    return result.value.data;
  });

  // ── 3. validate (code) ───────────────────────────────────────────────────
  let candidate = await step("validate", "none", async (tally) => {
    const composed = compose(draft);
    tally.notes.push(
      `${composed.hard.length} hard issue(s), ${composed.soft.length} style issue(s) in the first draft`,
    );
    return composed;
  });

  // What the first draft got wrong, kept so the artifact can show what the
  // corrective round actually fixed.
  const originalFindings: readonly Issue[] = [...candidate.hard, ...candidate.soft];

  // ── 4. revise (AI, bounded) — only when a hard rule was broken ───────────
  let repairRounds = 0;
  if (candidate.hard.length > 0 && tuning.maxRepairRounds > 0) {
    candidate = await step("revise", "llm", async (tally) => {
      let best = candidate;
      for (let round = 0; round < tuning.maxRepairRounds; round += 1) {
        const result = await deps.llm.chat<ScriptDraft>(
          {
            task: "script.revise",
            templateVersion: SCRIPT_TEMPLATES.revise,
            schema: ScriptDraftSchema,
            schemaHint: SCRIPT_SCHEMA_HINT,
            messages: reviseMessages({
              topic: engineInput.topic,
              brief,
              targetWords,
              draft: best.draft,
              issues: [...best.hard, ...best.soft.slice(0, 12)].map((issue) => ({
                severity: issue.severity,
                sentenceId: issue.sentenceId,
                message: issue.message,
                detail: issue.detail,
              })),
            }),
            maxRepairAttempts: 1,
          },
          ctx,
        );
        tallyResult(tally, result);
        tally.templateVersion = result.value.templateVersion;
        tally.model = result.value.model;
        repairRounds += 1;
        const revised = compose(result.value.data);
        tally.notes.push(
          `round ${repairRounds}: ${revised.hard.length} hard issue(s) (was ${best.hard.length})`,
        );
        if (isBetter(revised, best)) best = revised;
        if (best.hard.length === 0) break;
      }
      return best;
    });
  }

  // ── 5. finalize (code): gate, ledger, stats, provenance ─────────────────
  const doc = await step("finalize", "none", async (tally) => {
    const final = applyGate(candidate, brief, engineInput, clock, {
      startedMs,
      repairRounds,
      steps,
      warnings,
      context,
      originalFindings,
    });
    tally.notes.push(
      final.quality.droppedSentences.length > 0
        ? `dropped ${final.quality.droppedSentences.length} sentence(s) that broke a hard rule`
        : "no sentence had to be dropped",
    );
    return final;
  });

  // Validate the artifact exactly as it will be read back.
  const parsed = ScriptDocSchema.parse(doc);
  if (parsed.stats.words === 0) {
    throw new ProviderContentError("script draft produced no narration", {
      provider: deps.llm.id,
      operation: "script.write",
    });
  }
  return parsed;
}

/** Prefer fewer hard issues, then fewer style issues, then closeness to target. */
function isBetter(candidate: Candidate, current: Candidate): boolean {
  if (candidate.hard.length !== current.hard.length)
    return candidate.hard.length < current.hard.length;
  if (candidate.soft.length !== current.soft.length)
    return candidate.soft.length < current.soft.length;
  return candidate.doc.stats.words > current.doc.stats.words;
}

interface FinalizeContext {
  readonly startedMs: number;
  readonly repairRounds: number;
  readonly steps: ScriptStep[];
  readonly warnings: string[];
  readonly context: {
    readonly knownDomains: readonly string[];
    readonly evidenceExcerpts: readonly string[];
  };
  /** Findings from the first draft, so resolved issues can be reported as such. */
  readonly originalFindings: readonly Issue[];
}

/**
 * The gate: sentences that still break a hard rule after the corrective round
 * are removed (all quotes and sources of a bad sentence go with it), the claim
 * ledger is rebuilt from what remains, and everything is reported.
 */
function applyGate(
  candidate: Candidate,
  brief: ClaimBrief,
  input: ScriptInput,
  clock: Clock,
  finalize: FinalizeContext,
): ScriptDoc {
  const offending = new Set(
    candidate.hard.filter((issue) => issue.sentenceId !== "").map((issue) => issue.sentenceId),
  );
  const dropped: string[] = [];
  const sections = candidate.doc.sections
    .map((section) => {
      const sentences = section.sentences.filter((sentence) => {
        if (!offending.has(sentence.id)) return true;
        dropped.push(sentence.narration);
        return false;
      });
      return { ...section, sentences };
    })
    .filter((section) => section.sentences.length > 0);

  const renumbered = reindex(sections);
  const body: ScriptDoc = {
    ...candidate.doc,
    sections: renumbered,
    claims: buildClaimLedger({ ...candidate.doc, sections: renumbered }, brief),
    warnings: [...finalize.warnings],
  };

  const remaining = [...lintScript(body, finalize.context), ...claimFindings(body, brief)];
  const { hard, soft } = split(remaining);
  const issues = toQualityIssues([...hard, ...soft]);
  const resolved = toQualityIssues(
    finalize.originalFindings.filter((issue) => !remaining.some((left) => sameIssue(left, issue))),
    true,
  );

  const stats = computeStats(body);
  const structureBroken = hard.some((issue) => issue.code === "missing_section");
  const reviewRequired = hard.length > 0 || dropped.length > 0;
  if (dropped.length > 0) {
    body.warnings.push(
      `${dropped.length} sentence(s) were removed because they broke a hard fact or quotation rule`,
    );
  }
  if (structureBroken) {
    body.warnings.push(
      "the script no longer has the required section structure and needs an editor",
    );
  }

  return ScriptDocSchema.parse({
    ...body,
    stats,
    quality: {
      issues: [...issues, ...resolved],
      repairRounds: finalize.repairRounds,
      reviewRequired,
      droppedSentences: dropped,
    },
    provenance: {
      engine: SCRIPT_ENGINE,
      researchPackageHash: input.packageHash,
      providers: { llm: input.llmProvider ?? "unknown" },
      steps: finalize.steps,
      aiSteps: finalize.steps
        .filter((step) => step.engine === "llm" && step.calls > 0)
        .map((step) => step.step),
      deterministicSteps: finalize.steps
        .filter((step) => step.engine !== "llm")
        .map((step) => step.step),
      repairRounds: finalize.repairRounds,
      generatedAt: clock.nowIso(),
      durationMs: clock.now().getTime() - finalize.startedMs,
    },
  });
}

function sameIssue(a: StyleFinding, b: StyleFinding): boolean {
  return a.code === b.code && a.sentenceId === b.sentenceId && a.message === b.message;
}

/** Reassign positional ids after a drop so `sec2`/`s2_1` stay canonical. */
function reindex(sections: ScriptDoc["sections"]): ScriptDoc["sections"] {
  return sections.map((section, sectionIndex) => ({
    ...section,
    id: sectionId(sectionIndex),
    sentences: section.sentences.map((sentence, index) => ({
      ...sentence,
      id: sentenceId(sectionIndex, index),
    })),
  }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function computeStats(doc: Pick<ScriptDoc, "sections">): ScriptDoc["stats"] {
  const all = doc.sections.flatMap((section) => section.sentences);
  const total = all.reduce((sum, sentence) => sum + wordCount(sentence.narration), 0);
  return {
    sections: doc.sections.length,
    sentences: all.length,
    words: total,
    estimatedDurationSec: Math.round((total / DEFAULT_SCRIPT_TUNING.wordsPerSecond) * 10) / 10,
  };
}

/** Deterministic assembly of a model draft into the artifact shape. */
export function assembleScriptDoc(input: {
  readonly draft: ScriptDraft;
  readonly topic: string;
  readonly brief: ClaimBrief;
  readonly tuning: ScriptTuning;
  readonly researchPackageHash: string;
  readonly llmProvider: string;
  readonly generatedAt: string;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  readonly provenanceSteps: readonly ScriptStep[];
}): ScriptDoc {
  const sections = input.draft.sections.map((section, sectionIndex) => {
    const sentences = section.sentences.map((sentence, index) => {
      const visual = visualOf(sentence.visual);
      return {
        id: sentenceId(sectionIndex, index),
        narration: sentence.narration.trim(),
        assertion: sentence.assertion,
        claimRefs: [...new Set(sentence.claimRefs)],
        sourceRefs: [...new Set(sentence.sourceRefs)],
        ...(visual !== undefined ? { visual } : {}),
      };
    });
    return {
      id: sectionId(sectionIndex),
      role: section.role,
      title: section.title.trim(),
      transition: section.transition.trim(),
      sentences,
    };
  });

  const base: ScriptDoc = {
    version: 2,
    topic: input.topic,
    workingTitle: input.draft.workingTitle.trim(),
    logline: input.draft.logline.trim(),
    sections,
    claims: [],
    quality: { issues: [], repairRounds: 0, reviewRequired: false, droppedSentences: [] },
    stats: computeStats({ sections }),
    provenance: {
      engine: SCRIPT_ENGINE,
      researchPackageHash: input.researchPackageHash,
      providers: { llm: input.llmProvider ?? "unknown" },
      steps: [...input.provenanceSteps],
      aiSteps: [],
      deterministicSteps: [],
      repairRounds: 0,
      generatedAt: input.generatedAt,
      durationMs: input.durationMs,
    },
    warnings: [...input.warnings],
  };
  return { ...base, claims: buildClaimLedger(base, input.brief) };
}

function visualOf(
  visual: ScriptDraft["sections"][number]["sentences"][number]["visual"],
): ScriptVisualCue | undefined {
  if (visual === undefined) return undefined;
  const description = visual.description.trim();
  if (description === "") return undefined;
  return {
    kind: visual.kind ?? "broll",
    description,
    searchHint: (visual.searchHint ?? "").trim(),
  };
}
