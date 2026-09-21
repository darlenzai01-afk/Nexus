# Research Engine (Phase 5)

Phase 5 turns a topic into a **research package**: research questions, sources
with metadata, verbatim evidence, factual claims, claim/source relationships,
recorded conflicts, a verification status for every claim, and provenance for
everything. `@nexus/research` holds it; the `research` stage of the long-form
pipeline runs it.

The engine exists to make four promises structurally true rather than
prompt-dependent. Each promise is enforced by code, and each has a test that
fails if the enforcement is removed:

| Promise                                       | Mechanism                                                                                                                                                                                                                        | Where                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Sources are never invented**                | A source only enters the package from a provider search row that passed URL validation, canonicalisation and dedup; every refusal is recorded in `dropped[]`.                                                                    | `discover`, `acceptSource()`         |
| **Quotations are never invented**             | The model supplies a candidate quote; the engine locates it in the retrieved text and stores _the source's own characters_ (`content.slice(start, end)`) plus the offsets. An unlocatable quote is dropped.                      | `findQuote()`, `collectExtraction()` |
| **Uncertain claims are never stated as fact** | `status`, `confidence`, `contested` and `certainty` are derived deterministically; `mayStateAsFact` is true only for a corroborated, uncontested claim, and the package carries the gate (`reviewRequired`, `blockingClaimIds`). | `evaluateClaims()`                   |
| **Disagreement is preserved**                 | Conflicts are recorded with both sides, never auto-resolved; a verified dissenting quote becomes a real `contradicts` link.                                                                                                      | `detectConflicts()`                  |

AI is used for four things only — planning questions, extracting evidence and
claims from one document, grouping restatements of one fact, and proposing
disagreements (AD-07). Parsing, validation, deduplication, quotation
verification, scoring, status derivation and storage are ordinary code.

---

## 1. Pipeline (`packages/research/src/pipeline.ts`)

```
topic
  │
  ├─ plan        AI    topic + outline → questions, each with search queries
  ├─ discover    provider search + code: URL validation, canonicalisation,
  │                    dedup by canonical URL and by content hash, limits
  ├─ extract     AI    per source: candidate evidence + candidate claims
  │              code   verify every quote against the source text, resolve
  │                     every claim→evidence reference
  ├─ reconcile   AI    group claims that assert the same fact
  │              code   deterministic merge (identical statements merge first)
  ├─ conflicts   AI    propose claim-vs-claim conflicts and quoted refutations
  │              code   validate ids, verify refutation quotes, mark contested
  └─ evaluate    code  status, confidence, corroboration, certainty, gate
                        │
                        ▼
                  ResearchPackage (validated against its own schema)
```

Every step records a `ResearchStep`: start/finish, duration, which capability
served it (`engine: llm | research | none`), adapter id, model, template version,
call count, cache hits, metered units, outcome (`ok | partial | skipped`) and
notes. `provenance.aiSteps` lists the steps that actually consulted a model;
`provenance.deterministicSteps` lists the ones that did not.

### Degradation, not fabrication

- A search call that fails is recorded, and the run continues with the calls
  that succeeded (`partial: true`, a warning, and the failure in the step notes).
  **If every search call fails, the run fails** (the classified provider error
  propagates, so the job runner retries a 429 and gives up on a 401).
- A `ManualRequiredError` from a degraded capability is never swallowed: the task
  parks the job at `MANUAL_INPUT` (AD-06).
- An extraction that fails for one source degrades that source only; if _every_
  extraction fails, the run fails.
- Reconciliation and conflict detection are optimisations: losing either sets
  `partial` and a warning but keeps the sources, evidence and claims.
- **An empty result stays empty.** No sources ⇒ no evidence, no claims, no
  conflict, `reviewRequired: true`, and the task parks for a human instead of
  inventing material to keep the pipeline moving.

## 2. The package (`src/types.ts`)

| Field                   | What it holds                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `questions[]`           | `id` (`q1…`), question, rationale, priority, the queries issued                                                                                                                                                                                                                                                                    |
| `sources[]`             | `id` (`src_<hash8>` of the canonical URL), canonical + original URL, domain, title, publisher, `publishedAt`, `retrievedAt`, adapter, the questions that surfaced it, the retrieved text, its sha256, `retrieval` (`provider_snippet` / `operator_text` / `unavailable`)                                                           |
| `evidence[]`            | `id` (`ev_…`), `sourceId`, the **verbatim** `excerpt`, `locator {start,end}` such that `source.content.slice(start, end) === excerpt`, relevance, `extractedBy {provider, model, templateVersion}`                                                                                                                                 |
| `claims[]`              | `id` (`cl_<hash8>` of the canonical statement), canonical `statement`, other `variants` of the same fact, questions, `links[]` (the claim/source relationships: source, evidence, `stance`, model-reported `strength`, rationale), `status`, `certainty`, `confidence`, `corroboration`, `contested`, `mayStateAsFact`, provenance |
| `conflicts[]`           | `id`, `kind` (`direct_contradiction`, `numeric_disagreement`, `attribution`, `scope`), explanation, `detectedBy` (`model` / `evidence_stance`), `sides[]` (claim sides and verbatim source sides), `preserved: true`                                                                                                               |
| `verification`          | claim count, counts per status, `established`, `contested`, conflict count, `reviewRequired`, `blockingClaimIds`                                                                                                                                                                                                                   |
| `provenance`            | engine name/version, schema version, topic, project/episode, start/finish/duration, the adapters that served each capability, the per-step trace, AI vs deterministic steps                                                                                                                                                        |
| `dropped[]`             | every rejection with its stage, a reason code (`invalid_url`, `malformed_result`, `duplicate_url`, `duplicate_content`, `source_limit`, `no_content`, `quote_not_found`, `unknown_reference`, `claim_without_evidence`, `malformed_extraction`), a detail and the offending value                                                  |
| `warnings[]`, `partial` | operator-facing notes and whether the run is short of something                                                                                                                                                                                                                                                                    |

## 3. Verification: what may be asserted (§11)

`status` describes the claim's own evidence; `certainty` describes what a writer
may do with it. Both come from `evaluateClaims()`, never from a model.

| Situation                                                              | `status`        | `certainty`   | `mayStateAsFact`       |
| ---------------------------------------------------------------------- | --------------- | ------------- | ---------------------- |
| ≥2 independent sources support it, confidence ≥ 0.7, nothing contested | `supported`     | `established` | **yes**                |
| Exactly one source supports it                                         | `supported`     | `likely`      | no                     |
| A source's verbatim quote disputes it                                  | `contradicted`  | `disputed`    | no                     |
| Involved in an unresolved conflict between claims                      | (unchanged)     | `disputed`    | no                     |
| Only mentions, nothing supports it                                     | `unsupportable` | `unsupported` | no                     |
| No quotation survived verification                                     | `unverified`    | `uncertain`   | no                     |
| (nothing to evaluate at all)                                           | —               | —             | `reviewRequired: true` |

Confidence is deterministic and documented: `base × (0.6 + 0.4 × mean top
strength)`, where base is `0.5 / 0.75 / 0.9` for `1 / 2 / 3+` independent
supporting sources, capped at `0.4` when the claim is contested and at `0.25`
when a source disputes it. The only model input is a link's `strength` (0–1),
and no reported strength can lift a claim over a contradiction. Thresholds are
tunable (`establishedMinSources`, `establishedMinConfidence`).

`reviewRequired` is true when any claim is not established, and also when the
package contains no claims: an empty run must never look like a passed gate.
`blockingClaimIds` lists exactly the claims a downstream stage must not assert.

## 4. Persistence (`src/persist.ts`, AD-09)

- **The package** is one JSON document in the CAS, registered as
  `kind: "document"` with `meta.generatedBy` — the kind the `research` stage
  already declares it produces. `loadResearchPackage()` reads it back, and the
  task's `validateReuse()` refuses to adopt a stage output whose bytes are gone
  or unparseable.
- **Sources** are written to the `sources` table and linked to the episode
  (`episode_sources`, role `research`). `repo.addSource` dedupes by URL _or_
  content hash, so re-running research never duplicates a source; operator-pasted
  text stays `added_by: 'operator'`.
- **Claims stay in the package for now**: the `claims` table is keyed by
  `script_id` + `sentence_id`, so a pre-script claim has no row to live in
  (OD-15). The fact-check stage will turn accepted claims into script-bound rows
  and copy their evidence into `claim_evidence`.
- **No schema change was needed.** `sources`, `episode_sources` and
  `artifacts` already model everything Phase 5 stores; adding an artifact kind
  (`research`) would require a SQLite table rebuild, which is approval-gated
  (OD-10), so `document` is used instead.

## 5. The stage task (`src/task.ts`)

`createResearchTask({llm, research, storage, repo, clock, tuning})` returns the
`Task` for stage key `research`. It reads the topic and outline from the episode,
operator sources from `params.operatorSources` (validated; a malformed list is a
permanent configuration error), runs the engine, and:

- completes with `{hash, kind: "document", role: "research_package"}` plus a
  JSON summary (package hash, counts, `verification`, warnings) for downstream
  stages;
- parks at `MANUAL_INPUT` when the capability degrades to manual **or** when no
  usable source was found, with instructions the operator can act on;
- translates provider failures through `toJobError`, so retryable/permanent
  classification happens in the provider layer and nowhere else;
- logs `research.started`, `research.warning`, `research.rejected`,
  `research.completed` and `research.review_required` to the job log.

The `research` stage's episode states (`RESEARCHING` → `FACT_CHECKING`) and
labels are unchanged; the `fact_check` stage (Phase 6+) owns the `FACT_REVIEW`
gate, and this engine hands it the blocking claim ids it needs.

## 6. Cost control

Searches are issued once per planned query (the question text is only a fallback
when a planner returns none), evidence extraction runs once per source, and the
source budget (`maxSources`, default 8) caps the extraction calls. Every call
goes through the Phase 4 `invoke()` pipeline, so identical prompts are served
from the provider cache for free and every unit is metered against
`provider_accounts`. Deduplication happens before extraction, so two search hits
for the same article cost one extraction rather than two.

## 7. How this was verified

`pnpm verify` — format, lint, typecheck, tests: **26 files / 318 tests**, of which
`@nexus/research` contributes 4 files / 42 tests. All of them use mock providers:
no network, no API key, no paid call.

- `text.test.ts` (10) — quote location returns the source's characters and not
  the model's; layout/case/typography tolerance; a quote that is not present is
  refused; excerpt budget; URL canonicalisation; statement normalisation; stable
  content-derived ids.
- `pipeline.test.ts` (20) — the eight required scenarios: **successful
  research** (questions, canonical sources, verbatim evidence with locators,
  merged corroborated claim, provenance, empty dropped list), **empty result**,
  **malformed provider output** (LLM schema failure, malformed search rows, bad
  evidence references, unverifiable quotes), **timeout** (partial + total),
  **rate limit** (partial + total, retryable), **conflicting sources** (both
  sides preserved, both contested, verified refutation → `contradicts` link,
  fabricated refutation dropped), **duplicate sources** (URL and content), and
  **invalid URLs** (`javascript:`, `file:`, loopback, private, IPv4-mapped,
  credentials, operator-supplied). Plus: byte-for-byte reproducibility for the
  same clock and answers, the topic fallback, the source budget, and one
  end-to-end run on the bundled `FakeResearchProvider`.
- `evaluate.test.ts` (6) — the verification table above, including that two
  corroborating sources still are not enough while a conflict stands.
- `task.test.ts` (6) — the stage inside the real `runJob`: package registered and
  readable, sources linked to the episode, episode at `FACT_CHECKING`, step
  output for downstream stages, park on manual degradation, park on an empty
  search, operator sources from params, malformed params rejected, and the reuse
  guard refusing missing package bytes.

## 8. What Phase 5 deliberately does not include

- **No script engine** (per the phase brief). Research claims are not written to
  the `claims` table and no `fact_check` stage is implemented; the gate decision
  is _reported_ (`verification`), not enforced.
- **No page-content fetcher.** Evidence is limited to the text a provider
  returned (its snippet) or that an operator pasted — there is no HTML fetch +
  extraction capability yet, so a source's quotable text is short (GAP-15). The
  package records `retrieval` honestly so this is visible per source.
- **No real research adapter.** `none` / `fake` / `manual` only; a real search
  provider is a Phase 4-shaped adapter behind the same interface (OD-5/OD-2).
- **No HTTP surface** for research packages or claim review (GAP-1), and the
  worker still does not register tasks at startup (GAP-9).
- **No semantic fact-checking of the script.** The engine verifies that claims
  are grounded in retrieved text; it does not yet re-check them against a
  finished script.
