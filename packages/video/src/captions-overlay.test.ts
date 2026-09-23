import { buildCaptionTrack, cueText, loadAudioTrack, type CaptionTrack } from "@nexus/audio";
import { Db, Repo, migrate } from "@nexus/db";
import { MemoryBlobStore } from "@nexus/providers";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createCanvas, pixelAt } from "./canvas.js";
import { activeCue, drawCaption } from "./captions-overlay.js";
import { fixtureAudio, fixtureManifest } from "./fixtures.js";
import { DEFAULT_FONT_CANDIDATES, findFont, loadFontFile, type FontSet } from "./font.js";

/**
 * Burning the captions in.
 *
 * The caption track was derived in Phase 10 — wrapped lines, non-overlapping
 * windows, enough hold to read — so this module's whole job is to draw the cue
 * that is on screen *now* and nothing else. The tests check exactly that: the
 * right cue, in the right place, and silence where the track has no cue.
 */

const FONT_FILE = findFont(DEFAULT_FONT_CANDIDATES);

/**
 * Burning a caption needs a face: there is nothing else to draw the words with.
 * The pipeline reports `font_missing` and skips the burn when none is installed,
 * so a machine without TrueType fonts simply has no caption coverage — the tests
 * say so rather than pretending to pass.
 */
function loadFonts(): FontSet | undefined {
  if (FONT_FILE === undefined || !existsSync(FONT_FILE)) {
    console.warn(`[captions] no TrueType face found in ${DEFAULT_FONT_CANDIDATES.join(", ")}`);
    return undefined;
  }
  return { regular: loadFontFile(FONT_FILE) };
}

const fonts = loadFonts();

const storage = new MemoryBlobStore();
const db = Db.memory();
migrate(db);
const repo = new Repo(db);

async function track(): Promise<CaptionTrack> {
  const manifest = fixtureManifest({ seconds: 2 });
  const audio = await fixtureAudio(storage, repo, manifest);
  return buildCaptionTrack(loadAudioTrack(storage, audio.trackHash));
}

describe("activeCue", () => {
  it("finds the cue whose window contains the moment, and nothing in the gaps", async () => {
    const captions = await track();
    const first = captions.cues[0];
    expect(first).toBeDefined();
    expect(activeCue(captions, first!.startMs)?.id).toBe(first!.id);
    expect(activeCue(captions, first!.startMs + 1)?.id).toBe(first!.id);
    // The cues are held across the clip (Phase 10 packs them), so the only time
    // with no cue is after the last one ends.
    const last = captions.cues.at(-1)!;
    expect(activeCue(captions, last.endMs + 1)).toBeUndefined();
    expect(captions.cues.every((cue) => cue.endMs > cue.startMs)).toBe(true);
  });
});

describe.skipIf(fonts === undefined)("drawCaption", () => {
  it("draws the cue's own lines, inside the safe area", async () => {
    const captions = await track();
    const cue = captions.cues[0]!;
    const canvas = createCanvas(320, 180);
    const drawn = drawCaption(canvas, captions, cue.startMs + 1, fonts!);
    expect(drawn?.cueId).toBe(cue.id);
    expect(drawn?.lines).toEqual(cue.lines.map((line) => line.text));
    expect(drawn!.band.x).toBeGreaterThanOrEqual(0);
    expect(drawn!.band.x + drawn!.band.width).toBeLessThanOrEqual(320);
    expect(drawn!.band.y + drawn!.band.height).toBeLessThanOrEqual(180);
    // Captions sit at the bottom of the frame — anchored to the configured margin,
    // not floating in the middle of the picture.
    expect(drawn!.band.y + drawn!.band.height).toBe(180 - 24);
    expect(drawn!.band.y).toBeGreaterThan(60);
  });

  it("leaves the frame alone in a gap between cues", async () => {
    const captions = await track();
    const canvas = createCanvas(320, 180);
    const before = canvas.data.slice();
    const lastCue = captions.cues.at(-1)!;
    expect(drawCaption(canvas, captions, lastCue.endMs + 1, fonts!)).toBeUndefined();
    expect(Array.from(canvas.data)).toEqual(Array.from(before));
  });

  it("paints a band and ink when a font is available", async () => {
    const captions = await track();
    const cue = captions.cues[0]!;
    const canvas = createCanvas(320, 180);
    const drawn = drawCaption(canvas, captions, cue.startMs + 1, fonts!);
    expect(drawn).toBeDefined();
    // The band is opaque enough to be seen over any background.
    const bandPixel = pixelAt(
      canvas,
      Math.round(drawn!.band.x + drawn!.band.width / 2),
      drawn!.band.y + 2,
    );
    expect(bandPixel[3]).toBeGreaterThan(120);
    if (fonts !== undefined) {
      // Some ink inside the band: the caption is legible, not just a strip.
      let inked = 0;
      for (let x = drawn!.band.x; x < drawn!.band.x + drawn!.band.width; x += 1) {
        for (let y = drawn!.band.y; y < drawn!.band.y + drawn!.band.height; y += 1) {
          const pixel = pixelAt(canvas, x, y);
          if (pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200) inked += 1;
        }
      }
      expect(inked).toBeGreaterThan(50);
    }
  });

  it("honours the caption style it is given", async () => {
    const captions = await track();
    const cue = captions.cues[0]!;
    const canvas = createCanvas(320, 180);
    const drawn = drawCaption(canvas, captions, cue.startMs + 1, fonts!, {
      fontPx: 12,
      marginPx: 8,
      bandOpacity: 0.4,
      ink: "#ffffff",
      band: "#000000",
      safeWidthRatio: 0.9,
    });
    expect(drawn!.band.y + drawn!.band.height).toBe(180 - 8);
    expect(drawn!.band.height).toBeLessThanOrEqual(40);
  });

  it("draws the text the caption track says, word for word", async () => {
    const captions = await track();
    const cue = captions.cues[0]!;
    const canvas = createCanvas(320, 180);
    const drawn = drawCaption(canvas, captions, cue.startMs + 1, fonts!);
    expect(drawn?.lines.join(" ")).toBe(cueText(cue).replace(/\s+/gu, " ").trim());
  });
});
