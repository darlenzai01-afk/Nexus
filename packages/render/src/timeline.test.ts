import { describe, expect, it } from "vitest";

import {
  buildTimeline,
  framesOfScene,
  sceneTimelineAt,
  sceneTimelineForFrame,
  transitionAt,
} from "./timeline.js";
import { manifestFixture, timelineFixture } from "./fixtures.js";
import { sceneFixture } from "./fixtures.js";

describe("timeline", () => {
  it("indexes a manifest into frames", () => {
    const manifest = manifestFixture([
      sceneFixture({ id: "scn_a", index: 0, startSec: 0, durationSec: 4 }),
      sceneFixture({ id: "scn_b", index: 1, startSec: 4, durationSec: 2 }),
    ]);
    const timeline = buildTimeline(manifest);
    expect(timeline.fps).toBe(30);
    expect(timeline.resolution).toEqual({ width: 1920, height: 1080 });
    expect(timeline.durationSec).toBe(6);
    expect(timeline.frameCount).toBe(180);
    expect(timeline.scenes.map((scene) => [scene.startFrame, scene.endFrame])).toEqual([
      [0, 119],
      [120, 179],
    ]);
  });

  it("partitions frames without gaps or overlaps", () => {
    const timeline = buildTimeline(
      manifestFixture([
        sceneFixture({ id: "scn_a", index: 0, startSec: 0, durationSec: 1.3 }),
        sceneFixture({ id: "scn_b", index: 1, startSec: 1.3, durationSec: 0.7 }),
      ]),
    );
    const seen: number[] = [];
    for (const scene of timeline.scenes) seen.push(...framesOfScene(timeline, scene));
    expect(seen).toHaveLength(timeline.frameCount);
    expect(new Set(seen).size).toBe(timeline.frameCount);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(timeline.frameCount - 1);
  });

  it("finds the scene for a frame and for a time, and clamps past the end", () => {
    const timeline = buildTimeline(
      manifestFixture([
        sceneFixture({ id: "scn_a", index: 0, startSec: 0, durationSec: 4 }),
        sceneFixture({ id: "scn_b", index: 1, startSec: 4, durationSec: 2 }),
      ]),
    );
    expect(sceneTimelineForFrame(timeline, 0).scene.id).toBe("scn_a");
    expect(sceneTimelineForFrame(timeline, 119).scene.id).toBe("scn_a");
    expect(sceneTimelineForFrame(timeline, 120).scene.id).toBe("scn_b");
    expect(sceneTimelineForFrame(timeline, 179).scene.id).toBe("scn_b");
    expect(sceneTimelineAt(timeline, 3.9).scene.id).toBe("scn_a");
    expect(sceneTimelineAt(timeline, 4).scene.id).toBe("scn_b");
    expect(sceneTimelineAt(timeline, 999).scene.id).toBe("scn_b");
  });

  it("has no seam on a cut, and a full ramp on a fade", () => {
    const cut = buildTimeline(timelineFixture({ transition: { kind: "cut", durationSec: 0 } }));
    const cutScene = cut.scenes[0]!;
    expect(cutScene.scene.transition.toSceneId).toBe("");
    expect(transitionAt(cutScene, 0)).toMatchObject({ kind: "cut", progress: 0, mix: 0 });
    expect(transitionAt(cutScene, 3.5)).toMatchObject({ progress: 0, mix: 0 });

    const fade = buildTimeline(
      manifestFixture([
        sceneFixture({
          id: "scn_a",
          index: 0,
          durationSec: 4,
          transition: { kind: "fade_to_black", durationSec: 1 },
        }),
        sceneFixture({ id: "scn_b", index: 1, startSec: 4, durationSec: 2 }),
      ]),
    );
    const scene = fade.scenes[0]!;
    expect(transitionAt(scene, 2.9)).toMatchObject({ progress: 0, mix: 0 });
    expect(transitionAt(scene, 3)).toMatchObject({ progress: 0, mix: 0 });
    expect(transitionAt(scene, 3.5)).toMatchObject({ progress: 0.5, mix: 0.5 });
    expect(transitionAt(scene, 4)).toMatchObject({ progress: 1, mix: 1 });
    expect(transitionAt(scene, 3.5).toSceneId).toBe("scn_b");
    expect(transitionAt(scene, 3.5).durationSec).toBe(1);
  });

  it("keeps the scene's own event order", () => {
    const timeline = buildTimeline(
      timelineFixture({
        animation: [
          {
            id: "a1",
            atSec: 0.2,
            durationSec: 0.3,
            kind: "fade_in",
            target: "scene",
            targetId: "",
            params: {},
          },
          {
            id: "a2",
            atSec: 0.6,
            durationSec: 0.3,
            kind: "pulse",
            target: "text",
            targetId: "",
            params: { amount: 0.05 },
          },
        ],
      }),
    );
    expect(timeline.scenes[0]!.events.map((event) => event.id)).toEqual(["a1", "a2"]);
  });
});
