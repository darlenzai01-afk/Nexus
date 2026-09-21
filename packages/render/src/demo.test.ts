import { CharacterLibrary } from "@nexus/characters";
import { validateSceneManifest } from "@nexus/scenes";
import { beforeAll, describe, expect, it } from "vitest";

import { composeScene, composeVideo, verifyAssets, type ComposedScene } from "./compose.js";
import { loadDemoScene } from "./demo.js";
import { frameToSvg, storyboardSvg } from "./svg.js";
import { createCharacterStage, type CharacterStage } from "./performance.js";
import { buildTimeline, type Timeline } from "./timeline.js";
import type { CharacterElement, TextElement } from "./types.js";

/**
 * The Phase 9 smoke test: **manifest → asset resolution → animation events →
 * composited scene**, run over the one demonstration scene the package ships.
 *
 * It is deliberately an end-to-end test rather than a unit test: it loads the
 * scene from its JSON file, validates it on its own *and* against the real
 * character library, composes every frame of it (all 345), reads every character
 * layer it drew back off disk through the character system's hash checks, and
 * writes the result as SVG. Nothing here touches the network, a provider, a
 * database or a rasteriser.
 */

const SCENE_ID = "scn_demo_composite";

let library: CharacterLibrary;
let stage: CharacterStage;
let timeline: Timeline;
let composed: ComposedScene;

beforeAll(() => {
  library = CharacterLibrary.load();
  stage = createCharacterStage(library);
  timeline = buildTimeline(loadDemoScene());
  composed = composeScene(timeline, SCENE_ID, { deps: { characters: stage } });
});

const frameAt = (timeSec: number) => composed.frames[Math.round(timeSec * composed.fps)]!;
const charactersOf = (timeSec: number): CharacterElement[] =>
  frameAt(timeSec).elements.filter(
    (element): element is CharacterElement => element.kind === "character",
  );
const textOf = (timeSec: number): TextElement => {
  const text = frameAt(timeSec).elements.find(
    (element): element is TextElement => element.kind === "text",
  );
  if (text === undefined) throw new Error("the demonstration scene has no text card");
  return text;
};

describe("the demonstration scene, end to end", () => {
  it("step 1 — the manifest is valid on its own, and against the real character library", () => {
    const alone = validateSceneManifest(loadDemoScene());
    expect(alone.ok).toBe(true);
    expect(alone.issues).toEqual([]);
    expect(alone.stats).toMatchObject({ scenes: 1, assets: 1, words: 26, totalDurationSec: 11.5 });

    const againstLibrary = validateSceneManifest(loadDemoScene(), { characters: library });
    expect(againstLibrary.ok).toBe(true);
    expect(againstLibrary.issues).toEqual([]);
    // Both cast members are on screen, and both references match the library.
    for (const member of loadDemoScene().cast) {
      expect(member.definition).toEqual(library.ref(member.id));
    }
  });

  it("step 2 — the library resolves every layer of it, with hashes that check out", () => {
    const verification = library.verifyAssets();
    expect(verification.map((entry) => entry.characterId)).toEqual(library.ids());
    const checks = verification.flatMap((entry) => entry.checks);
    expect(checks.length).toBeGreaterThanOrEqual(38);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.every((check) => check.expected.hash === check.actual?.hash)).toBe(true);
  });

  it("step 3 — the timeline covers the scene in whole frames", () => {
    expect(timeline.fps).toBe(30);
    expect(timeline.frameCount).toBe(345);
    expect(timeline.durationSec).toBe(11.5);
    expect(timeline.scenes).toHaveLength(1);
    expect(timeline.scenes[0]!.events).toHaveLength(12);
    expect(composed.frames).toHaveLength(timeline.frameCount);
    expect(composed.frames[0]!.index).toBe(0);
    expect(composed.frames[344]!.index).toBe(344);
    expect(composed.frames[344]!.timeSec).toBeCloseTo(11.467, 3);
  });

  it("step 4 — every frame composes with no error diagnostics", () => {
    expect(composed.diagnostics).toEqual([]);
    for (const frame of composed.frames) {
      expect(frame.diagnostics).toEqual([]);
      expect(frame.sceneId).toBe(SCENE_ID);
      expect(frame.resolution).toEqual({ width: 1920, height: 1080 });
      // Two presenters, one card, one plate, one callout card: every frame.
      expect(frame.elements.map((element) => element.kind)).toEqual([
        "character",
        "character",
        "effect",
        "media",
        "text",
      ]);
    }
  });

  it("step 5 — the performance comes from the character system, layer by layer", () => {
    const assets = new Map(
      library
        .list()
        .flatMap((definition) => definition.character.assets)
        .map((asset) => [asset.id, asset]),
    );
    const drawn = new Set<string>();
    for (const time of [0.05, 1.5, 3, 5, 7, 9, 11]) {
      for (const character of charactersOf(time)) {
        expect(character.layers.length).toBeGreaterThanOrEqual(5);
        expect(character.layers.map((layer) => layer.drawIndex)).toEqual(
          character.layers.map((_layer, index) => index),
        );
        for (const layer of character.layers) {
          const asset = assets.get(layer.assetId);
          expect(asset?.path).toBe(layer.path);
          expect(asset?.hash).toBe(layer.hash);
          drawn.add(layer.path);
        }
      }
    }
    expect(drawn.size).toBeGreaterThanOrEqual(10);
    expect(composed.assets.map((asset) => asset.path).sort()).toEqual([...drawn].sort());
  });

  it("step 6 — every layer the composition drew is readable and hash-checked", () => {
    const { report, diagnostics } = verifyAssets(composed, stage);
    expect(diagnostics).toEqual([]);
    expect(report).toHaveLength(composed.assets.length);
    expect(report.every((entry) => entry.ok)).toBe(true);
    for (const asset of composed.assets) {
      const bytes = stage.read(asset.path);
      expect(bytes?.startsWith("<svg")).toBe(true);
    }
  });

  it("step 7 — the animation events are visible in the frames", () => {
    // opacity — a scene-wide fade in.
    expect(charactersOf(0)[1]?.opacity).toBe(0);
    expect(charactersOf(0.7)[1]?.opacity).toBe(1);

    // position — a slide in from the left, over the wait the blocking put it at.
    const slideEarly = charactersOf(0.3)[1]!.transform.x;
    const slideLate = charactersOf(1.2)[1]!.transform.x;
    expect(slideEarly).toBeLessThan(slideLate);

    // scale — a pulse on the card, and the camera's dolly.
    expect(frameAt(5.9).camera.scale).toBeGreaterThan(frameAt(0).camera.scale);
    expect(textOf(5.9).transform.scale).toBeGreaterThan(textOf(6.4).transform.scale);

    // rotation — a card that settles level.
    expect(textOf(7.4).transform.rotationDeg).toBe(-1.6);
    expect(textOf(8.1).transform.rotationDeg).toBe(0);

    // character pose — a `pose_change` event switches the performance.
    expect(charactersOf(4.7)[1]?.pose).toBe("talk");
    expect(charactersOf(4.9)[1]?.pose).toBe("walk");
    expect(charactersOf(4.9)[1]?.layers.some((layer) => layer.path.includes("walk"))).toBe(true);

    // character expression — and so does an `expression_change`.
    expect(charactersOf(6.3)[0]?.expression).toBe("engaged");
    expect(charactersOf(6.5)[0]?.expression).toBe("surprised");

    // text — typed on, counted up, and wrapped into the box.
    expect(textOf(1.1).revealChars).toBe(0);
    expect(textOf(1.7).revealChars).toBeGreaterThan(0);
    expect(Number(textOf(3).value.split(" ")[0])).toBeCloseTo(345 * 0.7, 0);
    expect(textOf(4).value).toBe("345 frames composited from one manifest");
    expect(textOf(4).lines).toHaveLength(2);

    // camera movement — a dolly in that ends tighter, aimed at the presenter.
    expect(frameAt(0).camera).toMatchObject({ movement: "dolly_in", shot: "medium_close" });
    expect(frameAt(0).camera.aim.x).toBeCloseTo(0.34, 2);
    expect(frameAt(11.4).camera.scale).toBeCloseTo(1.08, 2);

    // transition — the seam ramps over the last 0.8s of the scene.
    expect(frameAt(10.6).transition.mix).toBe(0);
    expect(frameAt(11.1).transition.mix).toBeCloseTo(0.5, 2);
    expect(frameAt(11.466).transition.mix).toBe(1);
  });

  it("step 8 — the composed frames write to SVG, byte for byte reproducibly", () => {
    const sample = [0, 90, 180, 270, 344];
    for (const index of sample) {
      const first = frameToSvg(composed.frames[index]!, { read: (path) => stage.read(path) });
      const second = frameToSvg(composed.frames[index]!, { read: (path) => stage.read(path) });
      expect(first.svg).toBe(second.svg);
      expect(first.diagnostics).toEqual([]);
      expect(first.svg).toContain('viewBox="0 0 1920 1080"');
    }
    const sheet = storyboardSvg(
      [0, 30, 60, 90, 120, 180, 240, 300, 330, 340, 344].map((index) => composed.frames[index]!),
      { read: (path) => stage.read(path) },
    );
    expect(sheet.diagnostics).toEqual([]);
    expect(sheet.bytes).toBeGreaterThan(10_000);
    expect(sheet.svg).toContain("fade_to_black");
  });

  it("step 9 — the whole chain is reproducible: one manifest, one digest", () => {
    const again = composeScene(buildTimeline(loadDemoScene()), SCENE_ID, {
      deps: { characters: createCharacterStage(CharacterLibrary.load()) },
    });
    expect(again.digest).toBe(composed.digest);
    expect(again.frames).toEqual(composed.frames);
    expect(composed.digest).toMatch(/^[0-9a-f]{64}$/u);

    const video = composeVideo(timeline, { deps: { characters: stage }, every: 30 });
    expect(video.diagnostics).toEqual([]);
    expect(video.assets.length).toBe(composed.assets.length);
    expect(video.digest).not.toBe(composed.digest);
    expect(video.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
