import { describe, expect, it } from "vitest";

import { audioManifest, audioScene, castingFixture, twoSceneManifest } from "./fixtures.js";
import {
  DEFAULT_WORDS_PER_SECOND,
  estimateDurationMs,
  segmentIdForScene,
  segmentPlansFrom,
  synthesisRequestFor,
} from "./requests.js";

/**
 * What gets spoken, and by whom.
 *
 * These are the decisions a synthesis call is built from, and they are made
 * *before* any provider is consulted: one segment per scene, the narrator or the
 * presenting character, the manifest's sentence ids carried next to the text they
 * belong to. The tests care about the seam where the manifest stops and the audio
 * starts, so they check the plan and not the audio.
 */

describe("segment plans", () => {
  it("plans exactly one segment per scene, in manifest order", () => {
    const manifest = twoSceneManifest();
    const { plans, issues } = segmentPlansFrom(manifest, castingFixture());

    expect(issues).toEqual([]);
    expect(plans.map((plan) => plan.id)).toEqual(["seg_scn_one", "seg_scn_two"]);
    expect(plans.map((plan) => plan.index)).toEqual([0, 1]);
    expect(plans.map((plan) => plan.sceneId)).toEqual(manifest.scenes.map((scene) => scene.id));
    expect(segmentIdForScene("scn_one")).toBe("seg_scn_one");

    const [first] = plans;
    expect(first).toMatchObject({
      sceneType: "CHARACTER",
      speakerId: "maya",
      text: "The bridge carries forty thousand crossings a day.",
      words: 8,
      plannedStartSec: 0,
      plannedDurationSec: 4,
    });
    expect(first?.characters).toBe(first?.text.length);
  });

  it("carries the manifest's sentence ids beside the text it split", () => {
    const manifest = twoSceneManifest();
    const { plans } = segmentPlansFrom(manifest, castingFixture());
    const second = plans[1]!;

    expect(second.sentenceTexts).toEqual(["Two sentences here.", "The second one is shorter."]);
    expect(second.sentenceIds).toEqual(["snt_2", "snt_3"]);
    expect(second.words).toBe(8);
  });

  it("cannot be handed a scene with nothing to say: the manifest refuses one", () => {
    // The seam this file is about, from the other side: a scene whose narration
    // has no words would mean a scene with no audio at all, so the manifest's own
    // validation rejects it before any planner sees it. The planner still reports
    // the case (`silent_scene`) for documents assembled in memory rather than
    // loaded from the CAS.
    expect(() => audioScene({ narration: "   ", sentenceIds: [] })).toThrow(/word/u);

    const manifest = audioManifest([audioScene({ id: "scn_one", index: 0 })]);
    const { plans, issues } = segmentPlansFrom(manifest, castingFixture());
    expect(plans).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it("warns when the sentence ids disagree with the text, and keeps the ids", () => {
    const manifest = audioManifest([
      audioScene({
        id: "scn_one",
        index: 0,
        narration: "Two sentences here. The second one is shorter.",
        sentenceIds: ["snt_1"],
      }),
    ]);
    const { plans, issues } = segmentPlansFrom(manifest, castingFixture());

    expect(issues.map((issue) => issue.code)).toEqual(["timing_mismatch"]);
    expect(plans[0]?.sentenceTexts).toHaveLength(2);
    expect(plans[0]?.sentenceIds).toEqual(["snt_1"]);
  });

  it("builds the call out of the resolved voice, not out of the manifest", () => {
    const { plans } = segmentPlansFrom(twoSceneManifest(), castingFixture());
    const settings = {
      voiceId: "fake-deep",
      label: "Maya",
      language: "en",
      gender: "masculine" as const,
      rate: 0.9,
      style: "calm",
      format: "wav" as const,
      sampleRate: 24_000,
    };
    const request = synthesisRequestFor(plans[0]!, settings);

    expect(request).toEqual({
      text: "The bridge carries forty thousand crossings a day.",
      voice: { id: "fake-deep", label: "Maya", language: "en", gender: "masculine" },
      format: "wav",
      sampleRate: 24_000,
      rate: 0.9,
    });
    // `style` is a casting decision the request shape has no field for; it stays
    // in the segment's voice settings (and therefore in the cache key).
    expect("style" in request).toBe(false);
  });
});

describe("the duration estimate", () => {
  it("is the word count at the manifest's pace, floored at a readable minimum", () => {
    expect(estimateDurationMs("The bridge carries forty thousand crossings a day.")).toBe(3_200);
    expect(estimateDurationMs("The bridge carries forty thousand crossings a day.", 4)).toBe(2_000);
    // One word never rounds down to "no time at all".
    expect(estimateDurationMs("Yes.", 10)).toBe(200);
    expect(estimateDurationMs("")).toBe(0);
    expect(DEFAULT_WORDS_PER_SECOND).toBe(2.5);
  });
});
