import {
  kindForStatus,
  parseRetryAfterMs,
  ProviderAuthError,
  ProviderContentError,
  ProviderError,
  ProviderInvalidRequestError,
  ProviderQuotaError,
} from "../errors.js";
import { mergeHeaders, readResponse } from "../http.js";
import type {
  PublishMetadata,
  PublishProvider,
  PublishRef,
  PublishStatusReport,
  PublisherQuota,
} from "../publishing.js";
import type { InvokeRuntime } from "../runtime.js";
import type { CallContext, ProviderResult } from "../types.js";
import { truncate } from "../util.js";

/**
 * The one *real* publishing adapter: the YouTube Data API v3, over OAuth 2.0.
 *
 * Scope (Phase 15): an operator's **refresh token** — the standing grant the
 * channel owner made once, out of band — is exchanged for short-lived access
 * tokens; the video is uploaded with the resumable protocol; the thumbnail is
 * set; the status probe reports where the video stands after YouTube's
 * processing. Getting the refresh token (the consent screen, the channel
 * selection, the audit) is deliberately out of scope: the adapter documents
 * the three env-var names and refuses to run without them.
 *
 * Credential discipline (AD-12, and the phase's hard rule):
 * - the three secrets live in environment variables — `NEXUS_YOUTUBE_CLIENT_ID`,
 *   `NEXUS_YOUTUBE_CLIENT_SECRET` (the runtime's own `credentialsEnv`),
 *   `NEXUS_YOUTUBE_REFRESH_TOKEN` — read at call time, never persisted;
 * - **no token is ever logged**: every message that could carry one goes
 *   through `neverLog`, which scrubs the runtime's pattern redactions *plus*
 *   the exact access/refresh token values this instance has seen;
 * - the provider call log records input hashes and usage only (the invoke
 *   pipeline's own discipline) — bodies are not persisted.
 *
 * Retry handling: transport/5xx/429 failures are retryable (the invoke
 * pipeline backs off and retries inside the call); validation failures
 * (bad title length, `publishAt` on a non-private video, missing bytes) are
 * permanent; an expired access token is refreshed **once** mid-call and the
 * request retried. YouTube has no client idempotency key, so an upload that
 * *succeeded* but whose acknowledgement was lost must not be retried blindly —
 * that guard lives one level up (a completed publish stage is reused, and the
 * publish task refuses to re-upload an episode that already has a record).
 */
export interface YouTubePublishOptions {
  readonly id?: string;
  /** Token endpoint (OAuth 2.0 refresh-token grant). */
  readonly tokenUrl?: string;
  /** Resumable-upload / thumbnails / videos API origin. */
  readonly apiUrl?: string;
}

/** YouTube's own published limits — enforced *before* any bytes move. */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_TOTAL_TAGS = 500;

export class YouTubePublishProvider implements PublishProvider {
  readonly id: string;
  readonly kind = "publishing" as const;
  readonly mode = "live" as const;
  readonly label = "YouTube Data API v3 (OAuth)";

  private readonly tokenUrl: string;
  private readonly apiUrl: string;
  /** The short-lived access token, and the exact strings that must never leak. */
  private accessToken: string | undefined;
  private accessTokenExpiresAtMs = 0;
  private readonly secrets: string[] = [];

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: YouTubePublishOptions = {},
  ) {
    this.id = options.id ?? "youtube";
    this.tokenUrl = options.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.apiUrl = options.apiUrl ?? "https://www.googleapis.com";
  }

  async upload(
    videoHash: string,
    metadata: PublishMetadata,
    ctx?: CallContext,
  ): Promise<ProviderResult<PublishRef>> {
    return this.runtime.invoke<PublishRef>({
      operation: "publish.upload",
      ...(ctx !== undefined ? { context: ctx } : {}),
      // Uploading is a side effect: no cache entry (same rule as the fake).
      usage: () => ({ units: 1600, unit: "uploads" }),
      execute: async () => {
        this.validateMetadata(metadata);
        const video = this.requireBytes(videoHash, `video ${videoHash}`);
        // Fail before the upload when the thumbnail's bytes are gone — a
        // video published without its thumbnail is worse than one not
        // published while the operator fixes the store.
        const thumbnail =
          metadata.thumbnailHash !== undefined
            ? this.requireBytes(metadata.thumbnailHash, `thumbnail ${metadata.thumbnailHash}`)
            : undefined;

        const videoId = await this.insertVideo(video, metadata);
        if (thumbnail !== undefined) {
          // The video is already public-or-private on YouTube: a failed
          // thumbnail must not fail the upload (a retry would duplicate it).
          // The status probe / Studio shows the missing art.
          await this.setThumbnail(videoId, thumbnail).catch((error: unknown) => {
            this.runtime.logger({
              level: "warn",
              event: "publish.thumbnail_failed",
              message: `thumbnail was not set: ${this.neverLog(
                error instanceof Error ? error.message : String(error),
              )}`,
            });
          });
        }

        const publishAt = metadata.scheduledAt;
        return {
          id: videoId,
          provider: this.id,
          mode: "api" as const,
          status: (publishAt !== undefined ? "scheduled" : "uploaded") as PublishRef["status"],
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      },
    });
  }

  async status(ref: PublishRef, ctx?: CallContext): Promise<ProviderResult<PublishStatusReport>> {
    return this.runtime.invoke<PublishStatusReport>({
      operation: "publish.status",
      ...(ctx !== undefined ? { context: ctx } : {}),
      // A probe is read-only but time-sensitive: no cache entry, ever.
      usage: () => ({ units: 1, unit: "requests" }),
      execute: async () => {
        const token = await this.accessTokenOrRefresh();
        const response = await this.runtime.transport(
          `${this.apiUrl}/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(ref.id)}`,
          {
            method: "GET",
            headers: this.authorized({}, token),
          },
        );
        const body = await readResponse(response);
        if (!body.ok) {
          await this.throwForStatus("publish.status", body, () => this.accessTokenOrRefresh());
        }
        const parsed = body.json() as {
          items?: readonly {
            status?: {
              uploadStatus?: string;
              privacyStatus?: string;
              publishAt?: string;
              rejectionReason?: string;
            };
            processingDetails?: { processingStatus?: string };
          }[];
        };
        const item = parsed.items?.[0];
        if (item === undefined) {
          throw new ProviderContentError(`video ${ref.id} is not visible to this account`, {
            provider: this.id,
            operation: "publish.status",
          });
        }
        const uploadStatus = item.status?.uploadStatus;
        return {
          provider: this.id,
          id: ref.id,
          uploadStatus:
            uploadStatus === "processed"
              ? ("processed" as const)
              : uploadStatus === "processing"
                ? ("processing" as const)
                : uploadStatus === "rejected" || uploadStatus === "deleted"
                  ? ("failed" as const)
                  : ("unknown" as const),
          ...(item.processingDetails?.processingStatus !== undefined
            ? {
                processingStatus: item.processingDetails
                  .processingStatus as PublishStatusReport["processingStatus"],
              }
            : {}),
          ...(item.status?.privacyStatus === "private" ||
          item.status?.privacyStatus === "unlisted" ||
          item.status?.privacyStatus === "public"
            ? { privacyStatus: item.status.privacyStatus }
            : {}),
          ...(item.status?.publishAt !== undefined ? { publishAt: item.status.publishAt } : {}),
          ...(item.status?.rejectionReason !== undefined
            ? { rejectionReason: item.status.rejectionReason }
            : {}),
          checkedAt: this.runtime.clock.nowIso(),
        };
      },
    });
  }

  async quota(ctx?: CallContext): Promise<ProviderResult<PublisherQuota>> {
    return this.runtime.invoke<PublisherQuota>({
      operation: "publish.quota",
      ...(ctx !== undefined ? { context: ctx } : {}),
      usage: () => ({ units: 0, unit: "requests" }),
      execute: async () => ({
        provider: this.id,
        window: "daily" as const,
        // The upload allowance is visible in YouTube Studio, not via the API.
        limit: null,
        used: null,
        remaining: null,
        note: "YouTube does not expose the upload quota via the API; check Studio",
      }),
    });
  }

  // ── OAuth 2.0 ────────────────────────────────────────────────────────────

  /**
   * A valid access token, refreshing the stored refresh token when needed.
   * The refresh happens at most once per expiry window; a 401 mid-call asks
   * for exactly one more (an admin may have revoked the grant).
   */
  private async accessTokenOrRefresh(): Promise<string> {
    const now = this.runtime.clock.now().getTime();
    if (this.accessToken !== undefined && now < this.accessTokenExpiresAtMs) {
      return this.accessToken;
    }
    const clientId = this.requireEnv("NEXUS_YOUTUBE_CLIENT_ID");
    const clientSecret = this.runtime.requireCredential();
    const refreshToken = this.requireEnv("NEXUS_YOUTUBE_REFRESH_TOKEN");
    this.remember(refreshToken);

    const response = await this.runtime.transport(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const body = await readResponse(response);
    if (!body.ok) {
      // The body never reaches a message verbatim — only its named error
      // fields, guarded — and an invalid grant is a *permanent* auth failure
      // (the operator must re-consent; retrying cannot help).
      const parsed = safeJson(body.body) as { error?: string; error_description?: string };
      const detail = this.neverLog(
        `${parsed?.error ?? ""}${parsed?.error_description !== undefined ? `: ${parsed.error_description}` : ""}`.trim(),
      );
      throw new ProviderAuthError(
        `YouTube token refresh failed with HTTP ${body.status}${detail === "" ? "" : ` (${detail})`}`,
        { provider: this.id, operation: "oauth.refresh", status: body.status },
      );
    }
    const parsed = body.json() as { access_token?: string; expires_in?: number };
    if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
      throw new ProviderContentError("token endpoint returned no access_token", {
        provider: this.id,
        operation: "oauth.refresh",
      });
    }
    this.remember(parsed.access_token);
    this.accessToken = parsed.access_token;
    // Refresh a minute early, so an in-flight call never rides an expiry.
    this.accessTokenExpiresAtMs =
      this.runtime.clock.now().getTime() + Math.max(60, (parsed.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  // ── The upload protocol ──────────────────────────────────────────────────

  /** Resumable init → Location → the bytes → the video resource. */
  private async insertVideo(bytes: Uint8Array, metadata: PublishMetadata): Promise<string> {
    const metadataBody = {
      snippet: {
        title: metadata.title,
        description: metadata.description,
        ...(metadata.tags !== undefined && metadata.tags.length > 0
          ? { tags: [...metadata.tags] }
          : {}),
        ...(metadata.categoryId !== undefined ? { categoryId: metadata.categoryId } : {}),
        ...(metadata.language !== undefined ? { defaultLanguage: metadata.language } : {}),
      },
      status: {
        privacyStatus: metadata.privacyStatus,
        ...(metadata.scheduledAt !== undefined ? { publishAt: metadata.scheduledAt } : {}),
        ...(metadata.madeForKids !== undefined
          ? { selfDeclaredMadeForKids: metadata.madeForKids }
          : {}),
      },
    };

    const token = await this.accessTokenOrRefresh();
    const init = await this.runtime.transport(
      `${this.apiUrl}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: this.authorized(
          {
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-length": String(bytes.byteLength),
            "x-upload-content-type": "video/mp4",
          },
          token,
        ),
        body: JSON.stringify(metadataBody),
      },
    );
    const initBody = await readResponse(init);
    if (!initBody.ok) {
      await this.throwForStatus("publish.upload", initBody, () => this.accessTokenOrRefresh());
    }
    const location = initBody.headers.get("location");
    if (location === null || location === "") {
      throw new ProviderContentError(
        "resumable init returned no session Location — YouTube's API contract changed?",
        { provider: this.id, operation: "publish.upload" },
      );
    }

    const uploaded = await this.runtime.transport(location, {
      method: "PUT",
      headers: this.authorized({ "content-type": "video/mp4" }, token),
      body: bytes,
    });
    const uploadedBody = await readResponse(uploaded);
    if (!uploadedBody.ok) {
      await this.throwForStatus("publish.upload", uploadedBody, () => this.accessTokenOrRefresh());
    }
    const parsed = uploadedBody.json() as { id?: string };
    if (typeof parsed.id !== "string" || parsed.id === "") {
      throw new ProviderContentError("upload succeeded but the response named no video id", {
        provider: this.id,
        operation: "publish.upload",
      });
    }
    return parsed.id;
  }

  private async setThumbnail(videoId: string, bytes: Uint8Array): Promise<void> {
    const token = await this.accessTokenOrRefresh();
    const response = await this.runtime.transport(
      `${this.apiUrl}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
      {
        method: "POST",
        headers: this.authorized({ "content-type": thumbnailMime(bytes) }, token),
        body: bytes,
      },
    );
    const body = await readResponse(response);
    if (!body.ok) {
      await this.throwForStatus("publish.thumbnail", body, () => this.accessTokenOrRefresh());
    }
  }

  // ── Validation, bytes, secrets ───────────────────────────────────────────

  /** Refuse before any bytes move when YouTube would reject the metadata. */
  private validateMetadata(metadata: PublishMetadata): void {
    const title = metadata.title.trim();
    if (title.length === 0 || title.length > MAX_TITLE) {
      throw new ProviderInvalidRequestError(
        `title must be 1–${MAX_TITLE} characters (got ${title.length})`,
        { provider: this.id, operation: "publish.upload" },
      );
    }
    if (metadata.description.length > MAX_DESCRIPTION) {
      throw new ProviderInvalidRequestError(
        `description must be at most ${MAX_DESCRIPTION} characters (got ${metadata.description.length})`,
        { provider: this.id, operation: "publish.upload" },
      );
    }
    if (metadata.tags !== undefined && metadata.tags.join(",").length > MAX_TOTAL_TAGS) {
      throw new ProviderInvalidRequestError(
        `tags must total at most ${MAX_TOTAL_TAGS} characters (got ${metadata.tags.join(",").length})`,
        { provider: this.id, operation: "publish.upload" },
      );
    }
    if (metadata.scheduledAt !== undefined) {
      const when = Date.parse(metadata.scheduledAt);
      if (Number.isNaN(when)) {
        throw new ProviderInvalidRequestError(
          `scheduledAt must be an ISO timestamp (got "${truncate(metadata.scheduledAt, 40)}")`,
          { provider: this.id, operation: "publish.upload" },
        );
      }
      // YouTube's rule: a video can only *become* public later if it is
      // private now.
      if (metadata.privacyStatus !== "private") {
        throw new ProviderInvalidRequestError(
          'scheduling requires privacyStatus "private" — YouTube publishes by flipping a private video',
          { provider: this.id, operation: "publish.upload" },
        );
      }
    }
  }

  private requireBytes(hash: string, what: string): Uint8Array {
    try {
      const bytes = this.runtime.storage.read(hash);
      if (bytes.byteLength > 0) return bytes;
    } catch {
      // fall through to the error below
    }
    throw new ProviderInvalidRequestError(
      `${what} has no bytes in the artifact store — refusing to publish an empty file`,
      { provider: this.id, operation: "publish.upload" },
    );
  }

  private requireEnv(name: string): string {
    const value = this.runtime.env[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ProviderAuthError(
        `Missing credential for '${this.id}': set the ${name} environment variable ` +
          "(the value is never stored in the database or repo)",
        { provider: this.id, operation: "auth" },
      );
    }
    return value;
  }

  private authorized(headers: Record<string, string>, token: string): Record<string, string> {
    return mergeHeaders(headers, { authorization: `Bearer ${token}` });
  }

  /**
   * Map an API failure to the taxonomy. A 401 gets exactly one re-auth and
   * retry (the passed `reauthorize` renews the token); 403 quota walls fail
   * closed; everything else follows the status.
   */
  private async throwForStatus(
    operation: string,
    body: { status: number; body: string; headers: { get(name: string): string | null } },
    reauthorize: () => Promise<string>,
  ): Promise<never> {
    const detail = this.neverLog(truncate(body.body.replace(/\s+/gu, " "), 300));
    const retryAfterMs = parseRetryAfterMs(body.headers.get("retry-after"));
    if (body.status === 401) {
      // The access token may have been revoked mid-flight: refresh once and
      // let the caller's invoke-pipeline retry ride the new token.
      this.accessToken = undefined;
      this.accessTokenExpiresAtMs = 0;
      await reauthorize();
      throw new ProviderError(
        `YouTube returned HTTP 401 (${detail}); the access token was refreshed — the retry should re-authenticate`,
        {
          kind: "auth",
          provider: this.id,
          operation,
          status: body.status,
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    if (body.status === 403 && /quotaExceeded|uploadLimitExceeded/iu.test(body.body)) {
      throw new ProviderQuotaError(
        `YouTube refused the upload on quota (${detail}) — the daily upload allowance is spent`,
        { provider: this.id, operation, status: body.status },
      );
    }
    throw new ProviderError(`YouTube request failed with HTTP ${body.status}: ${detail}`, {
      kind: kindForStatus(body.status),
      provider: this.id,
      operation,
      status: body.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  /** Track a secret so `neverLog` can scrub its exact value. */
  private remember(value: string): void {
    if (value.length >= 8 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  /** The only door any message takes toward a log, a row, or an operator. */
  private neverLog(text: string): string {
    let output = this.runtime.redact(text);
    for (const secret of this.secrets) output = output.split(secret).join("[REDACTED]");
    if (this.accessToken !== undefined) {
      output = output.split(this.accessToken).join("[REDACTED]");
    }
    return output;
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function thumbnailMime(bytes: Uint8Array): string {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/jpeg";
}
