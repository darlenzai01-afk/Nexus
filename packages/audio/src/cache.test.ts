import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSegmentCache,
  MemorySegmentCache,
  NullSegmentCache,
  segmentCacheFor,
  segmentCacheKey,
  type CachedAudio,
} from "./cache.js";

/**
 * Segment-level reuse.
 *
 * The cache is a hint, never a source of truth: its key must include everything
 * that changes the audio (adapter, text, voice, container, rate, style) and it
 * must survive its own file being unreadable — the worst case is always "voice it
 * again", never "fail the stage".
 */

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cachePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nexus-audio-cache-"));
  temporary.push(directory);
  return path.join(directory, "index.json");
}

const key = {
  provider: "fake",
  text: "hello",
  voiceId: "fake-warm",
  format: "wav",
  sampleRate: 8_000,
  rate: 1,
} as const;

const entry: CachedAudio = {
  hash: "a".repeat(64),
  bytes: 16_044,
  mime: "audio/wav",
  format: "wav",
  sampleRate: 8_000,
  durationMs: 1_000,
  voiceId: "fake-warm",
  provider: "fake",
};

describe("the segment cache", () => {
  it("keys on everything that changes the audio", () => {
    const base = segmentCacheKey(key);
    expect(segmentCacheKey({ ...key })).toBe(base);
    expect(segmentCacheKey({ ...key, text: "hello!" })).not.toBe(base);
    expect(segmentCacheKey({ ...key, voiceId: "fake-deep" })).not.toBe(base);
    expect(segmentCacheKey({ ...key, provider: "elevenlabs" })).not.toBe(base);
    expect(segmentCacheKey({ ...key, format: "mp3" })).not.toBe(base);
    expect(segmentCacheKey({ ...key, sampleRate: 24_000 })).not.toBe(base);
    expect(segmentCacheKey({ ...key, rate: 1.1 })).not.toBe(base);
    expect(segmentCacheKey({ ...key, style: "calm" })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("remembers within a run, and forgets when caching is off", () => {
    const memory = new MemorySegmentCache();
    expect(memory.get("k")).toBeUndefined();
    memory.set("k", entry);
    expect(memory.get("k")).toEqual(entry);
    expect(memory.size).toBe(1);

    const none = new NullSegmentCache();
    none.set("k", entry);
    expect(none.get("k")).toBeUndefined();
    expect(none.size).toBe(0);
  });

  it("persists an index that a later run reads back", () => {
    const file = cachePath();
    const first = new FileSegmentCache(file);
    first.set("k", entry);
    expect(first.size).toBe(1);

    const second = new FileSegmentCache(file);
    expect(second.get("k")).toEqual(entry);
    const contents = JSON.parse(readFileSync(file, "utf8")) as { version: number };
    expect(contents.version).toBe(1);
  });

  it("treats a corrupt or half-written index as empty", () => {
    const file = cachePath();
    writeFileSync(file, "{ not json", "utf8");
    const cache = new FileSegmentCache(file);
    expect(cache.size).toBe(0);

    // A well-formed file with a junk entry drops only that entry.
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: { good: entry, bad: { hash: "nope" } } }),
      "utf8",
    );
    const mixed = new FileSegmentCache(file);
    expect(mixed.get("good")).toEqual(entry);
    expect(mixed.get("bad")).toBeUndefined();
    expect(mixed.size).toBe(1);
  });

  it("is off unless an operator names a file", () => {
    expect(segmentCacheFor("off")).toBeInstanceOf(NullSegmentCache);
    expect(segmentCacheFor("")).toBeInstanceOf(NullSegmentCache);
    expect(segmentCacheFor("/tmp/nexus-audio-index.json")).toBeInstanceOf(FileSegmentCache);
  });
});
