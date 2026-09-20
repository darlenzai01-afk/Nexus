# NEXUS FORGE — Architecture Discovery (000)

**Status:** Planning only — no implementation code exists or should exist yet.
**Author:** Principal Software Architect (discovery session)
**Date:** 2026-09-20
**Companion doc:** [000-decisions.md](./000-decisions.md)

---

## 1. Executive Summary

Nexus Forge aims to be a cloud-first, ~$0-infrastructure automated YouTube
production system: topic → research → fact-check → script → scenes → media →
characters/animation → voice → captions → render → QA → human approval →
publish, plus a long-form → Shorts repurposing pipeline.

**The proposed component list is directionally correct but is a trap if taken
literally as ~18 services.** The single most important architectural decision
in this document is:

> **Build a modular monolith in one repository with one deployable application
> (plus an optional worker entrypoint), not a fleet of microservices.**
> Modularity lives in *packages and interfaces*, not in *network boundaries*.

Key recommendations:

1. **One TypeScript monorepo** (pnpm workspaces): `app` (dashboard + API +
   orchestrator) and `worker` share the same codebase and are two entrypoints,
   not two systems. Domain logic lives in independent packages
   (`research`, `script`, `scene`, `media`, `voice`, `caption`, `render`,
   `shorts`, `publish`, `qa`, `providers`, `db`, `jobs`, `storage`).
2. **Code-driven composition/rendering** (Remotion or an equivalent
   HTML/Canvas-to-frames renderer) + FFmpeg for muxing/encoding. This is the
   linchpin: because video is *generated from a scene graph in code*, the
   Shorts 9:16 re-layout becomes a deterministic re-render, not fragile AI
   auto-reframing of a finished video. It also makes captions, diagrams, and
   character placement ordinary software problems.
3. **SQLite (WAL) as the system of record** for jobs, state, claims, licenses,
   and approvals; **content-addressed artifact storage** on local disk behind
   an S3-compatible storage interface (Cloudflare R2 free tier when cloud
   storage is needed). Postgres is a later migration, not a day-one need.
4. **A durable, checkpointed job state machine in the database** — every
   pipeline is a DAG of idempotent steps; each step records input hashes and
   output artifact IDs; resume = skip completed steps. No Kafka, no Redis, no
   external broker at this scale.
5. **Strict provider abstraction**: every external dependency (LLM, TTS,
   transcription, search, image/video sources, storage, runner) sits behind a
   small interface with a fake/mock implementation used in tests and a
   "manual" implementation used when free tiers run dry.
6. **AI only where language/semantic judgment is required** (research
   synthesis, scriptwriting, fact-check assistance, short-moment scoring).
   Everything deterministic — caption timing, layout, transitions, rendering,
   loudness normalization, packaging, publishing — is ordinary code.
7. **Human approval is a first-class state**, not an afterthought. Nothing
   reaches YouTube without an explicit, audited approval record.
8. **Biggest external risks** (detailed in §18): YouTube Data API upload
   restrictions for un-audited projects, TTS quality-vs-cost on free tiers,
   render compute on $0 infrastructure, and Remotion's licensing terms for
   commercial use.

**Phasing:** do not build the whole pipeline. Phase 1 proves the hardest,
highest-risk loop — *script → scene plan → voice → captions → render one
minute of video locally* — with mocked research and manual media. Publishing
automation comes last, after the YouTube API audit risk is resolved.

---

## 2. Repository & Environment Findings

### 2.1 Repository state

- Repo `darlenzai01-afk/Nexus` is **effectively empty**: one initial commit,
  a 3-line `README.md` (`# Nexus`). No code, no CI, no package manifests.
- `origin` remote is already configured to the GitHub URL.
- Clean slate: no legacy constraints, no migration burden.

### 2.2 Available development environment (this sandbox)

| Resource        | Finding                                  | Implication |
|-----------------|------------------------------------------|-------------|
| Node.js         | v22 (LTS)                                | Primary runtime; modern, fine for Remotion/FFmpeg tooling. |
| Python          | 3.11                                     | Available for whisper/ML tooling if needed. |
| FFmpeg          | **Not installed**                        | Must be installed per environment (static build or apt); pin a version. |
| Docker          | **Not available**                        | Cannot assume container-based local dev; deployment design must not *require* Docker locally. |
| CPU / RAM       | 2 vCPU / ~3.8 GB                         | Confirms the user's machine is low-end. Local 1080p renders will be slow; design for chunked rendering and cloud runners. |
| Disk            | ~20 GB free                              | Artifacts must be prunable; content-addressed storage with GC policy. |
| Network         | Outbound available                       | Cloud APIs usable; long-lived inbound services are not the dev model. |

**Conclusion:** the dev environment matches the stated constraint (low-end
machine, $0 infra). The architecture must treat *compute-heavy rendering* as
a schedulable job that can run locally (slow), in CI (GitHub Actions free
minutes), or on a free-tier VM (Oracle Always Free) — chosen at runtime by a
**runner abstraction**, without code changes.

---

## 3. Recommended Architecture

### 3.1 Shape: modular monolith + worker, single repo

```
                        ┌────────────────────────────────────────┐
                        │                app (one process)        │
                        │  ┌──────────┐  ┌───────────────────┐   │
   browser ───────────▶ │  │ dashboard│  │ HTTP API (tRPC/   │   │
   (single operator)    │  │ (Next.js │  │  REST)            │   │
                        │  │  or SSR) │  └─────────┬─────────┘   │
                        │  └──────────┘            │              │
                        │              ┌───────────▼───────────┐  │
                        │              │      orchestrator     │  │
                        │              │  (job state machine)  │  │
                        │              └───────────┬───────────┘  │
                        └──────────────────────────┼──────────────┘
                                                   │ claims/enqueues
                        ┌──────────────────────────▼──────────────┐
                        │             worker (same codebase,      │
                        │  separate entrypoint; 0..n processes)   │
                        │  executes pipeline steps via Runner     │
                        └──┬─────────┬─────────┬─────────┬────────┘
                           │         │         │         │
                     ┌─────▼──┐ ┌────▼───┐ ┌───▼────┐ ┌──▼─────────┐
                     │ SQLite │ │artifact│ │provider│ │  runners   │
                     │  (WAL) │ │ store  │ │adapters│ │ local/CI/VM│
                     └────────┘ └────────┘ └────────┘ └────────────┘
```

- **app**: serves the dashboard, exposes the API, owns the orchestrator.
  Runs anywhere (laptop, free VM). Stateless except for the DB file.
- **worker**: polls the DB for claimed jobs, executes steps. Same binary,
  `--role worker`. On a single machine, app can embed a worker
  (`--role all`) — that is the expected $0 deployment.
- **runners**: a step that needs heavy compute (render, transcribe) is
  *dispatched*, not executed inline: local process pool, GitHub Actions
  workflow_dispatch, or SSH to a free VM. The step's state lives in the DB;
  the runner reports back via artifacts + status writes.

### 3.2 Why not microservices (challenge to the brief)

The brief lists ~18 "components". As services, that means 18 deployments,
18 log streams, service discovery, network error handling, distributed
tracing, and versioned contracts — for a **single-operator, single-tenant,
queue-depth-of-one** system. That is pure cost with zero benefit:

- There is exactly one user (the operator). No multi-tenant scaling need.
- Pipelines are sequential DAGs; the "throughput" is ~videos/day, not
  requests/second. A single worker loop is orders of magnitude sufficient.
- $0 infra cannot host 18 always-on services anyway (see §17 free-tier traps).
- Failure recovery is *easier* monolithically: one DB, one job table, one
  resume path. Distributed systems add failure modes, not remove them.

**Splitting criteria (for the future):** extract a service only when
(a) it needs independent scaling (renderer farm), (b) it needs a different
runtime/security domain (publishing agent holding YouTube OAuth tokens), or
(c) it needs independent deployment cadence. None apply at Phase 1–3.

### 3.3 What is a package vs. a service

| Component (from brief)     | Verdict                     | Notes |
|----------------------------|-----------------------------|-------|
| dashboard                  | Package (UI) inside `app`   | Next.js/SSR or plain SPA served by app. |
| orchestrator               | Package inside `app`        | Pure state-machine logic; no I/O of its own. |
| research engine            | Package + provider adapters | Mostly provider calls + storage of sources. |
| script engine              | Package + provider adapters | LLM-heavy; strict schema outputs. |
| scene planner              | Package                     | Mostly *deterministic* transformation of script → scene graph; LLM optional. |
| media engine               | Package + provider adapters | Search/fetch + license capture + caching. |
| character system           | Package (asset library)     | Data + SVG/Lottie/Rive assets, **not** a service. Start simple (see §18.7). |
| animation/composition      | Package (scene components)  | Remotion compositions = code. |
| voice engine               | Package + provider adapters | TTS behind interface; caching by text hash. |
| caption engine             | Package (deterministic)     | Word timestamps → styled caption track. No AI. |
| rendering engine           | Package + **runner dispatch** | The one component that may become a separate *runner*, still not a service. |
| Shorts engine              | Package                     | Candidate detection + vertical re-composition. |
| YouTube publishing engine  | Package + provider adapter  | OAuth flow, quota accounting, upload jobs. |
| QA engine                  | Package (deterministic checks + optional LLM review) | Mostly code: duration, loudness, resolution, caption presence, banned-content regexes. |
| provider abstraction layer | Package (`providers`)       | Interfaces + registry + fakes. |
| database                   | SQLite file (infra, not code component) | Drizzle/Prisma schema in `db` package. |
| object/artifact storage    | Package (`storage`)         | CAS interface; local FS now, S3/R2 later. |
| job/state system           | Package (`jobs`)            | Tables + claim/heartbeat/resume logic. |

---

## 4. Technology Choices & Alternatives

| Concern            | **Recommended**                          | Alternatives considered                     | Why |
|--------------------|------------------------------------------|---------------------------------------------|-----|
| Language           | **TypeScript (Node 22)** end-to-end      | Python monorepo; TS+Python polyglot         | Remotion, dashboard, DB, jobs all share one language; one runtime to deploy on a low-end box. Python kept as an *optional tool runtime* for whisper if needed. |
| Monorepo tooling   | **pnpm workspaces + Turborepo (optional)** | Nx, single package.json                    | pnpm is $0 and sufficient; Turborepo adds caching but is optional until build times hurt. |
| Web framework      | **Fastify + tRPC** (or Hono)             | Express, NestJS, full Next.js server        | Small surface, typed API, trivially embeds the dashboard. NestJS is over-structured for one team-of-one. |
| Dashboard UI       | **Next.js (static/SSR) or Vite SPA** served by app | Separate frontend host          | One origin = one deployment; no CORS; auth is a single session. |
| ORM / migrations   | **Drizzle ORM**                          | Prisma, Kysely, raw SQL                     | SQL-first, excellent SQLite support, portable to Postgres; Prisma's engine binaries are heavier on low-end machines. |
| Database           | **SQLite (WAL mode)**                    | Postgres (Neon/Supabase free tier)          | Zero-ops, single file, transactional job claims via `UPDATE ... RETURNING`. Postgres only if/when app and worker live on different hosts — and even then consider Litestream. |
| Artifact storage   | **Local content-addressed store** behind S3-like interface | R2/B2/S3 from day one          | Free, fast, works offline; interface keeps cloud swap trivial. R2 free tier (10 GB, no egress fee) is the designated cloud target. |
| Video composition  | **Remotion** (React → frames)            | Motion Canvas, custom Puppeteer capture, FFmpeg-only (xfade/filter_complex), Manim | Code-driven scene graph is the core requirement (reusable characters, diagrams, deterministic 9:16 re-layout). FFmpeg-only cannot express this; Manim is Python and math-oriented. **License caveat in §18.4.** |
| Encoding/muxing    | **FFmpeg (pinned static build)**         | GStreamer                                   | Industry default; needed for loudness norm (`loudnorm`), concat, mux. |
| TTS                | **Adapter; start: Edge-TTS (free) or Gemini TTS free tier; fallback: Piper (local)** | ElevenLabs free (10k chars/mo — too small), Azure/Google free tiers (quota-limited, ToS nuances) | Voice is the highest-churn provider decision; the adapter and cache matter more than the first choice. |
| Transcription      | **faster-whisper / whisper.cpp (local CPU)** | OpenAI Whisper API ($), cloud STT          | We mostly transcribe *our own generated audio* for word timestamps — many TTS providers return timestamps directly, making whisper a fallback, not the default path. |
| LLMs               | **OpenAI-compatible adapter over OpenRouter/Groq/Gemini free tiers; Ollama optional for dev** | Direct vendor SDKs per model                | One interface (`chat(schema, messages)`), per-provider quota trackers, graceful degradation to "manual mode". |
| Web search (research) | **Adapter: free tiers (Brave/Serper/Tavily/SearXNG)** | Paid SERP APIs                            | All are quota-limited; adapter + human-assisted fallback ("paste your sources" mode). |
| Job queue          | **DB-backed job table with claim/lease** | Redis+BullMQ, RabbitMQ, Temporal            | One DB, one worker pool; leases + heartbeats give crash recovery. Temporal is excellent but is exactly the kind of infra we can't afford to run. |
| IaC / deploy       | **None initially; systemd/pm2 on a free VM or the laptop** | Docker, Kubernetes, Terraform               | Docker isn't even available in this dev env; don't require it. Add Dockerfile in Phase 4 as *an option*, not a dependency. |

---

## 5. Service Boundaries (logical)

Even inside the monolith, enforce boundaries with dependency rules:

```
ui ──▶ api ──▶ orchestrator ──▶ jobs ──▶ db
                    │
                    ▼
              pipeline packages (research, script, scene, media,
              voice, caption, render, shorts, qa, publish)
                    │
                    ▼
        providers (adapters)      storage (CAS)      runners
```

Rules:

1. Pipeline packages never import each other directly; they exchange
   **typed artifacts** (JSON schemas) via the job/store layer.
2. Only `providers` and `storage` touch the outside world. Everything else
   is testable offline with fakes.
3. `orchestrator` contains no domain logic — it only sequences steps and
   manages state. Domain logic cannot know about jobs.
4. The UI only talks to the API; the API only talks to orchestrator +
   queries. No SQL in UI code.

These rules give 90% of microservice benefits (replaceability, testability)
with 0% of the operational cost, and make a later extraction mechanical.

---

## 6. Database / Domain Model

SQLite, Drizzle-managed migrations. Core entities (conceptual, not final DDL):

### 6.1 Production domain

- **project** — a channel/format configuration: style guide, character set
  refs, voice profile, aspect ratios, publishing defaults.
- **topic** — an input idea; status `new → approved_for_research → …`.
- **video** — the aggregate root for one production run (long-form).
  Denormalized `state` (from the state machine) + `project_id`, `topic_id`.
- **short** — a derived production run; FK to `video` + `source_segment`.
- **script** — versioned; structured JSON: sections → beats → sentences;
  each sentence has a stable `sentence_id` (used by claims, captions, scenes).
- **scene** — versioned scene-graph node list per script version:
  `scene_id`, layout intent, characters, props, media refs, timing hints,
  `vertical_variant` flags.
- **media_asset** — every external file: `content_hash` (CAS key),
  `source_uri`, `source_title`, `author`, `license_id`, `license_url`,
  `acquired_at`, `attribution_text`, `usage_context`, `expiry/review_at`.
- **source** — a research source: URL, publisher, retrieved_at, content
  hash of snapshot, credibility tags (human-assignable).
- **claim** — a factual statement extracted from a script sentence:
  `sentence_id`, `claim_text`, `status` (`unverified | supported |
  contradicted | unsupportable`), confidence.
- **claim_evidence** — M:N claim ↔ source with quoted excerpt + locator.
- **asset_render** — outputs: `video_id/short_id`, `variant` (16:9 master,
  9:16, thumbnail, captions.srt, transcript.json), `content_hash`, codec
  metadata, duration, loudness stats.

### 6.2 Execution domain

- **job** — `id`, `pipeline` (`longform_v1`, `shorts_v1`, `publish_v1`),
  `video_id/short_id`, `state`, `attempt`, `lease_owner`, `lease_expires_at`,
  `input_fingerprint`, `error`, timestamps.
- **job_step** — `job_id`, `step_key`, `state`, `input_hash`,
  `output_artifact_ids[]`, `attempt`, `log_ref`, `started/finished_at`.
  The unit of resumability: a step with `state=done` and matching
  `input_hash` is skipped on resume.
- **approval** — `subject_type/id` (video, short, publish action),
  `decision` (`approved | rejected | needs_changes`), `reviewed_by`,
  `reviewed_at`, `diff_fingerprint` (the exact artifact version approved —
  approvals are invalidated if content changes afterwards), `notes`.
- **audit_log** — append-only: who/what/when for approvals, publishes,
  provider calls that cost quota, license overrides.

### 6.3 Provider domain

- **provider_account** — adapter id, credentials *reference* (env var name,
  never the secret), quota window, quota used, cooldown.
- **provider_call_log** — adapter, operation, tokens/chars/units consumed,
  latency, cost estimate, cache key. Feeds the free-tier budget guard (§17).

### 6.4 Data-model principles (challenging the naive design)

- **Everything is versioned by content hash.** A `script` edit creates a new
  version; downstream steps recompute only what the hash change invalidates.
  This is what makes long jobs resumable and cheap to re-run.
- **No blobs in SQLite.** DB stores metadata + CAS keys; bytes live in the
  artifact store. Keeps the DB tiny and backup = copy two things.
- **Approval binds to a fingerprint.** Prevents the classic bug: "approved
  v3, published v4."
- **Claims are first-class, not comments.** Fact-check traceability is a
  schema guarantee, not a convention.

---

## 7. Job / State Machine

### 7.1 Video lifecycle (long-form)

```
DRAFT
 └▶ RESEARCHING ──▶ RESEARCH_REVIEW (human, optional gate)
     └▶ FACT_CHECKING ──▶ FACT_REVIEW (human gate: unsupported claims block)
         └▶ SCRIPTING ──▶ SCRIPT_REVIEW (human gate)
             └▶ SCENE_PLANNING ──▶ MEDIA_GATHERING ──▶ VOICE_SYNTHESIS
                 └▶ CAPTIONING ──▶ COMPOSITING ──▶ RENDERING
                     └▶ QA ──▶ APPROVAL (human gate, mandatory)
                         └▶ READY_TO_PUBLISH ──▶ PUBLISHING ──▶ PUBLISHED
                                                      └▶ SHORTS_EXTRACTION (parallel branch)

Any state ──▶ FAILED(step-level, resumable) │ CANCELED │ NEEDS_CHANGES (→ back to the responsible state)
```

- Human gates are **states with no timer**. A job parked at `APPROVAL`
  costs nothing and resumes exactly where it stopped.
- `NEEDS_CHANGES` carries a target step; re-entry recomputes only steps
  whose `input_hash` changed (e.g., re-record voice for one sentence →
  only captioning/compositing/render for affected segments re-run — segment-
  level rendering, §10.4, makes this affordable).

### 7.2 Step execution semantics

- Each step is a pure-ish function:
  `run(input_artifacts, config, providers) → output_artifacts`.
- **Idempotent & retryable**: retries with backoff; attempt count recorded;
  provider quota errors degrade to `PARKED(quota)` rather than `FAILED`.
- **Leases**: worker claims a job with `lease_expires_at`; crashed workers'
  leases expire and jobs are re-claimable. Heartbeat extends the lease.
- **Checkpointing granularity**: per step, plus per segment inside
  render/transcribe steps (the expensive ones).
- **Determinism requirement**: given the same inputs + provider outputs,
  a step produces the same artifact hash. Non-deterministic provider calls
  are cached by input hash, so re-runs are deterministic *and* free.

### 7.3 What we deliberately do NOT use

- No external broker (Redis/RabbitMQ/SQS): one DB table with
  `SELECT … FOR UPDATE`-style atomic claiming is enough for ≤ tens of
  concurrent jobs, and SQLite gives us that with zero infra.
- No Temporal/step-function engine: we'd re-implement 10% of it anyway, and
  it's infrastructure we can't host for $0. The DB state machine *is* the
  workflow engine. (Open decision OD-6: revisit if pipelines grow beyond
  ~40 step types.)

---

## 8. Provider Abstraction Layer

```ts
// Conceptual interfaces ONLY — not to be implemented in this phase.
interface LLMProvider   { chat(req: SchemaRequest): Promise<StructuredOutput>; usage(): Usage; }
interface TTSProvider   { synthesize(text, voiceProfile): Promise<{audioRef, wordTimings?}>; }
interface STTProvider   { transcribe(audioRef): Promise<WordTimeline>; }
interface SearchProvider{ web(query): Promise<SearchResult[]>; images(query, licenseFilter): Promise<MediaResult[]>; }
interface MediaSource   { fetch(url): Promise<{bytes, mime, licenseInfo}>; }
interface Storage       { put/get/hash/list(prefix) }              // CAS semantics
interface Runner        { dispatch(step, payload): Promise<RunRef>; poll(RunRef) }
interface Publisher     { upload(asset, metadata, privacy): Promise<PublishRef>; quota(): Quota; }
```

Design rules:

1. **Every interface ships with a `Fake*` implementation** (deterministic,
   offline) used in tests and in a `--dry-run` pipeline mode. This is what
   makes the whole system developable at $0 and on a 2-vCPU box.
2. **Every interface ships with a `Manual*` escape hatch**: e.g.,
   `ManualResearchProvider` = operator pastes URLs/notes into the dashboard.
   Free tiers will run out; the pipeline must degrade to human-in-the-loop,
   not crash.
3. **Registry + capability flags** select implementations per project/env:
   `NEXUS_LLM=openrouter:grok` etc. Quota trackers in `provider_account`
   gate calls *before* they're made; hitting 90% of a free quota flips the
   capability to `manual` automatically.
4. **Structured output contracts**: LLM steps must return JSON validated
   against a schema (zod); invalid → bounded retry with repair prompt →
   then `NEEDS_CHANGES`. Never let raw LLM text flow into rendering.

---

## 9. Local vs. Cloud

| Workload                      | Dev-time location        | Production location ($0 target)                |
|-------------------------------|--------------------------|------------------------------------------------|
| app + worker + DB + artifacts | Local machine / sandbox  | One free VM (Oracle Always Free ARM) or the same laptop; single process `--role all`. |
| LLM / TTS / search calls      | Cloud APIs (free tiers)  | Same; quota-guarded.                           |
| Rendering (frames + encode)   | Local, chunked, low-res previews | GitHub Actions matrix jobs (free minutes) chunking scenes in parallel; or the free VM overnight. |
| Transcription (if needed)     | Local whisper.cpp small  | Actions runner; only for segments lacking TTS timestamps. |
| Storage                       | Local CAS                | Local CAS + optional R2 mirror for backups.    |
| Dashboard access              | localhost                | localhost or Tailscale; **never** a public unauthenticated port (§15). |

Principle: **the cloud is a runner and a set of APIs, not a platform.** We
avoid PaaS entirely at first because every always-on PaaS free tier is either
gone, sleeping, or a credit-burn trap (§17).

---

## 10. Rendering Strategy

This is the make-or-break subsystem; getting it wrong means either fragile
AI-video mashups or unaffordable compute.

### 10.1 Composition model

- Video = **scene graph** (typed JSON) → **Remotion composition** (React
  components per scene type: `TalkingCharacter`, `Diagram`, `MediaPanel`,
  `Broll`, `QuoteCard`, `TitleCard`) → frames → FFmpeg encode.
- Characters are **parametric components** driven by data (pose, expression,
  palette, sprite/Lottie/Rive asset set) — reusable across videos by
  construction. No per-video character invention.
- Timing is **audio-driven**: TTS produces audio + word timestamps; scene
  durations derive from narration timing (deterministic math), not from
  LLM guesses.

### 10.2 Determinism

- Pinned versions (Remotion, FFmpeg, fonts, node), seeded randomness, fixed
  frame rate/resolution per project. Same inputs → same output hash. This
  enables caching, QA diffing, and safe resumes.

### 10.3 Compute strategy for a $0 budget

- Render **per scene/segment** into intermediate clips; concat with FFmpeg.
  Benefits: parallelism across cheap runners, segment-level caching (only
  re-render changed segments), and resumability.
- Preview tier: 480p/fast-encode drafts for human review; full render only
  after `APPROVAL`. **Never burn render compute on unapproved content.**
- GitHub Actions matrix: each segment = one job on a free runner; artifact
  upload → local/VM concat. Watch the 6h job cap and 2000 min/month (private
  repos) — a budget guard in `provider_call_log` tracks minutes like API quota.

### 10.4 What we do NOT do (challenges to the concept)

- **No generative AI video** (Sora/Runway-style) in the core pipeline:
  cost, non-determinism, licensing murk, and character inconsistency all
  violate the brief. Optional B-roll *images* via AI are allowed only through
  the media engine with provenance records marked `ai_generated`.
- **No real-time/GPU rendering**: nothing in the $0 stack has a GPU; the
  renderer must be CPU-only (headless Chromium frame capture is CPU-bound —
  fine).
- **No custom rendering engine from scratch** in Phase 1–3. If Remotion's
  license becomes a problem (§18.4), fall back to Motion Canvas (MIT) or a
  thin Puppeteer frame-capture layer — the scene-graph abstraction keeps
  this swap contained.

---

## 11. AI Usage Strategy

**Rule: AI for semantics, code for everything else.**

| Task                          | AI?  | Rationale |
|-------------------------------|------|-----------|
| Source discovery & summarization | Yes (LLM + search API) | Semantic judgment. |
| Claim extraction from script  | Yes (LLM, structured output) | Semantic; but every claim must cite a stored source excerpt — LLM output is a *hypothesis*, evidence link is the *record*. |
| Fact verification verdict     | Hybrid | LLM proposes verdict against retrieved excerpts; **deterministic gate**: claims without `supported` status cannot pass `FACT_REVIEW`. Human has final say. |
| Scriptwriting                 | Yes (LLM) | Constrained by schema + style guide + claim IDs; sentences carry claim references inline. |
| Scene planning                | Mostly no | Script structure + timing math → scene graph via templates; LLM optional for visual-idea suggestions only. |
| Character animation           | No   | Parametric components + keyframe data. AI-driven animation is a research project, not a pipeline step. |
| Voice                         | Provider TTS (a model, but consumed as a service, not "AI logic") | Deterministic input→output contract incl. timestamps. |
| Captions                      | No   | Word timestamps → styled ASS/SRT via code. Karaoke highlighting is arithmetic. |
| Thumbnail layout              | No (composition code); optional AI for *image* candidates | Same provenance rules as media. |
| Shorts candidate detection    | Hybrid | **Primary signal is structural**: our own script marks self-contained beats; sentence-level hooks scored by a cheap LLM pass over the transcript. Deterministic constraints (length 20–55 s, must start on a hook, must not span unresolved references) enforced in code. |
| QA                            | Mostly no | ffprobe checks (duration, resolution, loudness LUFS, silence detection, caption presence/validity, chapter markers) are code; optional LLM "watchability review" as advisory only. |
| Publishing decisions          | **Never** | Human approval gate; AI may draft title/description/tags (human edits). |

Additional hard rules:

- Every AI output is **schema-validated, cached by input hash, and stored as
  a versioned artifact** — pipelines never re-roll AI calls implicitly.
- Every AI-generated artifact carries `generated_by` metadata (provider,
  model, prompt template version) for auditability.
- Cost/quota observability is mandatory: no pipeline runs "blind" against
  paid meters.

---

## 12. Media / License / Provenance Strategy

1. **Content-addressed store**: `sha256(bytes)` = artifact key. Dedupe for
   free; integrity checks on resume; provenance chain = DB rows pointing at
   hashes.
2. **Every external byte enters through the media engine**, which refuses
   storage without a `media_asset` record: source URI, retrieval timestamp,
   license identifier (SPDX/Creative Commons variant), license URL,
   attribution text, and `redistribution_ok` flag.
3. **License policy engine (deterministic)**: each project declares allowed
   licenses (e.g., CC0, CC-BY, CC-BY-SA with attribution, public domain,
   licensed stock, own assets). Assets failing policy are quarantined, never
   rendered. Attribution requirements are compiled automatically into the
   video description (code, not AI).
4. **Preferred sources**: own generated assets (characters, diagrams) first;
   Wikimedia/Commons (API provides license metadata), Pexels/Pixabay/Unsplash
   (API keys, free tiers, clear licenses), NASA/gov public domain, archive.org.
   **Never** scrape "Google Images".
5. **AI-generated media** is labeled `ai_generated` with model + prompt
   provenance; policy decides per project/channel whether it's allowed
   (YouTube requires disclosure of realistic synthetic media — the publisher
   adapter sets the disclosure flag automatically when such assets are present).
6. **Retention**: source snapshots (HTML/text) kept for fact-check audit;
   prunable raw downloads kept only if license/audit requires. GC policy per
   artifact class, driven by the 20 GB disk reality.

---

## 13. Shorts Architecture

**Key insight: because we own the scene graph, Shorts are a re-render, not a
re-edit.** Reject any design that post-processes the finished 16:9 video
(AI reframing/cropping): it's fragile, lossy, and unnecessary here.

Pipeline (`shorts_v1`):

```
video PUBLISHED/READY
 └▶ 1. STRUCTURAL SCAN (code): script sections/beats → candidate segments
       (self-contained, 20–55 s after narration timing math)
    2. HOOK SCORING (cheap LLM, cached): rank candidates; flag need for
       re-written cold-open line
    3. HUMAN SELECTION (dashboard): operator picks/renames/reorders
    4. VERTICAL RE-COMPOSITION (code): scene graph → 9:16 layout variants
       (scene components declare vertical layout params: safe areas for
       captions/UI, stacked character+diagram arrangements)
    5. VOICE: reuse original audio when segment boundaries allow; otherwise
       re-synthesize only changed lines (word-timestamp splice)
    6. CAPTIONS (code): big-style vertical caption track from word timings
    7. RENDER (segment-chunked, as §10) ──▶ QA ──▶ APPROVAL ──▶ PUBLISH
```

- Shorts inherit the parent video's provenance records; a short's
  `media_asset` set is a subset of the parent's (plus any new hook assets).
- The 9:16 variants must be authored *alongside* 16:9 scene components from
  Phase 1 — retrofitting vertical layouts later is the classic failure mode.
  (This is a real cost of the concept and is flagged in §18.6.)

---

## 14. YouTube Publishing Architecture

### 14.1 Flow

```
APPROVAL(approved, fingerprint F)
 └▶ publish job:
    1. Package: master file + thumbnail + metadata (title/description/tags/
       chapters — description includes compiled attributions & AI disclosure)
    2. Pre-flight (code): re-verify fingerprint F matches current artifacts;
       re-run QA checklist; check quota (videos.insert ≈ 1600 units;
       default project budget 10,000 units/day → ~6 uploads/day max)
    3. Upload via resumable upload API (chunked; survives flaky connections)
    4. Privacy = private/unlisted ALWAYS on first upload; metadata set via
       videos.update; scheduled publish time optional
    5. Post-publish verification: poll videoStatus; record publish audit row
    6. Shorts: same flow with #Shorts-appropriate metadata
```

### 14.2 Hard constraints & mitigations (this is the riskiest external dependency)

- **Un-audited API projects:** videos uploaded via the Data API from
  unverified projects are **locked to private**. Mitigation path: (a) plan
  for the API audit/app verification early (needs a working demo — another
  reason publishing is a late phase); (b) until audited, the "publish" step
  degrades to **assisted manual publishing**: system produces an upload kit
  (file + metadata + thumbnail + checklist) and the operator uploads via
  YouTube Studio; the approval/audit records still apply. The `Publisher`
  interface has a `ManualPublisher` implementation for exactly this.
- **OAuth**: one operator account; refresh token stored encrypted at rest
  (§15); scopes limited to `youtube.upload` + `youtube.third-party-link.creator`
  only as needed; no `youtube.force-ssl` beyond what's required.
- **Quota** is tracked like money in `provider_call_log`; publish jobs fail
  closed when budget is insufficient.

---

## 15. Security Model

Threat model: single operator; secrets = LLM/TTS API keys, YouTube OAuth
tokens; assets = unpublished content, license records. It is *not* a
multi-tenant SaaS — don't build (or pay for) one.

1. **Network exposure: none by default.** Dashboard binds localhost; remote
   access via Tailscale (free) or SSH tunnel. No public ingress, no CORS
   surface, no bot traffic. This removes ~80% of the auth problem.
2. **AuthN/AuthZ (when exposed even privately)**: single-operator session
   auth (e.g., Auth.js/lucia with one identity, or a strong passphrase +
   signed session cookie). Role model is literally `operator`; approval
   records capture identity for audit. Do not build multi-user RBAC now.
3. **Secrets**: environment variables / OS keychain only. `provider_account`
   stores the *name* of the env var, never a value. `.env` git-ignored;
   example file committed. YouTube refresh token encrypted at rest
   (e.g., `sops`/age or libsodium secretbox with a key from env).
4. **Supply chain**: pinned dependency versions, `pnpm audit` in CI, pinned
   FFmpeg/Chromium builds with checksums.
5. **Injection & SSRF hygiene**: media engine fetches arbitrary URLs —
   block private/link-local IP ranges, cap download size/time, allowlist
   MIME types, never execute fetched content (HTML snapshots stored inert).
6. **Prompt-injection awareness**: research pulls untrusted web text into
   LLM context. Mitigation: untrusted content is wrapped as data (never as
   instructions), LLM outputs are schema-validated, and *no LLM output can
   trigger an action* — actions come only from the state machine and human
   gates. Publishing is human-approved, so worst case is a bad draft.
7. **Audit**: append-only `audit_log` for approvals, publishes, license
   overrides, and quota spends. Backups (DB + CAS index) encrypted.

---

## 16. Testing Strategy

- **Unit (fast, offline)**: state machine transitions; caption timing math;
  layout/scene-graph transforms; license policy engine; quota guards;
  fingerprint/invalidation logic. Golden-file tests for deterministic
  outputs (SRT/ASS files, scene graphs).
- **Provider contract tests**: one shared contract suite run against every
  adapter implementation *and* its Fake — guarantees replaceability is real,
  not aspirational. Live-provider tests are tagged, opt-in, quota-capped.
- **Pipeline integration (dry-run mode)**: full `longform_v1` execution
  against Fakes producing a real (tiny, low-res) video — proves resumability
  by killing the worker mid-run and asserting exact-resume.
- **Render snapshot tests**: reference frames at fixed timestamps compared
  perceptually (pixel diff threshold) — catches font/dependency drift.
- **QA engine tests**: intentionally broken fixtures (silent audio, wrong
  duration, missing captions) must be rejected.
- **E2E publishing**: never against real YouTube in CI; `FakePublisher` +
  a manual, documented "upload kit drill" per release.
- CI on GitHub Actions free tier: typecheck, lint, unit, dry-run pipeline
  (~10 min budget). Render snapshot jobs run on-demand only (minutes are
  scarce — treat CI minutes as a metered resource, §17).

---

## 17. Free-Tier / Resource Strategy

**Treat every free tier as a metered budget with an enforced cap in code.**

| Resource                | Free option                        | Trap                                        | Guard |
|-------------------------|------------------------------------|---------------------------------------------|-------|
| Compute (always-on)     | Oracle Cloud Always Free (4× ARM, 24 GB) — best $0 VM; capacity-limited signup | PaaS "free tiers" that are actually credits (GCP $300, Azure) burn silently; Fly/Railway/Heroku no longer meaningfully free | No PaaS. One VM or laptop. If Oracle unavailable: laptop + Actions. |
| CI minutes              | GitHub Actions 2000 min/mo (private) | Render matrix jobs eat minutes fast         | Minutes tracked in `provider_call_log`; previews 480p; full renders only post-approval; monthly cap config. |
| LLM                     | Gemini free tier, Groq free tier, OpenRouter free models | Rate limits, model churn, silent quality changes | Adapter + cached outputs + model pinned per prompt-template version; `ManualProvider` fallback. |
| TTS                     | Edge-TTS (unofficial — ToS/stability risk), Gemini TTS free chars | Unofficial APIs vanish; official free tiers are tiny (ElevenLabs 10k chars ≈ 10 min of video/mo) | Adapter; cache by text hash (never re-synthesize); Piper local fallback for drafts. |
| Storage                 | Local disk + R2 10 GB (no egress fees) | S3 egress fees; storing raw video in DB   | CAS dedupe; GC policy; R2 only for backups/exports. |
| DB                      | SQLite local; Litestream→R2 for backup | Managed Postgres free tiers sleep/expire   | None needed. |
| Search API              | Brave/Tavily/SearXNG free tiers      | Exhaustion mid-research                     | Quota guard → manual paste mode. |
| YouTube API             | 10k units/day default                | Uploads locked private until audited; quota exhausted by polling | §14; poll with backoff; upload kit fallback. |

Design consequences:

- **Cache aggressively**: LLM responses, TTS audio, search results,
  downloaded media, rendered segments — all content-addressed. Re-runs
  should approach zero external calls.
- **Draft cheap, finish late**: low-res previews and draft voices for all
  human review; expensive operations gated behind approval.
- **Degrade, don't fail**: every provider path has a manual fallback so a
  dead free tier pauses the pipeline at a human gate instead of erroring.

---

## 18. Risks & Contradictions in the Concept

1. **"Fully automated" vs. "human approval" vs. fact-check liability.**
   The brief wants automation *and* mandatory human gates — that's fine, but
   the honest framing is: **this is an assisted-production system, not an
   autonomous one.** LLM fact-checking is not reliable enough to be the last
   line of defense; the design makes humans the gate and claims/evidence the
   audit trail. Accept that throughput is bounded by human review time —
   which is *also* bounded by the free-tier quotas, so the contradiction is
   mostly moot in practice.
2. **YouTube Data API upload lock (HIGH).** Un-audited projects → uploads
   forced private. This can make "→ YOUTUBE" automation impossible for
   months. Mitigation: upload-kit/manual publisher from day one; pursue
   audit in Phase 4. *Do not promise full publishing automation in any demo
   until the audit passes.*
3. **$0 rendering vs. render time (HIGH).** A 10-minute 1080p animated
   video on 2 vCPU can take hours. Mitigations: segment-parallel CI renders,
   480p draft pipeline, post-approval full renders, overnight scheduling.
   Still, expect ~1–3 videos/day ceiling. If the concept assumes volume
   (multiple channels/day), it is contradicted by the $0 constraint.
4. **Remotion licensing (MEDIUM).** Remotion is source-available; free for
   individuals and very small teams, but a commercial license is required
   once the company/team size threshold is exceeded. A monetized channel
   *may* still qualify as individual use — **must be verified before
   Phase 1 commit** (OD-1). Fallbacks: Motion Canvas (MIT), custom
   Puppeteer capture layer. The scene-graph abstraction limits blast radius.
5. **Free-tier TTS instability (MEDIUM-HIGH).** Edge-TTS is unofficial and
   could break or violate ToS at any time; official free TTS quotas are too
   small for video narration at scale. Voice quality is also the single
   biggest determinant of whether the channel succeeds. This may be the one
   place where the $0 constraint genuinely must yield (e.g., ~$5–20/mo for
   a paid TTS) — flagged as OD-2, a business decision, not an architecture one.
6. **Dual-format authoring cost (MEDIUM).** Authoring every scene component
   in both 16:9 and 9:16 variants roughly doubles composition work. It's
   still far cheaper than AI reframing, but the brief's "shorts from
   long-form" fantasy of *free* derivatives is unrealistic: shorts need
   their own layout pass, hook rewrites, and approvals.
7. **Character/animation system scope creep (MEDIUM).** "Reusable animated
   characters" can balloon into a rigging/animation studio project. Phase 1
   characters = 2–4 static sprite states (idle/talk/point/react) with simple
   transform animation. Lip-sync is *approximated* (talk-state cycling on
   speech energy), not phoneme-accurate. Anything more is Phase 5+.
8. **Research quality ceiling (MEDIUM).** Free search APIs + LLM
   summarization produce shallow research; genuinely good explainers need
   primary sources. The manual-provider path (operator pastes sources) is
   not a fallback here — it's arguably the *primary* mode for quality content.
9. **SQLite on a laptop as the system of record (LOW-MEDIUM).** Single point
   of failure; mitigated by Litestream-to-R2 continuous backup and the fact
   that artifacts are content-addressed (rebuildable identity).
10. **Prompt-injection into scripts (LOW-MEDIUM).** Untrusted web text could
    poison script content. Mitigated by human gates on script + facts; but
    the operator must actually *read* at the gates — the UI should make
    claim/evidence review fast, not skimmable-past.
11. **Over-engineering is itself the top project risk.** An 18-component
    system designed up front will never ship. The phase plan (§20) exists to
    fight this: each phase ends with a *watchable artifact*, not a diagram.

---

## 19. Deployment Strategy

- **Phase 1–2 (dev):** everything on the dev machine/sandbox:
  `pnpm app --role all` (app+worker), SQLite file, local CAS, FFmpeg static
  binary. Zero deployment.
- **Phase 3 (persistent ops):** one free VM (Oracle Always Free ARM) or a
  dedicated low-power box: systemd unit for `app` + `worker`, Litestream
  backup to R2, Tailscale for dashboard access. Docker *optional* (provide a
  Dockerfile, don't require it).
- **Phase 4 (scale-out, only if needed):** worker on VM + render jobs
  dispatched to GitHub Actions matrix; publisher agent may separate for
  token isolation. Still no Kubernetes, no serverless, no PaaS.
- **Rollback/DR:** DB + CAS index are the only irreplaceable state; nightly
  encrypted backup to R2; artifacts re-derivable from job inputs otherwise.
  "Restore = copy files back, run migrations, resume jobs."

---

## 20. Recommended Implementation Phases

> Each phase has an exit criterion that is a *demonstrable artifact*.
> Nothing in a later phase is built (or even fully designed in code) until
> the earlier one ships.

**Phase 0 — Foundations (1–2 weeks)**
Scaffold monorepo (pnpm, TS strict, lint, CI); Drizzle schema + migrations
for §6 entities; job/state machine core with leases; CAS storage; provider
interfaces + Fakes; `--dry-run` pipeline harness.
*Exit:* a fake pipeline run executes end-to-end, is killable/resumable, and
leaves full audit records. No media produced yet.

**Phase 1 — The Hard Loop (2–4 weeks)**
Script (from operator-provided outline; LLM adapter with one free provider)
→ scene graph (2–3 scene component types) → TTS adapter + word timings →
deterministic captions → segment-chunked Remotion render → FFmpeg mux →
local QA checks → dashboard approval gate → export file.
*Exit:* **one watchable 60–90 s 16:9 video**, produced resumably, with
provenance for every asset, on $0 spend. Resolve OD-1 (Remotion license)
and OD-2 (voice provider) here.

**Phase 2 — Research & Fact-Check (2–3 weeks)**
Search adapters, source snapshots, claim extraction + evidence linking,
fact-review UI, script sentences bound to claims. Manual-paste mode
first-class.
*Exit:* a video whose every factual sentence traces to a stored source
excerpt through the dashboard.

**Phase 3 — Full Long-Form + Media Engine (3–4 weeks)**
License-aware media engine (Commons/Pexels/etc.), policy engine, expanded
scene components + character states, B-roll, diagrams; 8–12 min video;
Litestream backups; optional VM deployment.
*Exit:* a full-length episode rendered within free-tier budgets, draft-to-
final gated correctly.

**Phase 4 — Shorts Pipeline (2–3 weeks)**
Structural candidate scan, hook scoring, vertical scene variants,
shorts render/QA/approval.
*Exit:* 2–3 shorts derived from one long-form with human selection and
separate approvals.

**Phase 5 — Publishing (2–3 weeks + external timeline)**
OAuth flow, token encryption, upload-kit (manual publisher) first; Data API
auto-upload behind the audit; quota accounting; scheduling.
*Exit:* an upload kit used for a real publish; then (post-audit) one
API-published video with full audit trail.

**Phase 6+ — Hardening & optional scale:** CI render matrix, runner
abstraction to free VM, dashboard polish, character system depth,
multi-project support. *Explicitly out of scope until demanded by reality.*

---

## 21. Open Decisions (tracked in 000-decisions.md §OD)

| ID    | Decision                                              | Needed by |
|-------|-------------------------------------------------------|-----------|
| OD-1  | Remotion license viability vs. Motion Canvas/custom   | Phase 1 start |
| OD-2  | Primary TTS provider (free Edge-TTS vs. paid ElevenLabs-class) | Phase 1 |
| OD-3  | Primary LLM provider + models pinned per template     | Phase 1 |
| OD-4  | Oracle Always Free VM vs. laptop-only hosting         | Phase 3 |
| OD-5  | Channel content niche → determines research source mix & media policy | Phase 2 |
| OD-6  | DB-backed jobs vs. adopting a workflow engine later   | Revisit Phase 4 |
| OD-7  | YouTube API audit application timing & demo scope     | Phase 5 |
| OD-8  | Whether AI-generated imagery is allowed per project policy | Phase 3 |

---

## 22. What Should NOT Be Built Yet

- ❌ Any microservice, container orchestration, or IaC.
- ❌ The character animation "studio" (rigging, lip-sync, expression ML).
- ❌ Real YouTube publishing automation (audit risk; upload kit is enough).
- ❌ Multi-user auth, RBAC, teams, billing.
- ❌ A custom rendering engine or custom workflow engine.
- ❌ Redis/Kafka/Temporal/Postgres/managed anything.
- ❌ The Shorts pipeline (before long-form works).
- ❌ AI auto-reframing, AI video generation, AI thumbnails-as-default.
- ❌ Multi-channel/multi-tenant abstractions, plugin systems, public APIs.
- ❌ A polished dashboard — Phase 1 needs a table of jobs and an approve
  button, nothing more.

Building any of these now would consume the $0 budget and the solo
developer's attention before the core risk (script→render loop) is proven.

---

*End of discovery document. See `000-decisions.md` for the decision log.*
