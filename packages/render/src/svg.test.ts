import { CharacterLibrary } from "@nexus/characters";
import { beforeAll, describe, expect, it } from "vitest";

import { composeFrame } from "./compose.js";
import { loadDemoScene } from "./demo.js";
import { manifestFixture, sceneFixture } from "./fixtures.js";
import { createCharacterStage, type CharacterStage } from "./performance.js";
import { frameToSvg, storyboardSvg } from "./svg.js";
import { buildTimeline, type Timeline } from "./timeline.js";
import type { Frame } from "./types.js";

let timeline: Timeline;
let stage: CharacterStage;

beforeAll(() => {
  timeline = buildTimeline(loadDemoScene());
  stage = createCharacterStage(CharacterLibrary.load());
});

const read = (path: string): string | undefined => stage.read(path);
const frameAt = (index: number): Frame => composeFrame(timeline, index, { characters: stage });

describe("the SVG writer", () => {
  it("writes a frame document with every element in it", () => {
    const frame = frameAt(120);
    const { svg, diagnostics, bytes } = frameToSvg(frame, { read, xmlDeclaration: true });
    expect(diagnostics).toEqual([]);
    expect(bytes).toBe(new TextEncoder().encode(svg).length);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain('viewBox="0 0 1920 1080"');
    expect(svg).toContain(`fill="${frame.background}"`);
    for (const element of frame.elements) {
      expect(svg).toContain(`id="el-${element.id.replace(/[^A-Za-z0-9_-]/gu, "-")}"`);
    }
    // The character layers are embedded as nested SVG, each with its own view box.
    const characters = frame.elements.filter((element) => element.kind === "character");
    expect(characters).toHaveLength(2);
    const layers = characters.reduce((sum, element) => sum + element.layers.length, 0);
    const embedded = svg.split('viewBox="0 0 512 1024"').length - 1;
    expect(embedded).toBe(layers);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("draws clips for a partial reveal and pours them into defs", () => {
    const manifest = manifestFixture([
      sceneFixture({
        characters: [],
        type: "ENVIRONMENT",
        text: undefined,
        media: {
          kind: "generated",
          description: "A plate.",
          treatment: "full_frame",
          assets: ["asset_plate"],
        },
        animation: [
          {
            id: "a1",
            atSec: 0,
            durationSec: 2,
            kind: "wipe_in",
            target: "media",
            targetId: "asset_plate",
            params: {},
          },
        ],
        durationSec: 3.5,
      }),
    ]);
    const local = buildTimeline(manifest);
    const mid = frameToSvg(composeFrame(local, 30), { read });
    expect(mid.svg).toContain('<clipPath id="clip-media-asset_plate"');
    expect(mid.svg).toContain('clip-path="url(#clip-media-asset_plate)"');
    const done = frameToSvg(composeFrame(local, 90), { read });
    expect(done.svg).not.toContain("clip-path=");
  });

  it("escapes text and marks a layer whose bytes are missing", () => {
    const manifest = manifestFixture([
      sceneFixture({
        characters: [],
        type: "EVIDENCE",
        text: {
          kind: "claim",
          value: 'Tom & Jerry <script>alert("x")</script>',
          position: "center",
          maxLines: 3,
        },
      }),
    ]);
    const local = buildTimeline(manifest);
    const rendered = frameToSvg(composeFrame(local, 0));
    expect(rendered.svg).toContain("Tom &amp; Jerry &lt;script&gt;");
    expect(rendered.svg).not.toContain("<script>alert");

    const characterFrame = frameAt(0);
    const blind = frameToSvg(characterFrame, { read: () => undefined });
    expect(blind.diagnostics.length).toBeGreaterThan(0);
    expect(blind.diagnostics[0]!.code).toBe("missing_asset");
    expect(blind.svg).toContain("stroke-dasharray");
  });

  it("writes the same bytes for the same frame", () => {
    const first = frameToSvg(frameAt(200), { read });
    const second = frameToSvg(frameAt(200), { read });
    expect(second.svg).toBe(first.svg);
    expect(second.bytes).toBe(first.bytes);
  });

  it("writes a storyboard one tile per frame", () => {
    const frames = [0, 60, 120, 180, 240, 344].map((index) => frameAt(index));
    const sheet = storyboardSvg(frames, { read, columns: 3, tileWidth: 640, idPrefix: "board-" });
    expect(sheet.diagnostics).toEqual([]);
    expect(sheet.svg.match(/<svg x="[0-9.]+" y="[0-9.]+" width="640"/gu)).toHaveLength(
      frames.length,
    );
    expect(sheet.svg).toContain('width="1952"');
    expect(sheet.svg).toContain('height="812"');
    expect(sheet.svg).toContain("#344 ·");
    expect(sheet.svg).toContain("#120 ·");
    expect(sheet.svg).toContain("fade_to_black");
    // Def ids are prefixed per tile, so sixteen embedded frames cannot collide.
    expect(sheet.svg).toContain('id="board-t0-clip-');
    expect(() => storyboardSvg([], { read })).toThrow();
  });
});
