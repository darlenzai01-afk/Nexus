# Publishing (Phase 15)

YouTube publishing, through the provider layer's existing `PublishProvider`
capability — the same abstraction the manual upload-kit path (the audit-gated
first path) and the deterministic fake already speak. No new pipeline stage
graph, no vendor SDK: the adapter talks the YouTube Data API v3 over the
provider layer's own `FetchLike` seam.

```
operator presses Publish (episode READY, QA passed)
        │  the request (title/description/privacy/schedule) is stored
        │  content-addressed; its hash rides the job's idempotency key
        ▼
publish job (steps: ["publish"]) ──► createPublishTask
        │
        ├─ GATE 1  QA report: loads the report the episode was approved on;
        │          verdict pass | pass_with_warnings AND publishable —
        │          a failed report ⇒ PermanentError, NO upload call
        ├─ GATE 2  approval: an `approved` decision at FINAL_APPROVAL /
        │          SHORT_APPROVAL must exist for the episode
        ├─ dedup   a prior publish record for the same video ⇒ return it
        │          (never a second upload)
        ├─ GATE 3  episode state READY / PUBLISHING
        ▼
PublishProvider.upload(videoHash, metadata)   ── fake │ manual kit │ youtube
        │
        ├─ metadata artifact (publish_record)  ── the audit trail
        └─ document artifact  (confirmation / upload-kit instructions)
```

## 1. The gates are the task's own (defence in depth)

The stage graph only lets `publish` follow `approval`, but the task does not
trust wiring: it loads the QA report from the artifact store and checks the
verdict itself. **An episode that failed QA is not publishable — not scored
low, not deferred: refused**, with a `PermanentError` (the runner fails the
step and no retry can pass the same report). The dashboard route repeats the
same checks for fast feedback, and the task repeats them again from durable
state — the route is a convenience, never the gate.

## 2. What the capability supports

| Requested           | Where                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth               | `real/youtube.ts`: refresh-token grant against `oauth2.googleapis.com`; the access token is cached in memory and refreshed a minute before expiry; a 401 mid-call refreshes **once** and lets the invoke pipeline's retry ride the new token                                            |
| Upload              | the resumable protocol (`uploadType=resumable` → session `Location` → `PUT` bytes from the CAS); video bytes must exist in the artifact store _before_ the request — missing bytes refuse before anything moves                                                                         |
| Title / description | enforced against YouTube's own limits (≤ 100 / ≤ 5000 chars) before any HTTP                                                                                                                                                                                                            |
| Metadata            | tags, `categoryId`, language, `madeForKids` (`selfDeclaredMadeForKids`)                                                                                                                                                                                                                 |
| Thumbnail           | `thumbnails/set` with the registered thumbnail's bytes; a thumbnail failure after a successful upload is logged, not fatal — the video already exists, and a retry would duplicate it                                                                                                   |
| Privacy status      | `private` / `unlisted` / `public` (default `private`)                                                                                                                                                                                                                                   |
| Scheduling          | `status.publishAt`; YouTube's rule enforced up front: scheduling requires `privacyStatus: "private"`                                                                                                                                                                                    |
| Upload status       | `PublishProvider.status?(ref)` (optional capability extension) — videos.list → `uploadStatus`/`processingStatus`/`privacyStatus`/`publishAt`/`rejectionReason` in the abstraction's own words; the fake implements it deterministically, the manual kit reports `kit_ready` by existing |
| Retry handling      | transport/5xx/429 stay retryable (the invoke pipeline backs off inside the call; the runner retries the stage); quota walls fail closed (`ProviderQuotaError`); validation and gate violations are permanent; an already-published episode is a dedup, never a duplicate upload         |

## 3. Credential discipline (the phase's hard rules)

- The three secrets — `NEXUS_YOUTUBE_CLIENT_ID`, `NEXUS_YOUTUBE_CLIENT_SECRET`
  (the capability's `credentialsEnv`, overridable per account in
  `provider_accounts.credentials_env`), `NEXUS_YOUTUBE_REFRESH_TOKEN` — live in
  environment variables. The system stores _names_ only; nothing is persisted,
  and `.env.example` documents the names with empty values.
- **No token is ever logged.** Every message that could carry one passes
  through the adapter's `neverLog`: the runtime's pattern redactions plus the
  exact access/refresh-token values the instance has seen. Token-endpoint
  errors surface only their named `error`/`error_description` fields, guarded.
  A test pins this: a provider that echoes the access token back in an error
  body produces a warning line with `[REDACTED]`, not the token.
- The provider call log (durable metering) records operation, usage and hashes
  — never request bodies.

## 4. How a publish is requested

`POST /episodes/:id/publish` (episode page form): the operator's choices —
title, description, privacy, optional UTC schedule, tags — are stored as a
content-addressed **publish request** artifact, and the request's hash rides
the publish job's idempotency key (`publish:<episodeId>:<requestHash>`). The
task reads the request back from durable state, so nothing user-supplied
crosses into the job by reference to a request body. Same request twice ⇒ same
key ⇒ the same job; an already-published episode ⇒ a notice, no job.

## 5. What this phase deliberately does not do

- **The OAuth consent flow** (authorization code exchange, channel selection,
  the YouTube API audit itself) is out of scope: the adapter expects a standing
  refresh token granted out of band, and documents the three env names.
- **Chunked resumable upload** (multiple PUTs with byte ranges): the single
  session PUT covers the episode sizes this system renders; chunking can slot
  into `insertVideo` without touching the abstraction.
- **Publishing in the dashboard's default run**: `DASHBOARD_PIPELINE` still
  ends at approval — publishing is always an explicit second job (see
  `docs/plans/ISSUES.md` for the deferred shorts-publish wiring).
