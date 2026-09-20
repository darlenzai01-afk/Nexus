# NEXUS FORGE — Issue Tracker

Live log of **failed**, **pending**, and **unresolved** items encountered while
executing the phases. Maintained during work; a consolidated report is delivered
after the phases are complete (per operator instruction).

Legend: 🔴 failed/blocked · 🟡 pending (needs input/credentials/external) ·
🟠 unresolved risk · 🟢 resolved

Last updated: end of **Phase 3** (persistent job orchestration foundation).

---

## Environment & infrastructure

| ID    | Status | Description | Resolution / mitigation |
|-------|--------|-------------|-------------------------|
| ENV-1 | 🟢 | `apt-get install ffmpeg` failed — sandbox apt mirrors partially unreachable ("no installation candidate"). | Avoided; not needed for Phase 2. Do not retry apt. |
| ENV-2 | 🟢 | Binary downloads through the GitHub release-asset CDN are SSL-blocked in this sandbox (`johnvansickle.com` unreachable too). | Avoided. npm registry is reachable, so binaries will ship inside npm tarballs when needed (Phase 3). |
| ENV-3 | 🟢 | Media tooling availability for later phases (ffmpeg/ffprobe). | Verified working path: `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` npm packages (static binaries inside the tarball, executable in this sandbox). Will be added in Phase 3 with `NEXUS_FFMPEG_PATH`/`NEXUS_FFPROBE_PATH` overrides. |
| ENV-4 | 🟠 | `node:sqlite` is **experimental** in Node 22 (emits `ExperimentalWarning`; API may change in a future major). | Accepted deliberately (zero native build deps, synchronous API fits the single-writer design). Pinned `engines.node >= 22.12`. All SQLite coupling is isolated in `packages/db` (one file), so a swap to `better-sqlite3` or Postgres touches one package. Re-check on every Node major upgrade. |
| ENV-5 | 🟡 | Sandbox has 2 vCPU / 3.8 GB RAM — real video renders will be slow. | Not yet exercised (no rendering in Phase 2). Mitigation planned: draft-tier dimensions, final renders only after approval (AD-13). |
| ENV-6 | 🟡 | No `sqlite3`/`drizzle-kit` CLI available for ad-hoc DB inspection. | Not required: migrations are code (`migrate(db)`), inspection via `node --experimental-sqlite -e` or the repo layer. |
| ENV-7 | 🟡 | Tests that exercise the worker loop use real timers (poll/heartbeat/backoff). Kept fast by injecting sleeps/randomness and by manipulating `next_attempt_at`/`lease_expires_at` instead of sleeping; the full suite still runs in ~15s. | Accepted for now; if CI time grows, switch to fake timers per-test. |

## Phase 3 — status of the requested items

| Requested | Status | Notes |
|-----------|--------|-------|
| Job creation | 🟢 | `repo.createJob()` (validated pipeline id, ordered stages, retry ceiling) + idempotency key that collapses duplicate submissions onto one job. |
| Job status | 🟢 | `getJobStatus()` read model: stored state + derived `RETRYING`, attempts, backoff, gate, failure cause, per-stage labels, artifact refs, reuse provenance, log tail. HTTP route deferred to the pipeline phase. |
| State transitions | 🟢 | Three explicit machines (episode/job/stage) with `assert*` guards; a test asserts the stage graph is consistent with the episode machine. |
| Retry handling | 🟢 | Error taxonomy, exponential backoff w/ ceiling + jitter, persisted `next_attempt_at` (survives restart), per-stage or per-job attempt ceilings. |
| Failure states | 🟢 | `FAILED` + `error_kind` (`permanent`/`exhausted`), `CANCELED`, `WAITING_GATE`; episode moves to `FAILED`/`NEEDS_CHANGES` accordingly. |
| Resumability | 🟢 | Per-stage checkpoints keyed by fingerprint; crash = expired lease + `RUNNING` job; verified with a real file-backed DB across simulated process restarts. |
| Idempotency | 🟢 | Fingerprint-keyed stages (never executed twice for identical inputs), idempotency keys for jobs, content-addressed artifacts. |
| Artifact references | 🟢 | `pipeline_job_steps.artifacts` holds validated `{hash,kind,role}` refs; unregistered artifacts are refused; bytes stay in the CAS. |
| Job logs | 🟢 | Append-only `job_logs` (level/event/message/data/timestamp, cascade delete, `afterId`/`limit` queries). Retention not implemented. |
| Timestamps | 🟢 | ISO-8601 UTC: job created/updated, step started/finished, `heartbeat_at` (durable), `next_attempt_at`. |
| Worker/task abstraction | 🟢 | `Task` (pure stage work) + `TaskRegistry` (fail-fast coverage) + `Worker` (claim loop, heartbeats, bounded graceful stop, drain). App wiring waits for real tasks. |
| Completed-stage reuse | 🟢 | Cross-job/cross-episode adoption by fingerprint with provenance (`reused_from_*`), audit rows, and safety refusals when artifacts are missing. |

## Decisions taken under uncertainty (provisional — please ratify or reject)

| ID    | Status | Description |
|-------|--------|-------------|
| OD-1  | 🟡 | **Remotion license** unresolved (blocks the rendering approach). Provisional: own deterministic SVG→PNG→ffmpeg renderer (no license risk). No renderer is implemented yet in Phase 2; the scene-graph contract in the DB is renderer-agnostic. |
| OD-2  | 🟡 | **Primary TTS provider** unresolved (no credentials, and it is a budget decision for the operator). Not started (Phase 3). |
| OD-3  | 🟡 | **Primary LLM provider + pinned models** unresolved. Not started (Phase 3). |
| OD-5  | 🟡 | **Channel niche/topic domain** unknown — the decisions doc schedules this for Phase 2. It affects research source mix and media license policy (Phase 3), not the schema: `projects.config.allowedLicenses` is where the answer will land. |
| OD-8  | 🟡 | **AI-generated imagery policy** (Phase 3 decision). Schema already supports both paths via `media_assets.ai_generated` + `license`. |
| OD-10 | 🟡 | **Stage "RUNNING" is derived, not stored.** The requested long/short state lists include in-progress states, but the Phase 2 CHECK constraint on `pipeline_job_steps.state` allows only `PENDING/DONE/FAILED/WAITING` and SQLite cannot widen a CHECK without a table rebuild — which the safety rules forbid. Implementation: a stage is in flight when its job is `RUNNING` and the step has `started_at` but is not `DONE`; labels render as `RENDERING` vs `RENDERING_INTERRUPTED`. Ratify (keep derived) or approve a one-time table rebuild (create-copy-swap) in a later phase if a stored RUNNING proves necessary. |
| OD-11 | 🟡 | **Extra stages beyond the requested lists:** `fact_check` and `captions` are kept because the approved plan (§7.1) and AD-07 require them. If you prefer the literal requested lists, they can be folded into neighbours (fact-check into `research`, captions into `voice`) — confirm. |
| OD-12 | 🟡 | **Ad-hoc gates vs the plan's states:** plan §7.1 names optional gates `RESEARCH_REVIEW` / `SCRIPT_REVIEW` as episode states; only `FACT_REVIEW` exists in the Phase 2 episode enum. Implemented instead as *job-level* gates (`waiting_gate` + stage WAITING), which any task can request (`{ waiting: "FACT_REVIEW" }`) without a schema change. Ratify, or add the missing episode states in a future migration (needs the same table-rebuild approval as OD-10). |
| OD-9  | 🟡 | **Persistence implementation deviates from AD-04's wording**: AD-04 named *Drizzle ORM*; Phase 2 implements plain SQL DDL + a hand-written migration runner + zod validation on `node:sqlite`. Rationale: zero native deps, full control of the drift guard, no codegen step, and the SQL stays Postgres-portable. Ratify (amend AD-04) or ask for Drizzle — porting is confined to `packages/db`. |

## Implementation gaps (deliberate, phase-appropriate)

| ID    | Status | Description |
|-------|--------|-------------|
| GAP-1 | 🟡 | No HTTP/API surface for the new tables yet (routes arrive in the phase that consumes them). Phase 2 is library + tests only. |
| GAP-2 | 🟢 | Job executor: **implemented in Phase 3** (`packages/jobs` — claim loop, stage runner, retries, gates, reuse; see `docs/architecture/job-orchestration.md`). Remaining: wiring it into `apps/nexus` with real tasks and DB/CAS paths (tracked as GAP-9). |
| GAP-3 | 🟢 | Episode transitions are now **enforced** by `packages/jobs/src/machines.ts` (`assertEpisodeTransition`, separate long/short tables) and applied only through the runner; `Repo.setEpisodeState` deliberately stays permissive so operators/repairs are not blocked by machine rules — legality is a pipeline-layer concern, as planned. A test asserts the stage graph and the episode machine cannot drift apart. |
| GAP-4 | 🟡 | `media_assets` supports `image`/`video`/`document` kinds, but no acquisition adapters exist yet — rows are only insertable by the operator/API (Phase 3). |
| GAP-5 | 🟠 | No backup/DR wiring (Litestream → object storage) — AD-04 consequence, scheduled for the deployment phase (OD-4). Until then, backup = copy the DB file + the CAS directory together. |
| GAP-6 | 🟡 | `provider_call_log` records usage but nothing enforces the quota yet. Phase 3 gave tasks a parking mechanism (`{ waiting: "QUOTA" }` → job `WAITING_GATE`), so a task can already stop cleanly instead of failing; the budget guard that *decides* to park is wired when real providers are (AD-13). |
| GAP-7 | 🟡 | CAS garbage collection does not exist. Blobs are only added, never pruned. `CasStore.list()` was added in Phase 3 specifically so a reconciler can diff stored blobs against the `artifacts` table; the reconciler itself is not written. |
| GAP-8 | 🟡 | `job_logs` has no retention/compaction policy. Long-lived installations will accumulate rows; a pruning job (or a `logs_keep_days` setting) is needed before production. |
| GAP-9 | 🟡 | The app/worker entrypoints are **not yet wired** to the new orchestrator: `apps/nexus/src/worker.ts` still runs the Phase 1 heartbeat stub. Wiring is deliberately deferred to the phase that provides real tasks (a worker with zero registered tasks can only idle), together with `NEXUS_DB_PATH`/`NEXUS_CAS_DIR` config and the job HTTP routes. |
| GAP-10 | 🟢 | No duplicate-execution protection was needed at the DB level beyond the fingerprint checks and lease claiming; a partial unique index on `(input_hash, step_key)` for DONE steps was *considered and rejected* — legitimate re-runs (invalidation → re-execute → new checkpoint) and multi-job reuse both need more than one row per fingerprint, so uniqueness would break repairability. |

## Test / CI incidents

| ID    | Status | Description |
|-------|--------|-------------|
| CI-1  | 🟢 | `tsconfig.base.json` needed a wildcard path mapping (`@nexus/*`) for the new workspace packages; fixed in this phase. |
| CI-2  | 🟢 | A stray `require()` inside an ESM module (storage) and an invalid re-export line (db) were caught before the first build; both fixed. |
| CI-3  | 🟡 | `node:sqlite` prints an ExperimentalWarning into test output; cosmetic, not suppressed (suppressing warnings would hide real ones). |
| CI-4  | 🟢 | Phase 3 initially added `RUNNING` to the TypeScript `StepState` enum and wrote it to the DB — rejected by the shipped CHECK constraint at runtime. Resolved by deriving in-flight state instead (see OD-10); the enum and the SQL now agree, and a db test asserts the persisted set. |
| CI-5  | 🟢 | `Worker.stop()` could wait forever for a task that ignores its abort signal (caught by a test that hung). Fixed with a bounded `stop({ timeoutMs })` plus a `worker.stop_timeout` warning; the job stays leased and recoverable. |
