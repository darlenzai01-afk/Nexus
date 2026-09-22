import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { journalBytes, RenderJournalSchema, type RenderJournal } from "./schema.js";

/**
 * Where a render keeps its work.
 *
 * One directory per **render key** — the hash of the manifest, the voice, the
 * captions and the configuration — so two renders never share frames, segments or
 * a journal, and a stale directory can never be mistaken for a cache hit under a
 * different configuration.
 *
 * The layout is the resume protocol:
 *
 * ```
 * <workRoot>/<renderKey>/
 *   journal.json            finished segments, written after each one
 *   frames/seg-0000/frame-00123.png
 *   seg-0000.mp4            one encoded segment
 *   thumbnail.jpg
 *   video.mp4               the assembled output
 * ```
 */

export interface WorkDir {
  readonly root: string;
  readonly key: string;
  readonly dir: string;
  readonly framesDir: string;
  readonly journalFile: string;
  readonly outputFile: string;
  readonly thumbnailFile: string;
  readonly logFile: string;
  readonly concatFile: string;
}

export function createWorkDir(workRoot: string, renderKey: string): WorkDir {
  const dir = path.join(workRoot, renderKey.slice(0, 16));
  const framesDir = path.join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  return {
    root: workRoot,
    key: renderKey,
    dir,
    framesDir,
    journalFile: path.join(dir, "journal.json"),
    outputFile: path.join(dir, "video.mp4"),
    thumbnailFile: path.join(dir, "thumbnail.jpg"),
    logFile: path.join(dir, "render-log.jsonl"),
    concatFile: path.join(dir, "segments.txt"),
  };
}

export function segmentFile(work: WorkDir, index: number): string {
  return path.join(work.dir, `seg-${String(index).padStart(4, "0")}.mp4`);
}

export function frameFile(work: WorkDir, globalFrameIndex: number): string {
  return path.join(work.framesDir, `frame-${String(globalFrameIndex).padStart(6, "0")}.png`);
}

/** Read the journal, if there is one and it matches this render key. */
export function readJournal(work: WorkDir): RenderJournal | undefined {
  if (!existsSync(work.journalFile)) return undefined;
  try {
    const parsed = RenderJournalSchema.safeParse(
      JSON.parse(readFileSync(work.journalFile, "utf8")),
    );
    if (!parsed.success) return undefined;
    if (parsed.data.renderKey !== work.key) return undefined;
    return parsed.data;
  } catch {
    return undefined; // a corrupt journal means "start again", never a failed render
  }
}

export function writeJournal(work: WorkDir, journal: RenderJournal): void {
  writeFileAtomic(work.journalFile, journalBytes(journal));
}

/** Write through a temp file, so a killed process never leaves half a journal. */
export function writeFileAtomic(file: string, bytes: Uint8Array): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, file);
}

/** Remove the frames of a segment once its video is verified (the workspace policy). */
export function dropSegmentFrames(work: WorkDir, firstFrame: number, lastFrame: number): number {
  let removed = 0;
  for (let index = firstFrame; index <= lastFrame; index += 1) {
    const file = frameFile(work, index);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}

export function resetWorkDir(work: WorkDir): void {
  rmSync(work.dir, { recursive: true, force: true });
  mkdirSync(work.framesDir, { recursive: true });
}
