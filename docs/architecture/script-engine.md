# Script Engine (Phase 6)

Phase 6 turns a **verified research package** into a **structured narration
script**: a working title and logline, a hook, an introduction, narrative
sections with spoken transitions, a conclusion, visual cues per sentence, and —
the part that matters — a claim ledger in which every factual sentence still
points at the research claim and the verbatim evidence behind it. `@nexus/script`
holds it; the `script` stage of the long-form pipeline runs it.

The engine exists to make the phase's writing rules structural rather than
prompt-dependent. Each promise below is enforced by code and has a test that
fails if the enforcement is removed:

| Promise                                                    | Mechanism                                                                                                                                                                                                         | Where                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Every factual sentence traces back to research**         | `claimRefs` must name claims that exist in the package; the ledger resolves claim → sentences → verbatim evidence (with its source URL and locator), and a cited claim that research blocked is a hard failure.   | `buildClaimBrief()`, `verifyScriptClaims()`   |
| **Uncertain claims are never stated as fact**              | The package's `mayStateAsFact` decides whether a claim goes to the FACT list (assertable) or the REPORT list (attribution only). A `fact` sentence citing anything else is a hard violation.                      | `buildClaimBrief()`, `verifyScriptClaims()`   |
| **Reported claims are attributed out loud**                | An `attributed` sentence must cite the claim, name a source the claim is linked to, and say in the words that it is reporting (`According to…`, `… estimates`, `Reports put it at…`).                             | `verifyScriptClaims()`, `ATTRIBUTION_MARKERS` |
| **Quotations are never invented**                          | Every quoted span in the narration must appear in the research evidence (whitespace- and case-insensitively); otherwise `unverified_quote` (hard). No dialogue, no “experts say”.                                 | `lintScript()` + `quotedSpans()`              |
| **Sources are never invented**                             | A domain named in the narration must be one of the researched domains; otherwise `fabricated_source` (hard).                                                                                                      | `lintScript()` + `mentionedDomains()`         |
| **No filler, no repetitive AI phrasing, no fake suspense** | Deterministic phrase lists, whole-script n-gram repetition and connective density produce `filler`, `repetition` and `fake_suspense` findings (soft).                                                             | `lintScript()` + `style.ts`                   |
| **Nothing unsupported ships silently**                     | One bounded corrective round, then a gate: sentences still breaking a hard rule are dropped, the drop is warned about, `reviewRequired` is set, and the artifact lists what was removed and what the round fixed. | `generateScript()`, `applyGate()`             |

AI writes **prose only** — two calls at most: `write` and one `revise`. Ids,
section and sentence numbering, the claim ledger, statistics, the structure
check, citation validation, the quality report and storage are ordinary code
(AD-07). A model therefore cannot promote an unverified claim, invent a source,
or report a quality pass by asking nicely.

---

## 1. Pipeline (`packages/script/src/pipeline.ts`)

```
ResearchPackage (verified)  +  topic / outline / direction
  │
  ├─ select     code   split the package into FACT (assertable), REPORT
  │                    (attribution only) and BLOCKED (never sent to the model);
  │                    pick the evidence excerpts the prompt may quote
  ├─ write      AI     script.write@1 → workingTitle, logline, sections & sentences
  ├─ validate   code   assemble the document, then lint it: structure, claim
  │                    citations, quotations, domains, filler, repetition, length
  ├─ revise     AI     script.revise@1 — only if a hard rule was broken, at most
  │                    `maxRepairRounds` times, with the findings attached
  └─ finalize   code   gate (drop what still breaks a hard rule), rebuild the
                       ledger, renumber ids, statistics, provenance, quality
                        │
                        ▼
                  ScriptDoc (validated against its own schema)
```

Every step records a `ScriptStep`: start/finish, duration, which capability
served it (`engine: llm | none`), calls, cache hits, metered units, outcome
(`ok | partial | skipped`), notes, and the model + template version when a model
answered. `provenance.aiSteps` lists the steps that actually called a model
(a step that failed before its call does not count — CI-11); the rest are
`deterministicSteps`.

### Degradation, not fabrication

- A provider failure propagates unchanged through `toJobError`, so retries and
  permanent classification stay in the provider layer and nowhere else. A
  timeout reaches the runner as retryable; a schema-invalid model answer is a
  `ProviderContentError`.
- A `ManualRequiredError` (AI capability degraded, AD-06) is never swallowed: the
  task parks the job at `MANUAL_INPUT`.
- **If research cleared nothing, the run refuses to write.** `NoUsableClaimsError`
  carries the blocked claims and their reasons; the stage parks for a human
  instead of producing an opinion piece nobody asked for.
- The corrective round is bounded and never loops: the engine keeps the better of
  the two candidates (`fewer hard findings → fewer style findings → closer to the
target length`) and, if hard findings survive, the gate removes the offending
  sentences. A dropped line is recoverable; an unsupported fact is not.

## 2. The document (`@nexus/db/src/docs.ts`, `ScriptDoc` v2)

The narration contract lives in `@nexus/db` (not here) because
`repo.createScript()` validates it before a row exists, and because the scenes
stage will read it from the CAS.

| Field                                         | What it holds                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `topic`, `workingTitle`, `logline` | The flat fields a dashboard or a tooltip needs without walking the tree.                                                                                                                                                                                                          |
| `sections[]`                                  | Ordered `hook → introduction → narrative… → conclusion`; each has `id` (`sec1…`), `role`, `title`, the spoken `transition` into it (`""` on the hook) and its sentences.                                                                                                          |
| `sections[].sentences[]`                      | `id` (`s1_2` = section 1, sentence 2), the `narration` a voice reads, `assertion` (`fact \| attributed \| context`), `claimRefs[]`, `sourceRefs[]`, and an optional `visual {kind, description, searchHint}`.                                                                     |
| `claims[]` (the ledger)                       | One entry per researched claim the script uses: `claimId`, `statement`, `status`, `certainty`, `confidence`, `mayStateAsFact`, how it is `usage`d (`fact \| attributed`), the `sentenceIds` that use it, and its `evidence[]` (`sourceId`, `url`, verbatim `excerpt`, `locator`). |
| `quality`                                     | `issues[]` (`code`, `severity` `hard \| soft`, `message`, `sectionId`, `sentenceId`, `detail`, `resolvedByRepair`), `repairRounds`, `reviewRequired`, `droppedSentences[]`.                                                                                                       |
| `stats`                                       | Section, sentence and word counts plus `estimatedDurationSec` from the tuning's words-per-second.                                                                                                                                                                                 |
| `provenance`                                  | Engine name/version, the research package hash it was written from, the LLM adapter id, the per-step trace, AI vs deterministic steps, repair rounds, timestamps.                                                                                                                 |
| `warnings[]`                                  | Blocked claims, evidence the prompt could not include, drops, structural damage — the operator-facing notes.                                                                                                                                                                      |

`sections` is deliberately `min(1)`: a document must stay storable and readable
even when it is wrong, so a structure failure is reported (`missing_section`,
`reviewRequired`) rather than thrown as a parse error in the middle of the gate
(OD-16).

## 3. What may be said (`src/claims.ts`)

| Bucket      | Source in the package                            | What the writer may do                                                      | What code enforces                                                                       |
| ----------- | ------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **FACT**    | `mayStateAsFact` and verified evidence           | Assert it directly, citing the claim id                                     | A `fact` sentence with no claim, or with a claim that is not cleared, is hard.           |
| **REPORT**  | verified evidence, but not cleared for assertion | Report it with attribution, citing the claim id + naming a linked source    | Attribute without a claim, without a linked source, or without a reporting marker: hard. |
| **BLOCKED** | no verified evidence link (or no usable excerpt) | Nothing — it never appears in the prompt, and citing it is a hard violation | `unsupported_assertion` with the claim's certainty/status in the detail.                 |

The brief also carries the package's sources (id → domain, title) and the
verbatim evidence excerpts, which is what makes the quotation and domain checks
possible. Blocked claims are reported in `warnings[]` so the operator can see
what research could not support.

## 4. The writing lint (`src/style.ts`)

| Code                    | Severity | What it means                                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `unverified_quote`      | hard     | A quoted span is not in the research evidence.                                                                                  |
| `fabricated_source`     | hard     | The narration names a domain that is not one of the researched sources.                                                         |
| `unsupported_assertion` | hard     | States an uncleared claim as fact (or marks a fact sentence with no claim behind it).                                           |
| `unknown_claim`         | hard     | Cites a claim id that is not in the research package at all.                                                                    |
| `missing_attribution`   | hard     | Reports a claim without naming one of its sources, or without saying that it is reporting.                                      |
| `unknown_source`        | hard     | Cites a source id that is not in the package.                                                                                   |
| `unlinked_source`       | hard     | Names a source that backs none of the claims in that sentence.                                                                  |
| `missing_section`       | hard     | Not exactly one hook / one introduction / one conclusion, fewer than two narrative sections, out of order, or an empty section. |
| `filler`                | soft     | A padded phrase (`in this video`, `let's dive in`, `it's important to note`, …).                                                |
| `fake_suspense`         | soft     | Manufactured tension (`stay tuned`, `you won't believe`, `little did they know`, …).                                            |
| `repetition`            | soft     | The same sentence opening, or a repeated four-word phrase, or a run of `moreover/furthermore/…`.                                |
| `long_sentence`         | soft     | More than 32 spoken words in one sentence.                                                                                      |
| `markup`                | soft     | Markdown, HTML or bracketed stage directions in narration that a voice would read aloud.                                        |

Soft findings never remove narration: they are recorded, and the writer gets one
corrective round if a hard finding exists. The lint reports, it does not rewrite
prose — rewriting is a model's job, and a risky one to do silently.

## 5. The gate (`applyGate`)

After the (optional) corrective round, the document is re-linted and:

1. every sentence with a hard finding is **removed** (its quotes and its sources
   go with it), and the removal is listed in `quality.droppedSentences`;
2. ids are re-numbered so `sec2`/`s2_1` stay canonical;
3. the claim ledger is rebuilt from what remains — a dropped sentence takes its
   claims out of the ledger rather than leaving a claim claiming a sentence
   that no longer exists;
4. findings fixed by the round are kept as `resolvedByRepair: true` entries, so
   the artifact shows what the corrective round actually changed;
5. `reviewRequired` is true when a hard finding remains **or** any sentence was
   dropped, and `warnings[]` explains the drops and any structural damage.

## 6. Persistence (`src/persist.ts`, AD-09)

- **The script** is one JSON document in the CAS, registered as
  `kind: "script"` (the kind the `script` stage declares it produces) with
  `meta.generatedBy {provider, model, templateVersion}`. It carries the claim
  ledger, so traceability survives even if SQL rows are pruned.
- **A `scripts` row** per run: version per episode, status `draft`
  (approval is a separate human gate), `doc_hash` pointing at the artifact.
- **`claims` + `claim_evidence` rows**: one claim row per ledger entry, bound to
  the sentence that states it, with the research status carried over 1:1 (the
  two vocabularies are the same five values) and one evidence row per
  (claim, source) pair with the verbatim excerpt and the `start:end` locator over
  the source text. This is the OD-15 hand-off: pre-script claims lived in the
  package, script-bound claims live here.
- **Sources** are resolved with the idempotent `repo.addSource`, so a re-run (or
  a second script for the same episode) attaches to the same `sources` rows
  instead of duplicating them. An evidence link that cannot be resolved to a
  source row is reported in `unresolvedEvidence` and logged, never dropped
  silently.
- `loadScriptDoc()` re-parses from the CAS, and the stage's `validateReuse()`
  refuses to adopt an artifact whose claim ledger is empty.

## 7. The stage task (`src/task.ts`)

`createScriptTask({llm, storage, repo, clock, tuning})` returns the `Task` for
stage key `script`. It finds the research package from the job's upstream
`fact_check` or `research` output, or from `params.researchPackageHash`; a job
that names no package (or names one whose bytes are gone) fails permanently,
because re-running cannot help. Then it:

- completes with `{hash, kind: "script", role: "script_doc"}` plus a JSON summary
  (script id, working title, sections, claim usage, counts, stats, quality,
  warnings) for the stages downstream;
- parks at `MANUAL_INPUT` when the capability degrades to manual **or** when
  research cleared nothing to write about;
- logs `script.started`, `script.warning`, `script.completed` and
  `script.review_required` to the job log;
- keeps the `script` stage's episode states (`SCRIPTING` → `SCENE_PLANNING`)
  unchanged.

## 8. Cost control

At most two model calls per script (one write, one revise after a hard failure),
each through the Phase 4 `invoke()` pipeline, so an identical prompt is served
from the provider cache for free and every unit is metered against
`provider_accounts`. The prompt is bounded: at most `maxEvidenceInPrompt` (24)
verbatim excerpts, and blocked claims are never included at all. Findings are
capped before being sent to the corrective round (all hard findings, the first 12
style findings) so a pathological draft cannot grow the revision prompt without
bound.

Tuning (`ScriptTuning`, all overridable per run and by `params`):

| Knob                  | Default | Effect                                                     |
| --------------------- | ------- | ---------------------------------------------------------- |
| `targetDurationSec`   | 300     | The word budget handed to the writer (× `wordsPerSecond`). |
| `wordsPerSecond`      | 2.5     | Narration pace used for every length estimate (≈150 wpm).  |
| `narrativeSections`   | 3       | How many narrative sections the writer must produce.       |
| `maxRepairRounds`     | 1       | Corrective rounds after a hard validation failure.         |
| `maxEvidenceInPrompt` | 24      | Evidence excerpts included in the write prompt.            |

## 9. How this was verified

`pnpm verify` — format, lint, typecheck, tests: **30 files / 359 tests**, of which
`@nexus/script` contributes 4 files / 41 tests. All of them use mock providers:
no network, no API key, no paid call.

- `claims.test.ts` (11) — the FACT/REPORT/BLOCKED split, verbatim evidence with
  its locator, and every claim violation: a cleared claim asserted, an uncleared
  claim asserted, a fact with no claim, an unknown claim id, attribution that
  names no source or forgets to report, and the ledger (usage, sentence ids,
  evidence, status carried over).
- `style.test.ts` (7) — each lint category, the structure rules (counts, order,
  first-section-is-hook, empty sections) and that a clean script produces no
  findings at all.
- `pipeline.test.ts` (15) — the required scenarios: a full structured script
  (working title, hook → introduction → narrative ×2 → conclusion, transitions,
  visual cues, ledger), only-cleared-material in the prompt, byte-for-byte
  reproducibility for the same clock and answers, a refusal when nothing was
  verified, a corrective round that attributes everything, a soft finding that
  costs no round, a hard one that does and is reported as resolved, a drop that
  ships without the offending sentence, a blocked sentence that survives revision
  and is still removed, malformed model output, timeout propagation, manual
  hand-off propagation, tuning honouring, citation de-duplication, and an
  under-structured artifact that stays storable and is flagged (OD-16).
- `task.test.ts` (8) — the stage inside the real `runJob` and real SQLite: the
  artifact registered with its provenance, the document readable from the CAS,
  scripts/claims/`claim_evidence` rows, evidence locators re-sliced out of the
  stored source text, the step output downstream stages read, the park on manual
  degradation, the park when research cleared nothing, permanent failure with no
  package and with missing bytes, review-required reporting and storage for a
  script that lost a sentence, the reuse guard, and idempotent source resolution
  on a second persist.

## 10. What Phase 6 deliberately does not include

- **No animation, no rendering, no scene work** (per the phase brief). Visual
  cues are structured data (`kind`, `description`, `searchHint`) with no timing,
  no asset resolution and no search hints being executed (GAP-17).
- **No `fact_check` stage task.** The stage exists in the graph
  (`FACT_CHECKING` → `SCRIPTING`) and the script task prefers its output when
  present, but the task that produces it is not written yet; the script stage
  reads the research package directly.
- **No semantic re-check of narration wording.** The engine verifies that each
  factual sentence cites a claim research cleared and keeps its evidence
  attached; it does not (and cannot cheaply) judge whether a paraphrase drifts
  from the claim's own wording. That is an editor's or a future checker's job.
- **No script editing surface.** `reviewRequired` is reported in the artifact,
  the step output and the job log; changing a draft or approving it
  (`scripts.status`) is a repository/API action, and the HTTP surface is still
  GAP-1.
- **No voice, caption or duration fit.** `estimatedDurationSec` is an estimate
  from a fixed narration pace; real timing arrives with the TTS stage.
