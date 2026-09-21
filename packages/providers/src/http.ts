/**
 * The HTTP seam.
 *
 * Adapters never call `fetch` directly: they receive a `FetchLike`. Tests pass
 * a stub (so the suite runs offline, with no keys and no flakiness) and the
 * app passes the platform fetch. This is also why no vendor SDK is needed —
 * the OpenAI-compatible contract covers the free LLM tiers (OD-3) and adding a
 * provider means writing a function, not taking on a dependency.
 */
export interface FetchRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: FetchRequestInit) => Promise<FetchResponseLike>;

/** The platform fetch, adapted to `FetchLike` (structurally compatible). */
export const platformFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<FetchResponseLike>;

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: string;
  json(): unknown;
}

/** Read a response once into a body string, with the metadata callers need. */
export async function readResponse(response: FetchResponseLike): Promise<HttpResponse> {
  const body = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
    json: () => JSON.parse(body) as unknown,
  };
}

/** Merge headers, dropping undefined values so `headers` stays clean. */
export function mergeHeaders(
  ...sets: readonly (Readonly<Record<string, string | undefined>> | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [key, value] of Object.entries(set)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}
