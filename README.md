# Nexus Forge

Cloud-first automated video production system: topic → research → fact-check
→ script → scenes → media → voice → captions → render → QA → **human
approval** → publish, plus a long-form → Shorts repurposing pipeline.

> **Status: research → script → scene plan → characters → composition → voice
> → captions.**
> The provider layer, the job orchestrator, the research engine, the script
> engine, the scene planner, the character system, the animation/composition
> engine and the voice/caption architecture are delivered and tested offline — a
> deterministic fake voice writes real audio into the CAS, so the whole audio
> path runs with no key and no paid call. Nothing publishes or writes a video
> file yet: the media stage and the rasteriser/encoder are still to come. The
> architecture is fully planned in
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
  nexus/            # The single application (AD-01): the operator dashboard and
                    # the pipeline worker over one runtime (SQLite + CAS + a
                    # provider container). Server-rendered HTML (create/start/
                    # inspect/approve/reject/retry — Phase 13), a 12-stage task
                    # registry, and the app's glue stages (idea, fact_check gate,
                    # source_media, animate, approval) in `src/pipeline.ts`
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
  render/           # Animation & composition engine (Phase 9): a validated scene
                    # manifest + the character library -> deterministic frames
                    # (blocking, camera, animation events, text, transitions,
                    # pose/expression) -> SVG, with a coded diagnostic list and a
                    # one-scene demonstration wired end to end
  audio/            # The voice + caption architecture (Phase 10): typed voice
                    # configuration (casting) over the TTS capability, one synthesis
                    # segment per scene, clips in the CAS, duration metadata verified
                    # against the bytes, a segment cache, retries and coded
                    # provider-failure handling — plus the timing document captions
                    # and the renderer read, the cue engine that *derives* captions
                    # from the narration and that timing (never embedded per scene),
                    # and the `voice` / `captions` stage tasks
  video/            # The rendering pipeline (Phase 11): a browser-free, deterministic
                    # rasteriser (TTF text, SVG layers, PNG) that draws exactly the frame
                    # documents Phase 9 emits, and an FFmpeg pipeline that turns them into
                    # one MP4 — resumable by segment, reusable by content key, with render
                    # metadata, a render log and coded failure reports, plus the `render`
                    # stage task, a demo tool and a real-binary smoke test
  qa/               # The automated QA engine (Phase 12): five deterministic checks
                    # (content, visual, audio, video, pipeline) over the documents the
                    # earlier stages published, one structured report, and the gate that
                    # can BLOCK publication — plus the `qa` stage task
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

| Plan phase | Scope                                                            | State                                                                                                       |
| ---------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0          | Monorepo, config, tooling, CI, app/worker entrypoints            | ✅ delivered                                                                                                |
| —          | **Session 2:** domain schemas + persistence foundation           | ✅ delivered (`docs/architecture/domain-model.md`)                                                          |
| —          | **Session 3:** persistent job orchestration foundation           | ✅ delivered (`docs/architecture/job-orchestration.md`)                                                     |
| —          | **Session 4:** provider abstraction layer (AD-06/12/13)          | ✅ delivered (`docs/architecture/provider-layer.md`)                                                        |
| —          | **Session 5:** research engine (topic → research package)        | ✅ delivered (`docs/architecture/research-engine.md`)                                                       |
| —          | **Session 6:** script engine (research package → script)         | ✅ delivered (`docs/architecture/script-engine.md`)                                                         |
| —          | **Session 7:** scene manifest (script → six scene types)         | ✅ delivered (`docs/architecture/scene-manifest.md`)                                                        |
| —          | **Session 8:** character system (reusable original cast)         | ✅ delivered (`docs/architecture/character-system.md`)                                                      |
| —          | **Session 9:** animation & composition engine (one scene)        | ✅ delivered (`docs/architecture/render-engine.md`)                                                         |
| —          | **Session 10:** voice + caption/timing architecture              | ✅ delivered (`docs/architecture/audio-captions.md`)                                                        |
| —          | **Session 11:** cloud-compatible rendering pipeline              | ✅ delivered (`docs/architecture/video-rendering.md`)                                                       |
| —          | **Session 12:** automated QA engine (blocks publication)         | ✅ delivered (`docs/architecture/qa-engine.md`)                                                             |
| —          | **Session 13:** minimal functional operator dashboard            | ✅ delivered (`docs/architecture/dashboard.md`)                                                             |
| —          | **Session 14:** short-form repurposing engine (shorts)           | ✅ delivered (`docs/architecture/shorts.md`)                                                                |
| 1          | Hard loop: script → scene graph → voice → captions → render → QA | scene graph ✅, voice ✅, captions ✅, render ✅, QA ✅; `approval`/`publish` stages pending (plan-Phase 5) |
| 2          | Research + fact-check with claim/evidence traceability           | research ✅, script ✅, scenes ✅; `fact_check` stage pending                                               |
| 3          | Full long-form pipeline + media/license engine                   | pending                                                                                                     |
| 4          | Shorts pipeline (9:16 re-render from scene graph)                | engine ✅ (selection + 9:16 reflow, `docs/architecture/shorts.md`); stage wiring pending                    |
| 5          | Publishing (upload kit first, YouTube API after audit)           | pending                                                                                                     |

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
and no renderer — [`docs/architecture/character-system.md`](docs/architecture/character-system.md);
and (h) the animation & composition engine — `@nexus/render`: a validated scene
manifest plus the character library become **deterministic frames** (blocking by
cast count and shot, camera setups from 13 movements / 5 focuses / 5 angles,
animation events folded into opacity / position / scale / rotation / reveal /
pose / expression, on-screen text with counting, typing and fitting, and the
trailing transition seam), and those frames become SVG — with the demonstration
scene (`packages/render/demo/scene.json`: two characters, 12 events, 345 frames)
walked end to end from manifest to composited scene, and no video pipeline —
[`docs/architecture/render-engine.md`](docs/architecture/render-engine.md);
and (i) the voice architecture — `@nexus/audio`: a scene manifest plus a voice
casting become one synthesis segment per scene, clips in the CAS and an audio
track whose durations are _measured_ (a WAV header or an MP3 frame header, never
trusted from the adapter alone), with segment-level caching, a deterministic
retry budget, coded provider-failure handling that parks the job for an operator
to supply the clips that failed, and the sentence/scene timing document that
captions and the renderer read —
[`docs/architecture/audio-captions.md`](docs/architecture/audio-captions.md); and
(j) the caption/timing architecture — the same package's cue engine: captions
**derived** from a scene's narration and its measured window (never a caption
typed into a scene), wrapped to safe line lengths at word boundaries, held when
they would flash by, split when they would sit too long and reported when they
read too fast, published as a `captions` artifact with the `captions` stage task
; and
(k) the rendering pipeline — `@nexus/video`: a scene manifest, the character assets,
the animation events, the narration, the caption track and a validated render
configuration become one real MP4 through a **deterministic in-process rasteriser**
(the same frame documents Phase 9 writes as SVG, drawn with a TrueType parser and an
anti-aliased canvas — no browser, no GPU, no downloads) and **FFmpeg**, with segments
resumable after a kill, artifacts reusable by content key, a render key that pins
config + plan + audio + captions + fonts, output verified by reading the file back,
and failures reported as coded errors plus a `render_failure` report in the CAS —
[`docs/architecture/video-rendering.md`](docs/architecture/video-rendering.md);
and (l) the automated QA engine — `@nexus/qa`: five deterministic checks over the
documents the earlier stages published — content (missing sections, unsupported
claims, missing sources, contradictions), visual (missing assets, broken
references, missing scenes, unreadable text, invalid layouts, measured as _ink_
with the real fonts), audio (missing clips, duration mismatch, unexpected silence
found by a prefix-sum RMS walk, invalid artifacts), video (invalid/corrupted
output, wrong resolution or duration, encoding failures, dropped captions) and
pipeline (invalid job state, missing artifacts, holes in the stage run) — assembled
into one structured, versioned report whose `publishable` flag is computed, never
authored, and enforced three ways (`assertPublishable`, the `qa` stage failing the
job, reuse validation refusing blocked reports) so an episode that fails QA cannot
reach approval or publishing —
[`docs/architecture/qa-engine.md`](docs/architecture/qa-engine.md);
and (m) the operator dashboard — the single `apps/nexus` application with two
entrypoints (dashboard host + pipeline worker) over one runtime, the 12-stage
dashboard pipeline (longform minus publishing) with its glue stages and the
enforced `FACT_REVIEW`/`FINAL_APPROVAL` gates, server-rendered pages to create,
start, watch, inspect (research, sources, script, scenes, artifacts, QA) and
decide (approve, reject, rewind, retry) —
[`docs/architecture/dashboard.md`](docs/architecture/dashboard.md).
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

The `voice` stage is the first one that speaks: it reads the manifest the plan
stage published and synthesizes one clip per scene through the `tts` capability,
so `NEXUS_TTS_PROVIDER=fake` (the default) runs the whole path offline against a
deterministic WAV writer and a real adapter can be configured later without
touching the stage. `NEXUS_TTS_VOICE` (empty = the adapter's own first voice),
`NEXUS_TTS_FORMAT`/`NEXUS_TTS_SAMPLE_RATE`/`NEXUS_TTS_RATE` and
`NEXUS_AUDIO_SEGMENT_CACHE` (off, or a path to a segment index) are its only
knobs; when a scene cannot be voiced the stage parks the job at `MANUAL_INPUT`
with instructions (`params.operatorAudio`) rather than shipping a silent scene.
The `captions` stage needs no provider at all — it derives cues from the narration
and the audio track the voice stage published, and the same track always produces
the same subtitles.

The `render` stage is provider-free too (`NEXUS_FFMPEG_PATH`/`NEXUS_RENDER_*` are
its only knobs — see `docs/architecture/video-rendering.md`), and so is the stage
after it: the `qa` stage reads what the earlier stages published, runs the five
checks and stores the report — `NEXUS_QA_*` (thresholds: font sizes, tolerances,
silence) is its whole configuration surface, and every value is hashed into the
report so a verdict traces to the rules that produced it. A report with an error
finding fails the stage: the episode stops before approval, with the reasons in the
report artifact either way.

The character system needs no provider either, and adds no configuration of its
own: `CharacterLibrary.load({verifyAssets: true})` reads the bundled original cast
from `packages/characters` (or any directory of the same shape), and passing the
library as a plan's `cast` is what turns `cast[].id` into a definition reference.
Rebuild the demonstration art with
`node packages/characters/tools/build-demo-set.mjs` — byte-identical on a re-run,
so the hashes the definitions record stay valid.

The composition engine needs no provider either, and no rasteriser: it composes
frames, writer as SVG. `pnpm test` runs the smoke test
(`packages/render/src/demo.test.ts`) over the shipped demonstration scene, and
`pnpm build && node packages/render/tools/compose-demo.mjs` writes a storyboard of
sampled frames, the frame documents and four full-resolution frames into
`data/render-demo/` for a browser to draw.

The script stage needs only the `llm` capability (the fakes write a schema-valid
draft offline) and reads the package the earlier stage published. It parks the
job at `MANUAL_INPUT` when the AI capability degrades, and also when research
cleared nothing that may be asserted or reported — writing an opinion piece
instead of a factual script is an operator's decision, not the engine's.

Open decisions that block Phase 1 (Remotion licensing, TTS provider) are
tracked in [`docs/plans/000-decisions.md`](docs/plans/000-decisions.md#open-decisions-must-be-resolved-at-the-named-gate);
issues, pending items and unresolved risks are tracked in
[`docs/plans/ISSUES.md`](docs/plans/ISSUES.md).
