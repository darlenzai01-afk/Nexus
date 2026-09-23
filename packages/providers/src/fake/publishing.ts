import type {
  PublishMetadata,
  PublishProvider,
  PublishRef,
  PublishStatusReport,
  PublisherQuota,
} from "../publishing.js";
import type { InvokeRuntime } from "../runtime.js";
import type { CallContext, ProviderResult } from "../types.js";
import { hashInputs } from "../util.js";

/**
 * Deterministic offline publisher.
 *
 * It simulates the *API* path (what the real adapter will do after the YouTube
 * audit) including the daily upload quota, so the publishing phase can be built,
 * tested and dry-run today: uploads get stable fake ids, and the quota counter
 * behaves like the real one — including refusing the seventh upload of a day.
 *
 * Uploading is a side effect, so this adapter declares **no** cache entry: a
 * re-run that reaches this call really does upload (and really does consume
 * quota). Re-running a *stage* is prevented a level up, by the orchestrator's
 * completed-stage lookup — the cache is for read-only calls whose result is
 * reproducible, not for actions that already happened.
 */
export interface FakePublisherOptions {
  readonly id?: string;
  /** Uploads allowed per UTC day (YouTube's default is 6). */
  readonly dailyLimit?: number;
}

export class FakePublishProvider implements PublishProvider {
  readonly id: string;
  readonly kind = "publishing" as const;
  readonly mode = "fake" as const;
  readonly label = "Fake publisher (deterministic, no upload)";

  /** What this fake has "uploaded" this process, by video id. */
  private readonly uploaded = new Map<
    string,
    { privacyStatus: PublishMetadata["privacyStatus"]; publishAt?: string }
  >();

  constructor(
    private readonly runtime: InvokeRuntime,
    private readonly options: FakePublisherOptions = {},
  ) {
    this.id = options.id ?? "fake";
  }

  async upload(
    videoHash: string,
    metadata: PublishMetadata,
    ctx?: CallContext,
  ): Promise<ProviderResult<PublishRef>> {
    const dailyLimit = this.options.dailyLimit ?? 6;
    return this.runtime.invoke<PublishRef>({
      operation: "publish.upload",
      ...(ctx !== undefined ? { context: ctx } : {}),
      usage: () => ({ units: 1, unit: "uploads" }),
      execute: async () => {
        const usedToday = this.uploadsToday();
        if (usedToday >= dailyLimit) {
          throw new Error(
            `fake publisher: daily upload quota exhausted (${usedToday}/${dailyLimit})`,
          );
        }
        const shortId = hashInputs({ videoHash, title: metadata.title }).slice(0, 12);
        const id = `fake-${shortId}`;
        this.uploaded.set(id, {
          privacyStatus: metadata.privacyStatus,
          ...(metadata.scheduledAt !== undefined ? { publishAt: metadata.scheduledAt } : {}),
        });
        return {
          id,
          provider: this.id,
          mode: "api",
          status: metadata.scheduledAt !== undefined ? "scheduled" : "uploaded",
          url: `https://example.invalid/watch/${shortId}`,
        };
      },
    });
  }

  /**
   * The fake remembers what it uploaded (in memory — this adapter simulates a
   * provider, it is not a record of truth) and reports the same lifecycle the
   * real probe will: uploaded → processed; a scheduled video stays private
   * until its publishAt.
   */
  async status(ref: PublishRef, ctx?: CallContext): Promise<ProviderResult<PublishStatusReport>> {
    return this.runtime.invoke<PublishStatusReport>({
      operation: "publish.status",
      ...(ctx !== undefined ? { context: ctx } : {}),
      usage: () => ({ units: 0, unit: "requests" }),
      execute: async () => {
        const uploaded = this.uploaded.get(ref.id);
        const nowIso = this.runtime.clock.nowIso();
        if (uploaded === undefined) {
          return {
            provider: this.id,
            id: ref.id,
            uploadStatus: "unknown" as const,
            checkedAt: nowIso,
          };
        }
        const scheduled =
          uploaded.publishAt !== undefined && Date.parse(uploaded.publishAt) > Date.parse(nowIso);
        return {
          provider: this.id,
          id: ref.id,
          uploadStatus: "processed" as const,
          processingStatus: "succeeded" as const,
          privacyStatus: scheduled ? ("private" as const) : uploaded.privacyStatus,
          ...(uploaded.publishAt !== undefined ? { publishAt: uploaded.publishAt } : {}),
          checkedAt: nowIso,
        };
      },
    });
  }

  async quota(ctx?: CallContext): Promise<ProviderResult<PublisherQuota>> {
    const dailyLimit = this.options.dailyLimit ?? 6;
    return this.runtime.invoke<PublisherQuota>({
      operation: "publish.quota",
      ...(ctx !== undefined ? { context: ctx } : {}),
      usage: () => ({ units: 0, unit: "requests" }),
      execute: async () => {
        const used = this.uploadsToday();
        const resetsAt = nextUtcMidnight(this.runtime.clock.nowIso());
        return {
          provider: this.id,
          window: "daily",
          limit: dailyLimit,
          used,
          remaining: Math.max(0, dailyLimit - used),
          resetsAt,
          note: "simulated quota",
        };
      },
    });
  }

  /**
   * Uploads recorded today — read from the durable call log when available, so
   * the count survives a restart (a real provider's quota does too).
   *
   * Only successful `publish.upload` calls count: metadata reads, quota probes
   * and failed attempts do not consume a publisher's daily allowance.
   */
  private uploadsToday(): number {
    const repo = this.runtime.repo;
    if (!repo) return 0;
    const since = startOfUtcDay(this.runtime.clock.nowIso());
    return repo
      .listProviderCalls()
      .filter(
        (call) =>
          call.provider === this.id &&
          call.operation === "publish.upload" &&
          call.status === "ok" &&
          call.created_at >= since,
      ).length;
  }
}

function startOfUtcDay(iso: string): string {
  const date = new Date(iso);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString();
}

function nextUtcMidnight(iso: string): string {
  const date = new Date(iso);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  ).toISOString();
}
