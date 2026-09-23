import { existsSync } from "node:fs";

import { composeVideo, buildTimeline } from "@nexus/render";
import { describe, expect, it } from "vitest";

import { fixtureManifest, fixtureStage } from "./fixtures.js";
import {
  DEFAULT_FONT_CANDIDATES,
  findFont,
  loadFontFile,
  missingGlyphs,
  type FontSet,
} from "./font.js";
import { encodePng, verifyPngRoundTrip } from "./png.js";
import { rasteriseFrame, type RasterDiagnostic } from "./raster.js";
import type { Frame } from "@nexus/render";

/**
 * The rasteriser, on a real frame from the real demonstration plan.
 *
 * The point of the rasteriser is not that it can draw; it is that the same frame
 * always becomes the same pixels, in-process, with no browser and no fonts
 * installed by luck. So these tests check *identity* (two rasterisations, one
 * PNG hash) and *honesty* (a missing asset or a missing font is reported, not
 * silently skipped).
 */

const FONT_FILE = findFont(DEFAULT_FONT_CANDIDATES);
const BOLD_FILE = findFont([
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]);

function fonts(): FontSet | undefined {
  if (FONT_FILE === undefined || !existsSync(FONT_FILE)) return undefined;
  const regular = loadFontFile(FONT_FILE);
  if (BOLD_FILE === undefined || !existsSync(BOLD_FILE)) return { regular };
  return { regular, bold: loadFontFile(BOLD_FILE) };
}

function frameAt(index: number): Frame {
  const manifest = fixtureManifest({ seconds: 2 });
  const composed = composeVideo(buildTimeline(manifest), { deps: { characters: fixtureStage() } });
  const frames = composed.scenes.flatMap((scene) => [...scene.frames]);
  const frame = frames[index];
  if (frame === undefined) throw new Error(`no frame ${index} in the fixture plan`);
  return frame;
}

describe("rasteriseFrame", () => {
  it("draws every element of the demonstration frame and reports nothing", () => {
    const stage = fixtureStage();
    const result = rasteriseFrame(frameAt(30), {
      readAsset: (path) => stage.read(path),
      ...(fonts() !== undefined ? { fonts: fonts() } : {}),
    });
    expect(result.elements.length).toBeGreaterThanOrEqual(4);
    expect(result.elements.some((element) => element.kind === "character")).toBe(true);
    expect(result.elements.some((element) => element.kind === "text")).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.canvas.width).toBe(320);
    expect(result.canvas.height).toBe(180);
  });

  it("produces the same PNG bytes twice, which is what makes a render reproducible", () => {
    const stage = fixtureStage();
    const fontSet = fonts();
    if (fontSet === undefined) throw new Error("this test needs a system font");
    const frame = frameAt(30);
    const first = encodePng(
      rasteriseFrame(frame, { readAsset: (path) => stage.read(path), fonts: fontSet }).canvas,
    );
    const second = encodePng(
      rasteriseFrame(frame, { readAsset: (path) => stage.read(path), fonts: fontSet }).canvas,
    );
    expect(first.byteLength).toBeGreaterThan(1_000);
    expect(second).toEqual(first);
    expect(
      verifyPngRoundTrip(
        first,
        rasteriseFrame(frame, {
          readAsset: (path) => stage.read(path),
          fonts: fontSet,
        }).canvas,
      ),
    ).toBeUndefined();
  });

  it("scales the plan's geometry to the output resolution", () => {
    const stage = fixtureStage();
    const fontSet = fonts();
    const frame = frameAt(30);
    const small = rasteriseFrame(
      frame,
      {
        readAsset: (path) => stage.read(path),
        ...(fontSet !== undefined ? { fonts: fontSet } : {}),
      },
      { resolution: { width: 640, height: 360 } },
    );
    expect(small.canvas.width).toBe(640);
    expect(small.canvas.height).toBe(360);
    expect(small.scale).toBeCloseTo(2, 5);
    // Drawing at 2× is drawing the same frame: the element list is identical.
    const plan = rasteriseFrame(frame, { readAsset: (path) => stage.read(path) });
    expect(small.elements.map((drawn) => drawn.id)).toEqual(plan.elements.map((drawn) => drawn.id));
    // A frame drawn at 2× is a genuinely bigger image, not the same one.
    expect(encodePng(small.canvas).byteLength).toBeGreaterThan(encodePng(plan.canvas).byteLength);
  });

  it("refuses a resolution that would stretch the scene", () => {
    expect(() =>
      rasteriseFrame(frameAt(0), {}, { resolution: { width: 300, height: 180 } }),
    ).toThrow(/is 1\.667:1/u);
  });

  it("reports a missing asset instead of drawing nothing quietly", () => {
    const result = rasteriseFrame(frameAt(30), { readAsset: () => undefined });
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("missing_asset");
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "missing_asset")[0]?.severity,
    ).toBe("error");
  });

  it("reports skipped text when no font is available", () => {
    const stage = fixtureStage();
    const result = rasteriseFrame(frameAt(30), { readAsset: (path) => stage.read(path) });
    const diagnostics: readonly RasterDiagnostic[] = result.diagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "text_skipped")).toBe(true);
  });

  it("knows which characters a font cannot draw", () => {
    const fontSet = fonts();
    if (fontSet === undefined) return; // no system font: nothing to check
    // DejaVu has Latin but no CJK: the check has to notice, so text that cannot be
    // drawn is reported rather than turned into empty boxes.
    expect(missingGlyphs(fontSet, "Nexus 漢字").length).toBeGreaterThan(0);
    expect(missingGlyphs(fontSet, "Nexus writes video")).toEqual([]);
  });
});
