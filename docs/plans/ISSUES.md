# NEXUS FORGE — Issue Tracker

Live log of **failed**, **pending**, and **unresolved** items encountered while
executing the phases. Maintained during work; a consolidated report is delivered
after the phases are complete (per operator instruction).

Legend: 🔴 failed/blocked · 🟡 pending (needs input/credentials/external) ·
🟠 unresolved risk · 🟢 resolved

Last updated: end of **Phase 5** (research engine).

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

## Phase 4 — status of the requested items

| Requested | Status | Notes |
|-----------|--------|-------|
| Interfaces/abstractions for AI/LLM, research, TTS, media, storage, publishing | 🟢 | `packages/providers`: six small interfaces (`LLMProvider`, `ResearchProvider`, `TTSProvider`, `MediaProvider`, `StorageProvider`, `PublishProvider`) with a shared `ProviderMeta` identity. No pipeline module imports a vendor SDK. |
| Dependency injection | 🟢 | `createProviders({config, storage, repo, logger, clock, cache, transport, env, policy})` returns the whole outside world; every adapter receives one `InvokeRuntime` (storage, clock, logger, env, credentials, invoke). Tests inject a memory CAS, a fixed clock, a memory cache and a stub transport. |
| Provider selection | 🟢 | `ProviderRegistry` + `NEXUS_*_PROVIDER` (`adapter[:variant]`); unknown adapter fails fast listing what is registered; per-call override for tests; `dryRunConfig()`/`DRY_RUN_ENV` implement the `--dry-run` selection (remote capabilities → fakes, storage stays local). The CLI flag itself is wired with the app (GAP-9). |
| Configuration | 🟢 | `@nexus/config` validates the whole surface (six selections + policy + LLM base URL/model) at startup; nonsense values are rejected (incl. non-http base URLs). |
| Timeout handling | 🟢 | Per-attempt deadline (`withDeadline`), abort-aware; timeout vs. operator cancel distinguished in the error type and the log row. |
| Retry handling | 🟢 | Bounded attempts with exponential backoff + jitter, `Retry-After` honoured, attempts >60s handed to the job scheduler instead of slept. |
| Quota / rate limit | 🟢 | `provider_accounts` + `provider_call_log` metering, `BudgetGuard` (fail closed at the cap, degrade at 90%, cooldowns), UTC window rollover that never erases usage, self-imposed token bucket. |
| Provider errors | 🟢 | One `ProviderError` hierarchy with a `retryable` classification and `classifyError`/`toJobError` bridge into the orchestration vocabulary; every failure is a classified error, never a bare `TypeError`. |
| Structured results | 🟢 | Every call returns `ProviderResult<T>` (`value`, `cached`, `attempts`, `durationMs`, `usage`); LLM output is zod-validated with a bounded repair retry (`ProviderContentError` when exhausted). |
| Deterministic mocks; suite runs without paid APIs or keys | 🟢 | Six `Fake*` adapters (real WAV/PNG bytes in the CAS, schema-valid LLM output, deterministic hashes) + `Manual*` fallbacks + `none`. `pnpm verify` needs no network: 21 files / 274 tests. |
| Not every real provider implemented | 🟢 | Only `openai-compatible` (covers any OpenAI-shaped endpoint by base URL) and `local` storage; research/TTS/media/publishing real adapters await the vendor decisions (OD-2/3/5/8). |
| No paid dependencies added | 🟢 | No new runtime dependencies at all: Node built-ins + the existing zod/workspace packages. |

## Phase 5 — status of the requested items

| Requested | Status | Notes |
|-----------|--------|-------|
| Input: a topic | 🟢 | `runResearch({topic, outline?, episodeId?, projectId?, operatorSources?}, {llm, research, clock})`; the `research` stage task takes the topic from the episode. |
| Output: a structured research package | 🟢 | One zod-validated document (`ResearchPackageSchema`, version 1) stored as a CAS artifact, registered as `kind: "document"` with `generatedBy` provenance. Package hash is fed downstream in the step output. |
| Research questions | 🟢 | `plan` step (AI): questions + search queries, deduplicated, capped; the planner's queries are used as-is (extra question-text query only as a fallback), so metered search calls stay minimal. |
| Sources | 🟢 | `discover`: provider search rows only, URL-validated (`assertPublicHttpUrl`) and canonicalised; operator-pasted sources are marked `operator_text`. |
| Source metadata | 🟢 | Canonical + original URL, domain, title, publisher/adapter, `publishedAt`, `retrievedAt`, content + sha256 + length, `retrieval` honesty tag, questions that surfaced it. |
| Relevant evidence | 🟢 | `extract` (AI) proposes; code verifies. Every excerpt is `source.content.slice(start, end)` with its locator — a model quote that cannot be located is dropped (`quote_not_found`). |
| Factual claims | 🟢 | One assertable statement per claim, canonical wording chosen deterministically from the merged variants. |
| Claim/source relationships | 🟢 | `claim.links[]` (source, evidence, stance `supports\|contradicts\|mentions`, model-reported strength, rationale) + derived `corroboration`. |
| Conflicting information | 🟢 | `conflicts[]` with both sides (`detectedBy: model` for claim-vs-claim, `evidence_stance` for a quote-verified refutation), `preserved: true`, both claims marked `contested`. Unverifiable refutations are dropped, never quoted. |
| Confidence / verification status | 🟢 | Deterministic `evaluate`: `status` (`supported`/`contradicted`/`unverified`/`unsupportable` — the same vocabulary as `claims.status`), `confidence` 0–1 from corroboration with caps for dispute/contested, `certainty`, `mayStateAsFact`, and the gate (`reviewRequired`, `blockingClaimIds`). |
| Provenance | 🟢 | Engine + schema version, adapters per capability, per-step trace (which used AI, which was code, calls, cache hits, units, outcome, notes), model + template version per AI step, `generatedBy` on evidence and on the artifact row. |
| Never invent sources | 🟢 | A source exists only because a provider row passed validation; refusals are recorded in `dropped[]`; an empty result parks the job at `MANUAL_INPUT` instead of filling the gap. |
| Never invent quotations | 🟢 | Quotes are located in the retrieved text and the stored excerpt is the source's own characters with offsets (tested by re-slicing every excerpt). |
| Never present uncertain claims as established facts | 🟢 | `mayStateAsFact` is true only for corroborated, uncontested claims; the package reports `reviewRequired` + `blockingClaimIds`, and an empty package can never look like a passed gate. |
| Preserve disagreement | 🟢 | Conflicts are never resolved: both sides are kept, both claims are `contested`/`disputed`, and confidence is capped rather than decided. |
| AI only where reasoning/synthesis is needed | 🟢 | Four AI steps (plan, extract, reconcile, conflicts); all parsing, validation, dedup, storage, scoring, status derivation and assembly are code. |
| Deterministic code for deterministic operations | 🟢 | URL canonicalisation/dedup (by canonical URL and by content hash), quote verification, claim merging, scoring, ids derived from content, schema validation on write and read. Same clock + same answers ⇒ byte-identical package (tested). |
| Testing with mock providers | 🟢 | 4 files / 42 tests, no network and no keys: successful research, empty result, malformed provider output, timeout, rate limit, conflicting sources, duplicate sources, invalid URLs — plus scoring, the stage inside `runJob`, and one run on the bundled `FakeResearchProvider`. |
| No script engine built | 🟢 | Nothing beyond the `research` stage: no script generation, no `claims` rows, no `fact_check` stage. |

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
| OD-13 | 🟡 | **`storage` has no `manual` adapter** (it is the one exemption from AD-06's "every interface ships a Manual fallback"). Rationale: a human cannot stand in for a disk, and the `local` adapter has no quota to exhaust, so there is no state to degrade *to*. The capability still has `none`/`fake`/**real** (`local`) and is the only one configured by default. Ratify, or ask for a manual storage stub that refuses with instructions. |
| OD-14 | 🟡 | **Only one real LLM adapter ships, and it is vendor-neutral by construction.** `openai-compatible` speaks the OpenAI chat-completions shape, so OpenRouter/Groq/Together/Ollama/llama.cpp are all one base URL away; AD-03's "no coupling to a single AI company" is satisfied by the interface plus the configuration, not by writing N vendor clients before a provider is chosen. Addresses OD-2/OD-3 without spending quota. |
| OD-15 | 🟡 | **Research claims are not written to the `claims` table.** That table is keyed by `script_id` + `sentence_id` (NOT NULL), so a pre-script claim has no row to live in; Phase 5 keeps claims inside the package artifact (CAS, `kind: 'document'`) and copies their sources into `sources`/`episode_sources`. Consequence: claim/evidence traceability is complete inside the artifact, and the `claims`/`claim_evidence` rows arrive with the script stage (each script sentence then references the package claims it came from). Ratify, or approve (a) nullable `script_id` on `claims` — a table rebuild, approval-gated like OD-10 — or (b) a new `research_claims` table. |
| OD-9  | 🟡 | **Persistence implementation deviates from AD-04's wording**: AD-04 named *Drizzle ORM*; Phase 2 implements plain SQL DDL + a hand-written migration runner + zod validation on `node:sqlite`. Rationale: zero native deps, full control of the drift guard, no codegen step, and the SQL stays Postgres-portable. Ratify (amend AD-04) or ask for Drizzle — porting is confined to `packages/db`. |

## Implementation gaps (deliberate, phase-appropriate)

| ID    | Status | Description |
|-------|--------|-------------|
| GAP-1 | 🟡 | No HTTP/API surface for the new tables yet (routes arrive in the phase that consumes them). Phase 2 is library + tests only. |
| GAP-2 | 🟢 | Job executor: **implemented in Phase 3** (`packages/jobs` — claim loop, stage runner, retries, gates, reuse; see `docs/architecture/job-orchestration.md`). Remaining: wiring it into `apps/nexus` with real tasks and DB/CAS paths (tracked as GAP-9). |
| GAP-3 | 🟢 | Episode transitions are now **enforced** by `packages/jobs/src/machines.ts` (`assertEpisodeTransition`, separate long/short tables) and applied only through the runner; `Repo.setEpisodeState` deliberately stays permissive so operators/repairs are not blocked by machine rules — legality is a pipeline-layer concern, as planned. A test asserts the stage graph and the episode machine cannot drift apart. |
| GAP-4 | 🟡 | `media_assets` supports `image`/`video`/`document` kinds. Phase 4 added the `MediaProvider` interface with a deterministic fake and a tested SSRF guard, but **no real acquisition adapter** — rows are still only insertable by the operator/API. Real adapters await the licence policy decision (OD-8) and the search provider (OD-5). |
| GAP-5 | 🟠 | No backup/DR wiring (Litestream → object storage) — AD-04 consequence, scheduled for the deployment phase (OD-4). Until then, backup = copy the DB file + the CAS directory together. |
| GAP-6 | 🟡 | ~~`provider_call_log` records usage but nothing enforces the quota yet.~~ **Phase 4 delivered the decision half**: `BudgetGuard` reads the accounts/log, fails closed at the cap, degrades a live adapter to `manual` at 90% and applies cooldowns; `invoke()` refuses, degrades or proceeds accordingly. Phase 3 gave tasks a parking mechanism (`{ waiting: "QUOTA" }` → job `WAITING_GATE`), so a task can already stop cleanly instead of failing; the budget guard that *decides* to park is wired when real providers are (AD-13). |
| GAP-7 | 🟡 | CAS garbage collection does not exist. Blobs are only added, never pruned. `CasStore.list()` was added in Phase 3 specifically so a reconciler can diff stored blobs against the `artifacts` table; the reconciler itself is not written. |
| GAP-8 | 🟡 | `job_logs` has no retention/compaction policy. Long-lived installations will accumulate rows; a pruning job (or a `logs_keep_days` setting) is needed before production. |
| GAP-9 | 🟡 | The app/worker entrypoints are **not yet wired** to the new orchestrator: `apps/nexus/src/worker.ts` still runs the Phase 1 heartbeat stub. Wiring is deliberately deferred to the phase that provides real tasks (a worker with zero registered tasks can only idle), together with `NEXUS_DB_PATH`/`NEXUS_CAS_DIR` config, the `--dry-run` CLI flag (the provider-side helper exists: `dryRunConfig`) and the job HTTP routes. |
| GAP-11 | 🟠 | **Media SSRF guard validates the URL, not the resolved address.** `assertPublicHttpUrl` refuses non-HTTP(S), credentialed URLs, localhost/`.local`, private/CGNAT/link-local/loopback IPv4 and IPv6 (including IPv4-mapped forms, after a real bypass was found and fixed) — but a *public* hostname that resolves to a private IP (DNS rebinding / internal resolver) is still reachable. Mitigation when a real media adapter lands: resolve first and pin the address (or run fetches through a proxy with an egress policy). No real fetcher exists yet, so nothing is exposed today. |
| GAP-12 | 🟡 | **Storage `list()` reads a directory, not the DB.** `LocalStorageProvider.list()` / `CasStore.list()` enumerate blobs on disk, which over-reports blobs that no `artifacts` row references (and cannot see rows whose bytes are gone). The reconciler that diffs the two is GAP-7; until then, treat `list()` as "bytes present", not "artifacts known". |
| GAP-13 | 🟡 | **Provider cache has no eviction.** `<dataDir>/cache/providers` grows with every distinct prompt/query; entries are content-addressed JSON and cheap, but an LRU/TTL sweep (or a `cache_keep_days` setting) is needed before a long-running deployment. Caught by: nothing yet — flagged proactively with the CAS GC work (GAP-7). |
| GAP-14 | 🟡 | **Metering is opt-in per adapter.** Adapters with no `provider_accounts` row are allowed without limits (deliberate: a local fake has no quota). A real provider therefore needs its account row seeded before its free tier is protected; the dashboard/CLI path that seeds accounts is not written yet. |
| GAP-15 | 🟠 | **Evidence is snippet-only.** There is no page-content fetch + HTML-extraction capability yet, so a source's quotable text is whatever the search provider returned (or what an operator pasted). The package records this per source (`retrieval: provider_snippet \| operator_text \| unavailable`), and a source with no text contributes no evidence — but the verification depth is limited by snippet length. Mitigation planned: a `fetch(url) → text` capability (behind the same provider interface, with the SSRF guard), added when a real research adapter lands. |
| GAP-16 | 🟡 | **The verification gate is reported, not enforced.** `verification.reviewRequired` / `blockingClaimIds` are computed and logged, but the `fact_check` stage that parks a job at `FACT_REVIEW` is not built (Phase 6+), and no HTTP surface exposes a package for review (GAP-1). Also: no *real* research adapter yet (`none`/`fake`/`manual` only), and no semantic re-check of a finished script's claims against the package. |
| GAP-10 | 🟢 | No duplicate-execution protection was needed at the DB level beyond the fingerprint checks and lease claiming; a partial unique index on `(input_hash, step_key)` for DONE steps was *considered and rejected* — legitimate re-runs (invalidation → re-execute → new checkpoint) and multi-job reuse both need more than one row per fingerprint, so uniqueness would break repairability. |

## Test / CI incidents

| ID    | Status | Description |
|-------|--------|-------------|
| CI-1  | 🟢 | `tsconfig.base.json` needed a wildcard path mapping (`@nexus/*`) for the new workspace packages; fixed in this phase. |
| CI-2  | 🟢 | A stray `require()` inside an ESM module (storage) and an invalid re-export line (db) were caught before the first build; both fixed. |
| CI-3  | 🟡 | `node:sqlite` prints an ExperimentalWarning into test output; cosmetic, not suppressed (suppressing warnings would hide real ones). |
| CI-4  | 🟢 | Phase 3 initially added `RUNNING` to the TypeScript `StepState` enum and wrote it to the DB — rejected by the shipped CHECK constraint at runtime. Resolved by deriving in-flight state instead (see OD-10); the enum and the SQL now agree, and a db test asserts the persisted set. |
| CI-6  | 🟢 | **SSRF guard bypass found by a test** (Phase 4): `new URL("http://[::ffff:169.254.169.254]/").hostname` normalises to the *hex* form `[::ffff:a9fe:a9fe]`, which the dotted-only IPv4-mapped check did not recognise — i.e. the cloud metadata endpoint was reachable. Fixed by decoding both mapped and IPv4-compatible hex pairs back to dotted quads; the bypass URL is now a regression test. Lesson: URL parsers rewrite host literals, so a guard must test the parsed form, not the input string. |
| CI-7  | 🟢 | **A quota counter counted its own probes** (Phase 4): `FakePublishProvider` derived "uploads today" from `providerUsageSince().calls`, so every `quota()` lookup consumed allowance. Fixed by counting only successful `publish.upload` rows in the call log; a test asserts probes and refused uploads do not count. |
| CI-8  | 🟢 | **A verification test exposed a fake announcing the wrong name** (Phase 4): the in-memory storage adapter defaulted its id to `"memory"` while registered as `"fake"`, which would have made metering and logs disagree with configuration. Fixed (the container passes the registration id); the shared contract suite now asserts every adapter's `id`/`kind`/`mode`/`label` match its descriptor. |
| CI-9  | 🟢 | **Credential echo** (Phase 4): a provider that repeats the API key in a response body leaked it into logs and `provider_call_log.error`. Fixed with `makeRedactor([...])` (patterns *plus* the actual credential values), applied to every error path; tested end to end with a container built from the real config. |
| CI-10 | 🟢 | **The engine spent metered searches it did not need to** (Phase 5): every question issued its declared queries *plus* the question text as a third query, so each question cost two search calls (and doubled duplicate-rejection rows). Caught by tests asserting drop counts. Fixed: the planner's queries are used as-is; the question text is only a fallback when a planner returns none. |
| CI-11 | 🟢 | **Provenance overstated AI usage** (Phase 5): `provenance.aiSteps` listed every step whose engine was `llm`, including a `reconcile`/`conflicts` step that was skipped because there was nothing to compare — i.e. the audit trail claimed a model call that never happened. Fixed: a step counts as an AI step only if it called a model or failed trying. |
| CI-12 | 🟢 | **An empty package passed the gate vacuously** (Phase 5): `reviewRequired` was derived from unsupported *claims*, so a run with zero claims (and zero sources) reported `reviewRequired: false` — the one case where the gate matters most. Fixed: a package with no claims always requires review. |
| CI-5  | 🟢 | `Worker.stop()` could wait forever for a task that ignores its abort signal (caught by a test that hung). Fixed with a bounded `stop({ timeoutMs })` plus a `worker.stop_timeout` warning; the job stays leased and recoverable. |
