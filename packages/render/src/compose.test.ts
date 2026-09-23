import { CharacterLibrary } from "@nexus/characters";
import { beforeAll, describe, expect, it } from "vitest";

import { composeFrame, composeScene, composeVideo, verifyAssets } from "./compose.js";
import { loadDemoScene } from "./demo.js";
import { manifestFixture, sceneFixture } from "./fixtures.js";
import { createCharacterStage, type CharacterStage } from "./performance.js";
import { buildTimeline, type Timeline } from "./timeline.js";
import { DEPTH_BACK, DEPTH_Z } from "./layout.js";
import type { CharacterElement, DiagramElement, MediaElement, TextElement } from "./types.js";

const DEMO_SCENE = "scn_demo_composite";

let library: CharacterLibrary;
let stage: CharacterStage;
let timeline: Timeline;

beforeAll(() => {
  library = CharacterLibrary.load();
  stage = createCharacterStage(library);
  timeline = buildTimeline(loadDemoScene());
});

const frameAt = (timeSec: number) =>
  composeFrame(timeline, Math.round(timeSec * timeline.fps), { characters: stage });
const charactersOf = (index: number): CharacterElement[] => {
  const frame = composeFrame(timeline, index, { characters: stage });
  return frame.elements.filter(
    (element): element is CharacterElement => element.kind === "character",
  );
};
/** Undo the camera's shift and scale, to check where the scene put an element. */
function unanchor(
  element: CharacterElement,
  frame: ReturnType<typeof frameAt>,
): { x: number; y: number } {
  const camera = frame.camera;
  const back = (value: number, axis: number, size: number): number =>
    Math.round(((value - size / 2) / camera.scale + axis * size) * 1000) / 1000;
  return {
    x: back(element.transform.x, camera.aim.x, frame.resolution.width),
    y: back(element.transform.y, camera.aim.y, frame.resolution.height),
  };
}

const textOf = (index: number): TextElement => {
  const frame = composeFrame(timeline, index, { characters: stage });
  const element = frame.elements.find(
    (candidate): candidate is TextElement => candidate.kind === "text",
  );
  if (element === undefined) throw new Error("the demo scene has no text element");
  return element;
};

describe("composing a frame", () => {
  it("carries the scene's own facts", () => {
    const frame = frameAt(0);
    expect(frame).toMatchObject({
      fps: 30,
      index: 0,
      timeSec: 0,
      sceneId: DEMO_SCENE,
      sceneIndex: 0,
      sceneType: "HYBRID",
      localSec: 0,
      durationSec: 11.5,
      resolution: { width: 1920, height: 1080 },
    });
    expect(frame.camera).toMatchObject({
      shot: "medium_close",
      movement: "dolly_in",
      focus: "presenter",
      scale: 1,
    });
    expect(frame.narration.words).toBe(26);
    expect(frame.narration.sentenceIds).toEqual(["snt_demo_1"]);
    expect(frame.background).toBe("#12161c");
    expect(frame.transition).toMatchObject({ kind: "fade_to_black", durationSec: 0.8, mix: 0 });
    expect(frame.diagnostics).toEqual([]);
  });

  it("orders elements into the same layer sheet the engine documents", () => {
    const frame = frameAt(4);
    const zs = frame.elements.map((element) => element.z);
    expect([...zs].sort((left, right) => left - right)).toEqual(zs);
    expect(frame.elements.map((element) => element.id)).toEqual([
      "char:tomas",
      "char:maya",
      "fx:a_callout",
      "media:demo_plate",
      "text",
    ]);
    expect(frame.elements.map((element) => element.kind)).toEqual([
      "character",
      "character",
      "effect",
      "media",
      "text",
    ]);
  });

  it("draws the cast front and back, with the pose and expression the scene asks for", () => {
    const [tomas, maya] = charactersOf(Math.round(4 * 30));
    expect(maya?.characterId).toBe("maya");
    expect(maya?.depth).toBe("front");
    expect(maya?.z).toBe(DEPTH_Z.front);
    expect(maya?.opacity).toBe(1);
    expect(maya?.pose).toBe("talk");
    expect(maya?.expression).toBe("explaining");
    expect(maya?.facing).toBe("front");
    expect(maya?.anchor).toEqual({ x: 0.5, y: 1 });
    expect(maya?.canvas).toEqual({ width: 512, height: 1024 });
    // The stack is the character system's: one layer per region, in draw order.
    expect(maya?.layers.map((layer) => layer.drawIndex)).toEqual(
      maya?.layers.map((_layer, index) => index),
    );
    expect(maya?.layers.map((layer) => layer.slot)).toContain("base");
    expect(maya?.layers.some((layer) => layer.path.includes("maya_pose_talk_body"))).toBe(true);
    expect(maya?.layers.every((layer) => layer.hash.length === 64)).toBe(true);

    expect(tomas?.depth).toBe("back");
    expect(tomas?.z).toBe(DEPTH_Z.back);
    expect(tomas?.opacity).toBe(DEPTH_BACK.opacity);
    expect(tomas?.pose).toBe("stand");
    expect(tomas?.expression).toBe("engaged");
    expect(tomas?.gesture).toBe("point");
    expect(tomas?.clothing).toEqual(["field"]);
    // The listener stands smaller, further back and a little higher in the frame.
    expect(tomas!.transform.scale).toBeLessThan(maya!.transform.scale);
    expect(tomas!.transform.y).toBeLessThan(maya!.transform.y);
    expect(tomas!.transform.x).toBeGreaterThan(maya!.transform.x);
  });

  it("puts a character's anchor where the blocking says, scaled by the shot", () => {
    const frame = frameAt(1.2);
    const maya = frame.elements.find(
      (element): element is CharacterElement =>
        element.kind === "character" && element.characterId === "maya",
    )!;
    // medium_close is 0.84 of the frame high; the figure's canvas is 1024 tall.
    expect(maya.transform.scale).toBeCloseTo(((1080 * 0.84) / 1024) * frame.camera.scale, 3);
    expect(maya.transform.origin).toEqual({ x: 0.5, y: 1 });
    // Undo the camera: the figure's anchor sits where the blocking put it.
    const anchor = unanchor(maya, frame);
    expect(anchor.x).toBeCloseTo(1920 * 0.34, 2);
    expect(anchor.y).toBeCloseTo(1080 * 0.94, 2);
  });

  it("changes a character's pose and expression when the events say so", () => {
    expect(charactersOf(Math.round(4.7 * 30))[1]?.pose).toBe("talk");
    const afterPose = charactersOf(Math.round(4.9 * 30))[1]!;
    expect(afterPose.pose).toBe("walk");
    expect(afterPose.layers.some((layer) => layer.path.includes("maya_pose_walk_body"))).toBe(true);

    expect(charactersOf(Math.round(6.3 * 30))[0]?.expression).toBe("engaged");
    expect(charactersOf(Math.round(6.5 * 30))[0]?.expression).toBe("surprised");
  });

  it("counts the card up and types it on over the scene", () => {
    const opening = textOf(0);
    expect(opening.textKind).toBe("number");
    expect(opening.value).toBe("0 frames composited from one manifest");
    expect(opening.revealChars).toBe(0);
    expect(textOf(Math.round(3 * 30)).value).toMatch(
      /^24[12] frames composited from one manifest$/u,
    );
    const finished = textOf(Math.round(4 * 30));
    expect(finished.value).toBe("345 frames composited from one manifest");
    expect(finished.revealChars).toBeGreaterThanOrEqual(
      finished.lines.reduce((sum, line) => sum + line.length, 0),
    );
    expect(finished.attribution).toContain("not a research claim");
    expect(finished.style.fontSizePx).toBeGreaterThan(100);
    expect(finished.lines.length).toBeLessThanOrEqual(2);
  });

  it("applies the text's own events: lift in, pulse, rotate", () => {
    expect(textOf(20).opacity).toBeLessThan(1);
    expect(textOf(Math.round(2 * 30)).opacity).toBe(1);
    // A pulse leaves the card exactly where it found it.
    const paused = textOf(Math.round(6.4 * 30)).transform.scale;
    const pulsing = textOf(Math.round(5.9 * 30)).transform.scale;
    expect(pulsing).toBeGreaterThan(paused);
    expect(textOf(Math.round(7.4 * 30)).transform.rotationDeg).toBe(-1.6);
    expect(textOf(Math.round(7.7 * 30)).transform.rotationDeg).toBeLessThan(0);
    expect(textOf(Math.round(8.1 * 30)).transform.rotationDeg).toBe(0);
  });

  it("moves the camera as the scene's movement asks, and takes the frame with it", () => {
    expect(frameAt(0).camera.scale).toBe(1);
    expect(frameAt(5.75).camera.scale).toBeGreaterThan(1);
    expect(frameAt(11.4).camera.scale).toBeCloseTo(1.08, 2);
    const lifted = textOf(Math.round(11 * 30));
    const opening = textOf(0);
    expect(lifted.rect).toEqual(opening.rect);
    // The card's box is unchanged; the camera moved where it lands in the frame.
    expect(lifted.transform.y).not.toBe(opening.transform.y);
  });

  it("ramps the transition out over the tail of the scene", () => {
    expect(frameAt(9).transition.mix).toBe(0);
    const mid = frameAt(11.1);
    expect(mid.transition.progress).toBeCloseTo(0.5, 2);
    expect(mid.transition.mix).toBeCloseTo(0.5, 2);
    expect(frameAt(11.4667).transition.mix).toBe(1);
  });

  it("draws a diagram and a full-frame plate when a scene has them", () => {
    const diagramTimeline = buildTimeline(
      manifestFixture([
        sceneFixture({
          id: "scn_diagram",
          type: "DIAGRAM",
          characters: [],
          diagram: {
            kind: "bar_chart",
            title: "Crossings per day",
            annotations: ["peak hour"],
            series: [
              { label: "1973", value: 4000, unit: "" },
              { label: "2024", value: 40000, unit: "" },
            ],
            claimIds: [],
          },
        }),
      ]),
    );
    const frame = composeFrame(diagramTimeline, 0);
    const diagram = frame.elements.find(
      (element): element is DiagramElement => element.kind === "diagram",
    );
    expect(diagram?.series.map((point) => point.value)).toEqual([4000, 40000]);
    expect(diagram?.rect.width).toBeCloseTo(0.6 * 1920, 3);
    expect(frame.elements).toHaveLength(1);

    const mediaTimeline = buildTimeline(
      manifestFixture([
        sceneFixture({
          id: "scn_media",
          type: "ENVIRONMENT",
          characters: [],
          media: {
            kind: "image",
            description: "A wide plate of the harbour.",
            treatment: "background",
            assets: ["asset_plate"],
          },
        }),
      ]),
    );
    const media = composeFrame(mediaTimeline, 0).elements.find(
      (element): element is MediaElement => element.kind === "media",
    );
    expect(media).toMatchObject({
      id: "media:asset_plate",
      treatment: "background",
      z: 5,
      uri: "",
    });
    expect(media?.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});

describe("composing a scene and a video", () => {
  it("samples frames and digests them", () => {
    const all = composeScene(timeline, DEMO_SCENE, { deps: { characters: stage } });
    expect(all.frames).toHaveLength(345);
    expect(all.frames[0]!.index).toBe(0);
    expect(all.frames[344]!.index).toBe(344);
    expect(all.diagnostics).toEqual([]);
    expect(all.assets.length).toBeGreaterThan(10);
    expect(all.assets.every((asset) => asset.hash.length === 64)).toBe(true);

    const sampled = composeScene(timeline, DEMO_SCENE, {
      deps: { characters: stage },
      every: 30,
    });
    expect(sampled.frames).toHaveLength(13);
    expect(sampled.frames[0]!.index).toBe(0);
    expect(sampled.frames[sampled.frames.length - 1]!.index).toBe(344);
    expect(sampled.digest).not.toBe(all.digest);

    const video = composeVideo(timeline, { deps: { characters: stage } });
    expect(video.frameCount).toBe(345);
    expect(video.scenes).toHaveLength(1);
    expect(video.diagnostics).toEqual([]);
  });

  it("is deterministic, and a changed manifest is a changed digest", () => {
    const first = composeScene(timeline, DEMO_SCENE, { deps: { characters: stage }, every: 17 });
    const second = composeScene(timeline, DEMO_SCENE, { deps: { characters: stage }, every: 17 });
    expect(second.digest).toBe(first.digest);
    expect(second.frames).toEqual(first.frames);

    const moved = buildTimeline(
      manifestFixture([sceneFixture({ id: DEMO_SCENE, camera: { movement: "zoom_in" } })]),
    );
    const other = composeScene(moved, DEMO_SCENE, { every: 17 });
    expect(other.digest).not.toBe(first.digest);
  });

  it("reports what it cannot draw instead of throwing", () => {
    const manifest = manifestFixture(
      [
        sceneFixture({
          id: "scn_ghost",
          characters: [
            { characterId: "ghost", state: "idle" },
            { characterId: "maya", state: "talking" },
          ],
          animation: [
            // `text` targets the on-screen text: this scene has none.
            {
              id: "a1",
              atSec: 0.2,
              durationSec: 0.3,
              kind: "type_on",
              target: "text",
              targetId: "",
              params: {},
            },
            // A pose change on a character is fine; the same kind on a diagram is not.
            {
              id: "a2",
              atSec: 0.6,
              durationSec: 0.3,
              kind: "pose_change",
              target: "character",
              targetId: "maya",
              params: { pose: "walk" },
            },
          ],
        }),
      ],
      {
        cast: [
          library.castMember("maya"),
          {
            id: "ghost",
            name: "Ghost",
            role: "character",
            description: "A cast member no definition backs.",
          },
        ],
      },
    );
    const ghostTimeline = buildTimeline(manifest);
    const composed = composeScene(ghostTimeline, "scn_ghost", { deps: { characters: stage } });
    const codes = composed.diagnostics.map((entry) => entry.code).sort();
    expect(codes).toContain("missing_character");
    expect(codes).toContain("unknown_target");
    // The scene still composes: the character the library knows is drawn.
    const frame = composed.frames[0]!;
    expect(frame.elements.filter((element) => element.kind === "character")).toHaveLength(1);
    expect(frame.diagnostics.some((entry) => entry.code === "missing_character")).toBe(true);
  });

  it("reports a kind that cannot animate its target", () => {
    const manifest = manifestFixture([
      sceneFixture({
        characters: [{ characterId: "maya", state: "talking" }],
        animation: [
          {
            id: "a1",
            atSec: 0.2,
            durationSec: 0.3,
            kind: "type_on",
            target: "character",
            targetId: "maya",
            params: {},
          },
        ],
      }),
    ]);
    const composed = composeScene(buildTimeline(manifest), "scn_fixture", {
      deps: { characters: stage },
    });
    const issue = composed.diagnostics.find((entry) => entry.code === "kind_not_applicable");
    expect(issue?.message).toContain("type_on");
  });

  it("reports text that does not fit its box", () => {
    const manifest = manifestFixture([
      sceneFixture({
        characters: [],
        type: "EVIDENCE",
        text: {
          kind: "claim",
          value:
            "A claim card with a great many words in it, far more than two lines of type can hold at any size the card is willing to shrink to.",
          position: "corner",
          maxLines: 1,
        },
      }),
    ]);
    const composed = composeScene(buildTimeline(manifest), "scn_fixture");
    expect(composed.diagnostics.map((entry) => entry.code)).toContain("text_overflow");
  });

  it("notes when a count-up card has no placeholder to fill", () => {
    const manifest = manifestFixture([
      sceneFixture({
        characters: [],
        type: "EVIDENCE",
        text: { kind: "number", value: "forty thousand", position: "center", maxLines: 2 },
        animation: [
          {
            id: "a1",
            atSec: 0.2,
            durationSec: 0.5,
            kind: "count_up",
            target: "text",
            targetId: "",
            params: { to: 40, unit: "k" },
          },
        ],
      }),
    ]);
    const composed = composeScene(buildTimeline(manifest), "scn_fixture");
    expect(composed.diagnostics.map((entry) => entry.code)).toContain("defaulted_parameter");
    const text = composed.frames[composed.frames.length - 1]!.elements.find(
      (element): element is TextElement => element.kind === "text",
    );
    expect(text?.value).toBe("40k");
  });
});

describe("asset resolution", () => {
  it("reads every layer a composition draws, once", () => {
    const composed = composeScene(timeline, DEMO_SCENE, { deps: { characters: stage }, every: 60 });
    const { report, diagnostics } = verifyAssets(composed, stage);
    expect(report.length).toBe(composed.assets.length);
    expect(report.every((entry) => entry.ok)).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("reports a layer with no readable file behind it", () => {
    const blind: CharacterStage = { ...stage, read: () => undefined };
    const composed = composeScene(timeline, DEMO_SCENE, { deps: { characters: stage }, every: 60 });
    const { report, diagnostics } = verifyAssets(composed, blind);
    expect(report.every((entry) => !entry.ok)).toBe(true);
    expect(diagnostics).toHaveLength(report.length);
    expect(diagnostics[0]!.code).toBe("missing_asset");
    expect(diagnostics[0]!.severity).toBe("error");
    expect(verifyAssets(composed, undefined).diagnostics.length).toBe(report.length);
  });

  it("carries the character system's own checks through to the frame", () => {
    const composed = composeScene(timeline, DEMO_SCENE, { deps: { characters: stage }, every: 60 });
    const drawn = new Set(composed.assets.map((asset) => `${asset.assetId}:${asset.hash}`));
    const defined = new Set(
      library
        .list()
        .flatMap((definition) =>
          definition.character.assets.map((asset) => `${asset.id}:${asset.hash}`),
        ),
    );
    for (const entry of drawn) expect(defined.has(entry)).toBe(true);
    expect(library.verifyAssets().every((entry) => entry.checks.every((check) => check.ok))).toBe(
      true,
    );
  });
});
