/**
 * `@nexus/script` — the script generation engine (Phase 6).
 *
 * ```ts
 * const doc = await generateScript({ topic, research: pkg, packageHash }, { llm, clock });
 * const persisted = persistScript({ storage, repo }, doc, pkg, { episodeId });
 * ```
 *
 * `createScriptTask` is the same thing wired into the job orchestrator (the
 * `script` stage), which is what the worker actually runs.
 *
 * Public surface, grouped by what a caller is doing:
 *
 * - **Producing:** `generateScript`, `createScriptTask`, `ScriptInput`,
 *   `ScriptTuning`, `NoUsableClaimsError`.
 * - **The document:** the narration contract itself lives in `@nexus/db`
 *   (`ScriptDocSchema` — hook, introduction, narrative sections, transitions,
 *   conclusion, narration, visual cues, claim ledger) and is re-exported here,
 *   because the repository validates it when a script row is created.
 * - **Storing:** `persistScript`, `loadScriptDoc`, `scriptArtifactRef`,
 *   `resolveSourceIds`.
 * - **The rules, callable on their own:** `buildClaimBrief`, `verifyScriptClaims`,
 *   `buildClaimLedger` (claim/evidence traceability) and `lintScript`
 *   (filler, repetition, fake suspense, invented quotes, fabricated sources).
 */

// The narration contract (owned by @nexus/db, exercised by this package).
export {
  ScriptAssertionSchema,
  ScriptClaimEntrySchema,
  ScriptDocSchema,
  ScriptIssueCodeSchema,
  ScriptQualityIssueSchema,
  ScriptQualitySchema,
  ScriptSectionRoleSchema,
  ScriptSectionSchema,
  ScriptSentenceSchema,
  ScriptStatsSchema,
  ScriptVisualCueSchema,
  ScriptVisualKindSchema,
  parseScriptDoc,
  scriptDocBytes,
  scriptNarration,
  type ScriptAssertion,
  type ScriptClaimEntry,
  type ScriptDoc,
  type ScriptEvidenceRef,
  type ScriptIssueCode,
  type ScriptQuality,
  type ScriptQualityIssue,
  type ScriptSection,
  type ScriptSectionRole,
  type ScriptSentence,
  type ScriptStats,
  type ScriptStep,
  type ScriptVisualCue,
  type ScriptVisualKind,
} from "@nexus/db";

// Deterministic text handling (shared with later stages and tests).
export * from "./text.js";

// Claim brief + claim/evidence verification.
export {
  buildClaimBrief,
  buildClaimLedger,
  sameStatement,
  verifyScriptClaims,
  type AttributedBrief,
  type BlockedBrief,
  type ClaimBrief,
  type ClaimViolation,
  type EvidenceText,
  type FactBrief,
} from "./claims.js";

// The writing lint (deterministic quality findings).
export {
  FAKE_SUSPENSE_PHRASES,
  FILLER_PHRASES,
  OVERUSED_CONNECTIVES,
  lintScript,
  structureFindings,
  toQualityIssues,
  type StyleContext,
  type StyleFinding,
} from "./style.js";

// Prompt templates + the model-facing draft schema they must satisfy.
export {
  SCRIPT_SCHEMA_HINT,
  SCRIPT_TEMPLATES,
  ScriptDraftSchema,
  reviseMessages,
  writeMessages,
  type ScriptDraft,
} from "./prompts.js";

// The engine.
export {
  DEFAULT_SCRIPT_TUNING,
  NoUsableClaimsError,
  assembleScriptDoc,
  computeStats,
  generateScript,
  type ScriptDeps,
  type ScriptInput,
  type ScriptTuning,
} from "./pipeline.js";

// Persistence (CAS artifact + scripts/claims/claim_evidence rows).
export {
  SCRIPT_ARTIFACT_KIND,
  SCRIPT_ARTIFACT_ROLE,
  loadScriptDoc,
  persistScript,
  resolveSourceIds,
  scriptArtifactRef,
  type PersistScriptDeps,
  type PersistScriptOptions,
  type PersistedScript,
} from "./persist.js";

// Orchestration wiring (the `script` stage task).
export { SCRIPT_STAGE_KEY, createScriptTask, type ScriptTaskDeps } from "./task.js";
