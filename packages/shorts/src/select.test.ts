import { beforeEach, describe, expect, it } from "vitest";

import type { Scene } from "@nexus/scenes";

import { fixtureEpisode } from "./fixtures.js";
import { sceneWindowsOf, selectShorts, topicKeywordOf } from "./select.js";
import { SHORTS_FACTOR_CODES, type ShortsPlan } from "./schema.js";
import type { AudioTrack } from "@nexus/audio";
import type { SceneManifest } from "@nexus/scenes";

/**
 * The selection engine, over a real finished episode (the fixture manifest +
 * a real narration track from the fake TTS). What the tests hold the engine to:
 *
 * - candidates are scene-aligned spans with honest source timecodes — never
 *   fixed-length chunks;
 * - every factor is recorded with a score AND the reasons it saw;
 * - spans that depend on missing context are REJECTED with the reason, not
 *   merely scored low;
 * - the survivors are the best non-overlapping spans under the config.
 */

describe("shorts selection", () => {
  let manifest: SceneManifest;
  let track: AudioTrack;

  beforeEach(async () => {
    const episode = await fixtureEpisode();
    manifest = episode.manifest;
    track = episode.track;
  });

  // The fixture episode speaks for ~23s; a 14s ceiling leaves room for more
  // than one non-overlapping candidate.
  const select = (overrides: Parameters<typeof selectShorts>[1] = {}): ShortsPlan =>
    selectShorts(
      { manifest, track },
      { config: { minDurationSec: 3, maxDurationSec: 14, maxCandidates: 3 }, ...overrides },
    );

  it("turns a finished episode into scored, scene-aligned candidates", () => {
    const plan = select();

    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.length).toBeLessThanOrEqual(3);
    expect(plan.considered).toBeGreaterThan(plan.candidates.length);
    expect(plan.provenance.deterministic).toBe(true);

    for (const candidate of plan.candidates) {
      // The span is a contiguous scene range of the source manifest.
      const expected = manifest.scenes
        .slice(candidate.startIndex, candidate.endIndex + 1)
        .map((scene) => scene.id);
      expect(candidate.sceneIds).toEqual(expected);

      // Timecodes are the spoken ones from the narration track.
      const windows = sceneWindowsOf(manifest, track);
      expect(candidate.startSec).toBeCloseTo(windows[candidate.startIndex]!.startSec, 3);
      expect(candidate.endSec).toBeCloseTo(windows[candidate.endIndex]!.endSec, 3);
      expect(candidate.durationSec).toBeGreaterThanOrEqual(3);
      expect(candidate.durationSec).toBeLessThanOrEqual(14);

      // The transcript carries per-sentence timings inside the window.
      expect(candidate.transcript.length).toBeGreaterThan(0);
      expect(candidate.transcript[0]!.startSec).toBeGreaterThanOrEqual(candidate.startSec - 0.01);
      const lastLine = candidate.transcript[candidate.transcript.length - 1]!;
      expect(lastLine.endSec).toBeLessThanOrEqual(candidate.endSec + 0.01);

      // The score carries all seven factors with reasons.
      expect(candidate.score.factors.map((factor) => factor.code)).toEqual([
        ...SHORTS_FACTOR_CODES,
      ]);
      for (const factor of candidate.score.factors) {
        expect(factor.score).toBeGreaterThanOrEqual(0);
        expect(factor.score).toBeLessThanOrEqual(1);
        expect(factor.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it("is not a fixed-length chopper: spans end where the story ends", () => {
    const plan = select();
    expect(plan.candidates.length).toBeGreaterThan(1);
    const durations = plan.candidates.map((candidate) => candidate.durationSec);
    expect(new Set(durations).size).toBeGreaterThan(1);

    // Candidates start at scene boundaries, and the best one starts the story.
    const best = plan.candidates[0]!;
    expect(best.startIndex).toBe(0);
    expect(best.hookSentence.toLowerCase()).toMatch(/^why\b/u);
  });

  it("rewards the complete arc when the bounds allow it", () => {
    // Only the full run (hook → conclusion) is ~23s; shorter spans are out of bounds.
    const plan = selectShorts(
      { manifest, track },
      { config: { minDurationSec: 20, maxDurationSec: 45, maxCandidates: 3 } },
    );
    const best = plan.candidates[0]!;
    expect(best.startIndex).toBe(0);
    expect(best.endIndex).toBe(manifest.scenes.length - 1);
    const fullText = best.transcript.map((line) => line.text).join(" ");
    expect(fullText).toMatch(/keeps humming/u);
    // The closing payoff marker is part of the score's evidence.
    const payoff = best.score.factors.find((factor) => factor.code === "payoff")!;
    expect(payoff.reasons.join(" ")).toMatch(/resolution|conclusion/u);
  });

  it("records every factor's evidence for the best candidate", () => {
    const best = select().candidates[0]!;
    const hook = best.score.factors.find((factor) => factor.code === "hook")!;
    expect(hook.score).toBeGreaterThan(0.3);
    expect(hook.reasons.join(" ")).toMatch(/question/u);

    const visual = best.score.factors.find((factor) => factor.code === "visual")!;
    expect(visual.score).toBeGreaterThan(0);
  });

  it("rejects a span that opens on an unresolved reference", async () => {
    const shifted = withSceneText(
      manifest,
      1,
      "It turns out the number was never checked. Engineers kept the file open.",
    );
    const plan = selectShorts(
      { manifest: shifted, track },
      { config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 3 } },
    );
    const codes = plan.rejected.map((rejection) => rejection.code);
    expect(codes).toContain("context_opener_unresolved");
    const rejection = plan.rejected.find((entry) => entry.code === "context_opener_unresolved")!;
    expect(rejection.reason).toMatch(/referent is outside/u);
  });

  it("rejects a span that opens on a connective", () => {
    const shifted = withSceneText(
      manifest,
      1,
      "But the numbers never added up. Engineers kept the file open.",
    );
    const plan = selectShorts(
      { manifest: shifted, track },
      { config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 3 } },
    );
    expect(plan.rejected.map((rejection) => rejection.code)).toContain("context_connective_open");
  });

  it("rejects a span that points backward at earlier content", () => {
    const shifted = withSceneText(
      manifest,
      2,
      "As we saw earlier, the wind theory collapsed. The recordings said something else.",
    );
    const plan = selectShorts(
      { manifest: shifted, track },
      { config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 3 } },
    );
    expect(plan.rejected.map((rejection) => rejection.code)).toContain(
      "context_backward_reference",
    );
  });

  it("rejects a span that ends mid-contrast", () => {
    const shifted = withSceneText(manifest, 5, "The city considered every option, but");
    const plan = selectShorts(
      { manifest: shifted, track },
      { config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 3 } },
    );
    const codes = plan.rejected.map((rejection) => rejection.code);
    expect(codes).toContain("context_unfinished_contrast");
  });

  it("rejects a span that promises content it does not contain", () => {
    const shifted = withSceneText(
      manifest,
      1,
      "Stick around, because the dam story is stranger. Engineers kept the file open.",
    );
    const plan = selectShorts(
      { manifest: shifted, track },
      { config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 3 } },
    );
    expect(plan.rejected.map((rejection) => rejection.code)).toContain("context_dangling_promise");
  });

  it("a demonstrative with its noun resolves itself and is NOT rejected", () => {
    const shifted = withSceneText(
      manifest,
      1,
      "This bridge carries forty thousand vehicles a day. The number is the story.",
    );
    const plan = selectShorts(
      { manifest: shifted, track },
      { config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 3 } },
    );
    const openerRejects = plan.rejected.filter(
      (rejection) =>
        rejection.code === "context_opener_unresolved" && rejection.sceneIds.includes("scn_intro"),
    );
    expect(openerRejects).toEqual([]);
  });

  it("penalises a span that starts mid-section, and says so", () => {
    const plan = select({ config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 12 } });
    const midSection = plan.candidates.find((candidate) => candidate.startIndex > 0);
    if (midSection !== undefined) {
      expect(midSection.score.contextPenalty).toBeGreaterThan(0);
      expect(midSection.score.penaltyReasons.join(" ")).toMatch(/mid-section/u);
    }
  });

  it("candidates never overlap", () => {
    const plan = select();
    for (let a = 0; a < plan.candidates.length; a += 1) {
      for (let b = a + 1; b < plan.candidates.length; b += 1) {
        const first = plan.candidates[a]!;
        const second = plan.candidates[b]!;
        const overlap = first.startIndex <= second.endIndex && first.endIndex >= second.startIndex;
        expect(overlap).toBe(false);
      }
    }
  });

  it("honours the config's duration bounds and candidate cap", () => {
    const plan = select({ config: { minDurationSec: 10, maxDurationSec: 14, maxCandidates: 1 } });
    expect(plan.candidates.length).toBeLessThanOrEqual(1);
    for (const candidate of plan.candidates) {
      expect(candidate.durationSec).toBeGreaterThanOrEqual(10);
      expect(candidate.durationSec).toBeLessThanOrEqual(14);
    }
  });

  it("is deterministic: the same documents produce the same plan", async () => {
    const first = select();
    const second = select();
    expect(second).toEqual(first);
  });

  it("carries claim and source references into the candidates", () => {
    const plan = select({ config: { minDurationSec: 3, maxDurationSec: 45, maxCandidates: 12 } });
    const withClaims = plan.candidates.filter((candidate) => candidate.claimIds.length > 0);
    expect(withClaims.length).toBeGreaterThan(0);
    for (const candidate of plan.candidates) {
      expect(candidate.sourceIds.every((id) => id.length > 0)).toBe(true);
    }
  });

  it("reads the topic keyword for the standalone factor", () => {
    expect(topicKeywordOf("Why the Kira bridge hums at dusk")).toBe("kira");
    expect(topicKeywordOf("The: a an of")).toBe("");
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** Replace one scene's narration text (keeping the schema's invariants). */
function withSceneText(manifest: SceneManifest, index: number, text: string): SceneManifest {
  const scenes = manifest.scenes.map((scene, position) => {
    if (position !== index) return scene;
    const words = text.split(/\s+/u).filter((word) => word !== "").length;
    return {
      ...scene,
      narration: {
        ...scene.narration,
        text,
        words,
        estimatedDurationSec: Math.round((words / 2.5) * 10) / 10,
      },
    } satisfies Scene;
  });
  // The manifest's timeline is unchanged (durations match estimates again).
  return { ...manifest, scenes };
}
