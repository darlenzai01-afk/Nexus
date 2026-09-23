import {
  assertPublicHttpUrl,
  classifyProviderError,
  isManualRequired,
  sha256Hex,
  systemClock,
  type CallContext,
  type Clock,
  type LLMProvider,
  type ProviderResult,
  type ResearchProvider,
  type WebSearchResult,
} from "@nexus/providers";
import { z } from "zod";

import {
  RESEARCH_TEMPLATES,
  ConflictReportSchema,
  QuestionPlanSchema,
  ReconciliationSchema,
  SourceExtractionSchema,
  SCHEMA_HINTS,
  conflictMessages,
  extractMessages,
  planMessages,
  reconcileMessages,
  type ConflictReport,
  type QuestionPlan,
  type Reconciliation,
  type SourceExtraction,
} from "./prompts.js";
import {
  canonicalUrl,
  domainOf,
  findQuote,
  normalizeStatement,
  normalizeWhitespace,
  preview,
  shortId,
} from "./text.js";
import {
  RESEARCH_ENGINE,
  RESEARCH_PACKAGE_VERSION,
  ResearchPackageSchema,
  type Certainty,
  type ClaimLink,
  type Conflict,
  type ConflictKind,
  type DropReason,
  type DroppedItem,
  type Evidence,
  type GeneratedBy,
  type ResearchClaim,
  type ResearchPackage,
  type ResearchQuestion,
  type ResearchSource,
  type ResearchStep,
  type ResearchStepName,
  type VerificationStatus,
  type VerificationSummary,
} from "./types.js";

/**
 * The research engine (Phase 5): `topic → research package`.
 *
 * AI is used for exactly four things: planning questions, extracting evidence
 * and claims from a retrieved document, grouping restatements of one fact, and
 * proposing disagreements. Everything else is deterministic code — URL
 * validation, canonicalisation, deduplication, quotation verification (the text
 * stored as an excerpt is sliced out of the source, never taken from the model),
 * scoring, status derivation and assembly.
 */

// ── Inputs ────────────────────────────────────────────────────────────────

export const OperatorSourceSchema = z.object({
  url: z.string().min(1),
  title: z.string().default(""),
  content: z.string().default(""),
  publisher: z.string().default(""),
});
/** Normalised operator source (defaults filled in). */
export type OperatorSource = z.output<typeof OperatorSourceSchema>;
/** What a caller may pass: `url` is the only required field. */
export type OperatorSourceInput = z.input<typeof OperatorSourceSchema>;

export const OperatorSourceListSchema = z.array(OperatorSourceSchema);

export interface ResearchInput {
  readonly topic: string;
  /** Episode outline lines, when the episode has one (context for the planner). */
  readonly outline?: readonly string[];
  readonly projectId?: string;
  readonly episodeId?: string;
  /**
   * Sources supplied by a human (the AD-06 manual fallback): pasted URLs and
   * text. They are treated as retrieved content, are still URL-validated, and
   * are marked `operator_text` — never silently blended with provider rows.
   */
  readonly operatorSources?: readonly OperatorSourceInput[];
  readonly signal?: AbortSignal;
  /** Job id / episode id, carried into provider call logs. */
  readonly correlationId?: string;
}

export interface ResearchTuning {
  readonly maxQuestions: number;
  readonly maxQueriesPerQuestion: number;
  readonly maxSources: number;
  readonly resultsPerQuery: number;
  readonly maxEvidencePerSource: number;
  /** A claim is "established" only above both thresholds (never below). */
  readonly establishedMinConfidence: number;
  readonly establishedMinSources: number;
}

export const DEFAULT_RESEARCH_TUNING: ResearchTuning = {
  maxQuestions: 5,
  maxQueriesPerQuestion: 2,
  maxSources: 8,
  resultsPerQuery: 5,
  maxEvidencePerSource: 6,
  establishedMinConfidence: 0.7,
  establishedMinSources: 2,
};

export interface ResearchDeps {
  readonly llm: LLMProvider;
  readonly research: ResearchProvider;
  readonly clock?: Clock;
  readonly options?: Partial<ResearchTuning>;
}

/** Confidence cap applied to a claim that sources disagree about. */
const DISPUTED_CONFIDENCE_CAP = 0.25;
/** Confidence cap applied to a claim involved in an unresolved conflict. */
const CONTESTED_CONFIDENCE_CAP = 0.4;
/** Strength recorded for a refutation the conflict pass proved with a quote. */
const REFUTATION_STRENGTH = 0.9;
/** Claims sent to the reconciliation prompt (bounds the prompt size). */
const MAX_CLAIMS_FOR_RECONCILE = 80;

// ── Internals ─────────────────────────────────────────────────────────────

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

interface RawClaim {
  statement: string;
  links: ClaimLink[];
  questionIds: string[];
  extractedBy: GeneratedBy;
}

interface DiscoveryState {
  readonly sources: ResearchSource[];
  readonly byCanonicalUrl: Map<string, ResearchSource>;
  readonly byContentHash: Map<string, ResearchSource>;
}

/** Everything a run accumulates; keeps the step functions small. */
interface RunState {
  readonly input: ResearchInput & { topic: string };
  readonly tuning: ResearchTuning;
  readonly clock: Clock;
  readonly ctx: CallContext;
  readonly warnings: string[];
  readonly dropped: DroppedItem[];
  readonly steps: ResearchStep[];
  degraded: boolean;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export async function runResearch(
  input: ResearchInput,
  deps: ResearchDeps,
  options: Partial<ResearchTuning> = {},
): Promise<ResearchPackage> {
  const tuning: ResearchTuning = { ...DEFAULT_RESEARCH_TUNING, ...deps.options, ...options };
  const topic = normalizeWhitespace(input.topic);
  if (topic === "") {
    throw new Error("research: a topic is required");
  }
  const clock = deps.clock ?? systemClock;
  const ctx: CallContext = {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
  const state: RunState = {
    input: { ...input, topic },
    tuning,
    clock,
    ctx,
    warnings: [],
    dropped: [],
    steps: [],
    degraded: false,
  };

  const startedAt = clock.nowIso();
  const startedMs = clock.now().getTime();

  const questions = await step(state, "plan", "llm", (tally) => planQuestions(state, deps, tally));
  const discovery = await step(state, "discover", "research", (tally) =>
    discoverSources(state, deps, questions, tally),
  );
  const extracted = await step(state, "extract", "llm", (tally) =>
    extractClaims(state, deps, questions, discovery.sources, tally),
  );
  const reconciled = await step(state, "reconcile", "llm", (tally) =>
    reconcileClaims(state, deps, extracted, tally),
  );
  const conflicted = await step(state, "conflicts", "llm", (tally) =>
    detectConflicts(state, deps, discovery.sources, reconciled.claims, tally),
  );
  const evaluated = await step(state, "evaluate", "none", async (tally) => {
    tally.notes.push("statuses, confidence and the review gate are derived by code");
    return evaluateClaims(conflicted.claims, conflicted.conflicts, tuning);
  });

  const finishedAt = clock.nowIso();
  const packageValue: ResearchPackage = {
    version: RESEARCH_PACKAGE_VERSION,
    topic,
    createdAt: startedAt,
    questions,
    sources: discovery.sources,
    // Extraction evidence first: a refutation can quote the same span, and the
    // package must never carry the same evidence id twice.
    evidence: dedupeEvidence([...extracted.evidence, ...conflicted.evidence]),
    claims: evaluated.claims,
    conflicts: conflicted.conflicts,
    verification: evaluated.verification,
    provenance: {
      engine: RESEARCH_ENGINE,
      schemaVersion: RESEARCH_PACKAGE_VERSION,
      topic,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.episodeId !== undefined ? { episodeId: input.episodeId } : {}),
      startedAt,
      finishedAt,
      durationMs: clock.now().getTime() - startedMs,
      providers: { llm: deps.llm.id, research: deps.research.id },
      steps: state.steps,
      // A step that was skipped, or that had no work to hand a model, is not an
      // "AI step" — the distinction is what makes the provenance honest.
      aiSteps: state.steps
        .filter((s) => s.engine === "llm" && (s.calls > 0 || s.outcome === "partial"))
        .map((s) => s.step),
      deterministicSteps: state.steps.filter((s) => s.engine !== "llm").map((s) => s.step),
    },
    dropped: state.dropped,
    warnings: state.warnings,
    partial: state.degraded,
  };
  // Validate what we are about to publish (and normalise key order, which is
  // what makes the artifact bytes reproducible for the same clock and answers).
  return ResearchPackageSchema.parse(packageValue);
}

// ── Step plumbing ─────────────────────────────────────────────────────────

async function step<T>(
  state: RunState,
  name: ResearchStepName,
  engine: "llm" | "research" | "none",
  fn: (tally: StepTally) => Promise<T>,
): Promise<T> {
  const startedAt = state.clock.nowIso();
  const startedMs = state.clock.now().getTime();
  const tally: StepTally = { calls: 0, cached: 0, units: 0, outcome: "ok", notes: [] };
  const record = (outcome: StepTally["outcome"]): void => {
    state.steps.push({
      step: name,
      startedAt,
      finishedAt: state.clock.nowIso(),
      durationMs: state.clock.now().getTime() - startedMs,
      engine,
      ...(tally.provider !== undefined ? { provider: tally.provider } : {}),
      ...(tally.model !== undefined ? { model: tally.model } : {}),
      ...(tally.templateVersion !== undefined ? { templateVersion: tally.templateVersion } : {}),
      calls: tally.calls,
      cached: tally.cached,
      units: tally.units,
      outcome,
      notes: tally.notes,
    });
  };
  try {
    const value = await fn(tally);
    record(tally.outcome);
    return value;
  } catch (error) {
    tally.outcome = "partial";
    tally.notes.push(`failed: ${messageOf(error)}`);
    record("partial");
    throw error;
  }
}

function drop(state: RunState, item: DroppedItem): void {
  state.dropped.push(item);
}

function dropped(
  stage: DroppedItem["stage"],
  reason: DropReason,
  detail: string,
  value = "",
): DroppedItem {
  return { stage, reason, detail, value: preview(value, 160) };
}

/** Record a provider envelope on the step tally (usage + cache accounting). */
function tallyResult<T>(tally: StepTally, result: ProviderResult<T>): void {
  tally.calls += 1;
  if (result.cached) tally.cached += 1;
  tally.units += result.usage.units;
  tally.provider = result.provider;
}

// ── 1. plan (AI) ──────────────────────────────────────────────────────────

async function planQuestions(
  state: RunState,
  deps: ResearchDeps,
  tally: StepTally,
): Promise<ResearchQuestion[]> {
  const result = await deps.llm.chat<QuestionPlan>(
    {
      task: "research.questions",
      templateVersion: RESEARCH_TEMPLATES.questions,
      schema: QuestionPlanSchema,
      schemaHint: SCHEMA_HINTS.questions,
      messages: planMessages({
        topic: state.input.topic,
        outline: state.input.outline ?? [],
        maxQuestions: state.tuning.maxQuestions,
        maxQueriesPerQuestion: state.tuning.maxQueriesPerQuestion,
      }),
      maxRepairAttempts: 1,
    },
    state.ctx,
  );
  tallyResult(tally, result);
  tally.templateVersion = result.value.templateVersion;
  tally.model = result.value.model;

  const planned = result.value.data.questions
    .map((question) => ({
      question: normalizeWhitespace(question.question),
      rationale: normalizeWhitespace(question.rationale),
      priority: question.priority,
      queries: question.queries
        .map((query) => normalizeWhitespace(query).slice(0, 200))
        .filter((query) => query !== ""),
    }))
    .filter((question) => question.question !== "")
    .slice(0, state.tuning.maxQuestions);

  const questions: ResearchQuestion[] = [];
  const seen = new Set<string>();
  for (const plannedQuestion of planned) {
    const key = plannedQuestion.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // The planner's own queries are used as-is (every search call is metered);
    // the question text is only a fallback for a planner that gave none.
    const queries = unique(plannedQuestion.queries.map((query) => query.trim()))
      .filter((query) => query.length <= 200)
      .slice(0, state.tuning.maxQueriesPerQuestion);
    questions.push({
      id: `q${questions.length + 1}`,
      question: plannedQuestion.question,
      rationale: plannedQuestion.rationale,
      priority: plannedQuestion.priority,
      queries: queries.length > 0 ? queries : [plannedQuestion.question],
    });
  }

  if (questions.length === 0) {
    // Deterministic fallback: no invented subject matter, just the topic itself.
    state.warnings.push(
      "the planner returned no usable research questions; the topic was used as the only question",
    );
    state.degraded = true;
    return [
      {
        id: "q1",
        question: state.input.topic,
        rationale: "fallback: the planner produced no questions",
        priority: "primary",
        queries: [state.input.topic],
      },
    ];
  }
  return questions;
}

// ── 2. discover (provider search + deterministic validation) ──────────────

async function discoverSources(
  state: RunState,
  deps: ResearchDeps,
  questions: readonly ResearchQuestion[],
  tally: StepTally,
): Promise<{ sources: ResearchSource[] }> {
  const discovery: DiscoveryState = {
    sources: [],
    byCanonicalUrl: new Map(),
    byContentHash: new Map(),
  };

  // Operator-supplied sources come first: they are the manual fallback path and
  // carry real text, so provider snippets never shadow them.
  for (const candidate of state.input.operatorSources ?? []) {
    const operatorSource = OperatorSourceSchema.parse(candidate);
    acceptSource(state, discovery, {
      url: operatorSource.url,
      title: operatorSource.title,
      snippet: operatorSource.content,
      publishedAt: undefined,
      provider: "operator",
      questionIds: [],
      retrieval: "operator_text",
      publisher: operatorSource.publisher,
    });
  }

  const failures: unknown[] = [];
  let succeeded = 0;
  for (const question of questions) {
    for (const query of question.queries) {
      let envelope: ProviderResult<readonly WebSearchResult[]>;
      try {
        envelope = await deps.research.search(
          query,
          { limit: state.tuning.resultsPerQuery },
          state.ctx,
        );
        succeeded += 1;
      } catch (error) {
        // A degraded search capability must not silently shrink the research:
        // record it, and fail the run when nothing at all came back.
        failures.push(error);
        tally.notes.push(`search failed for "${preview(query, 60)}": ${messageOf(error)}`);
        continue;
      }
      tallyResult(tally, envelope);
      if (!Array.isArray(envelope.value)) {
        drop(
          state,
          dropped(
            "discover",
            "malformed_result",
            "the provider returned a non-array result set",
            query,
          ),
        );
        continue;
      }
      for (const row of envelope.value) {
        acceptSource(state, discovery, {
          url: (row as { url?: unknown } | null | undefined)?.url,
          title: (row as { title?: unknown } | null | undefined)?.title,
          snippet: (row as { snippet?: unknown } | null | undefined)?.snippet,
          publishedAt: (row as { publishedAt?: unknown } | null | undefined)?.publishedAt,
          provider:
            typeof (row as { source?: unknown } | null | undefined)?.source === "string" &&
            (row as { source?: string }).source !== ""
              ? (row as { source: string }).source
              : deps.research.id,
          questionIds: [question.id],
          retrieval: "provider_snippet",
        });
      }
    }
  }

  if (failures.length > 0) {
    const manual = failures.find((error) => isManualRequired(error));
    if (manual !== undefined) throw manual; // the caller parks the job at a gate
    if (succeeded === 0) {
      throw classifyProviderError(failures[0], {
        provider: deps.research.id,
        operation: "research.search",
      });
    }
    tally.outcome = "partial";
    state.degraded = true;
    state.warnings.push(
      `${failures.length} of ${failures.length + succeeded} search call(s) failed; the package covers the calls that succeeded`,
    );
  }

  if (discovery.sources.length === 0) {
    tally.outcome = "partial";
    state.degraded = true;
    state.warnings.push(
      `no usable sources were found for "${state.input.topic}" (nothing was invented to fill the gap)`,
    );
  }
  tally.notes.push(
    `${discovery.sources.length} source(s) accepted, ${state.dropped.filter((item) => item.stage === "discover").length} rejected`,
  );
  return { sources: discovery.sources };
}

interface CandidateSource {
  readonly url: unknown;
  readonly title: unknown;
  readonly snippet: unknown;
  readonly publishedAt: unknown;
  readonly provider: string;
  readonly questionIds: readonly string[];
  readonly retrieval: ResearchSource["retrieval"];
  readonly publisher?: string;
}

/** Validate + deduplicate one candidate row. Rejections are always recorded. */
function acceptSource(
  state: RunState,
  discovery: DiscoveryState,
  candidate: CandidateSource,
): ResearchSource | undefined {
  const rawUrl = typeof candidate.url === "string" ? candidate.url.trim() : "";
  if (rawUrl === "") {
    drop(
      state,
      dropped(
        "discover",
        "malformed_result",
        "the provider returned a row without a URL",
        String(candidate.title ?? ""),
      ),
    );
    return undefined;
  }

  try {
    // SSRF/localhost/credential-bearing URLs never enter the package (AD-12).
    assertPublicHttpUrl(rawUrl);
  } catch (error) {
    drop(state, dropped("discover", "invalid_url", messageOf(error), rawUrl));
    return undefined;
  }

  const canonical = canonicalUrl(rawUrl);
  if (canonical === undefined) {
    drop(state, dropped("discover", "invalid_url", "not an absolute URL", rawUrl));
    return undefined;
  }

  const existing = discovery.byCanonicalUrl.get(canonical);
  if (existing !== undefined) {
    // Same page seen again (another query, or a tracking-parameter variant):
    // keep one source and remember every question that surfaced it.
    existing.questionIds = unique([...existing.questionIds, ...candidate.questionIds]);
    drop(state, dropped("discover", "duplicate_url", "already collected", canonical));
    return existing;
  }

  if (discovery.sources.length >= state.tuning.maxSources) {
    drop(
      state,
      dropped(
        "discover",
        "source_limit",
        `source limit ${state.tuning.maxSources} reached`,
        canonical,
      ),
    );
    return undefined;
  }

  const content = typeof candidate.snippet === "string" ? candidate.snippet : "";
  const contentHash = sha256Hex(content);
  if (content !== "" && discovery.byContentHash.has(contentHash)) {
    drop(
      state,
      dropped("discover", "duplicate_content", "identical text to an accepted source", canonical),
    );
    return undefined;
  }

  const source: ResearchSource = {
    id: shortId("src", canonical),
    url: canonical,
    originalUrl: rawUrl,
    domain: domainOf(canonical),
    title: typeof candidate.title === "string" ? normalizeWhitespace(candidate.title) : "",
    publisher: candidate.publisher ?? candidate.provider,
    ...(typeof candidate.publishedAt === "string" && candidate.publishedAt !== ""
      ? { publishedAt: candidate.publishedAt }
      : {}),
    retrievedAt: state.clock.nowIso(),
    provider: candidate.provider,
    questionIds: unique(candidate.questionIds),
    content,
    contentHash,
    contentLength: content.length,
    retrieval: content === "" ? "unavailable" : candidate.retrieval,
  };
  discovery.sources.push(source);
  discovery.byCanonicalUrl.set(canonical, source);
  if (content !== "") discovery.byContentHash.set(contentHash, source);
  return source;
}

// ── 3. extract (AI per source; deterministic quote verification) ──────────

async function extractClaims(
  state: RunState,
  deps: ResearchDeps,
  questions: readonly ResearchQuestion[],
  sources: readonly ResearchSource[],
  tally: StepTally,
): Promise<{ evidence: Evidence[]; claims: RawClaim[] }> {
  const evidence: Evidence[] = [];
  const claims: RawClaim[] = [];
  const quotable = sources.filter((source) => source.retrieval !== "unavailable");
  const failures: unknown[] = [];
  let succeeded = 0;

  for (const source of sources) {
    if (source.retrieval === "unavailable") {
      drop(
        state,
        dropped("extract", "no_content", "source has no retrievable text to quote", source.url),
      );
      continue;
    }
    try {
      const result = await deps.llm.chat<SourceExtraction>(
        {
          task: "research.extract",
          templateVersion: RESEARCH_TEMPLATES.extract,
          schema: SourceExtractionSchema,
          schemaHint: SCHEMA_HINTS.extract,
          messages: extractMessages({
            topic: state.input.topic,
            questions,
            source: { url: source.url, title: source.title, provider: source.provider },
            text: source.content,
            maxEvidence: state.tuning.maxEvidencePerSource,
          }),
          maxRepairAttempts: 1,
        },
        state.ctx,
      );
      tallyResult(tally, result);
      tally.templateVersion = result.value.templateVersion;
      tally.model = result.value.model;
      succeeded += 1;
      collectExtraction(
        state,
        source,
        result.value.data,
        {
          provider: deps.llm.id,
          ...(result.value.model !== "" ? { model: result.value.model } : {}),
          templateVersion: result.value.templateVersion,
        },
        evidence,
        claims,
      );
    } catch (error) {
      if (isManualRequired(error)) throw error;
      failures.push(error);
      tally.notes.push(`extraction failed for ${source.domain}: ${messageOf(error)}`);
      drop(state, dropped("extract", "malformed_extraction", messageOf(error), source.url));
    }
  }

  if (failures.length > 0) {
    tally.outcome = "partial";
    state.degraded = true;
    state.warnings.push(
      `evidence extraction failed for ${failures.length} of ${quotable.length} source(s); those sources contributed nothing`,
    );
    if (succeeded === 0 && quotable.length > 0) {
      throw classifyProviderError(failures[0], {
        provider: deps.llm.id,
        operation: "llm.chat",
      });
    }
  }
  tally.notes.push(`${evidence.length} evidence passage(s), ${claims.length} candidate claim(s)`);
  return { evidence, claims };
}

/** Verify one model extraction against the source text and keep what is real. */
function collectExtraction(
  state: RunState,
  source: ResearchSource,
  extraction: SourceExtraction,
  generatedBy: GeneratedBy,
  evidence: Evidence[],
  claims: RawClaim[],
): void {
  const sourceEvidence: Evidence[] = [];
  const seenSpans = new Set<string>();

  for (const candidate of extraction.evidence.slice(0, state.tuning.maxEvidencePerSource)) {
    const match = findQuote(source.content, candidate.quote);
    if (match === undefined) {
      drop(
        state,
        dropped(
          "extract",
          "quote_not_found",
          `the quoted text does not appear in ${source.domain}`,
          candidate.quote,
        ),
      );
      continue;
    }
    const id = shortId("ev", source.id, String(match.start), String(match.end));
    if (seenSpans.has(id)) continue;
    seenSpans.add(id);
    const item: Evidence = {
      id,
      sourceId: source.id,
      // The excerpt is the source's own characters — never the model's copy.
      excerpt: match.excerpt,
      locator: { kind: "source_content", start: match.start, end: match.end },
      relevance: normalizeWhitespace(candidate.relevance),
      questionIds: [...source.questionIds],
      extractedBy: generatedBy,
    };
    sourceEvidence.push(item);
    evidence.push(item);
  }

  extraction.claims.forEach((candidate, index) => {
    const statement = normalizeWhitespace(candidate.statement);
    if (statement === "") {
      drop(state, dropped("extract", "malformed_extraction", "empty claim statement", source.url));
      return;
    }
    const links: ClaimLink[] = [];
    for (const reference of candidate.evidence) {
      const item = sourceEvidence[reference];
      if (item === undefined) {
        drop(
          state,
          dropped(
            "extract",
            "unknown_reference",
            `claim ${index + 1} references evidence ${reference}, which was not verified`,
            statement,
          ),
        );
        continue;
      }
      links.push({
        sourceId: source.id,
        evidenceId: item.id,
        stance: candidate.stance,
        strength: clamp01(candidate.strength),
        rationale: normalizeWhitespace(candidate.rationale),
      });
    }
    // A claim whose quotations all failed verification is kept — as an
    // *unverified* claim. Dropping it would hide what the model asserted.
    claims.push({
      statement,
      links,
      questionIds: [...source.questionIds],
      extractedBy: generatedBy,
    });
  });
}

// ── 4. reconcile (AI grouping; deterministic merge) ───────────────────────

interface ProvisionalClaim {
  id: string;
  bucket: RawClaim[];
  mergedBy: GeneratedBy | undefined;
}

async function reconcileClaims(
  state: RunState,
  deps: ResearchDeps,
  extracted: { evidence: Evidence[]; claims: RawClaim[] },
  tally: StepTally,
): Promise<{ claims: ResearchClaim[] }> {
  // Deterministic first pass: identical statements (after normalisation) are
  // the same claim, whatever the model would have said.
  const groups = new Map<string, RawClaim[]>();
  for (const claim of extracted.claims) {
    const key = normalizeStatement(claim.statement);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [claim]);
    else bucket.push(claim);
  }
  const provisional: ProvisionalClaim[] = [...groups.values()].map((bucket, index) => ({
    id: `p${index + 1}`,
    bucket,
    mergedBy: undefined,
  }));

  // Semantic pass: the model groups restatements that normalisation cannot see.
  if (provisional.length >= 2) {
    const promptable = provisional.slice(0, MAX_CLAIMS_FOR_RECONCILE);
    try {
      const result = await deps.llm.chat<Reconciliation>(
        {
          task: "research.reconcile",
          templateVersion: RESEARCH_TEMPLATES.reconcile,
          schema: ReconciliationSchema,
          schemaHint: SCHEMA_HINTS.reconcile,
          messages: reconcileMessages(
            promptable.map((entry) => ({
              id: entry.id,
              statement: entry.bucket[0]?.statement ?? "",
            })),
          ),
          maxRepairAttempts: 1,
        },
        state.ctx,
      );
      tallyResult(tally, result);
      tally.templateVersion = result.value.templateVersion;
      tally.model = result.value.model;
      const generatedBy: GeneratedBy = {
        provider: deps.llm.id,
        ...(result.value.model !== "" ? { model: result.value.model } : {}),
        templateVersion: result.value.templateVersion,
      };
      const byId = new Map(provisional.map((entry) => [entry.id, entry]));
      const claimed = new Set<string>();
      for (const group of result.value.data.groups) {
        const members = unique(group.claims)
          .map((id) => byId.get(id))
          .filter((entry): entry is ProvisionalClaim => entry !== undefined)
          .filter((entry) => !claimed.has(entry.id));
        if (members.length < 2) {
          const unknown = unique(group.claims).filter((id) => !byId.has(id));
          if (unknown.length > 0) {
            drop(
              state,
              dropped(
                "reconcile",
                "unknown_reference",
                "group referenced unknown claim ids",
                unknown.join(", "),
              ),
            );
          }
          continue;
        }
        const [first, ...rest] = members;
        if (first === undefined) continue;
        for (const member of rest) {
          claimed.add(member.id);
          first.bucket.push(...member.bucket);
          member.bucket = [];
        }
        first.mergedBy = generatedBy;
        claimed.add(first.id);
      }
    } catch (error) {
      // Reconciliation only improves corroboration; losing it degrades the run
      // rather than failing it.
      tally.outcome = "partial";
      state.degraded = true;
      tally.notes.push(`reconciliation failed: ${messageOf(error)}`);
      state.warnings.push(
        "claim reconciliation failed; identical wording was still merged, but restatements were not",
      );
    }
  } else {
    tally.outcome = "skipped";
  }

  const merged = provisional
    .filter((entry) => entry.bucket.length > 0)
    .map((entry) => mergeClaimGroup(entry.bucket, entry.mergedBy))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (merged.length === 0) {
    state.degraded = true;
    state.warnings.push("no factual claims could be extracted from the retrieved sources");
  }
  tally.notes.push(
    `${merged.length} claim(s) after merging ${extracted.claims.length} candidate(s)`,
  );
  return { claims: merged };
}

function mergeClaimGroup(bucket: readonly RawClaim[], reconciledBy?: GeneratedBy): ResearchClaim {
  const statements = unique(bucket.map((claim) => claim.statement));
  const links = dedupeLinks(bucket.flatMap((claim) => claim.links));
  const questionIds = unique(bucket.flatMap((claim) => claim.questionIds)).sort();
  const canonical = chooseCanonical(statements, bucket);
  const extractedBy = uniqueBy(
    bucket.map((claim) => claim.extractedBy),
    (generated) =>
      `${generated.provider}|${generated.model ?? ""}|${generated.templateVersion ?? ""}`,
  );
  return {
    id: shortId("cl", normalizeStatement(canonical)),
    statement: canonical,
    variants: statements.filter((statement) => statement !== canonical).sort(),
    ...(questionIds[0] !== undefined ? { questionId: questionIds[0] } : {}),
    questionIds,
    links,
    // Filled in by evaluateClaims — the evaluator owns status and confidence.
    status: "unverified",
    certainty: "uncertain",
    confidence: 0,
    corroboration: {
      supportingSources: [],
      contradictingSources: [],
      mentioningSources: [],
      independentSources: 0,
    },
    contested: false,
    mayStateAsFact: false,
    provenance: {
      extractedBy,
      ...(reconciledBy !== undefined ? { reconciledBy } : {}),
    },
  };
}

/**
 * Canonical wording for a merged claim: the wording supported by the most
 * links, then the shortest, then lexicographic. Deterministic, and it favours
 * the version most sources actually support instead of a model's favourite.
 */
function chooseCanonical(statements: readonly string[], bucket: readonly RawClaim[]): string {
  const counts = new Map<string, number>();
  for (const claim of bucket) {
    counts.set(claim.statement, (counts.get(claim.statement) ?? 0) + claim.links.length);
  }
  return [...statements].sort((a, b) => {
    const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    if (byCount !== 0) return byCount;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
}

function dedupeLinks(links: readonly ClaimLink[]): ClaimLink[] {
  const best = new Map<string, ClaimLink>();
  for (const link of links) {
    const key = `${link.sourceId}|${link.evidenceId}|${link.stance}`;
    const existing = best.get(key);
    if (existing === undefined || link.strength > existing.strength) best.set(key, link);
  }
  return [...best.values()].sort((a, b) => {
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    if (a.evidenceId !== b.evidenceId) return a.evidenceId < b.evidenceId ? -1 : 1;
    return a.stance < b.stance ? -1 : a.stance > b.stance ? 1 : 0;
  });
}

// ── 5. conflicts (AI proposals; deterministic validation) ─────────────────

async function detectConflicts(
  state: RunState,
  deps: ResearchDeps,
  sources: readonly ResearchSource[],
  inputClaims: readonly ResearchClaim[],
  tally: StepTally,
): Promise<{ claims: ResearchClaim[]; conflicts: Conflict[]; evidence: Evidence[] }> {
  const claims = inputClaims.map((claim) => ({ ...claim, links: [...claim.links] }));
  const evidence = new Map<string, Evidence>();
  const conflicts: Conflict[] = [];

  if (claims.length < 2) {
    tally.outcome = "skipped";
    tally.notes.push("fewer than two claims: nothing to disagree");
    return { claims, conflicts, evidence: [] };
  }

  try {
    const result = await deps.llm.chat<ConflictReport>(
      {
        task: "research.conflicts",
        templateVersion: RESEARCH_TEMPLATES.conflicts,
        schema: ConflictReportSchema,
        schemaHint: SCHEMA_HINTS.conflicts,
        messages: conflictMessages({
          claims: claims.map((claim) => ({ id: claim.id, statement: claim.statement })),
          sources: sources.map((source) => ({
            id: source.id,
            url: source.url,
            domain: source.domain,
          })),
        }),
        maxRepairAttempts: 1,
      },
      state.ctx,
    );
    tallyResult(tally, result);
    tally.templateVersion = result.value.templateVersion;
    tally.model = result.value.model;
    const generatedBy: GeneratedBy = {
      provider: deps.llm.id,
      ...(result.value.model !== "" ? { model: result.value.model } : {}),
      templateVersion: result.value.templateVersion,
    };
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const seenPairs = new Set<string>();

    // (a) Claim-vs-claim disagreement: both sides are kept, neither is resolved.
    for (const proposed of result.value.data.conflicts) {
      const members = unique(proposed.claims)
        .map((id) => byId.get(id))
        .filter((claim): claim is ResearchClaim => claim !== undefined);
      const unknown = unique(proposed.claims).filter((id) => !byId.has(id));
      if (unknown.length > 0) {
        drop(
          state,
          dropped(
            "conflicts",
            "unknown_reference",
            "conflict referenced unknown claim ids",
            unknown.join(", "),
          ),
        );
      }
      if (members.length < 2) {
        if (unknown.length === 0) {
          drop(
            state,
            dropped(
              "conflicts",
              "malformed_extraction",
              "conflict needs at least two distinct claims",
              proposed.claims.join(", "),
            ),
          );
        }
        continue;
      }
      const key = members
        .map((claim) => claim.id)
        .sort()
        .join("+");
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      for (const member of members) member.contested = true;
      conflicts.push({
        id: shortId("cf", key),
        kind: proposed.kind as ConflictKind,
        explanation: normalizeWhitespace(proposed.explanation),
        detectedBy: "model",
        sides: members.map((claim) => ({
          kind: "claim" as const,
          id: claim.id,
          statement: claim.statement,
          claimId: claim.id,
          sourceIds: unique(claim.links.map((link) => link.sourceId)),
        })),
        preserved: true,
      });
    }

    // (b) Refutations: a dissenting quote becomes a real contradiction link —
    // but only when the characters are actually in that source. An unverifiable
    // refutation is discarded, never quoted.
    for (const refutation of result.value.data.refutations) {
      const claim = byId.get(refutation.claim);
      const target = sourceById.get(refutation.source);
      if (claim === undefined || target === undefined) {
        drop(
          state,
          dropped(
            "conflicts",
            "unknown_reference",
            "refutation referenced an unknown claim or source",
            `${refutation.claim} / ${refutation.source}`,
          ),
        );
        continue;
      }
      const match = findQuote(target.content, refutation.quote);
      if (match === undefined) {
        drop(
          state,
          dropped(
            "conflicts",
            "quote_not_found",
            `the refuting text does not appear in ${target.domain}`,
            refutation.quote,
          ),
        );
        continue;
      }
      const evidenceId = shortId("ev", target.id, String(match.start), String(match.end));
      if (!evidence.has(evidenceId)) {
        evidence.set(evidenceId, {
          id: evidenceId,
          sourceId: target.id,
          excerpt: match.excerpt,
          locator: { kind: "source_content", start: match.start, end: match.end },
          relevance: normalizeWhitespace(refutation.explanation),
          questionIds: [...target.questionIds],
          extractedBy: generatedBy,
        });
        claim.links = dedupeLinks([
          ...claim.links,
          {
            sourceId: target.id,
            evidenceId,
            stance: "contradicts",
            strength: REFUTATION_STRENGTH,
            rationale: normalizeWhitespace(refutation.explanation),
          },
        ]);
      }
      claim.contested = true;
      const key = `${claim.id}+${target.id}`;
      if (conflicts.some((conflict) => conflict.id === shortId("cf", key))) continue;
      conflicts.push({
        id: shortId("cf", key),
        kind: "direct_contradiction",
        explanation: normalizeWhitespace(refutation.explanation),
        detectedBy: "evidence_stance",
        sides: [
          {
            kind: "claim",
            id: claim.id,
            statement: claim.statement,
            claimId: claim.id,
            sourceIds: unique(claim.links.map((link) => link.sourceId)),
          },
          {
            kind: "source",
            id: target.id,
            statement: match.excerpt,
            sourceIds: [target.id],
          },
        ],
        preserved: true,
      });
    }
  } catch (error) {
    if (isManualRequired(error)) throw error;
    tally.outcome = "partial";
    state.degraded = true;
    tally.notes.push(`conflict detection failed: ${messageOf(error)}`);
    state.warnings.push(
      "conflict detection failed; claims were kept as extracted, without a disagreement analysis",
    );
  }

  conflicts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  tally.notes.push(`${conflicts.length} conflict(s) recorded (none resolved)`);
  return { claims, conflicts, evidence: [...evidence.values()] };
}

// ── 6. evaluate (deterministic: status, confidence, gate) ─────────────────

interface Evaluation {
  readonly claims: ResearchClaim[];
  readonly verification: VerificationSummary;
}

/**
 * Deterministic verification of every claim from its claim/source links.
 *
 * Nothing here consults a model: the only model input is a link's `strength`,
 * which a model cannot raise above the caps set by evidence and disagreement.
 */
export function evaluateClaims(
  inputClaims: readonly ResearchClaim[],
  conflicts: readonly Conflict[],
  tuning: ResearchTuning = DEFAULT_RESEARCH_TUNING,
): Evaluation {
  const { establishedMinConfidence, establishedMinSources } = tuning;
  const conflictedClaimIds = new Set(
    conflicts.flatMap((conflict) =>
      conflict.sides.flatMap((side) => (side.claimId !== undefined ? [side.claimId] : [])),
    ),
  );

  const claims = inputClaims.map((claim) => {
    const supporting = unique(
      claim.links.filter((link) => link.stance === "supports").map((link) => link.sourceId),
    ).sort();
    const contradicting = unique(
      claim.links.filter((link) => link.stance === "contradicts").map((link) => link.sourceId),
    ).sort();
    const mentioning = unique(
      claim.links.filter((link) => link.stance === "mentions").map((link) => link.sourceId),
    ).sort();
    const contested = claim.contested || conflictedClaimIds.has(claim.id);

    const base =
      supporting.length === 0
        ? 0
        : supporting.length === 1
          ? 0.5
          : supporting.length === 2
            ? 0.75
            : 0.9;
    const strengths = supporting.map((sourceId) =>
      Math.max(
        ...claim.links
          .filter((link) => link.sourceId === sourceId && link.stance === "supports")
          .map((link) => link.strength),
      ),
    );
    const meanStrength =
      strengths.length === 0
        ? 0
        : strengths.reduce((sum, value) => sum + value, 0) / strengths.length;

    let confidence = base * (0.6 + 0.4 * clamp01(meanStrength));
    if (contested) confidence = Math.min(confidence, CONTESTED_CONFIDENCE_CAP);
    if (contradicting.length > 0) confidence = Math.min(confidence, DISPUTED_CONFIDENCE_CAP);
    confidence = round3(clamp01(confidence));

    const status: VerificationStatus =
      contradicting.length > 0
        ? "contradicted"
        : supporting.length > 0
          ? "supported"
          : claim.links.length > 0
            ? "unsupportable" // the material only mentions the subject
            : "unverified"; // no quotation survived verification

    // `status` describes the claim's own evidence; `certainty` describes what a
    // writer may do with it. A claim can be supported by its source and still
    // be disputed, because another source says something incompatible.
    const certainty: Certainty =
      status === "contradicted" || contested
        ? "disputed"
        : status === "unsupportable"
          ? "unsupported"
          : status === "unverified"
            ? "uncertain"
            : supporting.length >= establishedMinSources && confidence >= establishedMinConfidence
              ? "established"
              : "likely";

    return {
      ...claim,
      status,
      certainty,
      confidence,
      contested,
      // The mechanical guarantee against "uncertain claims stated as fact".
      mayStateAsFact: certainty === "established",
      corroboration: {
        supportingSources: supporting,
        contradictingSources: contradicting,
        mentioningSources: mentioning,
        independentSources: supporting.length,
      },
    };
  });

  const byStatus: Record<VerificationStatus, number> = {
    supported: 0,
    contradicted: 0,
    unverified: 0,
    unsupportable: 0,
  };
  for (const claim of claims) byStatus[claim.status] += 1;
  const blockingClaimIds = claims
    .filter((claim) => !claim.mayStateAsFact)
    .map((claim) => claim.id)
    .sort();

  return {
    claims,
    verification: {
      claims: claims.length,
      byStatus,
      established: claims.filter((claim) => claim.mayStateAsFact).length,
      contested: claims.filter((claim) => claim.contested).length,
      conflicts: conflicts.length,
      // Every claim that is not established needs a human (discovery §11), and
      // so does a package with nothing to verify — an empty run must never look
      // like a passed fact gate.
      reviewRequired: blockingClaimIds.length > 0 || claims.length === 0,
      blockingClaimIds,
    },
  };
}

// ── small helpers ─────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeEvidence(items: readonly Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(value);
  }
  return out;
}
