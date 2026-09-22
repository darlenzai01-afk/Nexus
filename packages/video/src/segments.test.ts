import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCaptionTrack } from "@nexus/audio";
import { Db, Repo, migrate } from "@nexus/db";
import { MemoryBlobStore } from "@nexus/providers";
import { buildTimeline, composeVideo } from "@nexus/render";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureAudio, fixtureManifest, fixtureRenderConfig, fixtureStage } from "./fixtures.js";
import { digestOfFrames, fileDigest, fileExists, planSegments } from "./segments.js";
import { loadAudioTrack } from "@nexus/audio";
import {
  createWorkDir,
  dropSegmentFrames,
  frameFile,
  readJournal,
  resetWorkDir,
  segmentFile,
  writeFileAtomic,
  writeJournal,
} from "./workdir.js";
import { RESULT_VERSION, RenderJournalSchema } from "./schema.js";

/**
 * Segments and the journal: the two mechanisms the brief calls resumability and
 * artifact reuse.
 *
 * A segment's key must be a *complete* description of its bytes — same frames,
 * same captions in its window, same fonts, same encoder settings, or a different
 * key — because the key is the only thing standing between a resumed render and a
 * wrong one. The journal must survive being written by a killed process: a
 * half-written or foreign journal means "start again", never "adopt this".
 */

const workRoot = mkdtempSync(path.join(tmpdir(), "nexus-segments-"));
const storage = new MemoryBlobStore();
const db = Db.memory();
migrate(db);
const repo = new Repo(db);
const manifest = fixtureManifest({ seconds: 2 });

let composed: ReturnType<typeof composeVideo>;
let captionTrack: ReturnType<typeof buildCaptionTrack>;

beforeAll(async () => {
  const audio = await fixtureAudio(storage, repo, manifest);
  captionTrack = buildCaptionTrack(loadAudioTrack(storage, audio.trackHash));
  composed = composeVideo(buildTimeline(manifest), { deps: { characters: fixtureStage() } });
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe("planSegments", () => {
  const config = fixtureRenderConfig({ segmentFrames: 25 });

  it("cuts the timeline into fixed-size segments that cover every frame once", () => {
    const plans = planSegments(composed, config, { renderKey: "a".repeat(64) });
    expect(plans).toHaveLength(Math.ceil(composed.frameCount / 25));
    expect(plans[0]).toMatchObject({ index: 0, firstFrame: 0, lastFrame: 24, frameCount: 25 });
    expect(plans.at(-1)?.lastFrame).toBe(composed.frameCount - 1);
    // No gaps and no overlaps.
    for (let index = 1; index < plans.length; index += 1) {
      expect(plans[index]?.firstFrame).toBe((plans[index - 1]?.lastFrame ?? 0) + 1);
    }
    const covered = plans.reduce((sum, plan) => sum + plan.frameCount, 0);
    expect(covered).toBe(composed.frameCount);
  });

  it("gives the same frames the same key, and changes it when anything that matters changes", () => {
    const base = planSegments(composed, config, { renderKey: "a".repeat(64) });
    const again = planSegments(composed, config, { renderKey: "a".repeat(64) });
    expect(again.map((plan) => plan.key)).toEqual(base.map((plan) => plan.key));

    const otherRender = planSegments(composed, config, { renderKey: "b".repeat(64) });
    expect(otherRender[0]?.key).not.toBe(base[0]?.key);

    const otherConfig = planSegments(
      composed,
      fixtureRenderConfig({ segmentFrames: 25, crf: 18 }),
      {
        renderKey: "a".repeat(64),
      },
    );
    expect(otherConfig[0]?.key).not.toBe(base[0]?.key);

    const otherFont = planSegments(composed, config, {
      renderKey: "a".repeat(64),
      fontHash: "f".repeat(64),
    });
    expect(otherFont[0]?.key).not.toBe(base[0]?.key);
  });

  it("changes a segment's key when the captions in its window change", () => {
    const without = planSegments(composed, config, { renderKey: "a".repeat(64) });
    const withCaptions = planSegments(composed, config, {
      renderKey: "a".repeat(64),
      captionTrack,
    });
    expect(withCaptions[0]?.key).not.toBe(without[0]?.key);
    // The frame digest itself does not move: captions are not part of the frames.
    expect(withCaptions[0]?.frameDigest).toBe(without[0]?.frameDigest);
  });

  it("keeps a different frame range apart even at the same index", () => {
    const short = planSegments(composed, fixtureRenderConfig({ segmentFrames: 10 }), {
      renderKey: "a".repeat(64),
    });
    const long = planSegments(composed, config, { renderKey: "a".repeat(64) });
    expect(short[0]?.key).not.toBe(long[0]?.key);
    expect(short[0]?.frameDigest).not.toBe(long[0]?.frameDigest);
  });
});

describe("digestOfFrames", () => {
  it("digests a range deterministically and distinctly", () => {
    const first = digestOfFrames(composed, 0, 9);
    expect(digestOfFrames(composed, 0, 9)).toBe(first);
    expect(digestOfFrames(composed, 0, 10)).not.toBe(first);
    expect(digestOfFrames(composed, 5, 14)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("the work directory", () => {
  it("puts everything a render needs under one directory per render key", () => {
    const work = createWorkDir(workRoot, "c".repeat(64));
    expect(work.dir.startsWith(workRoot)).toBe(true);
    expect(work.dir).toContain("c".repeat(16));
    expect(segmentFile(work, 3)).toBe(path.join(work.dir, "seg-0003.mp4"));
    expect(frameFile(work, 123)).toBe(path.join(work.framesDir, "frame-000123.png"));
  });

  it("keeps one directory per render key, so two renders never share frames", () => {
    const first = createWorkDir(workRoot, "1".repeat(64));
    const second = createWorkDir(workRoot, "2".repeat(64));
    expect(first.dir).not.toBe(second.dir);
  });

  it("reads back the journal it wrote", () => {
    const work = createWorkDir(workRoot, "d".repeat(64));
    writeJournal(work, {
      version: RESULT_VERSION,
      renderKey: work.key,
      configHash: "e".repeat(64),
      manifestHash: "f".repeat(64),
      segments: [],
      updatedAt: "2024-05-01T00:00:00.000Z",
    });
    const journal = readJournal(work);
    expect(journal?.renderKey).toBe(work.key);
    expect(RenderJournalSchema.safeParse(journal).success).toBe(true);
  });

  it("treats a journal from a different render as no journal at all", () => {
    const work = createWorkDir(workRoot, "3".repeat(64));
    writeJournal(work, {
      version: RESULT_VERSION,
      renderKey: "4".repeat(64), // somebody else's journal
      configHash: "e".repeat(64),
      manifestHash: "f".repeat(64),
      segments: [],
      updatedAt: "2024-05-01T00:00:00.000Z",
    });
    expect(readJournal(work)).toBeUndefined();
  });

  it("treats a half-written journal as no journal at all", () => {
    const work = createWorkDir(workRoot, "5".repeat(64));
    writeFileSync(work.journalFile, '{"version":1,"renderKey":"5');
    expect(readJournal(work)).toBeUndefined();
    // And an invalid journal cannot be written in the first place: the only way a
    // bad one appears is a process dying mid-write, which `writeFileAtomic` rules
    // out for the file itself.
    expect(() => writeJournal(work, JSON.parse("{}") as never)).toThrow();
  });

  it("writes atomically, so a reader never sees half a file", () => {
    const work = createWorkDir(workRoot, "6".repeat(64));
    const file = path.join(work.dir, "atomic.txt");
    writeFileAtomic(file, new TextEncoder().encode("complete"));
    expect(readFileSync(file, "utf8")).toBe("complete");
  });

  it("drops a segment's frames only when asked, and only that segment's", () => {
    const work = createWorkDir(workRoot, "7".repeat(64));
    for (const index of [0, 1, 2, 11]) writeFileSync(frameFile(work, index), "png");
    expect(dropSegmentFrames(work, 0, 1)).toBe(2);
    expect(fileExists(frameFile(work, 0))).toBe(false);
    expect(fileExists(frameFile(work, 2))).toBe(true);
    expect(fileExists(frameFile(work, 11))).toBe(true);
  });

  it("can be reset, which is what 'render it from scratch' means", () => {
    const work = createWorkDir(workRoot, "8".repeat(64));
    writeFileSync(segmentFile(work, 0), "video");
    resetWorkDir(work);
    expect(fileExists(segmentFile(work, 0))).toBe(false);
    expect(fileExists(work.framesDir)).toBe(true);
  });
});

describe("fileDigest", () => {
  it("hashes the bytes on disk, which is how reuse is confirmed", () => {
    const work = createWorkDir(workRoot, "9".repeat(64));
    const file = path.join(work.dir, "bytes.bin");
    writeFileSync(file, "some bytes");
    const digest = fileDigest(file);
    expect(digest.bytes).toBe(10);
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/u);
    writeFileSync(file, "other bytes");
    expect(fileDigest(file).hash).not.toBe(digest.hash);
  });
});
