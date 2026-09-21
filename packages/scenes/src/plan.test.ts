import { FixedClock } from "@nexus/providers";
import { wordCount } from "@nexus/script";
import { describe, expect, it } from "vitest";

import { CLOCK_ISO, SCRIPT_HASH, manifestFixture, scriptFixture } from "./fixtures.js";
import {
  DEFAULT_CAST,
  DEFAULT_TRANSITION_DURATION_SEC,
  ScenePlanError,
  buildSceneManifest,
  sceneTypeFor,
} from "./plan.js";
import { SCENE_TYPES, scenesOfType, type Scene, type SceneType } from "./schema.js";
import { SCENE_TYPE_SPECS, legacySceneKind } from "./scene-types.js";
import { DEFAULT_WORDS_PER_SECOND, fromDeciseconds, toDeciseconds } from "./timing.js";
import { validateSceneManifest } from "./validate.js";

/**
 * The planner: a script in, a manifest out.
 *
 * These tests pin the *rules*, not the current numbers: every sentence's scene
 * type, the timeline arithmetic, the claim/evidence chain, the media the plan
 * asks for, and the fact that two runs over one script produce one manifest.
 */

const typeOf = (scene: Scene): SceneType => scene.type;

describe("scene type rules", () => {
  it("maps each visual kind onto a scene type", () => {
    const script = scriptFixture();
    const [sec1, sec2, sec3, sec4, sec5] = script.sections;
    expect(sceneTypeFor(sec1!.sentences[0]!)).toBe("CHARACTER"); // no cue: presenter
    expect(sceneTypeFor(sec2!.sentences[0]!)).toBe("HYBRID"); // broll + a cleared fact
    expect(sceneTypeFor(sec2!.sentences[1]!)).toBe("EVIDENCE"); // text card citing a claim
    expect(sceneTypeFor(sec3!.sentences[0]!)).toBe("EVIDENCE"); // a quotation
    expect(sceneTypeFor(sec3!.sentences[1]!)).toBe("DIAGRAM"); // a chart
    expect(sceneTypeFor(sec4!.sentences[0]!)).toBe("ENVIRONMENT"); // image, context only
    expect(sceneTypeFor(sec4!.sentences[1]!)).toBe("CHARACTER"); // no cue at all
    expect(sceneTypeFor(sec5!.sentences[0]!)).toBe("HYBRID"); // broll carrying a cleared fact
  });

  it("falls back to a presenter scene for an unknown visual kind", () => {
    const [sentence] = scriptFixture().sections[0]!.sentences;
    expect(
      sceneTypeFor({ ...sentence!, visual: { kind: "none", description: "", searchHint: "" } }),
    ).toBe("CHARACTER");
    expect(sceneTypeFor({ ...sentence!, visual: undefined })).toBe("CHARACTER");
  });

  it("plans every one of the six scene types from the fixture script", () => {
    const manifest = manifestFixture();
    const counts = Object.fromEntries(
      SCENE_TYPES.map((type) => [type, scenesOfType(manifest, type).length]),
    );
    expect(counts).toEqual({
      CHARACTER: 2, // the two presenter beats
      EVIDENCE: 2, // the quotation and the figure card
      HYBRID: 2, // b-roll carrying a cleared fact
      DIAGRAM: 1,
      ENVIRONMENT: 2,
      TRANSITION: 4, // one per section with a spoken bridge (all but the hook)
    });
    expect(manifest.scenes).toHaveLength(13);
    return expect(validateSceneManifest(manifest, { script: scriptFixture() })).toMatchObject({
      ok: true,
    });
  });
});

describe("the planned timeline", () => {
  it("lays the scenes end to end, in order, with no gaps", () => {
    const manifest = manifestFixture();
    let running = 0;
    for (const [position, scene] of manifest.scenes.entries()) {
      expect(scene.index).toBe(position);
      expect(scene.startSec).toBeCloseTo(running, 6);
      running += scene.durationSec;
    }
    expect(manifest.totalDurationSec).toBeCloseTo(running, 6);
    expect(manifest.scenes.at(-1)!.transition.toSceneId).toBe("");
  });

  it("holds each scene for its narration plus the type's padding", () => {
    const manifest = manifestFixture();
    for (const scene of manifest.scenes) {
      expect(scene.narration.words).toBe(wordCount(scene.narration.text));
      expect(scene.durationSec).toBeGreaterThanOrEqual(scene.narration.estimatedDurationSec);
      // Every scene with narration keeps its type's floor, and none of them is padded.
      expect(scene.durationSec).toBeLessThanOrEqual(
        Math.max(
          SCENE_TYPE_SPECS[scene.type].minDurationSec,
          scene.narration.estimatedDurationSec + SCENE_TYPE_SPECS[scene.type].holdPaddingSec,
        ) + 1e-9,
      );
    }
    const words = manifest.scenes.reduce((total, scene) => total + scene.narration.words, 0);
    expect(manifest.totalDurationSec).toBeCloseTo(
      fromDeciseconds(toDeciseconds(manifest.totalDurationSec)),
      6,
    );
    expect(words).toBeGreaterThan(0);
  });

  it("varies camera movement and presenter shots instead of marching in step", () => {
    const manifest = manifestFixture();
    const characters = scenesOfType(manifest, "CHARACTER").map((scene) => scene.camera.shot);
    expect(new Set(characters).size).toBe(characters.length);
    const environments = scenesOfType(manifest, "ENVIRONMENT").map(
      (scene) => scene.camera.movement,
    );
    expect(new Set(environments).size).toBe(environments.length);
    // A scene keeps its type's base look: only the varying axis moves.
    for (const scene of manifest.scenes) {
      const base = SCENE_TYPE_SPECS[scene.type].camera;
      expect(scene.camera.angle).toBe(base.angle);
      expect(scene.camera.focus).toBe(base.focus);
      expect([
        "wide",
        "medium",
        "medium_close",
        "close_up",
        "extreme_close_up",
        "over_shoulder",
        "pov",
        "insert",
      ]).toContain(scene.camera.shot);
    }
  });

  it("keeps every animation event inside its own scene, in time order", () => {
    const manifest = manifestFixture();
    for (const scene of manifest.scenes) {
      expect(scene.animation.length).toBeGreaterThanOrEqual(2); // fade in … fade out
      expect(scene.animation.map((event) => event.id)).toEqual(
        scene.animation.map((_, at) => `${scene.id}.a${at + 1}`),
      );
      let previous = -1;
      for (const event of scene.animation) {
        expect(event.atSec).toBeGreaterThanOrEqual(previous);
        expect(event.atSec + event.durationSec).toBeLessThanOrEqual(scene.durationSec + 0.05);
        previous = event.atSec;
      }
      expect(scene.animation[0]!.kind).toBe("fade_in");
      expect(scene.animation.at(-1)!.kind).toBe("fade_out");
    }
  });

  it("cuts inside a run of one type and dissolves into a new one", () => {
    const manifest = manifestFixture();
    for (const [position, scene] of manifest.scenes.entries()) {
      const next = manifest.scenes[position + 1];
      if (next === undefined) continue;
      expect(scene.transition.toSceneId).toBe(next.id);
      const soft = next.type === "TRANSITION" || next.type !== scene.type;
      expect(scene.transition.durationSec).toBe(soft ? DEFAULT_TRANSITION_DURATION_SEC : 0);
      expect(scene.transition.kind).toBe(
        soft ? (next.type === "TRANSITION" ? "fade_to_black" : "dissolve") : "cut",
      );
    }
  });
});

describe("what a scene carries", () => {
  it("speaks exactly the script's sentences, and says which ones", () => {
    const script = scriptFixture();
    const manifest = manifestFixture();
    const byId = new Map(
      script.sections.flatMap((section) =>
        section.sentences.map((sentence) => [sentence.id, sentence] as const),
      ),
    );
    for (const scene of manifest.scenes) {
      if (scene.narration.kind === "transition") {
        const section = script.sections.find((candidate) => candidate.id === scene.sectionId)!;
        expect(scene.narration.text).toBe(section.transition);
        expect(scene.narration.sentenceIds).toEqual([]);
        continue;
      }
      expect(scene.narration.kind).toBe("sentence");
      expect(scene.narration.sentenceIds).toHaveLength(1);
      expect(scene.narration.text).toBe(byId.get(scene.narration.sentenceIds[0]!)!.narration);
    }
  });

  it("keeps the claim and its evidence verbatim, never paraphrased", () => {
    const script = scriptFixture();
    const manifest = manifestFixture();
    const claim = script.claims[0]!;
    const evidenceScene = manifest.scenes.find((scene) => scene.sources.length > 0)!;
    expect(evidenceScene.sources[0]).toMatchObject({
      claimId: claim.claimId,
      statement: claim.statement,
      usage: claim.usage,
      status: claim.status,
      certainty: claim.certainty,
      confidence: claim.confidence,
    });
    expect(evidenceScene.sources[0]!.evidence).toEqual(claim.evidence);
  });

  it("shows text only when the script asked for it, and never invents wording", () => {
    const manifest = manifestFixture();
    const quoteScene = scenesOfType(manifest, "EVIDENCE").find(
      (scene) => scene.text?.kind === "quote",
    )!;
    expect(quoteScene.text!.value).toContain("the crossing takes fifteen minutes at peak");
    expect(quoteScene.text!.attribution).toBe("forum.example.net");

    const cardScene = scenesOfType(manifest, "EVIDENCE").find(
      (scene) => scene.text?.kind === "number",
    )!;
    expect(cardScene.text!.value).toContain("40,000 vehicles a day");
    // Characters never carry a caption of their own.
    for (const scene of manifest.scenes) {
      if (scene.type === "CHARACTER" || scene.type === "TRANSITION")
        expect(scene.text).toBeUndefined();
    }
    // A figure only ever appears with a source behind it.
    expect(cardScene.sources.length).toBeGreaterThan(0);
  });

  it("builds a diagram out of the claims it cites", () => {
    const manifest = manifestFixture();
    const diagram = scenesOfType(manifest, "DIAGRAM")[0]!;
    expect(diagram.diagram!.kind).toBe("number_highlight");
    expect(diagram.diagram!.title).toContain("40,000");
    expect(diagram.diagram!.claimIds).toEqual(["cl_clear"]);
    expect(diagram.diagram!.series).toEqual([]);
  });

  it("plans every place and chart as an asset the media stage has to source", () => {
    const manifest = manifestFixture();
    expect(manifest.assets.map((asset) => asset.id)).toEqual([
      "asset_scn_sec2_1",
      "asset_scn_sec4_1",
      "asset_scn_sec4_3",
      "asset_scn_sec5_1",
    ]);
    expect(manifest.assets.map((asset) => asset.kind)).toEqual([
      "video",
      "image",
      "image",
      "video",
    ]);
    for (const asset of manifest.assets) {
      expect(asset.status).toBe("planned");
      expect(asset.uri).toBe("");
      expect(asset.description.length).toBeGreaterThan(0);
      expect(asset.searchHint.length).toBeGreaterThan(0);
      const scene = manifest.scenes.find((candidate) => candidate.id === asset.sceneId)!;
      expect(scene.media!.assets).toEqual([asset.id]);
    }
    // Footage has to fill the scene it belongs to; a still has no duration to fill.
    for (const asset of manifest.assets) {
      const scene = manifest.scenes.find((candidate) => candidate.id === asset.sceneId)!;
      expect(asset.minDurationSec).toBe(asset.kind === "video" ? scene.durationSec : 0);
    }
    // …and the cast is only who the plan was given.
    expect(manifest.cast).toEqual([...DEFAULT_CAST]);
  });

  it("records which sources a scene rests on and cites every visible figure", () => {
    const manifest = manifestFixture();
    const chart = scenesOfType(manifest, "DIAGRAM")[0]!;
    expect(chart.sourceIds).toEqual(["src_data", "src_news"]);
    const quote = scenesOfType(manifest, "EVIDENCE").find((scene) => scene.text?.kind === "quote")!;
    expect(quote.sourceIds).toEqual(["src_forum"]);
  });

  it("keeps the scene's own claims visible on a hybrid scene", () => {
    const manifest = manifestFixture();
    const hybrid = scenesOfType(manifest, "HYBRID")[0]!;
    expect(hybrid.camera.shot).toBe("medium");
    expect(hybrid.characters).toEqual([{ characterId: "presenter", state: "gesturing" }]);
    expect(hybrid.text).toMatchObject({ kind: "number", position: "lower_third" });
    expect(hybrid.media).toMatchObject({ kind: "video", treatment: "background" });
    expect(hybrid.sources.map((claim) => claim.claimId)).toEqual(["cl_clear"]);
  });
});

describe("the plan document", () => {
  it("is deterministic: same script, same manifest", () => {
    const first = manifestFixture();
    const second = manifestFixture();
    expect(second).toEqual(first);
  });

  it("says who planned it and that no model was involved", () => {
    const manifest = manifestFixture();
    expect(manifest.scriptHash).toBe(SCRIPT_HASH);
    expect(manifest.provenance).toMatchObject({
      engine: { name: "nexus-scenes", version: "1.0.0" },
      aiSteps: [],
      generatedAt: CLOCK_ISO,
    });
    expect(manifest.provenance.deterministicSteps).toEqual([
      "cast",
      "types",
      "timing",
      "camera",
      "animation",
      "assets",
      "validate",
    ]);
    expect(manifest.provenance.steps.every((step) => step.engine === "none")).toBe(true);
    expect(manifest.scriptId).toBe("script_1");
    expect(manifest.wordsPerSecond).toBe(DEFAULT_WORDS_PER_SECOND);
    expect(manifest.fps).toBe(30);
    expect(manifest.aspect).toBe("16:9");
    expect(manifest.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it("carries the script's identity into the manifest", () => {
    const manifest = manifestFixture();
    expect(manifest.topic).toBe("The Kira bridge");
    expect(manifest.workingTitle).toBe("Forty Thousand Crossings a Day");
  });

  it("portrays the presenter only when the script needs one", () => {
    const script = scriptFixture();
    // A script whose every sentence has its own material needs no cast at all.
    const stripped = {
      ...script,
      sections: script.sections.map((section) => ({
        ...section,
        sentences: section.sentences.map((sentence) => ({
          ...sentence,
          assertion: "context" as const,
          claimRefs: [],
          sourceRefs: [],
          visual: { kind: "broll" as const, description: "material", searchHint: "material" },
        })),
      })),
      claims: [],
    };
    const manifest = buildSceneManifest(stripped, {
      scriptHash: SCRIPT_HASH,
      cast: [],
      clock: new FixedClock(CLOCK_ISO),
    });
    expect(manifest.scenes.every((scene) => scene.characters.length === 0)).toBe(true);
    expect(scenesOfType(manifest, "TRANSITION")).toHaveLength(4);
    expect(validateSceneManifest(manifest, { script: stripped }).ok).toBe(true);
  });

  it("refuses to plan a presenter scene with nobody to show", () => {
    expect(() =>
      buildSceneManifest(scriptFixture(), { scriptHash: SCRIPT_HASH, cast: [] }),
    ).toThrowError(/needs someone on screen/);
    expect(() =>
      buildSceneManifest(scriptFixture(), { scriptHash: SCRIPT_HASH, cast: [] }),
    ).toThrowError(ScenePlanError);
  });

  it("refuses nonsense planning options", () => {
    const script = scriptFixture();
    expect(() => buildSceneManifest(script, { scriptHash: "not-a-hash" })).toThrowError(/sha256/);
    expect(() =>
      buildSceneManifest(script, { scriptHash: SCRIPT_HASH, wordsPerSecond: 0 }),
    ).toThrowError(/wordsPerSecond/);
    expect(() => buildSceneManifest(script, { scriptHash: SCRIPT_HASH, fps: 0 })).toThrowError(
      /fps/,
    );
    expect(() =>
      buildSceneManifest(script, { scriptHash: SCRIPT_HASH, transitionDurationSec: 5 }),
    ).toThrowError(/transitionDurationSec/);
  });

  it("warns, visibly, when it has to leave something out", () => {
    const script = scriptFixture();
    const orphaned = {
      ...script,
      sections: script.sections.map((section, position) =>
        position === 0
          ? {
              ...section,
              sentences: section.sentences.map((sentence) => ({
                ...sentence,
                sourceRefs: ["src_ghost"],
                narration: sentence.narration.replace("every single day", "every single day"),
              })),
            }
          : section,
      ),
    };
    const manifest = buildSceneManifest(orphaned, {
      scriptHash: SCRIPT_HASH,
      clock: new FixedClock(CLOCK_ISO),
    });
    expect(
      manifest.warnings.some((warning) => warning.includes("cannot show source src_ghost")),
    ).toBe(true);
    expect(validateSceneManifest(manifest, { script: orphaned }).ok).toBe(true);
  });

  it("schematic fallback: a chart with no claim is planned and reported", () => {
    const script = scriptFixture();
    const chartless = {
      ...script,
      sections: script.sections.map((section, position) =>
        position === 2
          ? {
              ...section,
              sentences: section.sentences.map((sentence, index) =>
                index === 1
                  ? {
                      ...sentence,
                      narration: "The counts were taken years apart.",
                      assertion: "context" as const,
                      claimRefs: [],
                      sourceRefs: [],
                      visual: {
                        kind: "chart" as const,
                        description: "Two counts, years apart",
                        searchHint: "",
                      },
                    }
                  : sentence,
              ),
            }
          : section,
      ),
    };
    const manifest = buildSceneManifest(chartless, {
      scriptHash: SCRIPT_HASH,
      clock: new FixedClock(CLOCK_ISO),
    });
    const diagram = scenesOfType(manifest, "DIAGRAM")[0]!;
    expect(diagram.diagram).toMatchObject({ kind: "schematic", claimIds: [], series: [] });
    expect(manifest.warnings.some((warning) => warning.includes("cites no claim"))).toBe(true);
  });

  it("can be planned for a vertical cut without re-deciding anything else", () => {
    const manifest = buildSceneManifest(scriptFixture(), {
      scriptHash: SCRIPT_HASH,
      aspect: "9:16",
      resolution: { width: 1080, height: 1920 },
      clock: new FixedClock(CLOCK_ISO),
    });
    expect(manifest.aspect).toBe("9:16");
    expect(manifest.assets.every((asset) => asset.orientation === "portrait")).toBe(true);
  });

  it("maps each scene type onto a legacy scenes.kind", () => {
    expect(SCENE_TYPES.map((type) => legacySceneKind(type))).toEqual([
      "talk",
      "quote",
      "talk",
      "fact",
      "media",
      "title",
    ]);
    const manifest = manifestFixture();
    for (const scene of manifest.scenes) {
      expect(["title", "talk", "fact", "media", "quote"]).toContain(legacySceneKind(typeOf(scene)));
    }
  });
});
