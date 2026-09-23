import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashInputs } from "@nexus/providers";
import { z } from "zod";

import { AudioFormatSchema, Sha256Schema, type AudioFormat } from "./schema.js";

/**
 * Segment-level audio reuse.
 *
 * There are three caches in this system, and they answer different questions:
 *
 * | Cache | Key | What it saves |
 * | ----- | --- | ------------- |
 * | provider cache (`@nexus/providers`, AD-13) | adapter + operation + request | the *call*: it sits inside `invoke`, so a repeated synthesis is answered from disk without touching the account |
 * | runner artifact reuse (`@nexus/jobs`) | the stage's content fingerprint | the whole *stage*: an unchanged episode adopts its previous track and never runs at all |
 * | **this one** | provider + text + voice + container | the *clip*: it survives an edited script, so an episode whose third scene changed re-voices that scene and reuses the rest |
 *
 * A hit is only trusted when the bytes it names are still in the CAS — an index is
 * a hint, never a source of truth — and the key includes the adapter id, so two
 * providers can never serve each other's audio.
 */

export interface AudioCacheKeyParts {
  readonly provider: string;
  readonly text: string;
  readonly voiceId: string;
  readonly format: AudioFormat;
  readonly sampleRate: number;
  readonly rate: number;
  readonly style?: string;
}

export function segmentCacheKey(parts: AudioCacheKeyParts): string {
  return hashInputs({
    v: 1,
    kind: "audio.segment",
    provider: parts.provider,
    text: parts.text,
    voiceId: parts.voiceId,
    format: parts.format,
    sampleRate: parts.sampleRate,
    rate: parts.rate,
    style: parts.style ?? null,
  });
}

export const CachedAudioSchema = z.strictObject({
  hash: Sha256Schema,
  bytes: z.number().int().positive(),
  mime: z.string().min(3).max(80),
  format: AudioFormatSchema,
  sampleRate: z.number().int().min(8_000).max(48_000),
  durationMs: z.number().int().positive(),
  voiceId: z.string().min(1).max(80),
  provider: z.string().min(1).max(60),
});
export type CachedAudio = z.infer<typeof CachedAudioSchema>;

export interface SegmentAudioCache {
  get(key: string): CachedAudio | undefined;
  set(key: string, entry: CachedAudio): void;
  /** Entries the cache can serve (used by the run summary). */
  readonly size: number;
}

/** In-run reuse: two identical segments in one episode cost one synthesis call. */
export class MemorySegmentCache implements SegmentAudioCache {
  private readonly entries = new Map<string, CachedAudio>();

  get(key: string): CachedAudio | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CachedAudio): void {
    this.entries.set(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** `NEXUS_AUDIO_SEGMENT_CACHE=off`: every run re-synthesizes. */
export class NullSegmentCache implements SegmentAudioCache {
  get(_key: string): CachedAudio | undefined {
    return undefined;
  }

  set(_key: string, _entry: CachedAudio): void {
    // Deliberately nothing: caching is off.
  }

  get size(): number {
    return 0;
  }
}

interface CacheFile {
  readonly version: 1;
  readonly entries: Record<string, unknown>;
}

/**
 * A JSON index on disk. It is written atomically (temp file + rename) and read
 * tolerantly: a missing, stale or corrupt index is an empty cache, never a failed
 * stage — the worst case is that audio is synthesized again.
 */
export class FileSegmentCache implements SegmentAudioCache {
  private entries: Map<string, CachedAudio> | undefined;

  constructor(private readonly filePath: string) {}

  get size(): number {
    return this.load().size;
  }

  get(key: string): CachedAudio | undefined {
    return this.load().get(key);
  }

  set(key: string, entry: CachedAudio): void {
    this.load().set(key, entry);
    this.flush();
  }

  /** Persist the index; called by `set`, exposed for tests and tools. */
  flush(): void {
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of this.load()) entries[key] = entry;
    const file: CacheFile = { version: 1, entries };
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
  }

  private load(): Map<string, CachedAudio> {
    if (this.entries !== undefined) return this.entries;
    this.entries = new Map<string, CachedAudio>();
    if (!existsSync(this.filePath)) return this.entries;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { entries?: unknown };
      const entries = parsed.entries;
      if (typeof entries !== "object" || entries === null) return this.entries;
      for (const [key, value] of Object.entries(entries)) {
        const entry = CachedAudioSchema.safeParse(value);
        if (entry.success) this.entries.set(key, entry.data);
      }
    } catch {
      // A corrupt index is an empty index.
    }
    return this.entries;
  }
}

/**
 * The cache a run should use: `"off"` (or an empty string) means none, and
 * anything else is a path to the index file.
 */
export function segmentCacheFor(configured: string): SegmentAudioCache {
  const value = configured.trim();
  return value === "" || value === "off" ? new NullSegmentCache() : new FileSegmentCache(value);
}
