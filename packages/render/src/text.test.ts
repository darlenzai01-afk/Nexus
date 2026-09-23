import { describe, expect, it } from "vitest";

import type { SceneAnimationEvent, SceneText, SceneTextKind } from "@nexus/scenes";

import {
  GLYPH_WIDTH_FACTOR,
  TEXT_BOX,
  countUpValue,
  fitText,
  revealCharsFor,
  textCentreY,
  textRect,
  visibleLines,
} from "./text.js";
import { DEFAULT_LOOK, makeLook } from "./look.js";
import { textStyle } from "./text.js";

const RESOLUTION = { width: 1920, height: 1080 };

const text = (overrides: Partial<SceneText> = {}): SceneText => ({
  kind: "claim",
  value: "The crossing takes fifteen minutes at peak.",
  attribution: "",
  position: "lower_third",
  maxLines: 2,
  sizeScale: 1,
  ...overrides,
});

const event = (params: SceneAnimationEvent["params"]): SceneAnimationEvent => ({
  id: "a1",
  atSec: 0,
  durationSec: 1,
  kind: "count_up",
  target: "text",
  targetId: "",
  params,
});

describe("on-screen text", () => {
  it("places a card where its position says, in frame pixels", () => {
    const rect = textRect(text({ position: "upper_third" }), RESOLUTION);
    expect(rect).toEqual({
      x: Math.round(TEXT_BOX.upper_third.x * 1920 * 1000) / 1000,
      y: Math.round(TEXT_BOX.upper_third.y * 1080 * 1000) / 1000,
      width: Math.round(TEXT_BOX.upper_third.width * 1920 * 1000) / 1000,
      height: Math.round(TEXT_BOX.upper_third.height * 1080 * 1000) / 1000,
    });
    expect(textCentreY(text(), RESOLUTION)).toBeCloseTo(0.8, 3);
  });

  it("wraps into the box and reports the size it settled on", () => {
    const rect = textRect(text(), RESOLUTION);
    const fitted = fitText(text().value, rect, 54, 2);
    expect(fitted.overflow).toBe(false);
    expect(fitted.fontSizePx).toBe(54);
    expect(fitted.lines.length).toBeLessThanOrEqual(2);
    expect(fitted.lines.join(" ")).toBe(text().value);
    // The approximation the engine documents, made explicit.
    const charsPerLine = Math.floor(rect.width / (54 * GLYPH_WIDTH_FACTOR));
    for (const line of fitted.lines) expect(line.length).toBeLessThanOrEqual(charsPerLine);
  });

  it("shrinks before it truncates, and truncates loudly", () => {
    const rect = textRect(text({ position: "corner" }), RESOLUTION);
    const long = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    const fitted = fitText(long, rect, 60, 2);
    expect(fitted.fontSizePx).toBeLessThan(60);
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1]!.endsWith("…")).toBe(true);
    expect(fitted.overflow).toBe(true);
  });

  it("hard-splits a word that cannot fit a line", () => {
    const fitted = fitText(
      "supercalifragilisticexpialidocious",
      textRect(text({ position: "corner" }), RESOLUTION),
      60,
      4,
    );
    expect(fitted.lines.length).toBeGreaterThan(1);
    expect(fitted.lines[0]!.endsWith("-")).toBe(true);
  });

  it("runs a count-up number through the card's template", () => {
    const templated = countUpValue(event({ from: 0, to: 345, decimals: 0 }), 0.5, "{n} frames");
    expect(templated).toMatchObject({ value: "173 frames", usedTemplate: true });
    expect(countUpValue(event({ from: 0, to: 345 }), 1, "{n} frames").value).toBe("345 frames");
    const bare = countUpValue(event({ from: 10, to: 20, unit: "%" }), 1, "no placeholder");
    expect(bare).toMatchObject({ value: "20%", usedTemplate: false });
    const decimals = countUpValue(event({ from: 0, to: 2.5, decimals: 2, prefix: "×" }), 1, "{n}");
    expect(decimals.value).toBe("×2.50");
    // Missing params take their documented defaults rather than throwing.
    expect(countUpValue(event({}), 1, "{n}").value).toBe("100");
  });

  it("reveals typed-on text one character at a time, across lines", () => {
    const lines = ["hello there", "world"];
    expect(revealCharsFor(lines, null)).toBe(Number.MAX_SAFE_INTEGER);
    expect(revealCharsFor(lines, 0)).toBe(0);
    expect(revealCharsFor(lines, 0.5)).toBe(8);
    expect(revealCharsFor(lines, 1)).toBe(16);
    expect(visibleLines(lines, 0)).toEqual([]);
    expect(visibleLines(lines, 5)).toEqual(["hello"]);
    expect(visibleLines(lines, 12)).toEqual(["hello there", "w"]);
    expect(visibleLines(lines, 16)).toEqual(lines);
  });

  it("sizes type from the card's kind and the look", () => {
    const title = textStyle("title", 91.8, DEFAULT_LOOK);
    expect(title).toMatchObject({ weight: 700, italic: false, colour: DEFAULT_LOOK.ink });
    const quote = textStyle("quote", 48, makeLook({ ink: "#ffffff" }));
    expect(quote).toMatchObject({ weight: 500, italic: true, colour: "#ffffff" });
    const kinds: SceneTextKind[] = ["title", "claim", "quote", "number", "label", "callout"];
    for (const kind of kinds) expect(textStyle(kind, 40, DEFAULT_LOOK).fontSizePx).toBe(40);
  });
});
