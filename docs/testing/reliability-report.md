# Reliability report — hostile pass over the Nexus Forge pipeline

**Scope:** the 25 failure scenarios from the reliability brief, reproduced against test
environments and mock providers only — fake LLM/research/TTS/publishers, scripted FFmpeg,
in-memory or temporary storage. No network, no keys, no paid calls, nothing published, no
production system touched.

**Method.** For every scenario: state the behavior an operator depends on → reproduce the
attack in a test → record what the system actually did → identify the defect (if any) → fix
only safe defects → pin the outcome with a regression test. Every "fixed" verdict below cites
the test that demonstrates the fix; nothing is claimed fixed on inspection alone.

**Where the tests live**

- `tests/reliability/providers.test.ts` — scenarios 1, 2, 3, 4, 5, 6, 7, 22, 23, 25.
- `tests/reliability/pipeline.test.ts` — scenarios 8–21, 24.

**Verdicts:** 22 held as designed (now pinned), 3 defects found and fixed (RL-1…RL-3), plus
2 design-accepted behaviors recorded with their rationale (RL-4, RL-5) and 1 scope boundary
(RL-6). Full suite after the pass: **84 files / 964 tests passing** (+3 skipped),
format/lint/tsc clean.

---

## Scenario results

| #   | Scenario                      | Expected behavior                                                                                                            | Reproduction → actual behavior                                                                                                                                                                                                                 | Verdict                                           |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | AI provider timeout           | Deadline aborts the call; error is `timeout`, retryable; attempts bounded by policy; every attempt logged                    | `providers.test.ts` #1: adapter ignores its deadline; invoke aborts, retries, throws `ProviderTimeoutError` after exactly `maxAttempts` calls; log shows one `provider.call.retry` + one `provider.call.error`                                 | 🟢 held                                           |
| 2   | AI quota exhaustion           | Refused BEFORE any provider call; fail-closed (`quota`, non-retryable); refusal logged                                       | `providers.test.ts` #2: budget window burned → next call throws `ProviderQuotaError`, `retryable === false`, execute called 0 times, `provider.quota.blocked` logged                                                                           | 🟢 held                                           |
| 3   | Malformed AI JSON             | Garbage never accepted as truth; bounded repair; surfaces as retryable `content` error                                       | `providers.test.ts` #3: a model that always answers off-schema → repair round runs once → `ProviderContentError` ("could not satisfy the schema"); engines re-validate everything they parse (`validateStructured`)                            | 🟢 held                                           |
| 4   | Research provider failure     | Failure surfaces (never silence); step recorded as partial; app layer turns it into a job failure                            | `providers.test.ts` #4: dead search provider → `runResearch` records the failed step (`outcome: "partial"`, note with the error) and rethrows `ProviderUnavailableError` (retryable)                                                           | 🟢 held                                           |
| 5   | Duplicate source              | Same URL → one source (`duplicate_url`); same content under new URL → dropped (`duplicate_content`); re-runs never duplicate | `providers.test.ts` #5: three colliding rows + one good row → 2 sources kept, both drop reasons recorded, sources unique                                                                                                                       | 🟢 held                                           |
| 6   | Conflicting sources           | Conflict preserved verbatim (both sides), claims capped (`confidence ≤ 0.4`, `mayStateAsFact=false`), human review demanded  | `providers.test.ts` #6: two sources state different counts → conflict recorded with both sides, both claims contested and capped, `verification.reviewRequired` true                                                                           | 🟢 held                                           |
| 7   | TTS failure                   | Failed segments park the run (`waiting`), failures recorded per scene, nothing fabricated, retries bounded                   | `providers.test.ts` #7: dead TTS → `waiting: true`, `failedSegments` = every scene, `provider_failed` issues, 0 clips invented. (A provider without voices fails closed earlier with `voice_unavailable` — also observed during reproduction.) | 🟢 held                                           |
| 8   | Missing audio                 | QA reports the missing narration; it is never silently ignored                                                               | `pipeline.test.ts` #8: evidence without a narration track → `audio_missing` finding on the report                                                                                                                                              | 🟢 held                                           |
| 9   | Unavailable media             | A scene that draws media no stage sourced is blocked                                                                         | `pipeline.test.ts` #9: `planned` asset drawn by a scene → `visual_asset_missing`, `publishable: false`                                                                                                                                         | 🟢 held                                           |
| 10  | Invalid media metadata        | Schema refuses nonsense metadata; metadata that "passes" but means no file is still refused by QA                            | `pipeline.test.ts` #10: unknown orientation → schema rejects; `status: resolved` with empty `uri` → QA `visual_asset_missing`, blocked                                                                                                         | 🟢 held                                           |
| 11  | Missing character asset       | QA reports cast members whose layer files are missing or changed                                                             | `pipeline.test.ts` #11: character library audit reports a lost layer file → `visual_asset_reference_broken`, blocked                                                                                                                           | 🟢 held                                           |
| 12  | Broken scene reference        | Plans referencing nonexistent scenes/assets are refused at validation                                                        | `pipeline.test.ts` #12: dangling `toSceneId` → `validateSceneManifest` fails naming the ghost; dangling media asset id → schema rejects                                                                                                        | 🟢 held                                           |
| 13  | Render failure                | Failure fails the job AT render; permanent errors don't burn retries                                                         | `pipeline.test.ts` #13: scripted FFmpeg failure → job `FAILED` at `render`, attempt 1 for a permanent error                                                                                                                                    | 🟢 held                                           |
| 14  | Corrupted output              | The container is re-parsed before anything ships; corruption blocks                                                          | `pipeline.test.ts` #14: valid render, bytes replaced with garbage → QA `video_corrupted`, `publishable: false`                                                                                                                                 | 🟢 held                                           |
| 15  | Worker restart                | A dead worker's expired lease is reclaimable; the restarted worker finishes the job                                          | `pipeline.test.ts` #15: worker A claims and dies; lease expires; worker B reclaims (attempt counted) and completes                                                                                                                             | 🟢 held                                           |
| 16  | Duplicate job execution       | Claims are exclusive; duplicate submissions are one job                                                                      | `pipeline.test.ts` #16: second concurrent claim gets nothing; same idempotency key returns the existing job with its step list intact                                                                                                          | 🟢 held                                           |
| 17  | Stale job                     | A zombie worker cannot resurrect or corrupt a finished job; losing the lease is survivable                                   | `pipeline.test.ts` #17: zombie runs a job that finished under another owner → refused (`DONE` skip), no stage re-executes, state intact                                                                                                        | 🟢 held (RL-5 for the expired-lease overlap case) |
| 18  | Interrupted pipeline          | A new run resumes from checkpoints: completed stages adopted, only the interrupted stage re-runs                             | `pipeline.test.ts` #18: run fails at render after plan+voice; new run adopts plan+voice (`reused_from_job_id`), re-runs render exactly once, completes                                                                                         | 🟢 held                                           |
| 19  | Database interruption         | Closed DB fails loudly, never silently; committed data survives (WAL)                                                        | `pipeline.test.ts` #19: write → close → every call throws; reopening the file shows the committed episode                                                                                                                                      | 🟢 held                                           |
| 20  | Artifact access violation     | The artifact store refuses malformed hashes; no path traversal                                                               | `pipeline.test.ts` #20: `read("../../../etc/hostname")` **returned bytes from outside the store**                                                                                                                                              | 🔴 **defect fixed (RL-1)**                        |
| 21  | Unauthorized approval attempt | Approvals only resolve parked, fingerprint-matched gates; unknown jobs and non-parked jobs are refused; nothing recorded     | `pipeline.test.ts` #21: approve on RUNNING job → refused, zero approval rows; unknown job → refused with error flash; `latestValidApproval` for a foreign fingerprint → none                                                                   | 🟢 held (RL-6 for auth)                           |
| 22  | YouTube upload failure        | A refused upload surfaces as a bounded retryable failure; no ref, no record; QA/approval gates re-checked in the task        | `providers.test.ts` #22: upload refusal → `ProviderUnavailableError`, bounded, logged. Gate-side refusals pinned by `apps/nexus/src/publish.test.ts` (QA-blocked/needs-approval episodes create no upload)                                     | 🟢 held                                           |
| 23  | Network interruption          | A raw socket break is classified retryable-unavailable and bounded                                                           | `providers.test.ts` #23: `TypeError("fetch failed: ECONNRESET")` → `ProviderUnavailableError`, exactly `maxAttempts` calls                                                                                                                     | 🟢 held                                           |
| 24  | Repeated retry                | Retries are bounded by an exact ceiling; a post-exhaustion retry cannot execute the failing stage again                      | `pipeline.test.ts` #24: always-failing render → exactly 3 attempts → `FAILED`; operator retry → re-enters PENDING and fails at the ceiling **without a fourth execution**                                                                      | 🟢 held (fix RL-3 demonstrates it)                |
| 25  | Provider recovery             | A provider that comes back is used: first call fails, retry succeeds, both on the record                                     | `providers.test.ts` #25: `failFirst: 1` → success on attempt 2; log shows `provider.call.retry` then `provider.call.ok`                                                                                                                        | 🟢 held                                           |

---

## Defects found and fixed

### RL-1 — The artifact store accepted any string as a "hash" (path traversal)

- **Found by:** scenario 20. `CasStore.pathFor` joined the raw string into the store path, so
  `read("../../../etc/hostname")` resolved outside the store and **returned the file's bytes**;
  `has()` confirmed files outside the store.
- **Why it matters:** every artifact access (QA, render, publish, dashboard artifact views)
  funnels through this one method. A malformed hash from any document or route parameter was
  a file-read primitive outside the data directory.
- **Fix:** `pathFor` validates sha-256 hex (the only legal artifact address) and throws on
  anything else; `has()`/`getPath()` answer `false`/`undefined` for malformed input so probes
  don't crash; `read()` throws a clear "blob not found".
- **Demonstrated by:** `pipeline.test.ts` #20 — five hostile hash shapes (traversal, absolute
  path, wrong length, embedded traversal) all refused; a legitimate artifact still round-trips.

### RL-2 — `runJob` executed FAILED jobs and died mid-run

- **Found by:** scenarios 17/24 while probing zombie/stale states. `runJob` refused
  `DONE`/`CANCELED` jobs but not `FAILED` ones: it re-entered the stage list and crashed on
  the illegal `FAILED → DONE` transition — and, before crashing, re-executed stages without
  any attempt bookkeeping.
- **Why it matters:** a stale process or a caller bug could burn provider calls against a job
  the operator had already closed, then die half-way.
- **Fix:** the runner refuses FAILED jobs at entry (`skipped`): the operator retries them
  (which moves them back to PENDING) or starts a new run that adopts their completed stages.
- **Demonstrated by:** `pipeline.test.ts` #18 (the recovery path for a failed run is a new run
  that adopts plan+voice via `reused_from_job_id` and re-runs only render) and #24; the
  existing orchestration suite (resume, retry, gates) passes unchanged.

### RL-3 — An operator's retry was silently delayed by a stale backoff window

- **Found by:** scenario 24. `retryFailedJob` (and the `needs_changes` rewind) moved the job
  back to PENDING but left `next_attempt_at` set from the failed attempts — so the worker's
  claim loop (which filters on `next_attempt_at`) ignored the operator's decision until the
  old backoff window elapsed, and a same-instant operator retry appeared to do nothing.
- **Why it matters:** the operator explicitly decided; the pipeline silently deferred the
  decision with no feedback — the classic "I pressed retry and nothing happened".
- **Fix:** `setJobState` gained `resetRetry`, and both operator paths (`retryFailedJob`,
  `needs_changes`) clear `next_attempt_at` so the job is claimable immediately.
- **Demonstrated by:** `pipeline.test.ts` #24 — after the operator retry the job is claimed
  immediately, the entry ceiling refuses it (no fourth execution), and the run is `FAILED`
  with the reason on the record; `packages/jobs` retry/gate suites pass unchanged.

## Design-accepted behaviors (recorded, not defects)

### RL-4 — Retry backoff is a claim-time rule, not an engine rule

`runJob` trusts its caller for eligibility; the claim (`claimJob`) is where exclusivity,
attempt counting and the retry backoff are enforced. The production worker always claims
before running, so the backoff holds on the real path (and the orchestration suite simulates
backoff elapsing the same way). A caller that bypasses the claim can drive the engine directly —
that is the engine's contract, bounded by the stage-attempt ceiling at the engine level too.

### RL-5 — An expired-lease worker may still checkpoint

The heartbeat design documents the choice: a worker that loses its lease logs
`lease.renew_failed` and keeps going, because every checkpoint is fingerprinted — a second
worker's identical work collapses onto the same artifacts (deterministic engines, CAS
addresses). The zombie cannot touch a finished or foreignly-_claimed-finished_ job (scenario
17), and overlapping work on an expired lease converges instead of corrupting.

### RL-6 — The dashboard has no authentication layer

The operator dashboard is a local tool (documented in `docs/architecture/dashboard.md`); adding
authentication would be a new product feature, out of scope for a reliability pass. What this
pass pins instead: gate decisions cannot be recorded against unknown jobs or non-parked runs,
approvals are bound to the parked content's fingerprint (a stale decision cannot authorize new
content), and refused attempts record nothing.

## Coverage notes

- Existing suites already covered large parts of scenarios 5, 6 and 22 (research duplicates/
  conflicts; publish-gate refusals; the YouTube adapter against a scripted transport). The new
  tests reproduce these independently and pin the pipeline-level consequences.
- The probe suite adds 25 tests; no pre-existing test was weakened. The three fixes are
  behavioral tightenings (refusals) plus one operator-latency fix (RL-3) — each pinned by both
  the new hostile tests and the pre-existing suites they touch.
