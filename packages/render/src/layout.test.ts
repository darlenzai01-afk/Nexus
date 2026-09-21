import { describe, expect, it } from "vitest";

import {
  DEPTH_BACK,
  DEPTH_Z,
  GROUND_Y,
  SHOT_FIGURE_HEIGHT,
  blockScene,
  centreFor,
  presenterCentre,
} from "./layout.js";
import { sceneFixture } from "./fixtures.js";

const RESOLUTION = { width: 1920, height: 1080 };

describe("blocking", () => {
  it("stands a lone presenter in the middle of the frame", () => {
    const blocking = blockScene(sceneFixture({ type: "CHARACTER" }), RESOLUTION);
    expect(blocking).toHaveLength(1);
    const only = blocking[0]!;
    expect(only.characterId).toBe("maya");
    expect(only.position.x).toBe(960);
    expect(only.position.y).toBeCloseTo(1080 * GROUND_Y, 3);
    expect(only.depth).toBe("front");
    expect(only.z).toBe(DEPTH_Z.front);
    expect(only.heightPx).toBeCloseTo(1080 * SHOT_FIGURE_HEIGHT.medium, 3);
  });

  it("puts the presenting character in front and the listener behind", () => {
    const blocking = blockScene(
      sceneFixture({
        characters: [
          { characterId: "maya", state: "talking" },
          { characterId: "tomas", state: "listening" },
        ],
      }),
      RESOLUTION,
    );
    const [maya, tomas] = blocking;
    expect(maya?.depth).toBe("front");
    expect(tomas?.depth).toBe("back");
    expect(maya?.position.x).toBe(round(1920 * 0.34));
    expect(tomas?.position.x).toBe(round(1920 * 0.66));
    expect(tomas?.heightPx).toBe(round((maya?.heightPx ?? 0) * DEPTH_BACK.scaleFactor));
    expect(tomas?.position.y).toBe(round(maya!.position.y - DEPTH_BACK.liftY * -1080));
    expect(maya!.z).toBeGreaterThan(tomas!.z);

    // The first character presents when nobody is talking.
    const silent = blockScene(
      sceneFixture({
        characters: [
          { characterId: "maya", state: "idle" },
          { characterId: "tomas", state: "idle" },
        ],
      }),
      RESOLUTION,
    );
    expect(silent[0]?.depth).toBe("front");
  });

  it("spreads three characters across the frame", () => {
    expect(centreFor(0, 3)).toBe(0.22);
    expect(centreFor(1, 3)).toBe(0.5);
    expect(centreFor(2, 3)).toBe(0.78);
    expect(centreFor(0, 5)).toBe(0.16);
    expect(centreFor(4, 5)).toBeCloseTo(0.84, 3);
    const blocking = blockScene(
      sceneFixture({
        characters: [
          { characterId: "a", state: "talking" },
          { characterId: "b", state: "listening" },
          { characterId: "c", state: "listening" },
        ],
      }),
      RESOLUTION,
    );
    expect(blocking.map((entry) => entry.position.x)).toEqual([
      round(1920 * 0.22),
      round(1920 * 0.5),
      round(1920 * 0.78),
    ]);
  });

  it("scales the figure with the shot", () => {
    const wide = blockScene(sceneFixture({ camera: { shot: "wide" } }), RESOLUTION)[0]!;
    const close = blockScene(sceneFixture({ camera: { shot: "close_up" } }), RESOLUTION)[0]!;
    const extreme = blockScene(
      sceneFixture({ camera: { shot: "extreme_close_up" } }),
      RESOLUTION,
    )[0]!;
    expect(wide.heightPx).toBeLessThan(close.heightPx);
    expect(close.heightPx).toBeLessThan(extreme.heightPx);
    expect(close.heightPx).toBeCloseTo(1080 * SHOT_FIGURE_HEIGHT.close_up, 3);
  });

  it("blocks nothing when the scene shows nobody, and reports the presenter", () => {
    const empty = blockScene(sceneFixture({ type: "TRANSITION", characters: [] }), RESOLUTION);
    expect(empty).toEqual([]);
    expect(presenterCentre(empty, RESOLUTION)).toBeUndefined();
    const blocking = blockScene(
      sceneFixture({
        characters: [
          { characterId: "maya", state: "talking" },
          { characterId: "tomas", state: "listening" },
        ],
      }),
      RESOLUTION,
    );
    expect(presenterCentre(blocking, RESOLUTION)).toBeCloseTo(0.34, 3);
  });
});

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
