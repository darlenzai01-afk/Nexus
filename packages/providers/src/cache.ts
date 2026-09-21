import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashInputs } from "./util.js";

/**
 * Provider cache (AD-13: "cache aggressively"). Every metered call has a
 * content-addressed key, so a re-run of the same stage costs nothing: the
 * provider is never contacted and no quota is consumed.
 *
 * Values are stored as JSON because provider results are structured by
 * definition. A cached result is only used when it decrypts *and* re-validates
 * against the caller's schema (see `invoke`), so a corrupt entry degrades to a
 * fresh call rather than a broken pipeline.
 */
export interface ProviderCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
}

/**
 * The cache key of a call: adapter + operation + everything that changes the
 * answer. Excludes ids, timestamps and anything else that is not an input —
 * `canonicalize` makes the hash order-insensitive.
 */
export function providerCacheKey(parts: {
  readonly provider: string;
  readonly operation: string;
  readonly inputs: unknown;
}): string {
  return hashInputs({
    v: 1,
    provider: parts.provider,
    operation: parts.operation,
    inputs: parts.inputs,
  });
}

export const encodeJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Disabled caching (`NEXUS_PROVIDER_CACHE=off`, or `--dry-run` in tests). */
export class NullProviderCache implements ProviderCache {
  async get(_key: string): Promise<Uint8Array | undefined> {
    return undefined;
  }

  async set(_key: string, _value: Uint8Array): Promise<void> {
    // intentionally nothing
  }
}

/** In-memory cache for tests and for `--dry-run` runs. */
export class MemoryProviderCache implements ProviderCache {
  private readonly entries = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const hit = this.entries.get(key);
    return hit === undefined ? undefined : new Uint8Array(hit);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.entries.set(key, new Uint8Array(value));
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Durable cache: `<root>/<key[0..2]>/<key>`, written through a temp file +
 * rename so a killed process can never leave a half-written entry behind.
 * Same discipline as the CAS (AD-09) — by design, not by coincidence.
 */
export class FileProviderCache implements ProviderCache {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  pathFor(key: string): string {
    return path.join(this.root, key.slice(0, 2), key);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;
    try {
      return readFileSync(file);
    } catch {
      // Unreadable entry: treat as a miss rather than failing the call.
      rmSync(file, { force: true });
      return undefined;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const file = this.pathFor(key);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, value);
    renameSync(tmp, file);
  }
}
