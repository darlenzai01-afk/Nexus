# Domain Model & Persistence Foundation (Phase 2)

Status: **implemented** in `packages/db` (migrations + repo) and
`packages/storage` (CAS). Governing decisions: AD-04 (SQLite is the system of
record), AD-05 (DB-backed resumable jobs), AD-08 (fingerprinted approvals),
AD-09 (content-addressed artifacts + provenance), AD-12 (no secrets in the DB).

---

## 1. Why these entities, and nothing more

Phase 2 asked for the minimum viable structures for: Project, Episode,
PipelineJob, JobState, Artifact, Source, Claim, Script, Scene, MediaAsset,
and provider metadata. The schema is exactly that set — **16 tables, no
speculative tables**. Two of the requested concepts are represented as
_attributes_, not tables, because a table would add a join and no capability:

| Asked for         | Where it lives                                        | Why not a table                                                                                                                               |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Project           | `projects`                                            | —                                                                                                                                             |
| Episode           | `episodes` (kind `long`/`short`, `parent_episode_id`) | Shorts are the same aggregate with a parent link (AD-10); a separate `shorts` table would duplicate every job/approval/artifact relationship. |
| PipelineJob       | `pipeline_jobs` + `pipeline_job_steps`                | Steps are the unit of resumability, so they must be rows (AD-05); the job itself is one row.                                                  |
| JobState          | CHECK-constrained `pipeline_jobs.state` (+ zod enum)  | Enum-as-data-attribute; the state machine is code, the value is data.                                                                         |
| Artifact          | `artifacts` (hash, kind, bytes, meta)                 | Metadata only — bytes live in CAS.                                                                                                            |
| Source            | `sources` + `episode_sources`                         | Sources are shared across episodes; the link table carries the relationship.                                                                  |
| Claim             | `claims` + `claim_evidence`                           | Evidence is M:N claim↔source with excerpt + locator (traceability is a schema guarantee, §6.4).                                               |
| Script            | `scripts` (versioned per episode, `doc_hash` → CAS)   | The document body is an artifact; the row carries version/status.                                                                             |
| Scene             | `scenes` (ordered rows per script version)            | Queryable per scene (re-render only what changed); payload as validated JSON.                                                                 |
| MediaAsset        | `media_assets` (hash PK → `artifacts`)                | License/provenance/attribution are mandatory columns (AD-09).                                                                                 |
| Provider metadata | `provider_accounts` + `provider_call_log`             | Quota windows + per-call metering (AD-13). `credentials_env` stores the **env var NAME**, never a secret (AD-12).                             |

Deliberately **not** created (no current consumer): topics, tags, playlists,
notifications, users/roles (single-operator system, AD-12), a `render_variants`
table (variant is a column on the artifact's `meta` until a real query needs
it), and any table for "AI cost forecasts".

## 2. Conventions

- **Stable IDs**: TEXT uuid v4, generated in the repo layer (`randomUUID()`),
  never autoincrement — a job/artifact id must be safe to log, cache and
  reference from another machine. `audit_log` and `provider_call_log` are the
  deliberate exceptions: append-only logs keyed by `INTEGER PRIMARY KEY`
  (order matters, no cross-machine references).
- **Timestamps**: TEXT ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`), written by
  the repo layer. Human-readable in a DB browser, correctly sortable, portable
  to Postgres.
- **Enums twice**: zod (`packages/db/src/types.ts`) for good error messages
  before SQL, CHECK constraints for raw-write safety. `schema.test.ts` asserts
  the DB rejects invalid values.
- **Money/scores**: REAL confined to `[0,1]` by CHECK (claim scores, evidence
  scores).
- **No blobs**: `artifacts` has no content column; `media_assets` has no
  bytes. Verified by test.

## 3. Artifacts without blobs (AD-09)

```
bytes ──put()──▶ CAS  <root>/<sha256[0:2]>/<sha256>        (packages/storage)
                    ▲
hash ───────────────┘  artifacts(hash PK, kind, bytes, meta)   ← DB index
                       media_assets(hash FK, license, …)        ← provenance
                       scripts.doc_hash / scenes / jobs reference hashes only
```

- Writes are temp-file + `rename`, so a partially-written blob never becomes
  visible under its final hash.
- `registerArtifact` refuses to re-register a hash under a different `kind`
  (a hash identifies one content; mislabelling is a bug, not a reclassification).
- `registerMediaAsset` refuses assets whose hash is not registered and refuses
  assets without a license (no provenance, no bytes).
- Trade-off: hashes are meaningless without the store, so **backup = copy the
  DB and the CAS directory together**; a future cloud backend only has to
  satisfy the `BlobStore` interface.

## 4. Resumable jobs (AD-05)

- `pipeline_jobs.state ∈ {PENDING, RUNNING, WAITING_GATE, DONE, FAILED, CANCELED}`
  with `lease_owner` / `lease_expires_at`. `claimJob()` runs inside
  `BEGIN IMMEDIATE`, picks the oldest PENDING job (or RUNNING with an expired
  lease) and stamps the lease — crashed workers' jobs are reclaimable, and two
  workers can never hold one job.
- `pipeline_job_steps` has `UNIQUE(job_id, idx)` **and** `UNIQUE(job_id,
step_key)`: order is data, duplicates are impossible.
- A step is skippable when `state = 'DONE'` and `input_hash` equals the hash of
  its computed inputs (upstream outputs chained). `isStepSatisfied()` is that
  predicate; `invalidateFromStep()` resets a step and all downstream steps when
  upstream content changes (edit one sentence → re-render from that step only).
- Leaving `RUNNING` (DONE/FAILED/CANCELED/WAITING_GATE) clears the lease, so a
  parked gate never looks like a stuck worker.
- `pipeline` ids are versioned strings validated by shape
  (`^[a-z0-9_]+_v\d+$`, e.g. `longform_v1`) — shipping `longform_v2` later is a
  code deploy, not a migration.

## 5. Approvals bind to fingerprints (AD-08)

`approvals(subject_type, subject_id, gate, decision, fingerprint, reviewed_by,
reviewed_at)`. `latestValidApproval(subject, currentFingerprint)` returns a row
**only if the approved fingerprint still matches current content** — the guard
against "approved v3, published v4". Every approval also appends an
`audit_log` row in the same call.

## 6. Migrations: versioned, append-only, guarded

- `MIGRATIONS` is an ordered array of `{ id: "0001_domain_foundation", sql }`.
- `migrate(db)` creates `_migrations(id, sql_hash, applied_at)`, applies pending
  migrations in one transaction, and is idempotent.
- **Drift guard**: before applying anything it re-hashes every applied
  migration and throws `MigrationDriftError` if the SQL changed. Editing an
  applied migration is impossible by policy, and now impossible in practice —
  silent destructive drift is the failure mode this prevents.
- **No destructive paths exist**: no `DROP`, `TRUNCATE`, or `DELETE FROM` in
  any migration; enforced by a test. Schema evolution is additive new
  migrations only. There is no "reset" command in this codebase.
- SQLite specifics are confined here: WAL, `foreign_keys=ON`,
  `busy_timeout=5000`, `synchronous=NORMAL`. Every statement is portable enough
  for Postgres, should that day come.

## 7. What Phase 2 explicitly does not include

Research, scripting, TTS, rendering, shorts and publishing logic (Phases 3–5),
plus: no HTTP routes for these tables yet, no worker loop, no auth (single
operator, AD-12), no Litestream backup (Phase 3+, OD-4). The repo layer is the
only sanctioned write path; `repo.raw()` exists for read-only diagnostics and
rejects anything that is not `SELECT`/`PRAGMA`/`WITH`.
