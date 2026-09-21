/**
 * `@nexus/research` — the research engine (Phase 5).
 *
 * One entry point matters:
 *
 * ```ts
 * const pkg = await runResearch({ topic, episodeId }, { llm, research, clock });
 * const persisted = persistResearchPackage({ storage, repo }, pkg, { episodeId });
 * ```
 *
 * `createResearchTask` is the same thing wired into the job orchestrator (the
 * `research` stage), which is what the worker actually runs.
 *
 * The public surface, grouped by what a caller is doing:
 *
 * - **Producing:** `runResearch`, `createResearchTask`, `ResearchInput`,
 *   `ResearchTuning`.
 * - **Storing:** `persistResearchPackage`, `loadResearchPackage`,
 *   `researchArtifactRef`.
 * - **Reading the result:** the package schema and vocabulary in `types.ts` —
 *   `ResearchPackage`, `ResearchClaim` (`status`, `certainty`, `confidence`,
 *   `mayStateAsFact`), `Conflict`, `VerificationSummary`, `Provenance`.
 * - **Deterministic helpers:** `findQuote`, `canonicalUrl`, `normalizeStatement`
 *   (used by the fact-check and script stages to re-verify evidence).
 */

// Vocabulary, document schemas and byte helpers.
export * from "./types.js";

// Deterministic text/URL handling (shared with later stages and tests).
export * from "./text.js";

// Prompt templates + the model-facing schemas they must satisfy.
export {
  ConflictReportSchema,
  QuestionPlanSchema,
  ReconciliationSchema,
  RESEARCH_TEMPLATES,
  SCHEMA_HINTS,
  SourceExtractionSchema,
  type ConflictReport,
  type QuestionPlan,
  type Reconciliation,
  type SourceExtraction,
} from "./prompts.js";

// The engine.
export {
  DEFAULT_RESEARCH_TUNING,
  OperatorSourceListSchema,
  OperatorSourceSchema,
  evaluateClaims,
  runResearch,
  type OperatorSource,
  type OperatorSourceInput,
  type ResearchDeps,
  type ResearchInput,
  type ResearchTuning,
} from "./pipeline.js";

// Persistence (CAS artifact + sources table).
export {
  RESEARCH_ARTIFACT_KIND,
  RESEARCH_ARTIFACT_ROLE,
  loadResearchPackage,
  persistResearchPackage,
  researchArtifactRef,
  type PersistResearchDeps,
  type PersistResearchOptions,
  type PersistedResearch,
} from "./persist.js";

// Orchestration wiring (the `research` stage task).
export { RESEARCH_STAGE_KEY, createResearchTask, type ResearchTaskDeps } from "./task.js";
