# NEXUS FORGE — Issue Tracker

Live log of **failed**, **pending**, and **unresolved** items encountered while
executing the phases. Maintained during work; a consolidated report is delivered
after the phases are complete (per operator instruction).

Legend: 🔴 failed/blocked · 🟡 pending (needs input/credentials/external) ·
🟠 unresolved risk · 🟢 resolved

Last updated: end of **Phase 2** (domain schemas + database foundation).

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

## Decisions taken under uncertainty (provisional — please ratify or reject)

| ID    | Status | Description |
|-------|--------|-------------|
| OD-1  | 🟡 | **Remotion license** unresolved (blocks the rendering approach). Provisional: own deterministic SVG→PNG→ffmpeg renderer (no license risk). No renderer is implemented yet in Phase 2; the scene-graph contract in the DB is renderer-agnostic. |
| OD-2  | 🟡 | **Primary TTS provider** unresolved (no credentials, and it is a budget decision for the operator). Not started (Phase 3). |
| OD-3  | 🟡 | **Primary LLM provider + pinned models** unresolved. Not started (Phase 3). |
| OD-5  | 🟡 | **Channel niche/topic domain** unknown — the decisions doc schedules this for Phase 2. It affects research source mix and media license policy (Phase 3), not the schema: `projects.config.allowedLicenses` is where the answer will land. |
| OD-8  | 🟡 | **AI-generated imagery policy** (Phase 3 decision). Schema already supports both paths via `media_assets.ai_generated` + `license`. |
| OD-9  | 🟡 | **Persistence implementation deviates from AD-04's wording**: AD-04 named *Drizzle ORM*; Phase 2 implements plain SQL DDL + a hand-written migration runner + zod validation on `node:sqlite`. Rationale: zero native deps, full control of the drift guard, no codegen step, and the SQL stays Postgres-portable. Ratify (amend AD-04) or ask for Drizzle — porting is confined to `packages/db`. |

## Implementation gaps (deliberate, phase-appropriate)

| ID    | Status | Description |
|-------|--------|-------------|
| GAP-1 | 🟡 | No HTTP/API surface for the new tables yet (routes arrive in the phase that consumes them). Phase 2 is library + tests only. |
| GAP-2 | 🟡 | No worker loop / job executor yet: the *schema and repo primitives* for resumable jobs exist and are tested (claim, lease, checkpoint, invalidate), but nothing drains the queue until Phase 3. |
| GAP-3 | 🟡 | Episode state transitions are **validated but not enforced as a state machine** (any documented state can follow any other). Transition legality belongs to the pipeline layer (Phase 3) where the steps that cause transitions live. |
| GAP-4 | 🟡 | `media_assets` supports `image`/`video`/`document` kinds, but no acquisition adapters exist yet — rows are only insertable by the operator/API (Phase 3). |
| GAP-5 | 🟠 | No backup/DR wiring (Litestream → object storage) — AD-04 consequence, scheduled for the deployment phase (OD-4). Until then, backup = copy the DB file + the CAS directory together. |
| GAP-6 | 🟡 | `provider_call_log` records usage but nothing enforces the quota yet (budget guard is Phase 3, when real providers are wired). |
| GAP-7 | 🟡 | CAS garbage collection does not exist. Blobs are only added, never pruned; orphan detection will be needed once re-renders start replacing artifacts. |

## Test / CI incidents

| ID    | Status | Description |
|-------|--------|-------------|
| CI-1  | 🟢 | `tsconfig.base.json` needed a wildcard path mapping (`@nexus/*`) for the new workspace packages; fixed in this phase. |
| CI-2  | 🟢 | A stray `require()` inside an ESM module (storage) and an invalid re-export line (db) were caught before the first build; both fixed. |
| CI-3  | 🟡 | `node:sqlite` prints an ExperimentalWarning into test output; cosmetic, not suppressed (suppressing warnings would hide real ones). |
