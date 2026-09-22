# The operator dashboard (Phase 13)

`apps/nexus` is the single application: two entrypoints over one runtime, and the
first surface a human operates the pipeline through.

```
┌─────────────────────────── apps/nexus ────────────────────────────┐
│ server-entry.ts                worker-entry.ts                    │
│   buildApp() ─ HTML + forms      createPipelineWorker()           │
│   GET  pages (inspection)        12-task registry:                │
│   POST forms (decisions)           idea research fact_check       │
│          │                         script plan source_media       │
│          ▼                         voice captions animate         │
│   openRuntime(config)              render qa approval             │
│   ┌──────────────────────────────────────────────┐                │
│   │ SQLite (<dataDir>/nexus.db)  ·  CAS (<dataDir>/cas)           │
│   │ provider container (fake/manual/none/adapter) │                │
│   └──────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

Both entrypoints read the same validated env (`@nexus/config`) and open the same
data directory, so the dashboard sees exactly what the worker writes — the DB is
the read model, the CAS is the bytes.

## 1. What this phase is (and is not)

| Requested                    | Delivered                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Create an episode/project    | Home-page forms → `POST /projects`, `POST /episodes` (topic + optional outline)                        |
| Enter a topic                | The episode form; the `idea` stage normalises it before anything runs                                  |
| Start the pipeline           | `POST /episodes/:id/start` → idempotent job over the 12-stage dashboard pipeline                       |
| See current job state        | Episode page: state badge, gate banner, per-stage table (state/attempt/fingerprint/artifacts/errors)   |
| Inspect research             | `/episodes/:id/research` — questions, verification totals, claims with certainty + verbatim evidence   |
| Inspect sources              | `/episodes/:id/sources` — title, publisher, domain, licence, retrieval method                          |
| Inspect script               | `/episodes/:id/script` — sections, sentences, assertions, claim/source refs, the ledger, quality flags |
| Inspect scenes               | `/episodes/:id/scenes` — the manifest: types, windows, camera, assets with status/licence, raw JSON    |
| Inspect generated artifacts  | `/episodes/:id/artifacts` + `GET /artifacts/:hash` (typed bytes, download, inline player)              |
| Inspect QA results           | `/episodes/:id/qa` — verdict, publishable, per-check reports, findings with severity and fix hints     |
| Approve / reject             | Gate forms → `resolveGate` (fingerprint-bound decisions, AD-08)                                        |
| Retry eligible failed stages | `POST /jobs/:id/retry` → PENDING, re-enters at the failed stage; completed stages are reused unchanged |
| No YouTube publishing        | `publish` is not in the dashboard pipeline; no upload code exists                                      |

Not built (on purpose): client-side frameworks, live push (GAP-45), user
accounts/roles, episode editing beyond topic/outline, shorts (Phase 14), and any
visual polish beyond readable, responsive tables.

## 2. The dashboard pipeline

`DASHBOARD_PIPELINE` is `longform_v1` with `publish` removed: `idea → research →
fact_check → script → plan → source_media → voice → captions → animate → render
→ qa → approval`. The glue stages (which no engine owned) live in
`apps/nexus/src/pipeline.ts`:

- **`idea`** — normalises the operator's brief (topic, outline) into the job's
  first output; refuses an empty topic as a `PermanentError` before any
  provider is spent.
- **`fact_check`** — loads the research package, re-derives the review summary,
  and **parks the job at `FACT_REVIEW`** when `verification.reviewRequired`.
  The park carries the package artifact, so the gated document is attached to
  the step either way. An approval is bound to the package's fingerprint: a
  re-researched package parks again.
- **`source_media`** — resolves the plan's `planned` placeholder assets to
  `generated://plates/…` URIs (procedural plates, licence "generated") and
  republishes the manifest + a resolution report. With no media provider
  configured this is the honest path: the plates are visibly labelled, and QA
  reports them.
- **`animate`** — re-publishes the animated timeline artifact for the render
  stage.
- **`approval`** — the FINAL_APPROVAL gate; approving it completes the run
  (episode → READY). Publishing is excluded by instruction.

`fingerprintParams` exposes the cache-affecting configuration (provider ids,
plan fps/aspect, voice settings, render geometry, QA font settings) to the
stage fingerprints while excluding machine paths — the same run on another
machine produces the same hashes, which is what makes artifact reuse portable.

## 3. HTTP surface

Server-rendered HTML, no client framework, no client-side fetching. Every
mutation is a form POST that redirects (303) back to the page with `?error=`
or `?notice=` feedback — the browser's back button, reload and tab habits all
keep working, and there is no state on the client to lose.

```
GET  /                          studio home: episodes, projects, new-episode form
GET  /healthz                   liveness {status, env, version}
POST /projects                  create a project
POST /episodes                  create an episode (topic [+ outline])
POST /episodes/:id/start        start (or refuse to duplicate) the pipeline run
GET  /episodes/:id              job state, stage table, decisions, failure panel
GET  /episodes/:id/research     research package: questions, claims, evidence
GET  /episodes/:id/sources      sources with licences and retrieval methods
GET  /episodes/:id/script       script document + claims ledger
GET  /episodes/:id/scenes       scene manifest + assets
GET  /episodes/:id/artifacts    artifact table (+ inline video/thumbnail)
GET  /episodes/:id/qa           QA report: verdict, checks, findings, fixes
GET  /artifacts/:hash           raw artifact bytes (typed; ?download=1)
POST /jobs/:id/approve          approve the parked gate      ── decisions bind to
POST /jobs/:id/reject           reject → cancel              │  the fingerprint the
POST /jobs/:id/changes          needs-changes → rewind       │  operator saw (AD-08)
POST /jobs/:id/retry            retry a FAILED run           ──
```

Pages 404 honestly when a stage has not produced its document yet ("The script
stage has not produced a script yet") — a missing artifact is a fact, not an
error page.

## 4. Decisions in this phase

- **Server-rendered forms over a validated repo.** The app is a thin surface on
  `Repo` + `CasStore`; there is no second API and no client state to drift. The
  repo's validation is the validation.
- **Every gate decision carries `reviewedBy`.** The forms default to
  `dashboard` (the operator of record) and accept notes; the decision row, the
  job log and the audit trail all record it.
- **A blocked QA run must show its evidence** (CI-46): `PermanentError` carries
  the registered report artifacts, `failStep` keeps them on the FAILED step,
  and the QA page resolves the report from there when the step output is empty.
- **One upstream object per gate adoption** (CI-45): the checkpointed output
  and the in-memory upstream are the same object, so the pass after an approval
  recomputes the same downstream fingerprints and skips unchanged stages.
- **A coherent offline demo** (CI-47/GAP-44): with the fake LLM selected, the
  runtime installs a responder that quotes the fake search rows verbatim and
  writes only from the prompt's own FACT/REPORT lists. Nothing invented, every
  real gate still runs; with `none`/`manual`, the run parks for a human.
- **A shipped QA tolerance interim** (GAP-43): the plan's reading room means
  the spoken track runs shorter than the plan; until a retiming stage exists,
  the dashboard defaults `NEXUS_QA_DURATION_TOLERANCE_SEC=15`
  (`env-defaults.ts`) and documents why in one place.

## 5. Tests

- `pipeline.test.ts` — the glue stages in isolation: graph shape (12 steps, no
  publish), fingerprint param exposure/exclusions, idea normalisation and the
  empty-topic refusal, fact_check park/clear/missing-package, source_media
  resolve/no-op/republish, animate artifact, approval park.
- `app.test.ts` — five end-to-end tests over `buildApp` + `createPipelineWorker`
  with a scripted FFmpeg: the full walk (create → start → FACT_REVIEW approve →
  inspect every page → FINAL_APPROVAL → DONE/READY with real artifacts on every
  page), reject-at-gate, needs-changes rewind, QA-blocked retry (env-tuned
  `NEXUS_QA_MIN_FONT_PX`), and forms/health/duplicate-start.
- `tests/integration/app.test.ts` — the workspace wiring from outside the app
  (config → runtime → routes, health, home).
- `tests/integration/worker.test.ts` — the worker role against a real data
  directory: a live run to `FACT_REVIEW`, then a bound rejection.

## 6. Deliberate gaps

See `docs/plans/ISSUES.md`: GAP-43 (no retiming stage → shipped QA tolerance),
GAP-44 (the offline walk is a coherent demo, not research), GAP-45 (reload to
refresh status).
