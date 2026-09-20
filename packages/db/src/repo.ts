import { createHash, randomUUID } from "node:crypto";

import type { Db, SqlParam } from "./index.js";
import {
  ArtifactMetaSchema,
  OutlineSchema,
  ProjectConfigSchema,
  SceneDataSchema,
  ScriptDocSchema,
  type ProjectConfig,
  type ScriptDoc,
} from "./docs.js";
import {
  ApprovalDecisionSchema,
  ApprovalSubjectTypeSchema,
  ArtifactKindSchema,
  ClaimStatusSchema,
  EpisodeKindSchema,
  EpisodeStateSchema,
  EnvVarNameSchema,
  JobStateSchema,
  MediaKindSchema,
  PipelineIdSchema,
  SceneKindSchema,
  ProviderCallStatusSchema,
  QuotaWindowSchema,
  ScriptStatusSchema,
  Sha256Schema,
  type ApprovalDecision,
  type ApprovalRow,
  type ApprovalSubjectType,
  type ArtifactKind,
  type ArtifactRow,
  type AuditRow,
  type ClaimEvidenceRow,
  type ClaimRow,
  type ClaimStatus,
  type EpisodeKind,
  type EpisodeRow,
  type EpisodeState,
  type JobState,
  type JobStepRow,
  type MediaAssetRow,
  type MediaKind,
  type PipelineJobRow,
  type ProjectRow,
  type ProviderAccountRow,
  type ProviderCallRow,
  type QuotaWindow,
  type SceneKind,
  type SceneRow,
  type ScriptRow,
  type ScriptStatus,
  type SourceRow,
} from "./types.js";

import { ZodError } from "zod";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export const nowIso = (): string => new Date().toISOString();

/**
 * Validate against a zod schema and return its *output* type (defaults
 * applied). The parameter is structurally typed on `parse` so schemas whose
 * input type is narrower than their output type (anything using `.default()`)
 * still infer correctly.
 */
function validate<T>(schema: { parse: (value: unknown) => T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new ValidationError(`Invalid ${what}: ${issues}`);
    }
    throw error;
  }
}

const bool = (value: boolean): number => (value ? 1 : 0);

const createHashSha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// ── Input shapes ──────────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  slug: string;
  description?: string;
  config?: Partial<ProjectConfig>;
}

export interface CreateEpisodeInput {
  projectId: string;
  topic: string;
  outline?: string[];
  kind?: EpisodeKind;
  parentEpisodeId?: string;
}

export interface AddSourceInput {
  url: string;
  content: string;
  title?: string;
  publisher?: string;
  addedBy?: "operator" | "provider";
}

export interface RegisterArtifactInput {
  hash: string;
  kind: ArtifactKind;
  bytes: number;
  meta?: unknown;
}

export interface CreateScriptInput {
  episodeId: string;
  doc: ScriptDoc;
  /** CAS hash of the serialized doc — the blob must already be registered. */
  docHash: string;
  status?: ScriptStatus;
}

export interface SceneInput {
  kind: SceneKind;
  sectionId?: string;
  sentenceId?: string;
  startSec?: number;
  durationSec: number;
  data?: unknown;
}

export interface ClaimInput {
  claimRef: string;
  sentenceId: string;
  text: string;
  status?: ClaimStatus;
  score?: number;
  evidence?: { sourceId: string; excerpt?: string; locator?: string; score?: number }[];
}

export interface RegisterMediaAssetInput {
  hash: string;
  kind: MediaKind;
  license: string;
  licenseUrl?: string;
  sourceUri?: string;
  attribution?: string;
  aiGenerated?: boolean;
  projectId?: string;
}

export interface CreateJobInput {
  episodeId: string;
  pipeline: string;
  /** Ordered step keys of the pipeline DAG (versioned in code). */
  steps: readonly string[];
}

export interface ClaimJobInput {
  owner: string;
  leaseMs: number;
}

export interface RecordApprovalInput {
  subjectType: ApprovalSubjectType;
  subjectId: string;
  gate: string;
  decision: ApprovalDecision;
  fingerprint?: string;
  notes?: string;
  reviewedBy?: string;
}

export interface AppendAuditInput {
  action: string;
  actor?: string;
  subjectType?: string;
  subjectId?: string;
  detail?: unknown;
}

export interface UpsertProviderAccountInput {
  adapter: string;
  operationScope?: string;
  /** NAME of the env var holding the credential — never the value (AD-12). */
  credentialsEnv?: string;
  quotaWindow?: QuotaWindow;
  quotaLimit?: number;
  enabled?: boolean;
}

export interface LogProviderCallInput {
  provider: string;
  operation: string;
  units?: number;
  durationMs?: number;
  status?: "ok" | "error";
  error?: string;
  cacheKey?: string;
  accountId?: string;
}

/**
 * Repository layer: the only sanctioned write path into the domain tables.
 * Every input is validated here (zod) *before* SQL, so the DB CHECK
 * constraints remain a last line of defence rather than the error message a
 * caller ever sees.
 */
export class Repo {
  constructor(private readonly db: Db) {}

  // ── Projects ───────────────────────────────────────────────────────────

  createProject(input: CreateProjectInput): ProjectRow {
    const name = input.name?.trim();
    if (!name) throw new ValidationError("Invalid project: name is required");
    const slug = input.slug?.trim();
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new ValidationError("Invalid project: slug must be lowercase alphanumeric with dashes");
    }
    const config = validate(ProjectConfigSchema, input.config ?? {}, "project config");
    const id = randomUUID();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO projects (id, name, slug, description, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [id, name, slug, input.description ?? "", JSON.stringify(config), ts, ts],
    );
    return this.requireProject(id);
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?;", [id]);
  }

  requireProject(id: string): ProjectRow {
    const row = this.getProject(id);
    if (!row) throw new NotFoundError("project", id);
    return row;
  }

  listProjects(): ProjectRow[] {
    return this.db.all<ProjectRow>("SELECT * FROM projects ORDER BY created_at;");
  }

  projectConfig(id: string): ProjectConfig {
    return validate(
      ProjectConfigSchema,
      JSON.parse(this.requireProject(id).config),
      "project config",
    );
  }

  // ── Episodes ───────────────────────────────────────────────────────────

  createEpisode(input: CreateEpisodeInput): EpisodeRow {
    this.requireProject(input.projectId);
    const topic = input.topic?.trim();
    if (!topic) throw new ValidationError("Invalid episode: topic is required");
    const outline = validate(OutlineSchema, input.outline ?? [], "episode outline");
    const kind = validate(EpisodeKindSchema, input.kind ?? "long", "episode kind");
    if (kind === "short" && !input.parentEpisodeId) {
      throw new ValidationError("Invalid episode: a short episode must reference parentEpisodeId");
    }
    if (input.parentEpisodeId) {
      const parent = this.getEpisode(input.parentEpisodeId);
      if (!parent) throw new NotFoundError("episode", input.parentEpisodeId);
      if (parent.kind !== "long")
        throw new ValidationError("Invalid episode: parent must be a long-form episode");
    }
    const id = randomUUID();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO episodes (id, project_id, parent_episode_id, kind, topic, outline, state, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', NULL, ?, ?);`,
      [
        id,
        input.projectId,
        input.parentEpisodeId ?? null,
        kind,
        topic,
        JSON.stringify(outline),
        ts,
        ts,
      ],
    );
    return this.requireEpisode(id);
  }

  getEpisode(id: string): EpisodeRow | undefined {
    return this.db.get<EpisodeRow>("SELECT * FROM episodes WHERE id = ?;", [id]);
  }

  requireEpisode(id: string): EpisodeRow {
    const row = this.getEpisode(id);
    if (!row) throw new NotFoundError("episode", id);
    return row;
  }

  listEpisodes(projectId?: string): EpisodeRow[] {
    return projectId
      ? this.db.all<EpisodeRow>(
          "SELECT * FROM episodes WHERE project_id = ? ORDER BY created_at;",
          [projectId],
        )
      : this.db.all<EpisodeRow>("SELECT * FROM episodes ORDER BY created_at;");
  }

  episodeOutline(id: string): string[] {
    return validate(OutlineSchema, JSON.parse(this.requireEpisode(id).outline), "episode outline");
  }

  /** State is a validated enum (discovery §7); transition legality is the pipeline's job. */
  setEpisodeState(id: string, state: EpisodeState, error: string | null = null): EpisodeRow {
    this.requireEpisode(id);
    const next = validate(EpisodeStateSchema, state, "episode state");
    this.db.run("UPDATE episodes SET state = ?, error = ?, updated_at = ? WHERE id = ?;", [
      next,
      error,
      nowIso(),
      id,
    ]);
    return this.requireEpisode(id);
  }

  // ── Sources ────────────────────────────────────────────────────────────

  addSource(input: AddSourceInput): SourceRow {
    const url = input.url?.trim();
    if (!url) throw new ValidationError("Invalid source: url is required");
    const content = input.content ?? "";
    const addedBy = input.addedBy ?? "operator";
    if (addedBy !== "operator" && addedBy !== "provider") {
      throw new ValidationError("Invalid source: addedBy must be 'operator' or 'provider'");
    }
    const contentHash = createHashSha256(content);
    const existing = this.db.get<SourceRow>(
      "SELECT * FROM sources WHERE url = ? OR content_hash = ? LIMIT 1;",
      [url, contentHash],
    );
    if (existing) return existing;

    const id = randomUUID();
    const ts = nowIso();
    this.db.run(
      `INSERT INTO sources (id, url, title, publisher, content, content_hash, added_by, retrieved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [id, url, input.title ?? "", input.publisher ?? "", content, contentHash, addedBy, ts, ts],
    );
    return this.db.get<SourceRow>("SELECT * FROM sources WHERE id = ?;", [id])!;
  }

  listSources(): SourceRow[] {
    return this.db.all<SourceRow>("SELECT * FROM sources ORDER BY created_at;");
  }

  linkEpisodeSource(episodeId: string, sourceId: string, role = "research"): void {
    this.requireEpisode(episodeId);
    if (!this.db.get("SELECT id FROM sources WHERE id = ?;", [sourceId])) {
      throw new NotFoundError("source", sourceId);
    }
    this.db.run(
      `INSERT INTO episode_sources (episode_id, source_id, role, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(episode_id, source_id) DO UPDATE SET role = excluded.role;`,
      [episodeId, sourceId, role, nowIso()],
    );
  }

  listEpisodeSources(episodeId: string): SourceRow[] {
    return this.db.all<SourceRow>(
      `SELECT s.* FROM sources s
        JOIN episode_sources es ON es.source_id = s.id
       WHERE es.episode_id = ?
       ORDER BY es.added_at;`,
      [episodeId],
    );
  }

  // ── Artifacts (CAS index — hashes only, never bytes) ───────────────────

  registerArtifact(input: RegisterArtifactInput): ArtifactRow {
    const hash = validate(Sha256Schema, input.hash, "artifact hash");
    const kind = validate(ArtifactKindSchema, input.kind, "artifact kind");
    if (!Number.isInteger(input.bytes) || input.bytes < 0) {
      throw new ValidationError("Invalid artifact: bytes must be a non-negative integer");
    }
    const meta = validate(ArtifactMetaSchema, input.meta ?? {}, "artifact meta");
    const existing = this.db.get<ArtifactRow>("SELECT * FROM artifacts WHERE hash = ?;", [hash]);
    if (existing) {
      if (existing.kind !== kind) {
        throw new ConflictError(
          `Artifact ${hash} already registered as '${existing.kind}', cannot re-register as '${kind}'`,
        );
      }
      return existing;
    }
    this.db.run(
      "INSERT INTO artifacts (hash, kind, bytes, meta, created_at) VALUES (?, ?, ?, ?, ?);",
      [hash, kind, input.bytes, JSON.stringify(meta), nowIso()],
    );
    return this.db.get<ArtifactRow>("SELECT * FROM artifacts WHERE hash = ?;", [hash])!;
  }

  getArtifact(hash: string): ArtifactRow | undefined {
    return this.db.get<ArtifactRow>("SELECT * FROM artifacts WHERE hash = ?;", [hash]);
  }

  artifactMeta(hash: string): unknown {
    const row = this.getArtifact(hash);
    if (!row) throw new NotFoundError("artifact", hash);
    return JSON.parse(row.meta);
  }

  // ── Scripts / scenes / claims ──────────────────────────────────────────

  createScript(input: CreateScriptInput): ScriptRow {
    this.requireEpisode(input.episodeId);
    validate(ScriptDocSchema, input.doc, "script document");
    const docHash = validate(Sha256Schema, input.docHash, "script doc hash");
    const artifact = this.getArtifact(docHash);
    if (!artifact) {
      throw new ValidationError(
        `Invalid script: docHash ${docHash} is not registered in artifacts — store the blob in CAS and register it first`,
      );
    }
    const status = validate(ScriptStatusSchema, input.status ?? "draft", "script status");
    const ts = nowIso();
    const id = randomUUID();
    const versionRow = this.db.get<{ next: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM scripts WHERE episode_id = ?;",
      [input.episodeId],
    );
    const version = versionRow?.next ?? 1;

    this.db.transaction(() => {
      if (status === "approved") {
        this.db.run(
          "UPDATE scripts SET status = 'superseded', updated_at = ? WHERE episode_id = ? AND status = 'approved';",
          [ts, input.episodeId],
        );
      }
      this.db.run(
        `INSERT INTO scripts (id, episode_id, version, status, doc_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [id, input.episodeId, version, status, docHash, ts, ts],
      );
    });
    return this.requireScript(id);
  }

  getScript(id: string): ScriptRow | undefined {
    return this.db.get<ScriptRow>("SELECT * FROM scripts WHERE id = ?;", [id]);
  }

  requireScript(id: string): ScriptRow {
    const row = this.getScript(id);
    if (!row) throw new NotFoundError("script", id);
    return row;
  }

  listScripts(episodeId: string): ScriptRow[] {
    return this.db.all<ScriptRow>("SELECT * FROM scripts WHERE episode_id = ? ORDER BY version;", [
      episodeId,
    ]);
  }

  latestScript(episodeId: string): ScriptRow | undefined {
    return this.db.get<ScriptRow>(
      "SELECT * FROM scripts WHERE episode_id = ? ORDER BY version DESC LIMIT 1;",
      [episodeId],
    );
  }

  setScriptStatus(id: string, status: ScriptStatus): ScriptRow {
    this.requireScript(id);
    const next = validate(ScriptStatusSchema, status, "script status");
    this.db.run("UPDATE scripts SET status = ?, updated_at = ? WHERE id = ?;", [
      next,
      nowIso(),
      id,
    ]);
    return this.requireScript(id);
  }

  /** Replace a script version's scene graph (idempotent re-plan). */
  replaceScenes(scriptId: string, scenes: readonly SceneInput[]): SceneRow[] {
    const script = this.requireScript(scriptId);
    const ts = nowIso();
    this.db.transaction(() => {
      this.db.run("DELETE FROM scenes WHERE script_id = ?;", [scriptId]);
      scenes.forEach((scene, idx) => {
        const kind = validate(SceneKindSchema, scene.kind, "scene kind");
        if (!(scene.durationSec > 0))
          throw new ValidationError("Invalid scene: durationSec must be > 0");
        const data = validate(SceneDataSchema, scene.data ?? {}, "scene data");
        this.db.run(
          `INSERT INTO scenes (id, script_id, episode_id, idx, kind, section_id, sentence_id, start_sec, duration_sec, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            randomUUID(),
            scriptId,
            script.episode_id,
            idx,
            kind,
            scene.sectionId ?? "",
            scene.sentenceId ?? "",
            scene.startSec ?? 0,
            scene.durationSec,
            JSON.stringify(data),
            ts,
          ],
        );
      });
    });
    return this.listScenes(scriptId);
  }

  listScenes(scriptId: string): SceneRow[] {
    return this.db.all<SceneRow>("SELECT * FROM scenes WHERE script_id = ? ORDER BY idx;", [
      scriptId,
    ]);
  }

  /** Replace a script version's claims + evidence (fact-check is deterministic, re-runnable). */
  replaceClaims(scriptId: string, claims: readonly ClaimInput[]): ClaimRow[] {
    const script = this.requireScript(scriptId);
    const ts = nowIso();
    this.db.transaction(() => {
      this.db.run("DELETE FROM claims WHERE script_id = ?;", [scriptId]);
      for (const claim of claims) {
        if (!claim.claimRef?.trim())
          throw new ValidationError("Invalid claim: claimRef is required");
        if (!claim.text?.trim()) throw new ValidationError("Invalid claim: text is required");
        if (!claim.sentenceId?.trim())
          throw new ValidationError("Invalid claim: sentenceId is required");
        const status = validate(ClaimStatusSchema, claim.status ?? "unverified", "claim status");
        const score = claim.score ?? 0;
        if (score < 0 || score > 1)
          throw new ValidationError("Invalid claim: score must be within [0, 1]");
        const id = randomUUID();
        this.db.run(
          `INSERT INTO claims (id, episode_id, script_id, claim_ref, sentence_id, text, status, score, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            id,
            script.episode_id,
            scriptId,
            claim.claimRef,
            claim.sentenceId,
            claim.text,
            status,
            score,
            ts,
            ts,
          ],
        );
        for (const evidence of claim.evidence ?? []) {
          if (!this.db.get("SELECT id FROM sources WHERE id = ?;", [evidence.sourceId])) {
            throw new NotFoundError("source", evidence.sourceId);
          }
          this.db.run(
            "INSERT INTO claim_evidence (claim_id, source_id, excerpt, locator, score) VALUES (?, ?, ?, ?, ?);",
            [
              id,
              evidence.sourceId,
              evidence.excerpt ?? "",
              evidence.locator ?? "",
              evidence.score ?? 0,
            ],
          );
        }
      }
    });
    return this.listClaims(scriptId);
  }

  listClaims(scriptId: string): ClaimRow[] {
    return this.db.all<ClaimRow>("SELECT * FROM claims WHERE script_id = ? ORDER BY claim_ref;", [
      scriptId,
    ]);
  }

  /** Evidence rows always name a source — the traceability guarantee (§6.4). */
  listClaimEvidence(claimId: string): (ClaimEvidenceRow & { url: string; title: string })[] {
    return this.db.all<ClaimEvidenceRow & { url: string; title: string }>(
      `SELECT ce.claim_id, ce.source_id, ce.excerpt, ce.locator, ce.score, s.url, s.title
         FROM claim_evidence ce JOIN sources s ON s.id = ce.source_id
        WHERE ce.claim_id = ?;`,
      [claimId],
    );
  }

  setClaimStatus(claimId: string, status: ClaimStatus, score?: number): ClaimRow {
    const next = validate(ClaimStatusSchema, status, "claim status");
    const existing = this.db.get<ClaimRow>("SELECT * FROM claims WHERE id = ?;", [claimId]);
    if (!existing) throw new NotFoundError("claim", claimId);
    if (score !== undefined && (score < 0 || score > 1)) {
      throw new ValidationError("Invalid claim score: must be within [0, 1]");
    }
    this.db.run("UPDATE claims SET status = ?, score = ?, updated_at = ? WHERE id = ?;", [
      next,
      score ?? existing.score,
      nowIso(),
      claimId,
    ]);
    return this.db.get<ClaimRow>("SELECT * FROM claims WHERE id = ?;", [claimId])!;
  }

  // ── Media assets (provenance is mandatory: AD-09) ───────────────────────

  registerMediaAsset(input: RegisterMediaAssetInput): MediaAssetRow {
    const hash = validate(Sha256Schema, input.hash, "media hash");
    const kind = validate(MediaKindSchema, input.kind, "media kind");
    const license = input.license?.trim();
    if (!license)
      throw new ValidationError(
        "Invalid media asset: license is required (no provenance, no bytes)",
      );
    if (!this.getArtifact(hash)) {
      throw new ValidationError(`Invalid media asset: hash ${hash} is not registered in artifacts`);
    }
    if (input.projectId && !this.getProject(input.projectId)) {
      throw new NotFoundError("project", input.projectId);
    }
    this.db.run(
      `INSERT INTO media_assets (hash, project_id, kind, license, license_url, source_uri, attribution, ai_generated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         license = excluded.license,
         license_url = excluded.license_url,
         attribution = excluded.attribution,
         ai_generated = excluded.ai_generated;`,
      [
        hash,
        input.projectId ?? null,
        kind,
        license,
        input.licenseUrl ?? "",
        input.sourceUri ?? "",
        input.attribution ?? "",
        bool(input.aiGenerated ?? false),
        nowIso(),
      ],
    );
    return this.db.get<MediaAssetRow>("SELECT * FROM media_assets WHERE hash = ?;", [hash])!;
  }

  listMediaAssets(): MediaAssetRow[] {
    return this.db.all<MediaAssetRow>("SELECT * FROM media_assets ORDER BY created_at;");
  }

  // ── Pipeline jobs (resumable, lease-based; AD-05) ──────────────────────

  createJob(input: CreateJobInput): { job: PipelineJobRow; steps: JobStepRow[] } {
    this.requireEpisode(input.episodeId);
    const pipeline = validate(PipelineIdSchema, input.pipeline, "pipeline id");
    if (input.steps.length === 0)
      throw new ValidationError("Invalid job: at least one step is required");
    if (new Set(input.steps).size !== input.steps.length) {
      throw new ValidationError("Invalid job: step keys must be unique");
    }
    const id = randomUUID();
    const ts = nowIso();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO pipeline_jobs (id, episode_id, pipeline, state, waiting_gate, attempt, lease_owner, lease_expires_at, input_fingerprint, error, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', NULL, 0, NULL, NULL, NULL, NULL, ?, ?);`,
        [id, input.episodeId, pipeline, ts, ts],
      );
      input.steps.forEach((stepKey, idx) => {
        if (!stepKey.trim()) throw new ValidationError("Invalid job: step keys must be non-empty");
        this.db.run(
          "INSERT INTO pipeline_job_steps (job_id, step_key, idx, state) VALUES (?, ?, ?, 'PENDING');",
          [id, stepKey, idx],
        );
      });
    });
    return { job: this.requireJob(id), steps: this.listJobSteps(id) };
  }

  getJob(id: string): PipelineJobRow | undefined {
    return this.db.get<PipelineJobRow>("SELECT * FROM pipeline_jobs WHERE id = ?;", [id]);
  }

  requireJob(id: string): PipelineJobRow {
    const row = this.getJob(id);
    if (!row) throw new NotFoundError("pipeline job", id);
    return row;
  }

  listJobs(episodeId?: string): PipelineJobRow[] {
    return episodeId
      ? this.db.all<PipelineJobRow>(
          "SELECT * FROM pipeline_jobs WHERE episode_id = ? ORDER BY created_at;",
          [episodeId],
        )
      : this.db.all<PipelineJobRow>("SELECT * FROM pipeline_jobs ORDER BY created_at;");
  }

  listJobSteps(jobId: string): JobStepRow[] {
    return this.db.all<JobStepRow>(
      "SELECT * FROM pipeline_job_steps WHERE job_id = ? ORDER BY idx;",
      [jobId],
    );
  }

  getJobStep(jobId: string, stepKey: string): JobStepRow | undefined {
    return this.db.get<JobStepRow>(
      "SELECT * FROM pipeline_job_steps WHERE job_id = ? AND step_key = ?;",
      [jobId, stepKey],
    );
  }

  /**
   * Claim the oldest runnable job with an expiring lease. Crashed workers'
   * RUNNING jobs (expired or missing lease) become claimable again — that is
   * what makes the pipeline crash-resumable.
   */
  claimJob(input: ClaimJobInput): PipelineJobRow | undefined {
    if (!input.owner?.trim()) throw new ValidationError("Invalid claim: owner is required");
    if (!(input.leaseMs > 0)) throw new ValidationError("Invalid claim: leaseMs must be > 0");
    const now = nowIso();
    const expires = new Date(Date.now() + input.leaseMs).toISOString();
    return this.db.transaction(() => {
      const candidate = this.db.get<PipelineJobRow>(
        `SELECT * FROM pipeline_jobs
          WHERE state = 'PENDING'
             OR (state = 'RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
          ORDER BY created_at, rowid
          LIMIT 1;`,
        [now],
      );
      if (!candidate) return undefined;
      this.db.run(
        `UPDATE pipeline_jobs
            SET state = 'RUNNING', lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1, updated_at = ?
          WHERE id = ?;`,
        [input.owner, expires, now, candidate.id],
      );
      return this.requireJob(candidate.id);
    });
  }

  renewLease(jobId: string, owner: string, leaseMs: number): PipelineJobRow {
    const job = this.requireJob(jobId);
    if (job.lease_owner !== owner) {
      throw new ConflictError(
        `Job ${jobId} is leased to '${job.lease_owner ?? "nobody"}', not '${owner}'`,
      );
    }
    this.db.run("UPDATE pipeline_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?;", [
      new Date(Date.now() + leaseMs).toISOString(),
      nowIso(),
      jobId,
    ]);
    return this.requireJob(jobId);
  }

  setJobState(
    id: string,
    state: JobState,
    options: { error?: string | null; gate?: string | null } = {},
  ): PipelineJobRow {
    this.requireJob(id);
    const next = validate(JobStateSchema, state, "job state");
    const clearLease =
      next === "DONE" || next === "FAILED" || next === "CANCELED" || next === "WAITING_GATE";
    this.db.run(
      `UPDATE pipeline_jobs
          SET state = ?, waiting_gate = ?, error = ?, updated_at = ?
              ${clearLease ? ", lease_owner = NULL, lease_expires_at = NULL" : ""}
        WHERE id = ?;`,
      [next, options.gate ?? null, options.error ?? null, nowIso(), id],
    );
    return this.requireJob(id);
  }

  startStep(jobId: string, stepKey: string): JobStepRow {
    this.requireJob(jobId);
    const step = this.getJobStep(jobId, stepKey);
    if (!step) throw new NotFoundError("job step", `${jobId}/${stepKey}`);
    this.db.run(
      "UPDATE pipeline_job_steps SET state = 'PENDING', attempt = attempt + 1, started_at = ?, error = NULL WHERE job_id = ? AND step_key = ?;",
      [nowIso(), jobId, stepKey],
    );
    return this.getJobStep(jobId, stepKey)!;
  }

  /** Checkpoint a step: DONE with the input hash that produced this output. */
  checkpointStep(
    jobId: string,
    stepKey: string,
    input: { inputHash?: string; output?: unknown },
  ): JobStepRow {
    this.requireJob(jobId);
    if (!this.getJobStep(jobId, stepKey))
      throw new NotFoundError("job step", `${jobId}/${stepKey}`);
    this.db.run(
      `UPDATE pipeline_job_steps
          SET state = 'DONE', input_hash = ?, output = ?, finished_at = ?, error = NULL
        WHERE job_id = ? AND step_key = ?;`,
      [
        input.inputHash ?? null,
        input.output === undefined ? null : JSON.stringify(input.output),
        nowIso(),
        jobId,
        stepKey,
      ],
    );
    return this.getJobStep(jobId, stepKey)!;
  }

  failStep(jobId: string, stepKey: string, error: string): JobStepRow {
    this.requireJob(jobId);
    if (!this.getJobStep(jobId, stepKey))
      throw new NotFoundError("job step", `${jobId}/${stepKey}`);
    this.db.run(
      "UPDATE pipeline_job_steps SET state = 'FAILED', error = ?, finished_at = ? WHERE job_id = ? AND step_key = ?;",
      [error, nowIso(), jobId, stepKey],
    );
    return this.getJobStep(jobId, stepKey)!;
  }

  /** True when the step is DONE and was produced from exactly this input. */
  isStepSatisfied(jobId: string, stepKey: string, inputHash: string): boolean {
    const step = this.getJobStep(jobId, stepKey);
    return step?.state === "DONE" && step.input_hash === inputHash;
  }

  /** Drop checkpoints for a step and everything after it (content changed upstream). */
  invalidateFromStep(jobId: string, stepKey: string): JobStepRow[] {
    const steps = this.listJobSteps(jobId);
    const index = steps.findIndex((s) => s.step_key === stepKey);
    if (index < 0) throw new NotFoundError("job step", `${jobId}/${stepKey}`);
    this.db.transaction(() => {
      for (const step of steps.slice(index)) {
        this.db.run(
          "UPDATE pipeline_job_steps SET state = 'PENDING', input_hash = NULL, output = NULL, error = NULL, started_at = NULL, finished_at = NULL WHERE job_id = ? AND step_key = ?;",
          [jobId, step.step_key],
        );
      }
    });
    return this.listJobSteps(jobId);
  }

  // ── Approvals (bound to a fingerprint; AD-08) ───────────────────────────

  recordApproval(input: RecordApprovalInput): ApprovalRow {
    const subjectType = validate(
      ApprovalSubjectTypeSchema,
      input.subjectType,
      "approval subject type",
    );
    const decision = validate(ApprovalDecisionSchema, input.decision, "approval decision");
    if (!input.subjectId?.trim())
      throw new ValidationError("Invalid approval: subjectId is required");
    if (!input.gate?.trim()) throw new ValidationError("Invalid approval: gate is required");
    const id = randomUUID();
    this.db.run(
      `INSERT INTO approvals (id, subject_type, subject_id, gate, decision, fingerprint, notes, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        subjectType,
        input.subjectId,
        input.gate,
        decision,
        input.fingerprint ?? "",
        input.notes ?? "",
        input.reviewedBy ?? "operator",
        nowIso(),
      ],
    );
    this.appendAudit({
      action: `gate:${input.gate}:${decision}`,
      subjectType,
      subjectId: input.subjectId,
      detail: { fingerprint: input.fingerprint ?? "" },
    });
    return this.db.get<ApprovalRow>("SELECT * FROM approvals WHERE id = ?;", [id])!;
  }

  listApprovals(subjectId: string): ApprovalRow[] {
    return this.db.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE subject_id = ? ORDER BY reviewed_at DESC;",
      [subjectId],
    );
  }

  /**
   * The fingerprint of the latest approval for a subject, iff it still
   * matches the current content fingerprint. This is the guard against
   * "approved v3, published v4".
   */
  latestValidApproval(
    subjectType: ApprovalSubjectType,
    subjectId: string,
    currentFingerprint: string,
  ): ApprovalRow | undefined {
    return this.db.get<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE subject_type = ? AND subject_id = ? AND decision = 'approved' AND fingerprint = ?
        ORDER BY reviewed_at DESC LIMIT 1;`,
      [subjectType, subjectId, currentFingerprint],
    );
  }

  // ── Audit log (append-only) ─────────────────────────────────────────────

  appendAudit(input: AppendAuditInput): number {
    if (!input.action?.trim()) throw new ValidationError("Invalid audit entry: action is required");
    const result = this.db.run(
      `INSERT INTO audit_log (actor, action, subject_type, subject_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        input.actor ?? "system",
        input.action,
        input.subjectType ?? "",
        input.subjectId ?? "",
        JSON.stringify(input.detail ?? {}),
        nowIso(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  listAudit(limit = 100): AuditRow[] {
    return this.db.all<AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?;", [limit]);
  }

  // ── Providers (quota metering; secrets never stored; AD-06/AD-13) ───────

  upsertProviderAccount(input: UpsertProviderAccountInput): ProviderAccountRow {
    if (!input.adapter?.trim())
      throw new ValidationError("Invalid provider account: adapter is required");
    const scope = input.operationScope ?? "*";
    const credentialsEnv = input.credentialsEnv ?? "";
    if (credentialsEnv) {
      validate(EnvVarNameSchema, credentialsEnv, "credentials env-var name");
    }
    const quotaWindow = validate(QuotaWindowSchema, input.quotaWindow ?? "none", "quota window");
    if (input.quotaLimit !== undefined && input.quotaLimit < 0) {
      throw new ValidationError("Invalid provider account: quotaLimit must be >= 0");
    }
    const ts = nowIso();
    const existing = this.db.get<ProviderAccountRow>(
      "SELECT * FROM provider_accounts WHERE adapter = ? AND operation_scope = ?;",
      [input.adapter, scope],
    );
    if (existing) {
      this.db.run(
        `UPDATE provider_accounts
            SET credentials_env = ?, quota_window = ?, quota_limit = ?, enabled = ?, updated_at = ?
          WHERE id = ?;`,
        [
          credentialsEnv,
          quotaWindow,
          input.quotaLimit ?? null,
          bool(input.enabled ?? existing.enabled === 1),
          ts,
          existing.id,
        ],
      );
      return this.db.get<ProviderAccountRow>("SELECT * FROM provider_accounts WHERE id = ?;", [
        existing.id,
      ])!;
    }
    const id = randomUUID();
    this.db.run(
      `INSERT INTO provider_accounts (id, adapter, operation_scope, credentials_env, quota_window, quota_limit, quota_used, window_started_at, cooldown_until, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?);`,
      [
        id,
        input.adapter,
        scope,
        credentialsEnv,
        quotaWindow,
        input.quotaLimit ?? null,
        bool(input.enabled ?? true),
        ts,
        ts,
      ],
    );
    return this.db.get<ProviderAccountRow>("SELECT * FROM provider_accounts WHERE id = ?;", [id])!;
  }

  listProviderAccounts(): ProviderAccountRow[] {
    return this.db.all<ProviderAccountRow>("SELECT * FROM provider_accounts ORDER BY adapter;");
  }

  logProviderCall(input: LogProviderCallInput): number {
    if (!input.provider?.trim())
      throw new ValidationError("Invalid provider call: provider is required");
    if (!input.operation?.trim())
      throw new ValidationError("Invalid provider call: operation is required");
    const status = validate(ProviderCallStatusSchema, input.status ?? "ok", "provider call status");
    const result = this.db.run(
      `INSERT INTO provider_call_log (account_id, provider, operation, units, duration_ms, status, error, cache_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.accountId ?? null,
        input.provider,
        input.operation,
        input.units ?? 0,
        Math.round(input.durationMs ?? 0),
        status,
        input.error ?? null,
        input.cacheKey ?? null,
        nowIso(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  /** Units consumed per provider since a timestamp — the budget guard's input. */
  providerUsageSince(sinceIso: string): { provider: string; units: number; calls: number }[] {
    return this.db.all<{ provider: string; units: number; calls: number }>(
      `SELECT provider, SUM(units) AS units, COUNT(*) AS calls
         FROM provider_call_log
        WHERE created_at >= ?
        GROUP BY provider
        ORDER BY provider;`,
      [sinceIso],
    );
  }

  listProviderCalls(limit = 100): ProviderCallRow[] {
    return this.db.all<ProviderCallRow>(
      "SELECT * FROM provider_call_log ORDER BY id DESC LIMIT ?;",
      [limit],
    );
  }

  // ── Escape hatch for read-only diagnostics ──────────────────────────────

  raw<T = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): T[] {
    if (!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
      throw new ValidationError(
        "repo.raw() is read-only: only SELECT/PRAGMA/WITH statements are allowed",
      );
    }
    return this.db.all<T>(sql, params);
  }
}
