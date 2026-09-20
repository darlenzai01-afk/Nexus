# NEXUS FORGE — Decision Log (000)

**Status:** Planning phase. These are architectural decisions (ADRs) made
during discovery. None of them authorize implementation yet.
**Companion doc:** [000-architecture-discovery.md](./000-architecture-discovery.md)

Format: Context → Decision → Reasoning → Alternatives rejected → Consequences.
Decisions marked **[OD]** are open and must be resolved at the stated gate.

---

## AD-01 — Modular monolith, not microservices

**Context:** The brief lists ~18 logical components (dashboard, orchestrator,
research, script, scene, media, character, animation, voice, caption, render,
shorts, publish, QA, providers, DB, storage, jobs). Taken literally as
services, this implies 18 deployables for a single-operator system.

**Decision:** One repository, one TypeScript codebase, two entrypoints
(`app`, `worker`) that can also run as a single process. All 18 components
are *packages* with enforced dependency rules, not services.

**Reasoning:**
- Zero scaling pressure: throughput is videos/day, not requests/second.
- $0 infra cannot host always-on services; every split adds a deployment,
  a failure domain, and network error handling with no user-visible benefit.
- Resumability and auditability are *easier* with one DB and one job table.
- Package boundaries + typed artifact exchange preserve replaceability, so
  extraction later is mechanical, not a rewrite.

**Rejected:** Microservices; serverless function-per-step (cold starts,
15-min limits vs. renders, per-invocation billing traps); "start with
services because we'll need them later" (we probably won't).

**Consequences:** All domain packages must avoid importing each other
(artifact exchange only). Discipline is enforced by lint rules / dependency
checks in CI. Extraction criteria defined in discovery §3.2.

---

## AD-02 — TypeScript + Node 22 as the single language

**Context:** Rendering (Remotion), dashboard, API, jobs, and most adapters
have first-class TS ecosystems; whisper-class tooling is Python/C++.

**Decision:** TypeScript everywhere for the system; Python permitted only as
an isolated tool runtime (e.g., faster-whisper invoked as a subprocess) if
and when needed.

**Reasoning:** One runtime on a low-end machine; typed contracts across the
scene graph, provider adapters, and job payloads; Remotion (the linchpin
rendering choice) is TS-native; avoids polyglot build/deploy complexity.

**Rejected:** Python monorepo (weaker story for code-driven video
composition and the dashboard); polyglot core.

**Consequences:** Any ML tooling must be callable as a subprocess or via
API; no in-process Python.

---

## AD-03 — Code-driven composition (Remotion) + FFmpeg, no generative video

**Context:** The content format is animated explainers with reusable
characters, diagrams, and motion graphics. Rendering must be deterministic,
CPU-only, resumable, and must support 9:16 re-layout for Shorts.

**Decision:** Video is generated from a typed **scene graph** via Remotion
(React components → frames) and finished with FFmpeg (segment concat, mux,
loudness). No AI video generation in the core pipeline.

**Reasoning:**
- A scene graph in code makes captions, timing, character reuse, and the
  Shorts vertical re-layout *deterministic software problems*.
- Generative video violates determinism, provenance, cost, and character-
  consistency requirements simultaneously.
- Segment-chunked rendering gives parallelism on cheap runners and
  segment-level caching (only changed segments re-render).

**Rejected:** FFmpeg-filter-only pipelines (cannot express the format);
Manim (Python, math-animation oriented); AI video (Sora/Runway class);
custom rendering engine (months of work before first video).

**Consequences:** Locked to CPU rendering speeds; Remotion license must be
verified (→ OD-1); scene components must author 16:9 and 9:16 variants
together.

---

## AD-04 — SQLite (WAL) as the system of record

**Context:** Need transactional job claiming, durable state, approvals,
audit — on $0 infra, possibly a laptop or one free VM.

**Decision:** SQLite with WAL mode, accessed via Drizzle ORM with portable
SQL. No blobs in the DB (metadata + content hashes only). Litestream → R2
for continuous backup once off-laptop.

**Reasoning:** Zero ops, single file, fast enough for orders of magnitude
more load than this system will see; atomic claim/lease semantics replace a
queue broker; backup/DR is `copy files`.

**Rejected:** Managed Postgres free tiers (sleeping instances, expiry,
network dependency); Postgres-in-Docker (Docker unavailable in dev env and
unnecessary); NoSQL (we need transactions and relational integrity for
claims/evidence/approvals).

**Consequences:** Single-writer constraint — fine for one worker pool; if
app and worker ever split across hosts, revisit (→ OD-6 territory). Schema
kept Postgres-portable (no SQLite-only tricks beyond what Drizzle abstracts).

> **Phase 2 amendment (pending ratification — OD-9 in `ISSUES.md`).** The
> decision to use SQLite (WAL, single-file, no infra) stands unchanged; the
> *access layer* is implemented as plain SQL DDL + a hand-written migration
> runner (`packages/db/src/schema.ts`, `migrate()` with an append-only
> drift guard) plus zod validation in the repo layer, on `node:sqlite`,
> instead of Drizzle ORM. Rationale: no native build step, no codegen, full
> control of the drift guard and the resumability queries, and every
> statement stays portable to Postgres. The ORM choice is confined to
> `packages/db`, so adopting Drizzle later is a one-package change.

---

## AD-05 — DB-backed job state machine with leases; no workflow engine

**Context:** Long-running, resumable, human-gated pipelines must survive
crashes, quota exhaustion, and days-long pauses at approval gates.

**Decision:** Pipelines are versioned DAGs of idempotent steps persisted in
`job` / `job_step` tables. Workers claim jobs with expiring leases and
heartbeats. Steps skip on resume when `state=done` and `input_hash` matches.
Provider quota exhaustion parks jobs (`PARKED(quota)`) instead of failing.
Human gates are untimed states.

**Reasoning:** This is ~10% of Temporal's functionality, covers 100% of the
requirements, and runs on SQLite with zero infra. Content-hash invalidation
gives cheap partial re-runs (edit one script sentence → re-render only the
affected segment).

**Rejected:** Redis+BullMQ (extra infra, no better semantics here);
Temporal/Step Functions (can't self-host for $0; lock-in); cron-and-scripts
(no resumability, no audit).

**Consequences:** We own retry/backoff/lease code (small, well-understood).
Revisit only if step-type count and fan-out grow dramatically (OD-6).

---

## AD-06 — Provider abstraction with Fake and Manual implementations

**Context:** Every external dependency (LLM, TTS, STT, search, media
sources, storage, runner, publisher) is on a free tier that can rate-limit,
change, or vanish — and must be replaceable per the brief.

**Decision:** All externals sit behind small interfaces in a `providers`
package. Every interface ships with: (a) at least one real adapter, (b) a
deterministic `Fake*` for tests and `--dry-run`, (c) a `Manual*` human-in-
the-loop fallback (e.g., operator pastes sources / receives an upload kit).
A registry selects implementations by env/config; quota trackers flip
providers to Manual mode automatically at ~90% of free budget.

**Reasoning:** The brief's "providers must be replaceable" is only real if
tested — the shared contract suite run against every adapter (including
fakes) is what prevents accidental lock-in. Manual fallbacks convert
free-tier exhaustion from an outage into a pause at a human gate.

**Rejected:** Direct vendor SDK calls in domain code; a heavyweight plugin
system (YAGNI); "we'll abstract later" (later never comes).

**Consequences:** Slightly more upfront interface design; every LLM/TTS
output cached by input hash so re-runs are free and deterministic.

---

## AD-07 — AI for semantics only; deterministic code elsewhere

**Context:** Brief mandates: "AI must NOT be used for deterministic work."

**Decision:** Boundaries fixed as in discovery §11. AI: research synthesis,
claim extraction, verification proposals, scriptwriting, hook scoring,
optional advisories. Code: timing, captions, layout, scene planning core,
QA checks, license policy, attribution compilation, quota math, publishing
mechanics, 9:16 re-layout.

**Reasoning:** Deterministic work in code is free, testable, and stable; AI
in those roles would add cost, nondeterminism, and failure modes. Every AI
output is schema-validated, versioned, cached, and provenance-tagged
(`generated_by`), and can never directly trigger an action — only the state
machine and human gates do that.

**Consequences:** LLM structured-output failures degrade to bounded repair
retries then `NEEDS_CHANGES`, never to garbage-in-pipeline.

---

## AD-08 — Human approval is a first-class, fingerprinted state

**Context:** Brief mandates human approval before publishing; automation
ambitions could erode this.

**Decision:** `APPROVAL` is an untimed job state; `approval` records bind to
the exact content fingerprint approved; any content change after approval
invalidates it and re-routes to the responsible state. Publishing re-verifies
the fingerprint immediately before upload. Full audit log of decisions.

**Reasoning:** Prevents the "approved v3, published v4" class of bug and
makes the human gate meaningful rather than ceremonial.

**Consequences:** Re-renders after approval require re-approval (correct
behavior, occasionally annoying — by design).

---

## AD-09 — Content-addressed artifact store with license/provenance records

**Context:** Brief mandates media provenance/license records and claim
traceability; dev disk is ~20 GB.

**Decision:** All bytes (media, audio, renders, snapshots) live in a CAS
keyed by sha256, behind a storage interface with a local-FS implementation
now and S3/R2 later. No external byte enters the store without a
`media_asset` row (source, license, attribution, timestamps, redistribution
flag). A deterministic license policy engine quarantines non-conforming
assets; attributions are compiled into video descriptions by code.
AI-generated media is labeled and triggers YouTube disclosure flags.

**Reasoning:** Dedupe and integrity come free with CAS; provenance as a
schema constraint (not a convention) is the only version that survives
contact with production; policy-as-code keeps it enforceable at render time.

**Rejected:** Cloud object storage from day one (cost/complexity, offline
dev); DB-stored blobs; "license info in the filename/description" folklore.

**Consequences:** GC policies required; scraping arbitrary image search is
banned by design; Wikimedia/Pexels-class APIs are the sanctioned sources.

---

## AD-10 — Shorts are a re-render from the scene graph, never a re-edit

**Context:** The long-form → Shorts pipeline could either post-process the
finished 16:9 video (crop/AI-reframe) or re-compose from source data.

**Decision:** Shorts pipeline = structural candidate scan of our own script
(code) + hook scoring (cheap cached LLM) + human selection + **vertical
re-composition from the scene graph** + re-render. Scene components must
declare 9:16 layout variants from Phase 1.

**Reasoning:** We uniquely *own* the scene graph — reframing a baked video
throws that away and reintroduces exactly the fragile AI dependency the
brief warns against. Structural candidates are higher quality because our
scripts are authored with beats/sections already.

**Rejected:** AI auto-reframe/saliency cropping; manual re-editing in a
video editor (defeats the purpose); treating Shorts as "free byproducts"
(they need hook rewrites, own QA, own approvals — planned cost, not magic).

**Consequences:** ~2× composition authoring effort per scene type; shorts
audio splices reuse existing TTS where boundaries permit (cached, free).

---

## AD-11 — Publishing: upload-kit first, API automation after audit

**Context:** YouTube Data API locks uploads from un-audited projects to
private; quota is 10k units/day (upload ≈ 1600).

**Decision:** Phase 5 ships `ManualPublisher` (system-produced upload kit:
master file, thumbnail, metadata, attributions, checklist) as the default
publishing path. API auto-upload is implemented behind the same `Publisher`
interface and enabled only after the project passes YouTube's API audit.
All uploads go private/unlisted first; quota is tracked and enforced like
money; scheduling/privacy flips are separate audited actions.

**Reasoning:** The audit is an external dependency with an uncontrolled
timeline; the upload kit preserves the entire approval/provenance chain
meanwhile and is honest about what $0 + unverified can do.

**Consequences:** "Fully automated → YOUTUBE" is explicitly deferred; demos
must not claim it until audit passes (tracked as OD-7).

---

## AD-12 — Security: no public surface; single-operator auth; encrypted tokens

**Context:** Single operator; secrets include API keys and a YouTube OAuth
refresh token with upload rights.

**Decision:** Dashboard binds localhost by default; remote access via
Tailscale/SSH tunnel. One `operator` identity with session auth when
exposed. Secrets only in env/keychain (`provider_account` stores env var
*names*); YouTube refresh token encrypted at rest. SSRF hygiene in the
media fetcher (block private IP ranges, size/time/MIME caps). Untrusted web
text treated strictly as data in LLM contexts; schema-validated outputs;
no AI-triggered actions. Append-only audit log.

**Reasoning:** Removing the public attack surface eliminates most of the
auth/threat problem for free — appropriate for a system whose only user is
its owner. Multi-user RBAC now would be speculative complexity.

**Consequences:** If multi-operator ever becomes real, auth is the first
thing that must be rebuilt (accepted; out of scope).

---

## AD-13 — Free tiers are metered budgets enforced in code

**Context:** The entire system runs on free tiers (LLM, TTS, search, CI
minutes, storage, YouTube quota) that can silently exhaust.

**Decision:** `provider_call_log` + `provider_account` track consumption per
quota window for *every* metered resource — including GitHub Actions minutes
and render seconds. Guards: fail-closed at caps, auto-degrade to Manual
providers at ~90%, aggressive content-hash caching (LLM, TTS, media,
rendered segments), 480p drafts for all review, full renders only after
approval.

**Reasoning:** "Design around $0" only works if $0 is *measured*; otherwise
the first surprise bill or quota wall stalls production mid-pipeline.
Cache-everything makes re-runs approximately free, which is also what makes
resumability economical.

**Consequences:** Every adapter must report usage; dashboards must show
budget status (it's an operator-critical metric, not a vanity chart).

---

## AD-14 — Deployment: one process anywhere; VM optional; no Docker requirement

**Context:** Docker is unavailable in the current dev environment; the
operator's machine is low-end; Oracle Always Free (4× ARM/24 GB) is the best
genuinely-free VM but capacity-limited.

**Decision:** Deployment target is `pnpm app --role all` on any Linux box
(laptop → free VM), systemd-managed, Litestream backup to R2, Tailscale for
access. A Dockerfile is provided from Phase 3 as an *option*, never a
requirement. No Kubernetes, no PaaS, no serverless.

**Reasoning:** PaaS free tiers are credits in disguise or sleep-based;
serverless is hostile to long renders; the monolith + SQLite + CAS design
makes "deployment" a file copy.

**Consequences:** Hosting choice stays open (→ OD-4); scaling out = adding
workers pointed at the same runner dispatch, not re-platforming.

---

## AD-15 — Phase gates: every phase ends in a watchable artifact

**Context:** The top project risk is building an elaborate system that never
produces a video.

**Decision:** Six phases (discovery §20), each with a demonstrable exit
artifact: Phase 0 resumable fake pipeline; Phase 1 one 60–90 s real video
end-to-end on $0; Phase 2 full claim traceability; Phase 3 full-length
episode; Phase 4 derived shorts; Phase 5 publishing (kit → audited API).
No later-phase code is written before the earlier gate passes. The explicit
do-not-build list (discovery §22) is binding for this planning session and
for Phase 0–1 execution.

**Reasoning:** The riskiest assumptions (render loop cost, voice quality,
license viability) are all tested in Phase 1; everything after is variation
on a proven theme.

**Consequences:** Features like multi-channel support, character rigging
depth, and CI render farms are deliberately deferred and must not be
sneaked into early phases.

---

## Open Decisions (must be resolved at the named gate)

| ID   | Question | Options | Resolve by | Owner input needed |
|------|----------|---------|------------|--------------------|
| **OD-1** | Is Remotion's license acceptable for a monetized solo channel? | (a) Remotion individual license — verify current terms; (b) Motion Canvas (MIT); (c) custom Puppeteer frame-capture layer | **Before Phase 1 code** | Yes — business/legal comfort |
| **OD-2** | Primary TTS voice: free-but-risky vs. paid-but-stable? | (a) Edge-TTS (unofficial, ToS/stability risk, $0); (b) Gemini TTS free chars; (c) paid tier (~$5–22/mo, e.g., ElevenLabs-class) — the one place the $0 rule may need to bend | Phase 1 | Yes — budget decision |
| **OD-3** | Primary LLM provider + pinned models per prompt-template version | Groq free tier / Gemini free tier / OpenRouter free models; pin exact model IDs in config | Phase 1 | Preference |
| **OD-4** | Where does the always-on app/worker live? | (a) Operator laptop; (b) Oracle Always Free ARM VM (signup capacity risk); (c) other free VM | Phase 3 | Yes — hardware availability |
| **OD-5** | Channel niche/topic domain | Determines research source mix, media license policy, character/style guide | Phase 2 | Yes — creative decision |
| **OD-6** | Keep DB-backed jobs or adopt a workflow engine later? | Default: keep. Revisit only if step types > ~40 or multi-host fan-out needed | Phase 4 review | No |
| **OD-7** | YouTube API audit application: when and with what demo? | Apply after Phase 4 (needs working pipeline demo + privacy policy + contact); until then ManualPublisher | Phase 5 | Yes — account details |
| **OD-8** | Allow AI-generated imagery per project policy? | Default: allow only labeled, non-realistic (diagram-ish) assets; disclosure flags automatic | Phase 3 | Yes — editorial stance |

---

## Decision Review Rules

- Any decision here can be revisited with a superseding entry (AD-xx
  marked *superseded*), never by silent edit.
- Decisions OD-1 and OD-2 are **blocking** for Phase 1 implementation.
- Nothing in this log authorizes building the production system; Phase 0
  scaffolding begins only after this plan is approved by the operator.
