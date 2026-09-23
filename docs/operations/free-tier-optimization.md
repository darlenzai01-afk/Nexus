# Free-tier optimization — resource-consumption audit (Phase 19)

**Goal:** maximum automation with minimum AI/API/cloud usage — audited across the whole
system, measured (not assumed) by counting **paid provider calls**, and pinned with
regression tests. Factual integrity, reliability and output quality were not traded away:
every optimization here either removes work whose output would be byte-identical, or refuses
work that has nothing to do.

**Method.** The provider layer keeps a ledger of every call (`provider_calls`: operation,
units, status). Real calls carry `units > 0`; cache hits log `units = 0`. The regression
suite (`tests/resource-efficiency.test.ts`, FO-1…FO-4) drives the real orchestrator, mock
providers and scripted FFmpeg through whole pipeline runs and counts ledger rows — so the
claims below are demonstrated end to end, in a safe test environment (no network, no keys,
nothing published).

**Suite after the pass:** 88 files / 1 002 tests passing (+3 skipped); format/lint/tsc clean.

---

## Measured guarantees (regression-pinned)

| #    | Guarantee                                                                                                                                                                                                                         | Measurement                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| FO-1 | A needs-changes rewind that changes nothing upstream costs **zero paid provider calls** — script, plan, media, animation, voice, captions, render, QA all re-execute from the artifact/invoke caches and the run re-parks healthy | whole longform run paid N calls; after the rewind: **0** new paid rows, run completes DONE |
| FO-2 | A **second episode on the same topic** costs **zero paid provider calls** — questions, discovery, extraction, reconciliation, conflicts, script and voice all come from the durable provider cache                                | second episode, identical topic: **0** new paid rows across its entire pipeline            |
| FO-3 | A genuinely new topic **does** pay (bounded, then cached for every future reuse) — the system never confuses "new work" with "cached work"                                                                                        | new topic: > 0 paid rows, run completes                                                    |
| FO-4 | Changing **one scene's narration** re-synthesizes **exactly one** TTS segment; every unchanged line is a cache hit — and the duration "probe" is free (parsed from the WAV bytes, never an extra synthesis call)                  | 5-scene track: 5 calls; change one scene: **+1** call, 4 cache hits                        |

The durability behind FO-1/FO-2: every metered call's cache key is
`hash(provider, operation, inputs)` — excluding ids and timestamps, order-insensitive — and
hits are stored in a **durable file cache** (`<dataDir>/cache/providers`, default
`NEXUS_PROVIDER_CACHE=on`, atomic writes, corrupt entries degrade to a fresh call after
re-validating against the caller's schema). Cache survives process restarts: a re-run after a
crash re-pays nothing.

## Defects found by the measurement (fixed, regression-pinned)

The FO-1 probe initially could not even complete — the operator rewind flow was broken twice
over. Both fixes are preconditions for the free-tier guarantee (a rewind that spuriously
fails pushes operators into full re-runs, which is the most expensive outcome possible):

- **REW-1 — a needs-changes rewind left the episode parked at the gate state.** The job's
  steps rewound, but the episode state machine stayed at its gate state (e.g. APPROVAL), so
  the rewound run re-entered early stages "from the future" and QA's consistency check failed
  the run (`pipeline_invalid_state`) — the operator's rewind became a spurious FAILED run.
  Fix (`gates.ts` + `machines.ts`): the rewind now walks the episode backwards along the
  shortest path the state machine itself declares (`episodePathTo` — BFS over the transition
  tables, e.g. FACT_CHECKING → FACT_REVIEW → NEEDS_CHANGES → SCRIPTING), refusing loudly if
  no legal path exists. Demonstrated by FO-1 (rewind re-parks healthy) and the dashboard
  rewind e2e test.
- **REW-2 — operator gate decisions burned the automatic-retry ceiling.** `attempt`
  incremented on every claim, so a healthy two-gate run plus one rewind exhausted the default
  ceiling and failed with "Retry ceiling reached" — the ceiling meant to bound _automatic
  failure retries_ was consumed by _operator-driven completions_. Fix (`repo.ts` +
  `gates.ts`): `setJobState` gained `resetAttempts`, and both operator resume paths (approve,
  needs-changes rewind) start the budget over. Failure-driven retries (the FAILED-retry path,
  pinned by the reliability suite's exact 3-attempt ceiling) are untouched.

## Audit of the fifteen waste classes (systematic results)

| Waste class                                    | Verdict                                                                | Where / evidence                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate AI calls                             | **Held** (was already structural)                                      | `invoke` consults the durable cache before any contact; FO-2 proves zero re-payment across episodes; retry loop reuses one attempt budget per call                                                                                                                                                                                                                                                                                 |
| Repeated research                              | **Held**                                                               | discovery keys on query; identical questions/queries/extractions hit the cache (FO-2); stage adoption (fingerprints) skips re-running stages entirely on recoveries                                                                                                                                                                                                                                                                |
| Unnecessary LLM calls                          | **Held** + deterministic skips verified                                | `reconcile` skips the model below 2 distinct claims (dedup by normalization first); `conflicts` skips below 2 claims ("nothing to disagree"); script `revise` runs only when a hard rule is broken (bounded rounds); claim statuses/confidence derived by code, never asked of the model                                                                                                                                           |
| Unnecessary TTS regeneration                   | **Fixed-adjacent** (REW-1/2 made recovery healthy; granularity pinned) | per-scene cache keys (text+voice+format+rate+provider); FO-4: one changed scene → one call; duration measured from bytes (free), not by re-asking the provider                                                                                                                                                                                                                                                                     |
| Missing artifact caching                       | **Held**                                                               | every stage output is a CAS artifact; steps record artifact hashes; a re-run adopts identical fingerprints (`reused_from_job_id`); the provider cache is durable and default-on                                                                                                                                                                                                                                                    |
| Repeated media downloads                       | **N/A today, design note for the deferred fetcher**                    | the media stage resolves planned assets to deterministic generated plates (no network); when a real fetcher lands it must cache downloads by URL hash and honor the SSRF resolve-then-recheck rule (SA-8)                                                                                                                                                                                                                          |
| Unnecessary renders                            | **Held**                                                               | render output is content-addressed and re-declared, not re-rendered: identical re-render reuses every segment (`segmentsReused 6/6` pinned in the video suite)                                                                                                                                                                                                                                                                     |
| Full-video rerender on one-scene change        | **Held**                                                               | segment keys hash everything that decides a segment's pixels; one changed scene → all other segments adopted (5/6 reused pinned); PNG-level split even re-encodes without re-rasterising when only encode settings change                                                                                                                                                                                                          |
| Excessive polling                              | **Held (measured negligible)**                                         | worker idle poll is a 1 s local SQLite query (no cloud cost); the dashboard auto-refreshes (3 s) only while a run is active, static otherwise; upload status is read once per publish task run, not polled                                                                                                                                                                                                                         |
| Redundant database queries                     | **Held (measured negligible)**                                         | every hot path is indexed (`idx_pipeline_jobs_claimable`, episode/project/approval indexes); the home page's per-episode job lookup is one indexed query per row on a local single-operator DB — measured cost µs; log payloads capped (`logLimit`)                                                                                                                                                                                |
| Oversized API payloads                         | **Held**                                                               | prompt budgets are enforced in code (`maxEvidenceInPrompt`, capped issue lists, per-source extraction instead of whole-corpus prompts); provider results validated and truncated (`truncate 400`) in logs                                                                                                                                                                                                                          |
| Unnecessary cloud jobs                         | **Held**                                                               | publishing requires approved QA + operator approval + READY (re-checked by the task from durable state); duplicate uploads deduped by video hash; duplicate job submissions deduped by idempotency key — a double-pressed button creates one job                                                                                                                                                                                   |
| Missing retry backoff                          | **Held**                                                               | provider calls: exponential backoff with jitter, server-honored `retryAfterMs`; jobs: scheduled `next_attempt_at` (and the RL-3 fix guarantees operator retries are immediate); quota blocks fail closed _before_ spending a call                                                                                                                                                                                                  |
| Inefficient storage                            | **Held, one considered-and-rejected change**                           | CAS dedups by content (identical segments/manifests stored once; render work dir cleans up); artifact JSON is pretty-printed **by design** — operator-facing raw documents on the dashboard; the bytes are dwarfed by the binary WAV/MP4 artifacts, so compacting would trade operator debuggability for negligible space                                                                                                          |
| Deterministic work incorrectly delegated to AI | **Held** — the system is aggressively code-first                       | deterministic: claim evaluation/status/confidence, scene manifest planning + timing, caption segmentation, shot/layout math, the entire shorts engine ("no AI provider is involved"), QA's five checks, media placeholder plates, render segments, publish guards. AI is reserved for what needs reasoning: research questions, per-source evidence extraction, semantic claim grouping, conflict detection, script writing/repair |

## Deliberate non-changes (recorded so they are not re-litigated)

1. **The audio `SegmentAudioCache` stays unwired in the app.** It duplicates the durable
   provider cache for TTS (which is default-on and covers the same segments). Wiring both
   would add a second index file to maintain for zero saved calls. It remains available for
   deployments that run with `NEXUS_PROVIDER_CACHE=off`.
2. **Pretty-printed artifact JSON stays.** Readability is an operator feature (raw documents
   render on the dashboard); the storage delta is negligible next to binary artifacts.
3. **The 1 s worker idle poll stays.** It is a local indexed SQLite query; polling a cloud
   queue would be the waste — there is none.
4. **Research still runs one extraction call per source.** Attribution integrity requires
   evidence to be tied to exactly one document; batching sources into one prompt would blur
   which source said what — a factual-integrity trade the brief forbids.

## Notes for deferred components (design constraints, not features)

- **Real research/media fetchers (when built):** cache responses/downloads keyed by canonical
  URL + content hash; never fetch a URL twice in a run; enforce the SSRF
  resolve-then-recheck rule on every fetch.
- **Real TTS/LLM adapters:** inherit every guarantee here automatically — the caching,
  backoff, quota fail-closed and metering live in the `invoke` layer, not the adapters.
- **Publishing:** status polling, if a future API requires it, must back off exponentially
  and stop at a bounded count (today's adapter reads status once per run).

## Regression coverage added

- `tests/resource-efficiency.test.ts` — 4 tests: the FO-1…FO-4 paid-call ledger probes
  (whole-pipeline runs with the real orchestrator; TTS segment granularity with a counting
  adapter).
- The FO-1 probe doubles as the regression test for REW-1 and REW-2 (the rewind completes
  healthy at zero cost); the dashboard rewind e2e test pins the episode-state path walk.
- No pre-existing test was weakened; the Phase 17 reliability suite (including the exact
  3-attempt FAILED-retry ceiling) passes unchanged.
