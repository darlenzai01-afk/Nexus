import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CharacterLibrary,
  UnknownCharacterPartError,
  characterHash,
  demoRoot,
  parseCharacter,
  resolveCharacter,
  type Character,
  type ResolvedLayer,
} from "./index.js";
import { mayaDocument } from "./fixtures.js";

/**
 * Pos, expression and layer resolution: a character plus what a scene asks for
 * becomes an ordered stack of layers, one per painted region, with every default
 * filled in and every unknown id refused by name.
 */

const library = CharacterLibrary.load();
const maya = library.require("maya");
const mayaHash = library.hashOf("maya");

const paintsOf = (layers: readonly ResolvedLayer[]): string[] =>
  layers.map((layer) => layer.assetId);

describe("resolveCharacter", () => {
  it("draws the definition's default performance when the scene asks for nothing", () => {
    const resolved = resolveCharacter(maya);
    expect(resolved.selection).toEqual({
      pose: "stand",
      expression: "neutral",
      gesture: "open_palms",
      clothing: ["studio"],
      accessories: ["studio_badge"],
    });
    expect(paintsOf(resolved.layers)).toEqual([
      "maya_plate",
      "maya_pose_stand_body",
      "maya_cloth_studio",
      "maya_expr_neutral",
      "maya_acc_studio_badge",
      "maya_gesture_open_palms_arms",
      "maya_gesture_open_palms_prop",
    ]);
    expect(resolved.layers.map((layer) => layer.drawIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(resolved.placement).toEqual({
      canvas: { width: 512, height: 1024 },
      anchor: { x: 0.5, y: 1 },
      facing: "front",
      scale: 1,
    });
    expect(resolved.characterId).toBe("maya");
    expect(resolved.hash).toBe(mayaHash);
    expect(resolved.name).toBe("Maya Okonkwo");
    expect(resolved.role).toBe("host");
  });

  it("lets a gesture replace the pose's arms instead of stacking four of them", () => {
    const withGesture = resolveCharacter(maya);
    const withoutGesture = resolveCharacter(maya, { gesture: "" });
    expect(withoutGesture.selection.gesture).toBe("");
    expect(paintsOf(withoutGesture.layers)).toContain("maya_pose_stand_arms");
    expect(paintsOf(withGesture.layers)).not.toContain("maya_pose_stand_arms");

    // One layer per region, whatever the performance.
    for (const resolved of [withGesture, withoutGesture]) {
      const byPaint = new Map<string, number>();
      for (const layer of resolved.layers) {
        byPaint.set(layer.assetId, (byPaint.get(layer.assetId) ?? 0) + 1);
      }
      expect([...byPaint.values()].every((count) => count === 1)).toBe(true);
      expect(resolved.assets.length).toBe(new Set(resolved.assets.map((a) => a.assetId)).size);
    }
  });

  it("resolves a pose, expression and outfit chosen by the scene", () => {
    const resolved = resolveCharacter(maya, {
      pose: "walk",
      expression: "surprised",
      gesture: "point",
      clothing: ["field"],
      accessories: ["field_bag"],
      facing: "left",
      scale: 0.75,
    });
    expect(resolved.selection).toEqual({
      pose: "walk",
      expression: "surprised",
      gesture: "point",
      clothing: ["field"],
      accessories: ["field_bag"],
    });
    expect(paintsOf(resolved.layers)).toEqual([
      "maya_plate",
      "maya_pose_walk_body",
      "maya_cloth_field",
      "maya_expr_surprised",
      "maya_acc_field_bag",
      "maya_gesture_point_arms",
      "maya_gesture_point_prop",
    ]);
    expect(resolved.placement.facing).toBe("left");
    expect(resolved.placement.scale).toBe(0.75);
    expect(resolved.layers.at(-1)?.slot).toBe("gesture");
    expect(resolved.layers.at(-1)?.source).toBe("gesture:point");
  });

  it("orders layers by slot, then the asset's own order, then id", () => {
    const resolved = resolveCharacter(maya, { pose: "walk" });
    const ranks = resolved.layers.map((layer) =>
      ["base", "pose", "clothing", "expression", "accessory", "gesture"].indexOf(layer.slot),
    );
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // Inside a slot, the pose's arm layer follows its body layer in every pose.
    for (const pose of ["stand", "walk", "talk"]) {
      const layers = resolveCharacter(maya, { pose, gesture: "" }).layers.map((l) => l.assetId);
      expect(layers.indexOf(`maya_pose_${pose}_arms`)).toBeGreaterThan(
        layers.indexOf(`maya_pose_${pose}_body`),
      );
    }
  });

  it("names every character asset it needs, once, with a real file behind it", () => {
    const resolved = resolveCharacter(maya, {
      pose: "talk",
      expression: "engaged",
      gesture: "point",
    });
    const seen = new Set<string>();
    for (const asset of resolved.assets) {
      expect(asset.path).toMatch(/^assets\/maya\/[a-z0-9_]+\.svg$/u);
      expect(seen.has(asset.assetId)).toBe(false);
      seen.add(asset.assetId);
      expect(fs.existsSync(path.join(demoRoot(), ...asset.path.split("/")))).toBe(true);
    }
    expect(resolved.assets.map((asset) => asset.path)).toContain(
      "assets/maya/maya_pose_talk_body.svg",
    );
  });

  it("refuses an unknown pose, expression, gesture, outfit or accessory by name", () => {
    const cases: readonly [Record<string, unknown>, string, string, string][] = [
      [{ pose: "cartwheel" }, "pose", "cartwheel", "stand, walk, talk"],
      [{ expression: "smug" }, "expression", "smug", "neutral, explaining, engaged, surprised"],
      [{ gesture: "shrug" }, "gesture", "shrug", "open_palms, point"],
      [{ clothing: ["tuxedo"] }, "clothing", "tuxedo", "studio, field"],
      [{ accessories: ["crown"] }, "accessory", "crown", "studio_badge, field_bag"],
    ];
    for (const [selection, kind, requested, available] of cases) {
      let thrown: unknown;
      try {
        resolveCharacter(maya, selection);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnknownCharacterPartError);
      const error = thrown as UnknownCharacterPartError;
      expect(error.kind).toBe(kind);
      expect(error.requestedId).toBe(requested);
      expect(error.available.join(", ")).toBe(available);
      expect(error.message).toContain(`maya has no ${kind} "${requested}"`);
    }
  });

  it("refuses a scale that is not a sane size", () => {
    for (const scale of [0, 0.01, 9]) {
      expect(() => resolveCharacter(maya, { scale })).toThrow(RangeError);
    }
  });

  it("is deterministic: the same character and selection give the same stack", () => {
    const once = resolveCharacter(maya, { pose: "talk", expression: "explaining" });
    const twice = resolveCharacter(maya, { pose: "talk", expression: "explaining" });
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("changes the character hash when the definition changes", () => {
    const document = mayaDocument() as { visual: { palette: Record<string, string> } };
    const edited: Character = parseCharacter({
      ...document,
      visual: {
        ...document.visual,
        palette: { ...document.visual.palette, primary: "#123456" },
      },
    });
    expect(characterHash(edited)).not.toBe(mayaHash);
    expect(resolveCharacter(edited).palette.primary).toBe("#123456");
  });
});
