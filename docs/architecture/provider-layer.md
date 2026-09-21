# Provider Layer (Phase 4)

Phase 4 builds the seam between Nexus and the outside world. Nothing in the
pipeline talks to an API, a disk or a CDN directly: every external capability is
reached through a small interface in `@nexus/providers`, chosen at startup by
configuration, metered as it is used, and replaceable in a test without changing
a single line of pipeline code.

The three decisions this implements:

- **AD-06 — no core coupling to any vendor.** Six capability interfaces, each
  with a registry, a real adapter (or an honest refusal when none exists yet),
  a deterministic fake, and — where a human is a legitimate substitute — a
  manual fallback.
- **AD-12 — secrets and safety.** Credentials exist only as environment-variable
  _names_; the media fetcher refuses anything that is not a public HTTP(S) URL;
  LLM output is validated against a schema before the pipeline ever sees it.
- **AD-13 — metering is not optional.** Every call goes through one `invoke()`
  pipeline that consults the budget, uses the content-hash cache, records the
  call, and knows when to stop.

---

## 1. The six capabilities

| Capability   | Interface (`src/*.ts`)                                    | Adapters registered today                            |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------- |
| `llm`        | `LLMProvider.chat`                                        | `none`, `fake`, `manual`, `openai-compatible` (real) |
| `research`   | `ResearchProvider.search` / `.images`                     | `none`, `fake`, `manual`                             |
| `tts`        | `TTSProvider.synthesize` / `.voices`                      | `none`, `fake`, `manual`                             |
| `media`      | `MediaProvider.fetch`                                     | `none`, `fake`, `manual`                             |
| `storage`    | `StorageProvider` (put/putFromFile/has/read/getPath/list) | `none`, `fake`, `local` (real, the default)          |
| `publishing` | `PublishProvider.upload` / `.quota`                       | `none`, `fake`, `manual`                             |

Only one real adapter exists so far, and deliberately so: `openai-compatible`
covers any OpenAI-shaped endpoint (OpenRouter, Groq, Together, a local llama.cpp
server) by base URL, so buying a second vendor integration before a provider is
chosen (OD-3) would be cost without benefit. The interfaces are what the pipeline
depends on; adding a research/TTS/media adapter later means registering one
descriptor.

`storage` is the one kind without a `manual` adapter: a human cannot stand in for
a disk, and the `local` adapter has no quota to exhaust, so there is nothing to
degrade to. It is also the only capability configured by default (`local`) —
the system must be runnable without an account anywhere.

## 2. Selection and degradation

Selection is a string per capability:

```
NEXUS_LLM_PROVIDER=openai-compatible:meta-llama/llama-3.1-8b-instruct
                   └── adapter ──┘ └──────── variant (model) ────────┘
```

Only the first colon separates adapter from variant, so model names containing
slashes or colons work unchanged. A call site may override the configuration
(`providers.llm("fake")`) — that is how `--dry-run` and tests stay offline while
production points at a real endpoint.

Resolution is one function, and every path through it is observable:

1. **Unknown adapter** → `ProviderConfigurationError` listing what _is_
   registered; never a silent fallback.
2. **Budget-degraded live adapter** → the registry swaps it for the `manual`
   adapter once the account is at `degradeRatio` (default 90%) of its quota, or
   disabled, or cooling down. Degrading logs once per capability, not per call.
3. **No account row** → allowed. Metering always works; quotas are opt-in per
   adapter.

The swap is why the pipeline never asks "which provider is this?" — it asks for
the capability and gets something that satisfies the interface, whether that is
an API client, a fake, or instructions for a human.

`--dry-run` is the same mechanism with a fixed answer: `dryRunConfig(config)`
(and `DRY_RUN_ENV` for CLI runs) points every remote capability at its fake while
leaving storage on the real local CAS — a dry run whose artifacts evaporated
with the process could not be inspected. The flag itself arrives with the app
wiring (GAP-9); the selection helper is here so nothing downstream has to know
what "dry run" means.

## 3. `invoke()` — the one path every call takes

```
budget (fail closed at the cap, degrade near it)
  → cache (hit: 0 units, cached: true, no adapter work)
  → rate-limit permit (self-imposed, waits instead of failing)
  → attempt (own deadline, abort-aware)  ── failure ──┐
  → retry with backoff (Retry-After honoured)         │
  → metering (one row per attempt)                    │
  → ProviderResult<T>  ◄──────────────────────────────┘  (classified ProviderError)
```

Details that matter:

- **Timeout vs cancel.** An outer abort is reported as `ProviderCanceledError`
  even when it lands exactly on the deadline; a deadline is
  `ProviderTimeoutError`. Operators need to distinguish "I stopped it" from
  "it hung".
- **Errors are rows.** Every failed attempt is written to `provider_call_log`
  with its classification, redacted and truncated to 400 characters. A flaky
  provider is diagnosable after the fact, and the retry ceiling is enforced.
- **Retry-After beyond the deadline** is not slept through: the failure is
  reported so the _job_ scheduler can pick it up later with real backoff.
- **`ManualRequiredError` is not retryable.** It is the signal a task catches to
  park (`{ waiting: "MANUAL_INPUT" }`) while the operator works; if it escapes,
  `toJobError` maps it to a permanent failure rather than burning attempts.

## 4. Quota (AD-13)

`provider_accounts` holds one row per `(adapter, scope)`; `provider_call_log`
records what happened. `BudgetGuard` reads them and answers one question —
allowed, degraded, or refused — plus the cooldown after a provider asks us to
slow down.

Two rules that took a bug to learn:

- **Rolling a window never erases usage.** When `window_started_at` is NULL the
  guard _stamps_ the window rather than resetting it; a reset would zero usage
  already charged in that period.
- **The caller's clock owns the timestamp.** The provider layer stamps
  `created_at` from its own clock so quota arithmetic and injected test clocks
  agree.

## 5. Fakes, manual and `none`

The fakes exist so the whole pipeline can be exercised in CI (and in
`--dry-run`) with no accounts and no network:

| Fake       | What it produces                                                                            |
| ---------- | ------------------------------------------------------------------------------------------- |
| LLM        | Schema-_valid_ structured output sampled from the schema; optional injected responder       |
| Research   | Deterministic results per query; licences rotate (`cc0`/`cc_by`/`cc_by_sa`/`public_domain`) |
| TTS        | A real playable WAV in the CAS, plus word timings that tile the audio exactly               |
| Media      | A real 1×1 PNG (valid bytes) with licence metadata attached                                 |
| Storage    | An in-memory blob store with the same content-addressing contract as the disk one           |
| Publishing | Stable fake ids, a daily upload quota that actually refuses the next upload                 |

Three properties are enforced by the shared contract suite rather than promised:

1. **Identity** — every adapter reports the id/kind/mode/label it was registered
   under (a test that caught the fake storage adapter announcing `memory`).
2. **Shape** — a successful call returns a `ProviderResult` with usage
   accounting; storage returns a blob descriptor (writing bytes is not a metered
   external call).
3. **Failure discipline** — everything thrown is a `ProviderError` subclass from
   this package; `none` refuses with the variable to set, `manual` raises a
   hand-off with instructions.

Where the fake would differ from a real provider in a way that matters, the
difference is explicit: the fake media fetcher does no URL validation because it
never opens a socket — the SSRF guard (`assertPublicHttpUrl`) belongs to real
fetchers and is tested directly. The fake publisher declares no cache entry,
because uploading is a side effect; re-running a _stage_ is prevented by the
orchestrator's completed-stage lookup, not by pretending the upload happened.

## 6. Structured LLM output (AD-12)

`chat()` never returns model text. It returns data that already validated:

1. the request carries a zod schema and a template version;
2. the model is asked for JSON (`response_format: json_object`) and the reply is
   parsed tolerantly (plain JSON, fenced blocks, JSON embedded in prose);
3. a failure to parse or validate triggers a bounded repair attempt (default 1)
   with the validation issues quoted back;
4. exhausting the budget raises `ProviderContentError` — a _content_ failure,
   retried by `invoke()` under the attempt ceiling, never silently passed on.

The template version and prompt go into the cache key, so editing a prompt or
re-pinning a model produces a cache miss instead of a stale answer.

## 7. How this was verified

- `pnpm verify` green: format, lint, typecheck, build, and **21 test files /
  274 tests** (94 of them in `@nexus/providers`).
- The new suites: `errors`, `util`, `invoke`, `quota`, `registry`, `llm`,
  `capabilities`, `contract`, plus `provider-repo` in `@nexus/db` and the
  extended `env` suite in `@nexus/config`.
- **No network, no keys**: every test runs offline; the real LLM adapter is
  exercised against an injected transport, and the contract suite asserts that an
  unconfigured real adapter fails with a _classified_ error rather than a raw
  exception.
- Two real defects were found by these tests and fixed: an SSRF bypass where
  `new URL()` normalises `::ffff:169.254.169.254` to a hex form the guard did not
  recognise, and a quota counter that counted its own quota probes as uploads.
- Credential leakage is tested end to end: a provider that echoes the API key
  back still leaves no trace of it in logs or the call log (`[redacted]`).

## 8. What Phase 4 deliberately does not include

- **Real research/TTS/media/publishing adapters.** The interfaces and the fake
  implementations are the deliverable; vendor selection is pending (OD-2, OD-3,
  OD-5, OD-8) and free-tier access is the operator's decision.
- **HTTP routes, app wiring and task registration.** The container is constructed
  by tests only; `apps/nexus` still runs the Phase 1 entrypoints (GAP-9).
- **Enforcement at the task layer.** The budget guard decides; the tasks that act
  on a `QUOTA` gate arrive with the pipeline that consumes these capabilities.
- **DNS-level SSRF protection.** The guard validates the URL before a socket is
  opened, but a public hostname that _resolves_ to a private address is not
  blocked yet (tracked as GAP-11 in `docs/plans/ISSUES.md`).
