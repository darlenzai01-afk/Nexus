# Job Orchestration (Phase 3)

Status: **implemented** — `packages/jobs` (engine) + `packages/db` migration
`0002_job_orchestration` (persistence). Governing decisions: AD-05 (DB-backed
job state machine with leases, no workflow engine), AD-08 (fingerprinted human
approvals), AD-13 (free tiers are metered budgets).

> **One sentence:** a stage runs at most once per fingerprint, and every run is
> checkpointed, so a crash, a retry, a duplicate submission or a brand-new job
> resumes from the last completed stage instead of redoing work.

---

## 1. State vocabulary: what was requested → what shipped

The requested state lists are a _stage_ vocabulary (`RESEARCHING` …
`RESEARCH_COMPLETE`). They are implemented exactly, on the layer that owns
stage progress, without widening the `episodes.state` CHECK constraint (SQLite
cannot alter a CHECK in place, and rebuilding tables is forbidden by the
project's safety rules — see §7).

Three levels, three lifetimes:

| Level       | Stored in                                                        | Owns                            | Answers                                      |
| ----------- | ---------------------------------------------------------------- | ------------------------------- | -------------------------------------------- |
| **Episode** | `episodes.state` (Phase 2 enum, unchanged)                       | the coarse lifecycle            | "what is happening to this episode?"         |
| **Job**     | `pipeline_jobs.state` + `attempt`/`next_attempt_at`/`error_kind` | one run of one pipeline         | "is this run alive, parked, retrying, done?" |
| **Stage**   | `pipeline_job_steps.state` + `input_hash` + `artifacts`          | resumability, reuse, provenance | "which work is done, and with what inputs?"  |

The requested vocabulary maps onto stage labels (`stageStateLabel()`), which are
available in the status view and the job log:

### Long-form — pipeline `longform_v1`

| Requested state                                    | Implemented as                                                                  | Episode state while/after             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------- |
| `IDEA`                                             | stage `idea` (label `IDEA`; `IDEA_COMPLETE` when done)                          | `QUEUED` → `RESEARCHING`              |
| `RESEARCHING` / `RESEARCH_COMPLETE`                | stage `research`                                                                | `RESEARCHING` → `FACT_CHECKING`       |
| _(not requested, required by the plan §7.1/AD-07)_ | stage `fact_check` (`FACT_CHECKING` / `FACT_CHECK_COMPLETE`)                    | `FACT_CHECKING` → `SCRIPTING`         |
| `SCRIPTING` / `SCRIPT_COMPLETE`                    | stage `script`                                                                  | `SCRIPTING` → `SCENE_PLANNING`        |
| `PLANNING` / `PLAN_COMPLETE`                       | stage `plan` (scene + timing plan)                                              | `SCENE_PLANNING` → `MEDIA_GATHERING`  |
| `SOURCING_MEDIA` / `MEDIA_COMPLETE`                | stage `source_media`                                                            | `MEDIA_GATHERING` → `VOICE_SYNTHESIS` |
| `GENERATING_VOICE` / `VOICE_COMPLETE`              | stage `voice`                                                                   | `VOICE_SYNTHESIS` → `CAPTIONING`      |
| _(not requested, required by the plan §7.1)_       | stage `captions` (`CAPTIONING` / `CAPTIONS_COMPLETE`)                           | `CAPTIONING` → `COMPOSITING`          |
| `BUILDING_ANIMATION` / `ANIMATION_COMPLETE`        | stage `animate`                                                                 | `COMPOSITING` → `RENDERING`           |
| `RENDERING` / `RENDER_COMPLETE`                    | stage `render`                                                                  | `RENDERING` → `QA`                    |
| `QA`                                               | stage `qa` (`QA` / `QA_COMPLETE`)                                               | `QA` → `APPROVAL`                     |
| `AWAITING_APPROVAL`                                | stage `approval` **WAITING**, job `WAITING_GATE`, gate `FINAL_APPROVAL`         | `APPROVAL`                            |
| `APPROVED`                                         | stage `approval` DONE + an `approvals` row bound to the content fingerprint     | `READY`                               |
| `PUBLISHING` / `PUBLISHED`                         | stage `publish`                                                                 | `PUBLISHING` → `PUBLISHED`            |
| `FAILED`                                           | job `FAILED` + episode `FAILED`, with `error_kind` = `permanent` \| `exhausted` | terminal                              |

### Short-form — pipeline `shorts_v1`

| Requested state                 | Implemented as                                        | Episode state while/after      |
| ------------------------------- | ----------------------------------------------------- | ------------------------------ |
| `SHORT_ANALYZING`               | stage `short_analyze`                                 | `QUEUED` → `SCENE_PLANNING`    |
| `CANDIDATES_FOUND`              | `short_analyze` DONE                                  | —                              |
| `SELECTING`                     | stage `short_select` (`SELECTION_COMPLETE` when done) | `SCENE_PLANNING` → `SCRIPTING` |
| `REWRITING`                     | stage `short_rewrite` (`REWRITE_COMPLETE`)            | `SCRIPTING` → `COMPOSITING`    |
| `VERTICAL_LAYOUT`               | stage `short_layout` (`LAYOUT_COMPLETE`)              | `COMPOSITING` → `RENDERING`    |
| `RENDERING` / `RENDER_COMPLETE` | stage `short_render`                                  | `RENDERING` → `QA`             |
| `QA`                            | stage `short_qa`                                      | `QA` → `APPROVAL`              |
| `AWAITING_APPROVAL`             | stage `short_approval` WAITING, gate `SHORT_APPROVAL` | `APPROVAL`                     |
| `APPROVED`                      | stage `short_approval` DONE + approval row            | `READY`                        |
| `PUBLISHED`                     | stage `short_publish` DONE                            | `PUBLISHING` → `PUBLISHED`     |
| `FAILED`                        | job `FAILED` + episode `FAILED`                       | terminal                       |

Two "extra" stages (`fact_check`, `captions`) come straight from the approved
architecture (§7.1 lifecycle and the discovery's captions stage); omitting them
would silently drop the plan's fact-check guarantee (AD-07) and the caption
artifact. Everything else in both requested lists exists verbatim as a label.

Naming rule for every stage: `<ACTIVITY>` while it runs, `<ACTIVITY>_COMPLETE`
once its artifacts exist, `<ACTIVITY>_FAILED` when it failed, and
`<ACTIVITY>_INTERRUPTED` when a crash left it mid-flight (derived from
`started_at` + the job's state — see §7).

## 2. State machines (`packages/jobs/src/machines.ts`)

Three explicit transition tables; every mutation in the orchestration layer goes
through `assertEpisodeTransition` / `assertJobTransition` / `assertStepTransition`,
so an illegal jump is a thrown `InvalidTransitionError` (and a failing test)
rather than a corrupt row. Highlights:

- **Episode (long):** the happy path is strictly forward. `PUBLISHED` is
  terminal. `FAILED` is _resumable_ (plan §7.1): it may re-enter the responsible
  stage. `NEEDS_CHANGES` may only rewind. `CANCELED → QUEUED` is the explicit
  requeue.
- **Episode (short):** the same states minus the long-form-only ones
  (`RESEARCHING`, `FACT_CHECKING`, `MEDIA_GATHERING`, `VOICE_SYNTHESIS`, …), which
  are unreachable for a short: a short analyzes an existing long-form episode.
- **Job:** `PENDING → RUNNING → {DONE, FAILED, WAITING_GATE, PENDING}`;
  `FAILED → PENDING` is operator retry; `WAITING_GATE → PENDING` is a resolved
  gate. `DONE`/`CANCELED` are terminal.
- **Stage:** `PENDING → {PENDING (start/retry), DONE (ran or reused), WAITING
(gate), FAILED}`; `DONE → PENDING` only ever means invalidation.

A test asserts **machine ⇄ stage-graph consistency**: every declared stage's
`episodeStateOnStart → episodeStateOnComplete` and every hand-off between
consecutive stages must be a legal episode transition. The pipeline definition
therefore cannot drift from the state machine.

## 3. Stages, fingerprints and the reuse contract

**Stage fingerprint** = `sha256(pipeline | stage | canonical(job inputs, upstream
outputs) | cache-affecting config)`. It deliberately excludes ids and
timestamps, so _the same work on the same content in the same project produces
the same hash anywhere_. Provider ids and template versions are part of the
config, so switching a provider invalidates the stages it produced.

The fingerprint is stored as the step's `input_hash` (Phase 2's field — one
identity, not two), and it powers three behaviours:

1. **Resume (no duplicate work):** a step that is `DONE` with a matching
   `input_hash` is skipped (`stage.skipped.completed` in the log).
2. **Invalidation:** a step that is `DONE` with a _different_ hash means
   upstream content changed — the step and everything after it are reset to
   `PENDING` (`stage.invalidated`), then re-run in order.
3. **Reuse (no duplicate _execution_):** before executing, the runner asks the
   database whether **any** job has already completed this exact stage from
   this exact fingerprint (`findCompletedStageRun`). If it has, the output and
   artifact references are adopted verbatim — `reused_from_job_id` records
   where they came from, `stage.reused` is logged and audited, and the task is
   never invoked.

**Reuse safety rules** (all enforced in `runner.ts: tryAdopt`):

- every referenced artifact must be registered in `artifacts` **and**, when the
  app supplies a CAS probe, the bytes must still exist — otherwise the reuse is
  rejected (`stage.reuse.rejected`) and the stage executes normally, so a
  missing blob degrades to re-work instead of a phantom result;
- a **canceled** job never donates artifacts;
- a job never reuses its own run (that is the resume path, not reuse);
- a task may veto adoption via `validateReuse(ctx, run)` (e.g. "the WAV does not
  parse") — it then re-executes;
- gates are never reused: an approval is a **per-episode human decision**, even
  when the underlying content is byte-identical.

## 4. Retry, failure and recovery

- **Error taxonomy** (`errors.ts`): `RetryableError` (provider blip / rate
  limit), `PermanentError` (bad input, missing artifact), `ConfigurationError`
  (broken wiring — never retried, always fatal). Anything unrecognised is treated
  as retryable but _bounded_, so a bug cannot burn a quota forever.
- **Backoff:** exponential with a ceiling and optional jitter
  (`retry.ts`); the delay is persisted as `next_attempt_at`, and `claimJob`
  refuses to hand out a job whose backoff has not elapsed. A retry therefore
  survives a restart exactly like any other parked work.
- **Ceilings:** `pipeline_jobs.max_attempts` (default 3) or a per-stage
  override; stage attempts are counted by `pipeline_job_steps.attempt`.
- **Failure kinds** (`pipeline_jobs.error_kind`): `permanent`, `exhausted`,
  `retryable` (a scheduled retry), `canceled`.
- **Operator recovery:** `retryFailedJob(repo, jobId)` returns a `FAILED` job to
  `PENDING`; the runner re-enters at the **failed stage** and skips everything
  already checkpointed.
- **Provider quota:** a task returns `{ waiting: "QUOTA" }` instead of throwing —
  the job parks (plan §7.2 `PARKED(quota)`) and costs nothing until it is
  resolved, rather than failing and losing its progress.

## 5. Gates (AD-08)

- **Mandatory gates** are declared by the pipeline (`approval` →
  `FINAL_APPROVAL`, `short_approval` → `SHORT_APPROVAL`). The runner parks the
  job _before_ executing anything for that stage: job `WAITING_GATE`, stage
  `WAITING`, **fingerprint written before parking**, and the lease released — a
  parked job holds no resources and no timer.
- **Ad-hoc gates**: a task that cannot proceed (unsupported claims → the plan's
  `FACT_REVIEW`) returns `{ waiting: "FACT_REVIEW" }`. Same mechanism, so any
  stage can request a human decision without a schema change.
- **Resolution** (`resolveGate`): `approved` → job `PENDING`, an `approvals` row
  is recorded **bound to the parked fingerprint**, and the runner verifies on
  resume that the fingerprint still matches — if content changed while the
  operator was away, the approval is invalid and the job parks again ("approved
  v3, published v4" cannot happen). `rejected` → the stage fails, the job is
  `CANCELED`, the episode moves to `NEEDS_CHANGES`. `needs_changes` with a
  `targetStage` → that stage and everything downstream is invalidated and the job
  resumes from there (re-record one sentence without re-rendering the world).

## 6. Worker / task abstraction (`worker.ts`, `types.ts`)

- A **`Task`** only knows how to do its job: read inputs, return
  `{ output, artifacts }` (or `{ waiting }`). It never touches job state, leases,
  retries or the log — the runner owns all of that, so a task cannot corrupt
  orchestration and is trivially unit-testable.
- A **`TaskRegistry`** maps stage keys to tasks and fails fast at startup
  (`assertCovers`) if the pipeline declares a stage this worker cannot execute —
  a missing handler discovered mid-run would strand a job.
- A **`Worker`** is a claim loop: `tick()` claims the oldest runnable job and
  runs it; `drain()` works the queue until nothing is claimable; `start()/stop()`
  run it in the background. Leases are heartbeated at a third of the lease
  length while a task runs, so long renders are never stolen.
- **Shutdown:** `stop()` aborts the signal and the runner stops _between_ stages,
  leaving the job leased with every completed stage checkpointed; if a task
  ignores the signal, `stop({ timeoutMs })` gives up waiting and logs
  `worker.stop_timeout` — shutdown never depends on a task being well-behaved.
  The abandoned job is picked up when its lease expires.
- **Concurrency:** one job per claim, one lease per job, enforced by data
  (`claimJob` runs inside `BEGIN IMMEDIATE`), not by the loop being careful.

## 7. Persistence notes (and one deliberate deviation)

- Migration `0002_job_orchestration` is **additive only**: new columns on
  `pipeline_jobs` (`idempotency_key`, `max_attempts`, `next_attempt_at`,
  `heartbeat_at`, `error_kind`, `failure_step`), new columns on
  `pipeline_job_steps` (`artifacts`, `reused_from_job_id`, `reused_from_step_key`),
  two indexes and the `job_logs` table. Nothing is rebuilt, dropped or rewritten;
  the Phase 2 drift guard still refuses to run an edited migration.
- **`RUNNING` is not a persisted stage state.** The shipped CHECK constraint
  allows `PENDING/DONE/FAILED/WAITING` and SQLite cannot widen a CHECK without a
  table rebuild (forbidden). "In flight" is therefore _derived_: a step is
  running when its **job is `RUNNING`** and the step has `started_at` but is not
  `DONE`. This is not a workaround for cosmetics — it is why the requested
  `..._COMPLETE` vocabulary needs no schema change at all, and why an
  interrupted stage shows as `..._INTERRUPTED` rather than a stuck row.
- **Idempotent submission:** `idempotency_key` has a unique (partial) index;
  `createJob` returns the existing job for a repeated key instead of creating a
  second run.
- **Job log:** `job_logs` is append-only (`level`, `event`, `message`, `data`,
  `created_at`, cascade with the job) and is what the status view reads.
  Retention/compaction is not implemented (see `ISSUES.md`).
- **Timestamps** are ISO-8601 UTC everywhere: `created_at`/`updated_at` on jobs,
  `started_at`/`finished_at` per stage, `heartbeat_at` as a durable "last known
  alive" stamp (kept after a job parks or finishes, for triage), `next_attempt_at`
  for scheduled retries.

## 8. How this was verified

```bash
pnpm verify                 # format check + lint + typecheck + build + all tests
pnpm test packages/jobs     # 4 files / 64 tests — the orchestration engine
pnpm test tests/integration # app + worker + cross-process orchestration (real files)
```

Beyond unit tests, the engine was driven from the built `dist/` against a
file-backed database to confirm operator-visible behaviour end to end:

| Scenario                                            | Observed                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold run to the mandatory gate                      | 11 stages executed, job `WAITING_GATE`, episode `APPROVAL`, status `Approval → AWAITING_APPROVAL`                                                                                           |
| Approve and finish                                  | job `DONE`, episode `PUBLISHED`, 12 executions total                                                                                                                                        |
| Duplicate submission (same idempotency key)         | returns the existing job — one job row, nothing re-run, nothing left to claim                                                                                                               |
| Second episode, identical content                   | **0 executions and 0 new blobs**; 12 stages adopted with `reused_from_job_id` provenance; episode `PUBLISHED`                                                                               |
| `needs_changes` targeting `voice`                   | 7 stages invalidated; `script` not re-run, `voice` re-run and everything after it                                                                                                           |
| Process death after `script` (abort + lease expiry) | job left `RUNNING` with 4 checkpoints, next stage `PLANNING_PENDING`; a new worker reclaimed it and every stage still ran **exactly once**                                                  |
| Re-running a finished episode                       | satisfied entirely from artifacts; the fingerprint-bound approval is honoured, `PUBLISHED` is not re-entered, and any refused episode transition is logged as `episode.transition.rejected` |

## 9. What Phase 3 deliberately does not include

- **No pipeline task implementations** (research, script, TTS, render, publish):
  tasks arrive in the next phase; the graph, gates, retries and reuse machinery
  they plug into are complete and tested with fake tasks.
- **No HTTP surface yet**: `getJobStatus()` is the read model; routes (and the
  dashboard) land with the pipeline phase so they expose real work.
- **No quota enforcement**: `provider_accounts`/`provider_call_log` exist
  (Phase 2) and tasks can park on quota, but the budget guard is wired when real
  providers are (AD-13).
- **No log retention policy**, no CAS garbage collection (GAP-7), no
  cross-host queue semantics (single-writer SQLite by design, OD-6).
