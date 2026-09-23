import { describe, expect, it } from "vitest";

import { MemoryBlobStore } from "../fake/storage.js";
import { FixedClock } from "../clock.js";
import { DEFAULT_PROVIDER_POLICY, RecordingProviderLogger } from "../types.js";
import { type FetchLike, type FetchRequestInit } from "../http.js";
import { BudgetGuard } from "../quota.js";
import { createRuntime, type InvokeRuntime } from "../runtime.js";
import { invoke } from "../invoke.js";
import { ProviderAuthError, ProviderInvalidRequestError, ProviderQuotaError } from "../errors.js";
import { YouTubePublishProvider } from "./youtube.js";

/**
 * The real YouTube adapter, against a scripted transport — the suite never
 * opens a socket and never publishes a real video. What the tests hold it to:
 * the resumable protocol is spoken correctly; the OAuth grant happens once and
 * refreshes when it must; YouTube's own limits are enforced *before* any bytes
 * move; failures land in the right retry class; and no token ever reaches a
 * log line, a call record, or an error message.
 */

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret-not-a-real-credential";
const REFRESH_TOKEN = "test-refresh-token-not-a-real-credential";

/** A fast, retry-friendly policy: the invoke pipeline's own shape. */
const policy = {
  ...DEFAULT_PROVIDER_POLICY,
  maxAttempts: 2,
  baseDelayMs: 1,
  factor: 1,
  maxDelayMs: 2,
};

function runtimeFor(options: {
  transport: FetchLike;
  clock?: FixedClock;
  logger?: RecordingProviderLogger;
  env?: Record<string, string | undefined>;
}): InvokeRuntime {
  const clock = options.clock ?? new FixedClock("2024-05-01T00:00:00.000Z");
  return createRuntime({
    adapterId: "youtube",
    kind: "publishing",
    storage: new MemoryBlobStore(),
    clock,
    logger: options.logger?.log ?? (() => {}),
    env: {
      NEXUS_YOUTUBE_CLIENT_ID: CLIENT_ID,
      NEXUS_YOUTUBE_CLIENT_SECRET: CLIENT_SECRET,
      NEXUS_YOUTUBE_REFRESH_TOKEN: REFRESH_TOKEN,
      ...options.env,
    },
    policy,
    transport: options.transport,
    budget: new BudgetGuard({ clock }),
    limiter: { tryAcquire: () => true, msUntilAvailable: () => 0 },
    credentialsEnv: "NEXUS_YOUTUBE_CLIENT_SECRET",
    invoke: (spec) =>
      invoke(
        {
          adapterId: "youtube",
          kind: "publishing",
          policy,
          budget: new BudgetGuard({ clock }),
          logger: options.logger?.log ?? (() => {}),
          clock,
          // Backoff delays are recorded, not slept.
          sleep: async () => {},
        },
        spec,
      ),
  });
}

const ok = (body: unknown, headers: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function tokenResponse() {
  return ok({ access_token: "ya29.test-access-token", expires_in: 3600 });
}

/** The scripted happy path: token → resumable init → PUT → (optional thumbnail). */
function happyTransport(record: {
  requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
  videoId?: string;
  withThumbnail?: boolean;
}): FetchLike {
  return async (url, init: FetchRequestInit = {}) => {
    const entry = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    record.requests.push(entry);
    if (url.includes("oauth2.googleapis.com/token")) return tokenResponse();
    if (url.includes("uploadType=resumable")) {
      return ok({ id: "unused" }, { location: "https://upload.example.invalid/session/abc" });
    }
    if (url.startsWith("https://upload.example.invalid/session/")) {
      return ok({ id: record.videoId ?? "vid_1234567890" });
    }
    if (url.includes("thumbnails/set")) {
      return record.withThumbnail === false
        ? {
            ok: false,
            status: 500,
            headers: { get: () => null },
            text: async () => "backend error",
            json: async () => ({}),
          }
        : ok({ items: [] });
    }
    if (url.includes("/youtube/v3/videos?")) {
      return ok({
        items: [
          {
            status: {
              uploadStatus: "processed",
              privacyStatus: "private",
              publishAt: "2024-05-02T00:00:00Z",
            },
            processingDetails: { processingStatus: "succeeded" },
          },
        ],
      });
    }
    throw new Error(`unexpected transport call: ${init.method ?? "GET"} ${url}`);
  };
}

const metadata = {
  title: "Why the Kira bridge hums at dusk",
  description: "The story of a resonance.",
  tags: ["bridges", "acoustics"],
  privacyStatus: "private" as const,
};

/**
 * The fixture's video bytes and their CAS hash — every runtime in this suite
 * that must find the video gets a store holding exactly these bytes.
 */
function providerStore(): MemoryBlobStore {
  const store = new MemoryBlobStore();
  store.put(new TextEncoder().encode("pretend mp4 bytes"));
  return store;
}

const VIDEO_HASH = new MemoryBlobStore().put(new TextEncoder().encode("pretend mp4 bytes")).hash;

async function providerWith(
  record: {
    requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
  },
  overrides: { env?: Record<string, string | undefined>; clock?: FixedClock } = {},
): Promise<YouTubePublishProvider> {
  const runtime = runtimeFor({
    transport: happyTransport(record),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    env: overrides.env,
  });
  // The adapter reads through the runtime's store, so the bytes are shared.
  return new YouTubePublishProvider({ ...runtime, storage: providerStore() });
}

describe("the YouTube publishing adapter", () => {
  it("uploads with the resumable protocol and maps the metadata", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record);
    const result = await provider.upload(VIDEO_HASH, metadata);

    expect(result.value).toEqual({
      id: "vid_1234567890",
      provider: "youtube",
      mode: "api",
      status: "uploaded",
      url: "https://www.youtube.com/watch?v=vid_1234567890",
    });

    // The init request carries the metadata and the byte length up front.
    const init = record.requests.find((entry) => entry.url.includes("uploadType=resumable"))!;
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer ya29.test-access-token");
    expect(init.headers["x-upload-content-length"]).toBe(String("pretend mp4 bytes".length));
    const body = JSON.parse(init.body as string) as {
      snippet: { title: string; description: string; tags: string[] };
      status: { privacyStatus: string };
    };
    expect(body.snippet.title).toBe(metadata.title);
    expect(body.snippet.description).toBe(metadata.description);
    expect(body.snippet.tags).toEqual(metadata.tags);
    expect(body.status.privacyStatus).toBe("private");

    // The session PUT carries the bytes.
    const put = record.requests.find((entry) =>
      entry.url.startsWith("https://upload.example.invalid/session/"),
    )!;
    expect(put.method).toBe("PUT");
    expect(put.headers["content-type"]).toBe("video/mp4");
  });

  it("exchanges the refresh token once and reuses the access token", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record);
    await provider.upload(VIDEO_HASH, metadata);
    await provider.upload(VIDEO_HASH, metadata);

    const tokenCalls = record.requests.filter((entry) => entry.url.includes("/token"));
    expect(tokenCalls).toHaveLength(1);
    // The grant names the client and asks for the refresh grant — and the
    // call record carries only what the transport saw (the adapter never
    // logs bodies itself).
    const sentBody = tokenCalls[0]!.body as string;
    expect(sentBody).toContain("grant_type=refresh_token");
    expect(sentBody).toContain(encodeURIComponent(CLIENT_ID));
  });

  it("never logs a token — not in messages, not in warnings", async () => {
    const logger = new RecordingProviderLogger();
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const storage = providerStore();
    const thumbnail = storage.put(new TextEncoder().encode("pretend png bytes")).hash;
    // A failing thumbnail after a successful upload must log a warning — and
    // that warning must not carry the access token the thumbnail request used.
    const scripted: FetchLike = async (url, init: FetchRequestInit = {}) => {
      if (url.includes("thumbnails/set")) {
        return {
          ok: false,
          status: 500,
          headers: { get: () => null },
          // The body echoes the token back — a provider that leaks.
          text: async () => `backend error for ya29.test-access-token`,
          json: async () => ({}),
        };
      }
      return happyTransport(record)(url, init);
    };
    const runtime = runtimeFor({ transport: happyTransport(record), logger });
    const provider = new YouTubePublishProvider({ ...runtime, storage, transport: scripted });
    await provider.upload(VIDEO_HASH, { ...metadata, thumbnailHash: thumbnail });

    const entries = logger.entries.map((entry) => JSON.stringify(entry)).join("\n");
    expect(entries).toContain("publish.thumbnail_failed");
    expect(entries).not.toContain("ya29.test-access-token");
    expect(entries).not.toContain(REFRESH_TOKEN);
    expect(entries).not.toContain(CLIENT_SECRET);
  });

  it("rejects a schedule on a non-private video before any HTTP happens", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record);
    await expect(
      provider.upload(VIDEO_HASH, {
        ...metadata,
        privacyStatus: "public",
        scheduledAt: "2024-05-02T00:00:00Z",
      }),
    ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
    expect(record.requests).toHaveLength(0);
  });

  it("enforces YouTube's title limit before any HTTP happens", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record);
    await expect(
      provider.upload(VIDEO_HASH, { ...metadata, title: "x".repeat(101) }),
    ).rejects.toBeInstanceOf(ProviderInvalidRequestError);
    expect(record.requests).toHaveLength(0);
  });

  it("refuses to upload bytes the artifact store does not have", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record);
    await expect(provider.upload("d".repeat(64), metadata)).rejects.toThrow(
      /has no bytes in the artifact store/u,
    );
    expect(record.requests).toHaveLength(0);
  });

  it("names the missing environment variable without ever logging a value", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record, {
      env: { NEXUS_YOUTUBE_CLIENT_ID: undefined },
    });
    const error = await provider.upload(VIDEO_HASH, metadata).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderAuthError);
    expect((error as Error).message).toContain("NEXUS_YOUTUBE_CLIENT_ID");
    expect((error as Error).message).not.toContain(CLIENT_SECRET);
    expect(record.requests).toHaveLength(0);
  });

  it("refreshes once on a 401 and marks the retry rideable", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    let first = true;
    const scripted: FetchLike = async (url, init: FetchRequestInit = {}) => {
      if (url.includes("uploadType=resumable") && first) {
        first = false;
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          text: async () => "expired",
          json: async () => ({}),
        };
      }
      return happyTransport(record)(url, init);
    };
    const runtime = runtimeFor({ transport: scripted });
    const provider = new YouTubePublishProvider({
      ...runtime,
      storage: providerStore(),
    });
    const error = await provider.upload(VIDEO_HASH, metadata).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // The invoke pipeline retries the (retryable) 401; the second run passes.
    expect(error).toBeUndefined();
    // The token endpoint was hit twice: the initial grant + the 401 refresh.
    expect(record.requests.filter((entry) => entry.url.includes("/token"))).toHaveLength(2);
  });

  it("fails closed on a quota wall and retries on a 5xx", async () => {
    const quotaRuntime = runtimeFor({
      transport: async (url) =>
        url.includes("uploadType=resumable")
          ? {
              ok: false,
              status: 403,
              headers: { get: () => null },
              text: async () => '{"error":{"errors":[{"reason":"quotaExceeded"}]}}',
              json: async () => ({}),
            }
          : tokenResponse(),
    });
    const quotaProvider = new YouTubePublishProvider({
      ...quotaRuntime,
      storage: providerStore(),
    });
    await expect(quotaProvider.upload(VIDEO_HASH, metadata)).rejects.toBeInstanceOf(
      ProviderQuotaError,
    );

    const unavailable = new YouTubePublishProvider({
      ...runtimeFor({
        transport: async (url) =>
          url.includes("uploadType=resumable")
            ? {
                ok: false,
                status: 503,
                headers: { get: () => "2" },
                text: async () => "backend error",
                json: async () => ({}),
              }
            : tokenResponse(),
      }),
      storage: providerStore(),
    });
    const error = await unavailable.upload(VIDEO_HASH, metadata).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // Retryable: the invoke pipeline exhausted its (2) attempts and rethrown.
    expect((error as Error).message).toContain("503");
  });

  it("reports upload status in the abstraction's own words", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const provider = await providerWith(record);
    const uploaded = await provider.upload(VIDEO_HASH, metadata);
    const status = await provider.status(uploaded.value);

    expect(status.value).toEqual({
      provider: "youtube",
      id: "vid_1234567890",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      publishAt: "2024-05-02T00:00:00Z",
      checkedAt: "2024-05-01T00:00:00.000Z",
    });
    const probe = record.requests.find((entry) =>
      entry.url.includes("part=status,processingDetails"),
    )!;
    expect(probe.url).toContain("part=status,processingDetails");
    expect(probe.url).toContain("id=vid_1234567890");
  });

  it("reports a rejected video as failed, with the reason", async () => {
    const provider = new YouTubePublishProvider(
      runtimeFor({
        transport: async (url) =>
          url.includes("/youtube/v3/videos?")
            ? ok({
                items: [
                  {
                    status: { uploadStatus: "rejected", rejectionReason: "termsOfUse" },
                    processingDetails: { processingStatus: "terminated" },
                  },
                ],
              })
            : tokenResponse(),
      }),
    );
    const status = await provider.status({
      id: "vid_x",
      provider: "youtube",
      mode: "api",
      status: "uploaded",
    });
    expect(status.value.uploadStatus).toBe("failed");
    expect(status.value.rejectionReason).toBe("termsOfUse");
  });

  it("keeps the video published when only the thumbnail fails", async () => {
    const record: {
      requests: { url: string; method: string; headers: Record<string, string>; body?: unknown }[];
    } = {
      requests: [],
    };
    const storage = providerStore();
    const thumbnail = storage.put(new TextEncoder().encode("pretend png")).hash;
    const scripted: FetchLike = async (url, init: FetchRequestInit = {}) => {
      if (url.includes("thumbnails/set")) {
        return {
          ok: false,
          status: 500,
          headers: { get: () => null },
          text: async () => "backend error",
          json: async () => ({}),
        };
      }
      return happyTransport(record)(url, init);
    };
    const provider = new YouTubePublishProvider({
      ...runtimeFor({ transport: scripted }),
      storage,
    });
    const result = await provider.upload(VIDEO_HASH, { ...metadata, thumbnailHash: thumbnail });
    expect(result.value.id).toBe("vid_1234567890");
  });
});
