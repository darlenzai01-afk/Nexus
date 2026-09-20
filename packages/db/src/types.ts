import { z } from "zod";

/**
 * Application-level mirror of the DB CHECK constraints. Every enum exists
 * twice on purpose: zod (fail fast with good messages before hitting SQL)
 * and CHECK (last line of defense for raw writes). Keep both in sync —
 * schema.test.ts asserts they agree.
 */

export const EpisodeStateSchema = z.enum([
  "QUEUED",
  "RESEARCHING",
  "FACT_CHECKING",
  "FACT_REVIEW",
  "SCRIPTING",
  "SCENE_PLANNING",
  "MEDIA_GATHERING",
  "VOICE_SYNTHESIS",
  "CAPTIONING",
  "COMPOSITING",
  "RENDERING",
  "QA",
  "APPROVAL",
  "READY",
  "PUBLISHING",
  "PUBLISHED",
  "NEEDS_CHANGES",
  "FAILED",
  "CANCELED",
]);
export type EpisodeState = z.infer<typeof EpisodeStateSchema>;

export const EpisodeKindSchema = z.enum(["long", "short"]);
export type EpisodeKind = z.infer<typeof EpisodeKindSchema>;

export const JobStateSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_GATE",
  "DONE",
  "FAILED",
  "CANCELED",
]);
export type JobState = z.infer<typeof JobStateSchema>;

/**
 * Persisted stage progress. Note there is no RUNNING: a stage is "in flight"
 * exactly when its job is RUNNING and the step is PENDING with a `started_at`
 * stamp. Keeping the persisted set small means adding orchestration concepts
 * never requires a table rebuild (SQLite cannot widen a CHECK in place).
 */
export const StepStateSchema = z.enum(["PENDING", "DONE", "FAILED", "WAITING"]);
export type StepState = z.infer<typeof StepStateSchema>;

export const ClaimStatusSchema = z.enum([
  "unverified",
  "supported",
  "contradicted",
  "unsupportable",
  "overridden",
]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ScriptStatusSchema = z.enum(["draft", "approved", "rejected", "superseded"]);
export type ScriptStatus = z.infer<typeof ScriptStatusSchema>;

export const SceneKindSchema = z.enum(["title", "talk", "fact", "media", "quote"]);
export type SceneKind = z.infer<typeof SceneKindSchema>;

export const ArtifactKindSchema = z.enum([
  "script",
  "scene_graph",
  "audio",
  "captions",
  "video",
  "thumbnail",
  "image",
  "document",
  "qa_report",
  "metadata",
  "other",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const MediaKindSchema = z.enum([
  "image",
  "audio",
  "video",
  "document",
  "generated",
  "original",
]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const ApprovalDecisionSchema = z.enum(["approved", "rejected", "needs_changes"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSubjectTypeSchema = z.enum(["episode", "script", "publish_action"]);
export type ApprovalSubjectType = z.infer<typeof ApprovalSubjectTypeSchema>;

export const QuotaWindowSchema = z.enum(["none", "daily", "monthly"]);
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const JobLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type JobLogLevel = z.infer<typeof JobLogLevelSchema>;

/**
 * Why a run stopped. `retryable` means a backoff is scheduled (the job is
 * PENDING with `next_attempt_at` in the future); `permanent` means the task
 * reported an unrecoverable error; `exhausted` means the retry ceiling was
 * hit; `canceled` means an operator stopped it.
 */
export const ErrorKindSchema = z.enum(["retryable", "permanent", "exhausted", "canceled"]);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

/**
 * Derived (never persisted) operator-facing job status: the four stored
 * states plus RETRYING, which is a PENDING job scheduled for a later attempt.
 */
export type JobStatus = JobState | "RETRYING";

export const ProviderCallStatusSchema = z.enum(["ok", "error"]);
export type ProviderCallStatus = z.infer<typeof ProviderCallStatusSchema>;

/** sha256 hex — the identity of every CAS blob. */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected 64-char lowercase sha256 hex");

/** Env-var NAME (never a value) — AD-12: secrets stay in the environment. */
export const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "expected an environment variable NAME like NEXUS_LLM_API_KEY");

/** Pipeline ids are versioned free-form strings; shape-checked, not enum-checked. */
export const PipelineIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+_v[0-9]+$/, "expected e.g. longform_v1");

// ── Row types (SELECT shapes) ─────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface EpisodeRow {
  id: string;
  project_id: string;
  parent_episode_id: string | null;
  kind: EpisodeKind;
  topic: string;
  outline: string;
  state: EpisodeState;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  url: string;
  title: string;
  publisher: string;
  content: string;
  content_hash: string;
  added_by: "operator" | "provider";
  retrieved_at: string;
  created_at: string;
}

export interface ArtifactRow {
  hash: string;
  kind: ArtifactKind;
  bytes: number;
  meta: string;
  created_at: string;
}

export interface ScriptRow {
  id: string;
  episode_id: string;
  version: number;
  status: ScriptStatus;
  doc_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SceneRow {
  id: string;
  script_id: string;
  episode_id: string;
  idx: number;
  kind: SceneKind;
  section_id: string;
  sentence_id: string;
  start_sec: number;
  duration_sec: number;
  data: string;
  created_at: string;
}

export interface ClaimRow {
  id: string;
  episode_id: string;
  script_id: string;
  claim_ref: string;
  sentence_id: string;
  text: string;
  status: ClaimStatus;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface ClaimEvidenceRow {
  claim_id: string;
  source_id: string;
  excerpt: string;
  locator: string;
  score: number;
}

export interface MediaAssetRow {
  hash: string;
  project_id: string | null;
  kind: MediaKind;
  license: string;
  license_url: string;
  source_uri: string;
  attribution: string;
  ai_generated: number;
  created_at: string;
}

export interface PipelineJobRow {
  id: string;
  episode_id: string;
  pipeline: string;
  state: JobState;
  waiting_gate: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  input_fingerprint: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  /** Set when the job was created from an idempotency key (unique per key). */
  idempotency_key: string | null;
  max_attempts: number;
  /** Retry backoff: the job is claimable again at/after this time. */
  next_attempt_at: string | null;
  heartbeat_at: string | null;
  error_kind: ErrorKind | null;
  /** Step key that produced the failure, for operator triage + targeted retry. */
  failure_step: string | null;
}

export interface JobStepRow {
  job_id: string;
  step_key: string;
  idx: number;
  state: StepState;
  /** Stage fingerprint: identical inputs ⇒ identical hash ⇒ reusable output. */
  input_hash: string | null;
  output: string | null;
  attempt: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** JSON array of ArtifactRef: the artifacts this stage produced or adopted. */
  artifacts: string;
  /** Provenance when the stage was not executed but adopted from another job. */
  reused_from_job_id: string | null;
  reused_from_step_key: string | null;
}

export interface JobLogRow {
  id: number;
  job_id: string;
  step_key: string | null;
  level: JobLogLevel;
  event: string;
  message: string;
  data: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  subject_type: ApprovalSubjectType;
  subject_id: string;
  gate: string;
  decision: ApprovalDecision;
  fingerprint: string;
  notes: string;
  reviewed_by: string;
  reviewed_at: string;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  subject_type: string;
  subject_id: string;
  detail: string;
  created_at: string;
}

export interface ProviderAccountRow {
  id: string;
  adapter: string;
  operation_scope: string;
  credentials_env: string;
  quota_window: QuotaWindow;
  quota_limit: number | null;
  quota_used: number;
  window_started_at: string | null;
  cooldown_until: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderCallRow {
  id: number;
  account_id: string | null;
  provider: string;
  operation: string;
  units: number;
  duration_ms: number;
  status: ProviderCallStatus;
  error: string | null;
  cache_key: string | null;
  created_at: string;
}
