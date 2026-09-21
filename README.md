# Nexus Forge

Cloud-first automated video production system: topic → research → fact-check
→ script → scenes → media → voice → captions → render → QA → **human
approval** → publish, plus a long-form → Shorts repurposing pipeline.

> **Status: foundation phase.** This repository currently contains the
> project scaffolding only — no AI, rendering, or publishing engines exist
> yet. The architecture is fully planned in
> [`docs/plans/000-architecture-discovery.md`](docs/plans/000-architecture-discovery.md)
> with binding decisions in [`docs/plans/000-decisions.md`](docs/plans/000-decisions.md).

## Architecture in one paragraph

Nexus Forge is a **modular monolith** (AD-01): one TypeScript monorepo, one
codebase, two entrypoints — `app` (HTTP API/dashboard host) and `worker`
(pipeline step executor) — that can also run as a single process. State
lives in SQLite (later phase), artifacts in a content-addressed store (later
phase), and every external dependency sits behind a provider adapter with
`Fake` and `Manual` fallbacks (AD-06). AI is used only for semantic work;
everything deterministic is ordinary code (AD-07). Nothing publishes without
a fingerprinted human approval (AD-08).

## Repository layout

```
apps/
  nexus/            # The single application: `app` + `worker` entrypoints (Fastify)
packages/
  config/           # Shared, schema-validated environment configuration (zod)
  db/               # SQLite system of record: versioned migrations, typed domain
                    # schemas, validated repository layer (no blobs, no secrets)
  storage/          # Content-addressed artifact store (sha256 CAS) behind a
                    # swappable interface — artifact bytes never enter the DB
  providers/        # The outside world behind six capability interfaces (LLM,
                    # research, TTS, media, storage, publishing): registry with
                    # env selection, a shared invoke() pipeline (budget, cache,
                    # rate limit, retry, metering), deterministic fakes and
                    # human-in-the-loop fallbacks
  jobs/             # Persistent job orchestration: state machines, stage graph,
                    # fingerprints, retry/backoff, artifact reuse, worker loop
  research/         # The research engine (Phase 5): topic → structured research
                    # package (questions, sources, verbatim evidence, factual
                    # claims, claim/source links, conflicts, verification status,
                    # provenance) plus the pipeline's `research` stage task
  script/           # The script engine (Phase 6): verified research package →
                    # structured narration script (hook, sections, transitions,
                    # conclusion, visual cues) with a claim/evidence ledger, a
                    # deterministic writing lint and the `script` stage task
services/           # Intentionally empty — no microservices (AD-01); see its README
infrastructure/     # Deployment assets (systemd/Docker/litestream) — added in later phases
tests/              # Cross-package integration tests (unit tests live beside sources)
docs/
  plans/            # Architecture discovery + decision log (the approved plan)
  architecture/     # Domain model + persistence notes (per delivered phase)
```

## Prerequisites

- **Node.js ≥ 22.12** (LTS)
- **pnpm 10** — `corepack enable` (the `packageManager` field pins the exact
  version) or `npm install -g pnpm@10`

## Getting started

```bash
pnpm install              # install workspace dependencies
cp .env.example .env      # optional — every variable has a safe default
pnpm dev                  # run the app entrypoint from source (tsx watch)
pnpm dev:worker           # run the worker entrypoint (separate terminal)
curl localhost:8080/healthz
```

Production-shaped run (after `pnpm build`):

```bash
pnpm start                # node apps/nexus/dist/server-entry.js
pnpm start:worker         # node apps/nexus/dist/worker-entry.js
```

## Scripts

| Script                         | What it does                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| `pnpm dev`                     | App entrypoint from source with watch mode                   |
| `pnpm dev:worker`              | Worker entrypoint from source with watch mode                |
| `pnpm build`                   | Compile all workspace projects (`tsc -b`, project refs)      |
| `pnpm typecheck`               | Same compiler pass (incremental) — types across all packages |
| `pnpm lint` / `lint:fix`       | ESLint (flat config, typescript-eslint)                      |
| `pnpm format` / `format:check` | Prettier                                                     |
| `pnpm test` / `test:watch`     | Vitest (unit + integration)                                  |
| `pnpm verify`                  | Everything CI runs: format, lint, typecheck, test            |
| `pnpm start` / `start:worker`  | Run built artifacts with plain Node                          |

## Configuration

All configuration is environment-driven and validated at startup by
`@nexus/config` (fail fast, never mid-run). See [`.env.example`](.env.example)
for the full list — every variable has a working default, so an empty
environment is valid.

**Security:** secrets are never committed and never stored in the database;
they exist only as environment variables referenced by name (AD-12). The app
binds to `127.0.0.1` by default — no public surface.

## Development conventions

- **TypeScript strict** everywhere; ESM only (`"type": "module"`, NodeNext).
- Packages expose sources via the `development` export condition so tests
  and `tsx` run without a build step; `tsc -b` produces `dist/` for Node.
- Unit tests live next to their sources (`*.test.ts`); cross-package
  integration tests live in `tests/integration/`.
- CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck/build,
  and tests on every PR — free-tier minutes are treated as a metered budget
  (AD-13), so the pipeline is kept lean.

## Roadmap (from the approved plan)

| Plan phase | Scope                                                       | State                                                            |
| ---------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| 0          | Monorepo, config, tooling, CI, app/worker entrypoints       | ✅ delivered                                                     |
| —          | **Session 2:** domain schemas + persistence foundation      | ✅ delivered (`docs/architecture/domain-model.md`)               |
| —          | **Session 3:** persistent job orchestration foundation      | ✅ delivered (`docs/architecture/job-orchestration.md`)          |
| —          | **Session 4:** provider abstraction layer (AD-06/12/13)     | ✅ delivered (`docs/architecture/provider-layer.md`)             |
| —          | **Session 5:** research engine (topic → research package)   | ✅ delivered (`docs/architecture/research-engine.md`)            |
| —          | **Session 6:** script engine (research package → script)    | ✅ delivered (`docs/architecture/script-engine.md`)              |
| 1          | Hard loop: script → scene graph → voice → captions → render | next (blocked on OD-1 Remotion, OD-2 TTS)                        |
| 2          | Research + fact-check with claim/evidence traceability      | research engine ✅, script engine ✅; `fact_check` stage pending |
| 3          | Full long-form pipeline + media/license engine              | pending                                                          |
| 4          | Shorts pipeline (9:16 re-render from scene graph)           | pending                                                          |
| 5          | Publishing (upload kit first, YouTube API after audit)      | pending                                                          |

**Delivered so far on this branch:** (a) the provider layer — six capability
interfaces with a registry, a quota-aware `invoke()` pipeline, deterministic
fakes and human-in-the-loop fallbacks, so the pipeline is buildable and testable
with no API keys and no network —
[`docs/architecture/provider-layer.md`](docs/architecture/provider-layer.md);
(b) the domain model + persistence foundation — versioned migrations,
typed/validated schemas, provenance-tracked artifacts (CAS hashes, never blobs) —
[`docs/architecture/domain-model.md`](docs/architecture/domain-model.md);
(c) the persistent job orchestration foundation — three state machines, the
versioned stage graph, content-fingerprint idempotency, retry/backoff, artifact
reuse without re-execution, gates, job logs and the worker/task abstraction —
[`docs/architecture/job-orchestration.md`](docs/architecture/job-orchestration.md);
and (d) the research engine — `topic → research package` with research questions,
deduplicated sources and metadata, evidence whose every quotation is sliced out
of the retrieved source, factual claims with claim/source relationships,
preserved conflicts, deterministic verification status and full provenance
(which step used AI, which was code) —
[`docs/architecture/research-engine.md`](docs/architecture/research-engine.md);
and (e) the script engine — `research package → structured script`: working title,
hook, introduction, narrative sections with spoken transitions, conclusion,
narration, visual cues and a claim ledger that still resolves every factual
sentence to the verbatim research evidence behind it, with the writing rules
(cleared facts only, attribution for everything else, no invented quotation,
source or suspense, no filler) enforced by deterministic validation and a gate
that removes what cannot be fixed —
[`docs/architecture/script-engine.md`](docs/architecture/script-engine.md).
These sit before plan-Phase 1 because every later step depends on typed
artifacts and crash-resumable, non-duplicating jobs.

The provider layer is configuration-driven: `NEXUS_*_PROVIDER` picks the
adapter per capability (`none`/`fake`/`manual`/real), `NEXUS_PROVIDER_*` sets the
call policy (timeout, attempts, cache, degrade ratio), and credentials are read
from the environment by _name_ only (AD-12). See
[`.env.example`](.env.example) for the full surface.

The research stage uses the `llm` and `research` capabilities and adds no
configuration of its own: `NEXUS_LLM_PROVIDER=fake NEXUS_RESEARCH_PROVIDER=fake`
runs the whole engine offline, and with no search provider configured the stage
parks the job at `MANUAL_INPUT` so an operator can paste sources
(`params.operatorSources`) instead of the engine inventing any.

The script stage needs only the `llm` capability (the fakes write a schema-valid
draft offline) and reads the package the earlier stage published. It parks the
job at `MANUAL_INPUT` when the AI capability degrades, and also when research
cleared nothing that may be asserted or reported — writing an opinion piece
instead of a factual script is an operator's decision, not the engine's.

Open decisions that block Phase 1 (Remotion licensing, TTS provider) are
tracked in [`docs/plans/000-decisions.md`](docs/plans/000-decisions.md#open-decisions-must-be-resolved-at-the-named-gate);
issues, pending items and unresolved risks are tracked in
[`docs/plans/ISSUES.md`](docs/plans/ISSUES.md).
