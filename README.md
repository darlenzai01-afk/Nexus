# Nexus Forge

Cloud-first automated video production system: topic → research → fact-check
→ script → scenes → media → voice → captions → render → QA → **human
approval** → publish, plus a long-form → Shorts repurposing pipeline.

> **Status: research → script → scene plan → characters.** The provider layer,
> the job orchestrator, the research engine, the script engine, the scene planner
> and the character system are delivered and tested offline. Nothing renders,
> speaks or publishes yet: the voice, media, caption and render stages are still
> to come. The architecture is fully planned in
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
  scenes/           # The scene planner (Phase 7): validated script → scene
                    # manifest (six scene types, camera, animation events,
                    # transitions, on-screen text/diagrams/media, planned assets,
                    # claim/source references) with strict schemas, a coded issue
                    # list and the `plan` stage task — no renderer
  characters/       # The character system (Phase 8): reusable original character
                    # definitions (identity, visual configuration, poses,
                    # expressions, gestures, clothing, accessories, hashed asset
                    # references), the library that loads and verifies them, the
                    # resolver that turns a performance into an ordered layer
                    # stack, a small demonstration cast, and the sync that lets a
                    # scene manifest reference characters without copying them
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

| Plan phase | Scope                                                       | State                                                                   |
| ---------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| 0          | Monorepo, config, tooling, CI, app/worker entrypoints       | ✅ delivered                                                            |
| —          | **Session 2:** domain schemas + persistence foundation      | ✅ delivered (`docs/architecture/domain-model.md`)                      |
| —          | **Session 3:** persistent job orchestration foundation      | ✅ delivered (`docs/architecture/job-orchestration.md`)                 |
| —          | **Session 4:** provider abstraction layer (AD-06/12/13)     | ✅ delivered (`docs/architecture/provider-layer.md`)                    |
| —          | **Session 5:** research engine (topic → research package)   | ✅ delivered (`docs/architecture/research-engine.md`)                   |
| —          | **Session 6:** script engine (research package → script)    | ✅ delivered (`docs/architecture/script-engine.md`)                     |
| —          | **Session 7:** scene manifest (script → six scene types)    | ✅ delivered (`docs/architecture/scene-manifest.md`)                    |
| —          | **Session 8:** character system (reusable original cast)    | ✅ delivered (`docs/architecture/character-system.md`)                  |
| 1          | Hard loop: script → scene graph → voice → captions → render | scene graph ✅ (Session 7); voice/render next (OD-1 Remotion, OD-2 TTS) |
| 2          | Research + fact-check with claim/evidence traceability      | research ✅, script ✅, scenes ✅; `fact_check` stage pending           |
| 3          | Full long-form pipeline + media/license engine              | pending                                                                 |
| 4          | Shorts pipeline (9:16 re-render from scene graph)           | pending                                                                 |
| 5          | Publishing (upload kit first, YouTube API after audit)      | pending                                                                 |

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
[`docs/architecture/script-engine.md`](docs/architecture/script-engine.md);
and (f) the scene planner — `validated script → scene manifest`: an ordered
timeline of CHARACTER / EVIDENCE / HYBRID / DIAGRAM / ENVIRONMENT / TRANSITION
scenes, each carrying the narration it speaks (verbatim, with its sentence ids),
the characters on screen with their states, on-screen text and diagrams built only
from cited research claims, camera, animation events and the transition into the
next scene, plus an asset inventory with search hints for the media stage and the
claim/source evidence behind every factual scene, all validated by strict schemas
and a coded issue list — and nothing rendered —
[`docs/architecture/scene-manifest.md`](docs/architecture/scene-manifest.md);
and (g) the character system — `@nexus/characters`: a strict, reusable character
definition (identity, visual configuration, poses, expressions, gestures,
clothing, accessories, asset references with size and sha256), a library that
loads and verifies it, a resolver that turns a scene's request into an ordered
layer stack with exactly one layer per painted region, and a sync that lets the
scene manifest reference characters by `{characterId, version, hash}` without
copying a single one of their details — shipped with a small, original
two-character demonstration set (38 flat SVG layers, generated deterministically)
and no renderer — [`docs/architecture/character-system.md`](docs/architecture/character-system.md).
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

The plan stage needs no provider at all: it reads the script the previous stage
published and plans deterministically (the same script plans the same scenes
every time), so `pnpm verify` — and any re-plan — costs nothing and touches no
network. It stores one `scene_graph` artifact and never writes `scenes` rows
(OD-19).

The character system needs no provider either, and adds no configuration of its
own: `CharacterLibrary.load({verifyAssets: true})` reads the bundled original cast
from `packages/characters` (or any directory of the same shape), and passing the
library as a plan's `cast` is what turns `cast[].id` into a definition reference.
Rebuild the demonstration art with
`node packages/characters/tools/build-demo-set.mjs` — byte-identical on a re-run,
so the hashes the definitions record stay valid.

The script stage needs only the `llm` capability (the fakes write a schema-valid
draft offline) and reads the package the earlier stage published. It parks the
job at `MANUAL_INPUT` when the AI capability degrades, and also when research
cleared nothing that may be asserted or reported — writing an opinion piece
instead of a factual script is an operator's decision, not the engine's.

Open decisions that block Phase 1 (Remotion licensing, TTS provider) are
tracked in [`docs/plans/000-decisions.md`](docs/plans/000-decisions.md#open-decisions-must-be-resolved-at-the-named-gate);
issues, pending items and unresolved risks are tracked in
[`docs/plans/ISSUES.md`](docs/plans/ISSUES.md).
