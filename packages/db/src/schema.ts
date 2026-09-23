/**
 * Versioned migrations — the domain model from docs/plans/000-architecture-discovery.md §6
 * and docs/architecture/domain-model.md, scoped to what the system uses now.
 *
 * RULES (enforced by migrate() and tests):
 * - Append-only: an applied migration must NEVER be edited (migrate() detects
 *   drift via stored sql_hash and refuses to run). Exception: until this
 *   migration set has shipped (end of Phase 2), 0001 may still be amended —
 *   after that it is frozen and any change must be a new migration.
 * - Non-destructive: no DROP TABLE / destructive resets. Schema changes to
 *   existing tables go through new additive migrations.
 * - No blobs: binary content lives in the content-addressed store; the DB
 *   holds hashes + metadata only (discovery §6.4).
 * - No secrets: credentials are referenced by env-var NAME only (AD-12).
 *
 * Conventions:
 * - IDs: TEXT uuid v4 (stable, generated in the repo layer).
 * - Timestamps: TEXT ISO-8601 UTC.
 * - Enums: TEXT + CHECK constraints (DB-level) mirrored by zod schemas
 *   (application-level) in ./types.ts.
 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_domain_foundation",
    sql: `
-- ── Production domain ────────────────────────────────────────────────────

CREATE TABLE projects (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) > 0),
  slug        TEXT NOT NULL UNIQUE CHECK (length(slug) > 0),
  description TEXT NOT NULL DEFAULT '',
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- An Episode is one production run. kind='short' episodes reference their
-- parent long-form episode (covers discovery §6.1 video+short with one
-- aggregate; shorts are re-renders of the parent, AD-10).
CREATE TABLE episodes (
  id                TEXT PRIMARY KEY NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  parent_episode_id TEXT REFERENCES episodes(id),
  kind              TEXT NOT NULL DEFAULT 'long' CHECK (kind IN ('long', 'short')),
  topic             TEXT NOT NULL CHECK (length(topic) > 0),
  outline           TEXT NOT NULL DEFAULT '[]',
  state             TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED', 'RESEARCHING', 'FACT_CHECKING', 'FACT_REVIEW', 'SCRIPTING',
    'SCENE_PLANNING', 'MEDIA_GATHERING', 'VOICE_SYNTHESIS', 'CAPTIONING',
    'COMPOSITING', 'RENDERING', 'QA', 'APPROVAL', 'READY', 'PUBLISHING',
    'PUBLISHED', 'NEEDS_CHANGES', 'FAILED', 'CANCELED'
  )),
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_episodes_project_state ON episodes(project_id, state);
CREATE INDEX idx_episodes_parent ON episodes(parent_episode_id);

CREATE TABLE sources (
  id           TEXT PRIMARY KEY NOT NULL,
  url          TEXT NOT NULL CHECK (length(url) > 0),
  title        TEXT NOT NULL DEFAULT '',
  publisher    TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  added_by     TEXT NOT NULL DEFAULT 'operator' CHECK (added_by IN ('operator', 'provider')),
  retrieved_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_sources_content_hash ON sources(content_hash);
CREATE INDEX idx_sources_url ON sources(url);

CREATE TABLE episode_sources (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'research',
  added_at   TEXT NOT NULL,
  PRIMARY KEY (episode_id, source_id)
);

-- CAS index: every stored blob is referenced by sha256. Bytes NEVER live in
-- this table (discovery §6.4 "no blobs in SQLite").
CREATE TABLE artifacts (
  hash       TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64),
  kind       TEXT NOT NULL CHECK (kind IN (
    'script', 'scene_graph', 'audio', 'captions', 'video', 'thumbnail',
    'image', 'document', 'qa_report', 'metadata', 'other'
  )),
  bytes      INTEGER NOT NULL CHECK (bytes >= 0),
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_kind ON artifacts(kind);

-- Scripts are versioned per episode; the document body is a CAS artifact.
CREATE TABLE scripts (
  id         TEXT PRIMARY KEY NOT NULL,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL CHECK (version >= 1),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  doc_hash   TEXT NOT NULL REFERENCES artifacts(hash),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (episode_id, version)
);

-- Scene rows are the persisted scene graph of one script version.
CREATE TABLE scenes (
  id           TEXT PRIMARY KEY NOT NULL,
  script_id    TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  episode_id   TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL CHECK (idx >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('title', 'talk', 'fact', 'media', 'quote')),
  section_id   TEXT NOT NULL DEFAULT '',
  sentence_id  TEXT NOT NULL DEFAULT '',
  start_sec    REAL NOT NULL DEFAULT 0 CHECK (start_sec >= 0),
  duration_sec REAL NOT NULL CHECK (duration_sec > 0),
  data         TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE (script_id, idx)
);
CREATE INDEX idx_scenes_episode ON scenes(episode_id);

-- Claims are first-class (discovery §6.4): every factual sentence traces to
-- claim rows, and claims trace to sources via claim_evidence.
CREATE TABLE claims (
  id          TEXT PRIMARY KEY NOT NULL,
  episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  script_id   TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  claim_ref   TEXT NOT NULL CHECK (length(claim_ref) > 0),
  sentence_id TEXT NOT NULL CHECK (length(sentence_id) > 0),
  text        TEXT NOT NULL CHECK (length(text) > 0),
  status      TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN (
    'unverified', 'supported', 'contradicted', 'unsupportable', 'overridden'
  )),
  score       REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (script_id, claim_ref)
);
CREATE INDEX idx_claims_episode_status ON claims(episode_id, status);

CREATE TABLE claim_evidence (
  claim_id  TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  excerpt   TEXT NOT NULL DEFAULT '',
  locator   TEXT NOT NULL DEFAULT '',
  score     REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
  PRIMARY KEY (claim_id, source_id)
);

-- External media with provenance/license records (AD-09). license is
-- mandatory: no provenance, no bytes. hash references the CAS index.
CREATE TABLE media_assets (
  hash         TEXT PRIMARY KEY NOT NULL REFERENCES artifacts(hash),
  project_id   TEXT REFERENCES projects(id),
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'document', 'generated', 'original')),
  license      TEXT NOT NULL CHECK (length(license) > 0),
  license_url  TEXT NOT NULL DEFAULT '',
  source_uri   TEXT NOT NULL DEFAULT '',
  attribution  TEXT NOT NULL DEFAULT '',
  ai_generated INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0, 1)),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_media_assets_license ON media_assets(license);

-- ── Execution domain (resumable jobs, discovery §6.2/§7) ─────────────────

-- pipeline ids are versioned strings ('longform_v1', 'shorts_v1',
-- 'publish_v1', …) validated in the repo layer, not by CHECK, so adding a
-- pipeline version never requires a schema migration.
CREATE TABLE pipeline_jobs (
  id                TEXT PRIMARY KEY NOT NULL,
  episode_id        TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  pipeline          TEXT NOT NULL CHECK (length(pipeline) > 0),
  state             TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING', 'RUNNING', 'WAITING_GATE', 'DONE', 'FAILED', 'CANCELED'
  )),
  waiting_gate      TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  input_fingerprint TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_pipeline_jobs_claimable ON pipeline_jobs(state, lease_expires_at);
CREATE INDEX idx_pipeline_jobs_episode ON pipeline_jobs(episode_id);

-- The unit of resumability: a step with state='DONE' and a matching
-- input_hash (chained over upstream outputs) is skipped on resume.
CREATE TABLE pipeline_job_steps (
  job_id      TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  step_key    TEXT NOT NULL CHECK (length(step_key) > 0),
  idx         INTEGER NOT NULL CHECK (idx >= 0),
  state       TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DONE', 'FAILED', 'WAITING')),
  input_hash  TEXT,
  output      TEXT,
  attempt     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (job_id, step_key),
  UNIQUE (job_id, idx)
);

-- Approvals bind to a content fingerprint (AD-08): approving v3 must never
-- publish v4.
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('episode', 'script', 'publish_action')),
  subject_id   TEXT NOT NULL CHECK (length(subject_id) > 0),
  gate         TEXT NOT NULL CHECK (length(gate) > 0),
  decision     TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'needs_changes')),
  fingerprint  TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  reviewed_by  TEXT NOT NULL DEFAULT 'operator',
  reviewed_at  TEXT NOT NULL
);
CREATE INDEX idx_approvals_subject ON approvals(subject_type, subject_id);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor        TEXT NOT NULL DEFAULT 'system',
  action       TEXT NOT NULL CHECK (length(action) > 0),
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id   TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

-- ── Provider domain (discovery §6.3, AD-06/AD-13) ────────────────────────

-- credentials_env holds the NAME of an environment variable (e.g.
-- 'NEXUS_LLM_API_KEY'), NEVER a secret value (AD-12). The repo layer
-- validates the identifier shape.
CREATE TABLE provider_accounts (
  id                TEXT PRIMARY KEY NOT NULL,
  adapter           TEXT NOT NULL CHECK (length(adapter) > 0),
  operation_scope   TEXT NOT NULL DEFAULT '*',
  credentials_env   TEXT NOT NULL DEFAULT '',
  quota_window      TEXT NOT NULL DEFAULT 'none' CHECK (quota_window IN ('none', 'daily', 'monthly')),
  quota_limit       REAL,
  quota_used        REAL NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  window_started_at TEXT,
  cooldown_until    TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (adapter, operation_scope)
);

CREATE TABLE provider_call_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT REFERENCES provider_accounts(id),
  provider    TEXT NOT NULL CHECK (length(provider) > 0),
  operation   TEXT NOT NULL CHECK (length(operation) > 0),
  units       REAL NOT NULL DEFAULT 0 CHECK (units >= 0),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  error       TEXT,
  cache_key   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_provider_call_log_provider_time ON provider_call_log(provider, created_at);
`,
  },
  {
    id: "0002_job_orchestration",
    sql: `
-- Phase 3 — job orchestration. ADDITIVE ONLY: no table is rebuilt, no column
-- is dropped, no data is touched (the episodes/pipeline_jobs CHECK lists stay
-- exactly as shipped in 0001; new states are derived, never persisted).

ALTER TABLE pipeline_jobs ADD COLUMN idempotency_key TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE pipeline_jobs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN error_kind TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN failure_step TEXT;

-- Job-creation idempotency: a duplicate submission (same episode + same
-- versioned request) collapses onto the job that already exists.
CREATE UNIQUE INDEX idx_pipeline_jobs_idempotency
  ON pipeline_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Artifact references + reuse provenance per completed stage. The step's
-- input_hash IS the stage fingerprint (same inputs ⇒ same hash ⇒ reusable
-- output), so no second fingerprint column is introduced.
ALTER TABLE pipeline_job_steps ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pipeline_job_steps ADD COLUMN reused_from_job_id TEXT;
ALTER TABLE pipeline_job_steps ADD COLUMN reused_from_step_key TEXT;

-- Reuse lookup: "has this exact stage already produced this exact output?"
CREATE INDEX idx_job_steps_reuse ON pipeline_job_steps(input_hash, state);

-- Append-only job log: operator-facing narrative + machine-readable events.
CREATE TABLE job_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  step_key   TEXT,
  level      TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event      TEXT NOT NULL CHECK (length(event) > 0),
  message    TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_job_logs_job ON job_logs(job_id, id);
`,
  },
];

/** Tables created by the migrations (used by tests to detect accidental drift). */
export const EXPECTED_TABLES: readonly string[] = [
  "projects",
  "episodes",
  "sources",
  "episode_sources",
  "artifacts",
  "scripts",
  "scenes",
  "claims",
  "claim_evidence",
  "media_assets",
  "pipeline_jobs",
  "pipeline_job_steps",
  "approvals",
  "audit_log",
  "provider_accounts",
  "provider_call_log",
  "job_logs",
];
