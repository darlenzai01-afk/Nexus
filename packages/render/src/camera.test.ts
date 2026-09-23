import { describe, expect, it } from "vitest";

import { applyCamera, cameraStateAt, focusPoint, type CameraInput } from "./camera.js";
import { sceneFixture } from "./fixtures.js";

const RESOLUTION = { width: 1920, height: 1080 };

function input(options: Parameters<typeof sceneFixture>[0], presenterX?: number): CameraInput {
  return {
    scene: sceneFixture({ durationSec: 8, ...options }),
    resolution: RESOLUTION,
    presenterX,
    textCentreY: 0.8,
  };
}

describe("camera", () => {
  it("holds still when the scene asks it to", () => {
    const camera = input(
      { camera: { movement: "static", focus: "presenter", angle: "eye_level" } },
      0.34,
    );
    expect(cameraStateAt(camera, 0)).toMatchObject({
      scale: 1,
      aim: { x: 0.34, y: 0.55 },
      rotationDeg: 0,
    });
    expect(cameraStateAt(camera, 4)).toEqual(cameraStateAt(camera, 8));
  });

  it("ramps a dolly in from the authored framing to its end scale", () => {
    const camera = input({ camera: { movement: "dolly_in", focus: "presenter" } }, 0.5);
    expect(cameraStateAt(camera, 0).scale).toBe(1);
    expect(cameraStateAt(camera, 4).scale).toBeCloseTo(1.04, 3);
    expect(cameraStateAt(camera, 8).scale).toBeCloseTo(1.08, 3);
    // A dolly also rises slightly as it closes, and stops when it is done.
    expect(cameraStateAt(camera, 8).aim.y).toBeGreaterThan(cameraStateAt(camera, 0).aim.y);
    expect(cameraStateAt(camera, 8)).toEqual(cameraStateAt(camera, 12));
  });

  it("pans across the aim and back to a mirrored end", () => {
    const camera = input({ camera: { movement: "pan_right", focus: "presenter" } }, 0.5);
    expect(cameraStateAt(camera, 0).aim.x).toBe(0.46);
    expect(cameraStateAt(camera, 4).aim.x).toBe(0.5);
    expect(cameraStateAt(camera, 8).aim.x).toBe(0.54);

    const left = input({ camera: { movement: "pan_left", focus: "presenter" } }, 0.5);
    expect(cameraStateAt(left, 0).aim.x).toBe(0.54);
    expect(cameraStateAt(left, 8).aim.x).toBe(0.46);
  });

  it("breathes deterministically when handheld", () => {
    const camera = input({ camera: { movement: "handheld", focus: "presenter" } }, 0.5);
    const first = cameraStateAt(camera, 2.5);
    const second = cameraStateAt(camera, 2.5);
    expect(first).toEqual(second);
    expect(Math.abs(first.aim.x - 0.5)).toBeLessThan(0.01);
    expect(first.aim).not.toEqual(cameraStateAt(camera, 3).aim);
  });

  it("tilts the frame for a dutch angle and lifts it for a low one", () => {
    const dutch = input({ camera: { angle: "dutch", movement: "static" } });
    expect(cameraStateAt(dutch, 1).rotationDeg).toBe(3);
    const low = input({ camera: { angle: "low", movement: "static" } });
    const eye = input({ camera: { angle: "eye_level", movement: "static" } });
    expect(cameraStateAt(low, 0).aim.y).toBeGreaterThan(cameraStateAt(eye, 0).aim.y);
  });

  it("aims at whatever the scene's focus names", () => {
    const presenter = input({ camera: { focus: "presenter", movement: "static" } }, 0.2);
    expect(focusPoint(presenter).aim.x).toBe(0.2);

    const screen = input({ camera: { focus: "screen", movement: "static" } }, 0.2);
    expect(screen.textCentreY).toBe(0.8);
    expect(focusPoint(screen).aim).toMatchObject({ x: 0.5, y: 0.8 });

    const background = input({ camera: { focus: "background", movement: "static" } }, 0.2);
    expect(focusPoint(background).scale).toBeCloseTo(0.96, 3);
    expect(focusPoint(background).aim.y).toBeCloseTo(0.46, 3);

    const diagram = input({ camera: { focus: "diagram", movement: "static" } }, 0.2);
    expect(focusPoint(diagram).scale).toBeCloseTo(1.04, 3);
  });

  it("moves the frame, not the elements, when it applies the camera", () => {
    const camera = {
      shot: "medium" as const,
      movement: "static" as const,
      angle: "eye_level" as const,
      focus: "presenter" as const,
      scale: 2,
      aim: { x: 0.5, y: 0.5 },
      rotationDeg: 0,
    };
    const moved = applyCamera(
      { x: 1200, y: 500, scale: 0.5, rotationDeg: 0, origin: { x: 0.5, y: 1 } },
      camera,
      RESOLUTION,
    );
    // (1200 - 960) * 2 + 960 = 1440 and (500 - 540) * 2 + 540 = 460: the frame
    // moves around the element, and the element's own scale doubles with it.
    expect(moved.x).toBe(1440);
    expect(moved.y).toBe(460);
    expect(moved.scale).toBe(1);
    expect(moved.origin).toEqual({ x: 0.5, y: 1 });
  });
});
