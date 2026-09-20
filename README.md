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

| Phase | Scope                                                       | State                               |
| ----- | ----------------------------------------------------------- | ----------------------------------- |
| 0     | Monorepo, config, tooling, CI, app/worker entrypoints       | **this repo** ✅                    |
| 1     | Hard loop: script → scene graph → voice → captions → render | not started (blocked on OD-1, OD-2) |
| 2     | Research + fact-check with claim/evidence traceability      | not started                         |
| 3     | Full long-form pipeline + media/license engine              | not started                         |
| 4     | Shorts pipeline (9:16 re-render from scene graph)           | not started                         |
| 5     | Publishing (upload kit first, YouTube API after audit)      | not started                         |

**Session 2 deliverable (this branch):** the domain model + persistence
foundation — versioned migrations, typed/validated schemas, resumable job
state, provenance-tracked artifacts (CAS hashes, never blobs). It sits before
plan-Phase 1 because every later step depends on typed artifacts and
crash-resumable jobs. See
[`docs/architecture/domain-model.md`](docs/architecture/domain-model.md).

Open decisions that block Phase 1 (Remotion licensing, TTS provider) are
tracked in [`docs/plans/000-decisions.md`](docs/plans/000-decisions.md#open-decisions-must-be-resolved-at-the-named-gate);
issues, pending items and unresolved risks are tracked in
[`docs/plans/ISSUES.md`](docs/plans/ISSUES.md).
