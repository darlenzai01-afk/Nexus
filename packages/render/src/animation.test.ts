import { describe, expect, it } from "vitest";

import type { SceneAnimationEvent, SceneAnimationKind } from "@nexus/scenes";

import {
  IDENTITY_ANIM,
  SCENE_EVENT_TARGET,
  TEXT_ONLY_KINDS,
  activeEvents,
  appliesTo,
  effectElementId,
  elementIdForEvent,
  foldAnimation,
  foldSceneAnimation,
  hasStarted,
  overridesAt,
} from "./animation.js";
import { EASINGS } from "./easing.js";

const RESOLUTION = { width: 1920, height: 1080 };
const AT = 1;
const DURATION = 2;

function event(
  kind: SceneAnimationKind,
  params: SceneAnimationEvent["params"] = {},
  overrides: Partial<SceneAnimationEvent> = {},
): SceneAnimationEvent {
  return {
    id: "a1",
    atSec: AT,
    durationSec: DURATION,
    kind,
    target: "text",
    targetId: "",
    params,
    ...overrides,
  };
}

/** The fold at the start of the event, its midpoint, and long after it finished. */
function fold(events: readonly SceneAnimationEvent[], elementId = "text") {
  return {
    before: foldAnimation(events, AT, elementId, RESOLUTION),
    mid: foldAnimation(events, AT + DURATION / 2, elementId, RESOLUTION),
    after: foldAnimation(events, AT + DURATION * 4, elementId, RESOLUTION),
  };
}

describe("the animation fold", () => {
  it("carries an identity state when nothing applies", () => {
    expect(foldAnimation([], 3, "text", RESOLUTION)).toEqual(IDENTITY_ANIM);
    expect(foldAnimation([event("fade_in")], 3, "char:maya", RESOLUTION)).toEqual(IDENTITY_ANIM);
  });

  it("fades in and out, and stays there", () => {
    const fadeIn = fold([event("fade_in")]);
    expect(fadeIn.before.opacity).toBe(0);
    expect(fadeIn.mid.opacity).toBeCloseTo(EASINGS.easeOut(0.5), 3);
    expect(fadeIn.after.opacity).toBe(1);

    for (const kind of ["fade_out", "dissolve_out"] as const) {
      const fadeOut = fold([event(kind)]);
      expect(fadeOut.before.opacity).toBe(1);
      expect(fadeOut.after.opacity).toBe(0);
      expect(fadeOut.mid.opacity).toBeLessThan(1);
    }
  });

  it("slides in from a named edge and out to one", () => {
    const fromBottom = fold([event("slide_in")]);
    expect(fromBottom.before.offsetY).toBe(0.25 * RESOLUTION.height);
    expect(fromBottom.after.offsetY).toBe(0);
    const fromLeft = fold([event("slide_in", { from: "left" })]);
    expect(fromLeft.before).toMatchObject({ offsetX: -0.25 * RESOLUTION.width, offsetY: 0 });
    const out = fold([event("slide_out", { from: "right", distance: 100 })]);
    expect(out.before.offsetX).toBe(0);
    expect(out.after.offsetX).toBe(100);
  });

  it("scales in, pushes in and zooms to a named scale", () => {
    const scaleIn = fold([event("scale_in")]);
    expect(scaleIn.before.scale).toBeCloseTo(0.55, 3);
    expect(scaleIn.after.scale).toBe(1);
    expect(scaleIn.mid.scale).toBeGreaterThan(0.55);

    const push = fold([event("push_in")]);
    expect(push.before.scale).toBeCloseTo(0.85, 3);
    expect(push.before.offsetY).toBeCloseTo(0.05 * RESOLUTION.height, 3);
    expect(push.after).toMatchObject({ scale: 1, offsetY: 0 });

    const zoom = fold([event("zoom_to", { scale: 1.5 })]);
    expect(zoom.before.scale).toBe(1);
    expect(zoom.mid.scale).toBeCloseTo(1.25, 3);
    expect(zoom.after.scale).toBe(1.5);
  });

  it("wipes, splits, pulses and rotates", () => {
    expect(fold([event("wipe_in")]).before.reveal).toEqual({ mode: "wipe", amount: 0 });
    expect(fold([event("wipe_in")]).after.reveal).toEqual({ mode: "wipe", amount: 1 });
    expect(fold([event("split_open")]).mid.reveal.mode).toBe("split");

    const pulse = fold([event("pulse", { amount: 0.1 })]);
    expect(pulse.before.scale).toBe(1);
    expect(pulse.mid.scale).toBeCloseTo(1.1, 3);
    expect(pulse.after.scale).toBe(1);

    const rotate = fold([event("rotate", { from: -4, to: 0 })]);
    expect(rotate.before.rotationDeg).toBe(-4);
    expect(rotate.mid.rotationDeg).toBeCloseTo(-2, 3);
    expect(rotate.after.rotationDeg).toBe(0);
    expect(fold([event("rotate", { to: 5 })]).after.rotationDeg).toBe(5);
  });

  it("carries type-on, count-up and highlight progress", () => {
    expect(fold([event("type_on")]).before.typeOn).toBe(0);
    expect(fold([event("type_on")]).mid.typeOn).toBe(0.5);
    expect(fold([event("type_on")]).after.typeOn).toBe(1);
    expect(fold([event("count_up")]).after.countUp).toBe(1);
    expect(fold([event("fade_in")]).before.typeOn).toBeNull();
    expect(fold([event("highlight")]).before.highlight).toBe(0);
    expect(fold([event("highlight")]).after.highlight).toBe(1);
  });

  it("lifts a lower third in and leaves the callout to its own card", () => {
    const lower = fold([event("lower_third")]);
    expect(lower.before.opacity).toBe(0);
    expect(lower.before.offsetY).toBeCloseTo(0.1 * RESOLUTION.height, 3);
    expect(lower.after).toMatchObject({ opacity: 1, offsetY: 0 });

    // A callout does not move the text it belongs to: it draws a card behind it.
    expect(fold([event("callout")]).after).toEqual(IDENTITY_ANIM);
    const card = fold([event("callout")], effectElementId(event("callout")));
    expect(card.before.opacity).toBe(0);
    expect(card.before.scale).toBeCloseTo(0.92, 3);
    expect(card.after).toMatchObject({ opacity: 1, scale: 1 });
  });

  it("leaves the performance kinds to the character system", () => {
    const pose = event("pose_change", { pose: "walk" }, { target: "character", targetId: "maya" });
    expect(fold([pose], "char:maya").after).toEqual(IDENTITY_ANIM);
    const expression = event(
      "expression_change",
      { expression: "surprised" },
      { target: "character", targetId: "tomas" },
    );
    expect(fold([expression], "char:tomas").after).toEqual(IDENTITY_ANIM);
  });

  it("folds several events into one state, in order", () => {
    const state = fold([
      event("fade_in"),
      event("pulse", { amount: 0.2 }, { id: "a2", atSec: AT + 1 }),
      event("rotate", { to: 6 }, { id: "a3", atSec: AT + 1 }),
    ]).after;
    expect(state.opacity).toBe(1);
    expect(state.scale).toBe(1);
    expect(state.rotationDeg).toBe(6);
  });

  it("keeps scene events out of the per-element fold", () => {
    const onScene = event("fade_in", {}, { target: "scene", targetId: "" });
    expect(foldAnimation([onScene], AT, "text", RESOLUTION).opacity).toBe(1);
    expect(foldSceneAnimation([onScene], AT, RESOLUTION).opacity).toBe(0);
    expect(foldSceneAnimation([onScene], AT + DURATION * 4, RESOLUTION).opacity).toBe(1);
    expect(foldSceneAnimation([event("fade_in")], AT, RESOLUTION).opacity).toBe(1);
  });

  it("maps events to the elements they animate", () => {
    expect(elementIdForEvent(event("fade_in", {}, { target: "scene" }))).toBe(SCENE_EVENT_TARGET);
    expect(elementIdForEvent(event("fade_in", {}, { target: "character", targetId: "maya" }))).toBe(
      "char:maya",
    );
    expect(elementIdForEvent(event("fade_in", {}, { target: "text" }))).toBe("text");
    expect(elementIdForEvent(event("fade_in", {}, { target: "diagram" }))).toBe("diagram");
    expect(elementIdForEvent(event("wipe_in", {}, { target: "media", targetId: "plate" }))).toBe(
      "media:plate",
    );
    expect(effectElementId(event("callout"))).toBe("fx:a1");
  });

  it("knows which kinds belong to which elements, and what has started", () => {
    for (const kind of TEXT_ONLY_KINDS) {
      expect(appliesTo(kind, "text")).toBe(true);
      expect(appliesTo(kind, "character")).toBe(false);
    }
    expect(appliesTo("pose_change", "character")).toBe(true);
    expect(appliesTo("pose_change", "text")).toBe(false);
    expect(appliesTo("fade_in", "diagram")).toBe(true);

    const events = [event("fade_in"), event("pulse", {}, { id: "b1", atSec: 5 })];
    expect(activeEvents(events, 2, "text").map((entry) => entry.id)).toEqual(["a1"]);
    expect(hasStarted(events[1]!, 4.9)).toBe(false);
    expect(hasStarted(events[1]!, 5)).toBe(true);
  });

  it("takes the performance a character is in from the last event that started", () => {
    const events: SceneAnimationEvent[] = [
      event(
        "pose_change",
        { pose: "talk" },
        { id: "p1", atSec: 1, target: "character", targetId: "maya" },
      ),
      event(
        "expression_change",
        { expression: "engaged" },
        { id: "e1", atSec: 2, target: "character", targetId: "maya" },
      ),
      event(
        "pose_change",
        { pose: "walk" },
        { id: "p2", atSec: 4, target: "character", targetId: "maya" },
      ),
      event(
        "pose_change",
        { pose: "run" },
        { id: "p3", atSec: 6, target: "character", targetId: "tomas" },
      ),
    ];
    expect(overridesAt(events, 0, "maya")).toEqual({});
    expect(overridesAt(events, 1, "maya")).toEqual({ pose: "talk" });
    expect(overridesAt(events, 3, "maya")).toEqual({ pose: "talk", expression: "engaged" });
    expect(overridesAt(events, 5, "maya")).toEqual({ pose: "walk", expression: "engaged" });
    expect(overridesAt(events, 5, "tomas")).toEqual({});
    expect(overridesAt(events, 7, "tomas")).toEqual({ pose: "run" });
  });
});
