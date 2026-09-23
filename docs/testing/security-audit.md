# Security audit — Nexus Forge

**Scope:** the 19 areas of the audit brief. Method: inspect the code that implements each
area, then attack it in a safe test environment (in-memory runtime, mock providers, scripted
FFmpeg — no network, no keys, no deployment touched). Unambiguous vulnerabilities were fixed
and pinned with regression tests; decisions that need architecture (not guesswork) are
recorded as documented findings.

**Deliverables of this pass**

- Fixes **SA-1…SA-3** (below), each with a regression test in `tests/security/`.
- Documented findings **SA-4…SA-9** (below) — recorded with analysis and a recommended
  direction, deliberately **not** "fixed" by guessing.
- Confirmed-good controls pinned as regression tests (SSRF guard, URL schemes, redaction,
  SQL parameterization, publish gates, fingerprint binding).
- Suite after the pass: **86 files / 998 tests passing** (+3 skipped), format/lint/tsc clean.

**Where the tests live:** `tests/security/dashboard.test.ts` (routes, headers, gates,
publishing, injection) and `tests/security/providers.test.ts` (SSRF, URL schemes, secrets,
redaction, SQL, command-execution boundary).

---

## Fixes (vulnerabilities found and closed)

### SA-1 — Cross-site request forgery on every dashboard action (critical, fixed)

- **Finding.** The dashboard's state changes are unauthenticated form POSTs (`/episodes`,
  `…/start`, `…/shorts`, `…/publish`, `/jobs/:id/approve|reject|changes|retry`) and carried no
  origin verification. Reproduced: `POST /episodes` with `Origin: https://evil.example` returned
  **303 and created the episode** — any web page the operator visits could drive their browser
  through the dashboard's same-origin policy and press **approve**, **publish**, or **start**
  on their behalf (a form POST is not a CORS request; the response is unreadable to the attacker
  but the side effect happens).
- **Fix.** An `onRequest` hook refuses any POST whose `Origin` header names a different host
  than the request's `Host` — browsers set `Origin` on cross-site POSTs and script forms cannot
  forge it; `Origin: null` (sandboxed frames, some cross-site redirects) is refused; same-origin
  POSTs, origin-less clients (curl, the worker, tests) and reverse proxies that preserve `Host`
  pass unchanged. GETs are unaffected (they are read-only by design).
- **Regression tests.** `dashboard.test.ts` SA-1 group: cross-origin POST → 403 with nothing
  recorded; `null`/malformed origins → 403; same-origin and no-origin POSTs still work; GETs
  unrestricted.

### SA-2 — Artifact bytes were served sniffable (medium, fixed)

- **Finding.** Artifact responses (`/artifacts/:hash` — the bytes of research documents,
  scripts, render metadata, i.e. outside content) carried no `X-Content-Type-Options`, so a
  browser could sniff a JSON/`application/octet-stream` body into HTML or script execution on
  the dashboard's origin (stored XSS via artifact content). No framing or referrer policy
  either (clickjacking of the approve/publish buttons; referrer leakage).
- **Fix.** Every response now carries `X-Content-Type-Options: nosniff`, `X-Frame-Options:
DENY` and `Referrer-Policy: no-referrer`. Artifact content types come from a fixed kind→type
  map (there is no `text/html` in it — verified by test).
- **Regression tests.** `dashboard.test.ts` SA-2 group: headers present on pages and error
  pages; an artifact whose bytes are an HTML page is served with a non-HTML type and `nosniff`.

### SA-3 — Unhandled errors leaked internal detail to the browser (medium, fixed)

- **Finding.** The error handler rendered any error's raw message — including 500s from
  infrastructure failures (SQLite messages, absolute filesystem paths, stack-adjacent detail) —
  into the error page. Reproduced with a route that throws a realistic internal error: the page
  displayed `SqliteError: …` and `/home/operator/secret-data/nexus.db`.
- **Fix.** 4xx responses keep their operator-facing messages (validation feedback is a
  feature); 5xx responses render a generic message while the real cause goes to the server log
  (where it already was logged).
- **Regression tests.** `dashboard.test.ts` SA-3: a 500 page contains neither the error class
  nor the path and points at the server log; 404 handling unchanged.

---

## Documented findings (architecture decisions recorded, not guessed)

### SA-4 — The dashboard has no authentication or tenant model (documented; scope)

The dashboard is a **single-operator, localhost tool** (documented in
`docs/architecture/dashboard.md`): no login, no sessions, every route addresses episodes/jobs
by id with no project scoping, and job ids are UUIDs (unguessable in practice, not
authorization). Adding authentication, roles, or tenant isolation is a product/architecture
decision — not a patch. The audit's position: with SA-1 in place, the browser-facing risk is
bounded to an operator who runs the dashboard on a machine they use to browse; anyone deploying
this beyond localhost must put an authenticating reverse proxy in front of it and treat
`docs/architecture/dashboard.md` as the contract. Recorded in ISSUES.md (AD security notes).

### SA-5 — Publish-task approval check is episode-scoped, not content-fingerprint-scoped (documented; needs design)

The publish **task** re-checks QA (by hash), episode state, and the existence of an `approved`
`FINAL_APPROVAL`/`SHORT_APPROVAL` decision — but that approval lookup is by episode only, not
by the _content fingerprint_ the approval was recorded against (`latestValidApproval`, which
binds fingerprints, exists in the repo but is not used here). The dashboard **route** partially
compensates: publishing requires the episode to be READY, and reaching READY requires the
final gate to have been passed for the current content — so the exploitable window is narrow
(content changing _after_ READY without a new gate). Closing it properly requires deciding what
content identity a publish approval binds (the parked approval stage's fingerprint? the QA
report hash? the video hash?) — an architecture decision, recorded instead of guessed.
Recommended direction: bind the publish decision to `latestValidApproval` over a fingerprint
derived from the artifact set being published.

### SA-6 — Gate decisions bind to parked content, but the dashboard approve does not re-verify at click time (documented; accepted for a single operator)

`resolveGate` binds every decision to the parked content's fingerprint (approved-then-changed
content re-parks — pinned by `orchestration.test.ts` and `dashboard.test.ts`). The dashboard's
approve button sends no fingerprint: the operator approves _whatever is parked when the POST
lands_ (a seconds-wide TOCTOU between viewing the page and clicking). For a single-operator
tool this is acceptable; multi-operator review would want the form to carry the fingerprint the
operator saw (the route support already exists).

### SA-7 — OAuth consent and token custody are operator-side by design (documented; unchanged)

The YouTube adapter consumes a **standing refresh token** from an environment variable named
by `credentials_env`; the consent flow, token issuance and revocation happen outside the
product (operator-side, documented in `docs/architecture/publishing.md`). Access tokens live
in process memory only (never the DB, never a file), every adapter log line passes `neverLog`
(pattern redactions **plus exact-value scrubbing of the configured secret** — pinned by the
Phase 15 leak test), and the DB stores credential _names_, never values (pinned by
`providers.test.ts`). No change made; the custody model is the documented architecture.

### SA-8 — SSRF: strong pre-fetch guard, but no shipped fetcher re-checks DNS (documented; deferred with the real fetcher)

`assertPublicHttpUrl` refuses non-HTTP(S) schemes, embedded credentials, loopback/link-local/
RFC1918/CGNAT literals (including IPv4-mapped IPv6 spellings, which the URL parser
canonicalizes first — octal/hex/integer IPv4 forms included), localhost and `.local` names.
Research discovery runs every candidate row through it, and non-HTTP(S) rows are dropped before
storage (pinned). Residual risk: the guard inspects the URL's **host string**; a public DNS
name that resolves to a private address (DNS rebinding) is not re-checked at resolution time.
Today nothing fetches research URLs (the real research adapter is deferred; the fakes never
open a socket), so there is no reachable fetch to harden. Requirement recorded for the future
fetcher: resolve the host, run the guard's address rules on the resolved IPs, connect only to
the validated address.

### SA-9 — Error pages render message text; flash messages render operator-supplied notes (documented; accepted)

4xx messages are operator-facing by design (validation feedback). Everything user- or
content-supplied is HTML-escaped by one `esc()` helper (pinned: hostile topics, flash params,
reflected paths render as text). The residual consideration is information _freshness_, not
injection: 4xx messages may name internal identifiers (job states, gate names) — appropriate
for the single-operator audience of SA-4.

---

## Area-by-area results (19 areas)

| Area                     | Result                      | Evidence                                                                                                                                                                            |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | SA-4 (documented scope)     | local-tool contract; no auth to audit                                                                                                                                               |
| Authorization            | Held                        | gates refuse non-parked/foreign-fingerprint decisions (`dashboard.test.ts`); only FAILED jobs are retryable; claims are exclusive (reliability #16)                                 |
| API access               | SA-1 fixed                  | origin guard on all POSTs; reads unaffected                                                                                                                                         |
| Database access          | Held                        | node:sqlite, positional parameters everywhere (the one dynamic IN-list is built from schema-validated enum values — `repo.ts` `listJobsByState`); `foreign_keys=ON`, `busy_timeout` |
| Artifact access          | Held + SA-2 fixed           | sha-256 validation at the store (RL-1), HEX64 + registered-artifact checks at the route, fixed content-type map, `nosniff`                                                          |
| File uploads             | Held (none exist)           | no multipart parser; forms are urlencoded text fields only                                                                                                                          |
| URL fetching             | Held                        | only the YouTube adapter fetches (fixed googleapis hosts); research fetcher deferred                                                                                                |
| SSRF                     | Held + SA-8 documented      | `assertPublicHttpUrl` pin: schemes, credentials, private/mapped/octal literals (12 cases)                                                                                           |
| Command execution        | Held                        | `spawnSync(binary, args[])`, never a shell (`ffmpeg.ts`); binary from operator config; file names hash-derived; hostile strings stay data (pinned)                                  |
| Injection                | Held                        | parameterized SQL pinned with hostile strings; HTML escaped by one helper (pinned incl. attributes)                                                                                 |
| Secrets                  | Held                        | env-var names only in DB (pinned); no hardcoded credentials found; redactor seeded with the real secret value                                                                       |
| OAuth                    | Held (SA-7)                 | tokens memory-only, `neverLog` scrubbing, leak test from Phase 15                                                                                                                   |
| Job manipulation         | Held                        | idempotency dedup (pinned), claim exclusivity, FAILED-run refusal (RL-2), id-addressed routes unguessable (SA-4 scope)                                                              |
| Approval bypass          | Held (SA-5/SA-6 documented) | fingerprint-bound decisions (pinned); publish task independently re-checks QA/state/approval                                                                                        |
| Publishing controls      | Held                        | route + task re-check QA verdict, approval, READY state; privacy whitelist; content-addressed request; dedup (Phase 15 tests + `dashboard.test.ts`)                                 |
| Provider credentials     | Held                        | `credentials_env` names (pinned); container redaction                                                                                                                               |
| Tenant/project isolation | SA-4 (documented scope)     | single-tenant local tool; routes address ids directly                                                                                                                               |
| Error leakage            | SA-3 fixed                  | 5xx generic; 4xx operator-facing; log carries the cause                                                                                                                             |
| Logs                     | Held                        | provider summaries redacted (`safeSummary` → `deps.redact`), YouTube messages via `neverLog`, structured JSON worker log carries events not payloads                                |

## Regression coverage added

- `tests/security/dashboard.test.ts` — 14 tests: SA-1 (4), SA-2 (2), SA-3 (1), gate/publish
  controls (4), injection/escaping/isolation probes (3).
- `tests/security/providers.test.ts` — 19 tests: SSRF guard (15), research URL schemes (1),
  secrets/redaction (2), command-execution boundary (1 documented probe), SQL injection (1).
- No pre-existing test was weakened; the Phase 15 publish-gate tests and the Phase 17
  reliability suite pass unchanged.
