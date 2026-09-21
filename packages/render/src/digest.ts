import { sha256 } from "@nexus/storage";

import type { Frame } from "./types.js";

/**
 * Digests.
 *
 * A composed frame is a document, and a document has a hash. Canonical JSON (keys
 * sorted, numbers already rounded by the engine) means the same manifest and the
 * same library always produce the same digest — on this machine, on CI, next
 * year. That is how composition gets *verified* rather than eyeballed: a change in
 * blocking, a camera curve, an easing or a character layer shows up as a new hash.
 */

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/** JSON with object keys in a stable order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** `sha256` over the canonical form of anything. */
export function digestOf(value: unknown): string {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
}

/** The digest of a set of composed frames. */
export function frameDigest(frames: readonly Frame[]): string {
  return digestOf(frames);
}
