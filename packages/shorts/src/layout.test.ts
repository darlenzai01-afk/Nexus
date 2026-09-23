import { describe, expect, it } from "vitest";

import type { AudioTrack } from "@nexus/audio";

import { SCENE_TYPE_SPECS, validateSceneManifest } from "@nexus/scenes";

import { fixtureEpisode } from "./fixtures.js";
import { focusOf, verticalReflow, withManifestHash } from "./layout.js";
import { sceneWindowsOf, selectShorts } from "./select.js";
import type { VerticalLayout } from "./schema.js";

/**
 * The 9:16 reflow, over the fixture episode. What the tests hold it to:
 *
 * - the vertical manifest is a real, validating manifest — not a crop hint;
 * - scene timings are re-planned to the SPEECH, not copied from the long form;
 * - the narration track is re-based onto the vertical timeline with byte-for-
 *   byte identical audio (nothing is re-synthesised);
 * - every framing decision is reviewable data with a reason.
 */
describe("vertical reflow", () => {
  it("turns the best candidate into a valid 9:16 manifest", async () => {
    const { manifest, track } = await fixtureEpisode();
    const plan = selectShorts({ manifest, track });
    const candidate = plan.candidates[0]!;

    const reflow = verticalReflow({
      manifest,
      track,
      candidate,
    });

    expect(reflow.manifest.aspect).toBe("9:16");
    expect(reflow.manifest.resolution).toEqual({ width: 1080, height: 1920 });
    expect(reflow.manifest.scenes.map((scene) => scene.id)).toEqual(candidate.sceneIds);
    // The shorts engine owns the vertical plan's provenance.
    expect(reflow.manifest.provenance.engine.name).toBe("nexus-shorts");
    expect(
      reflow.manifest.provenance.steps.some((step) =>
        step.notes.some((note) => note.startsWith("shorts.vertical_reflow")),
      ),
    ).toBe(true);

    // It passes the scenes engine's own timing validation, not just the schema.
    const report = validateSceneManifest(reflow.manifest);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("re-times every scene to its spoken duration, not the planned one", async () => {
    const { manifest, track } = await fixtureEpisode();
    const plan = selectShorts({ manifest, track });
    const candidate = plan.candidates[0]!;
    const windows = sceneWindowsOf(manifest, track);

    const reflow = verticalReflow({ manifest, track, candidate });

    let cursor = 0;
    for (const scene of reflow.manifest.scenes) {
      const spoken = windows[candidate.startIndex + scene.index]!;
      const spokenSec = spoken.endSec - spoken.startSec;
      // Speech sets the pace; the scene type sets the minimum hold.
      const typeFloor = SCENE_TYPE_SPECS[scene.type].minDurationSec;
      expect(scene.durationSec).toBeCloseTo(Math.max(0.4, spokenSec, typeFloor), 1);
      expect(scene.startSec).toBeCloseTo(cursor, 1);
      cursor += scene.durationSec;
    }
    // The vertical total is the sum of the re-timed scenes.
    const total = reflow.manifest.scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
    expect(reflow.manifest.totalDurationSec).toBeCloseTo(total, 1);

    // The audio follows the new timeline: one segment per scene, starting
    // where the scene starts.
    for (const scene of reflow.manifest.scenes) {
      const segment = reflow.track.segments.find((entry) => entry.sceneId === scene.id)!;
      expect(segment.startSec).toBeCloseTo(scene.startSec, 3);
    }
    // Sentence windows stay inside their (new) scene windows.
    for (const timing of reflow.track.sentences) {
      const scene = reflow.manifest.scenes.find((entry) => entry.id === timing.sceneId)!;
      expect(timing.startSec).toBeGreaterThanOrEqual(scene.startSec - 0.05);
      expect(timing.endSec).toBeLessThanOrEqual(scene.startSec + scene.durationSec + 0.05);
    }
  });

  it("re-bases the track with identical audio — nothing is re-synthesised", async () => {
    const { manifest, track } = await fixtureEpisode();
    const plan = selectShorts({ manifest, track });
    const candidate = plan.candidates[0]!;

    const reflow = verticalReflow({ manifest, track, candidate });

    // Same segments, same audio, new clock.
    expect(reflow.track.segments.length).toBe(candidate.sceneIds.length);
    for (const segment of reflow.track.segments) {
      const source = track.segments.find((entry) => entry.id === segment.id)!;
      expect(source.audio).toEqual(segment.audio);
      expect(source.words).toBe(segment.words);
    }
    // The span opens the vertical timeline at zero.
    const first = reflow.track.segments[0]!;
    expect(first.startSec).toBeCloseTo(0, 3);

    // Totals describe the span, not the whole episode.
    expect(reflow.track.totals.scenes).toBe(candidate.sceneIds.length);
    expect(reflow.track.totals.words).toBe(
      track.segments
        .filter((segment) => candidate.sceneIds.includes(segment.sceneId))
        .reduce((sum, segment) => sum + segment.words, 0),
    );
    // The rebased track carries a warning about the rebase.
    expect(reflow.track.warnings.join(" ")).toMatch(/rebased/u);
  });

  it("re-times animation events into the re-timed scene, when speech runs shorter than the plan", async () => {
    const { manifest, track } = await fixtureEpisode();
    const round1 = (value: number): number => Math.round(value * 10) / 10;
    const plan = selectShorts({ manifest, track });
    const candidate = plan.candidates[0]!;
    // Speech that lands well under its planned window (the voice read faster
    // than the plan's estimate): the diagram scene speaks at 40% of the plan.
    const victim = manifest.scenes.find((scene) => scene.id === "scn_intro")!;
    const factor = 0.4;
    const faster: AudioTrack = {
      ...track,
      segments: track.segments.map((segment) =>
        segment.sceneId === victim.id
          ? {
              ...segment,
              durationSec: round1(segment.durationSec * factor),
              audio: {
                ...segment.audio,
                durationMs: Math.round(segment.audio.durationMs * factor),
              },
              wordTimings: segment.wordTimings?.map((timing) => ({
                ...timing,
                startMs: Math.round(timing.startMs * factor),
                endMs: Math.round(timing.endMs * factor),
              })),
            }
          : segment,
      ),
      sentences: track.sentences.map((timing) =>
        timing.sceneId === victim.id
          ? {
              ...timing,
              startSec: round1(timing.startSec * factor),
              endSec: round1(timing.endSec * factor),
              durationSec: round1(timing.durationSec * factor),
            }
          : timing,
      ),
      scenes: track.scenes.map((timing) =>
        timing.sceneId === victim.id
          ? {
              ...timing,
              plannedDurationSec: round1(timing.plannedDurationSec * factor),
              spokenDurationSec: round1(timing.spokenDurationSec * factor),
            }
          : timing,
      ),
    };

    const reflow = verticalReflow({ manifest, track: faster, candidate });
    const scene = reflow.manifest.scenes.find((entry) => entry.id === victim.id)!;
    // The scene re-timed to its speech…
    expect(scene.durationSec).toBeLessThan(victim.durationSec);
    // …and every animation event moved into the shorter scene, still ordered.
    let previous = -1;
    for (const event of scene.animation) {
      expect(event.atSec).toBeGreaterThanOrEqual(previous);
      previous = event.atSec;
      expect(
        event.atSec + event.durationSec,
        `${event.id} inside the re-timed scene`,
      ).toBeLessThanOrEqual(scene.durationSec + 0.05);
    }
    // The reflowed manifest is still a fully valid plan.
    const report = validateSceneManifest(reflow.manifest);
    expect(report.ok).toBe(true);
  });

  it("stamps the vertical manifest hash with withManifestHash", async () => {
    const { manifest, track } = await fixtureEpisode();
    const plan = selectShorts({ manifest, track });
    const reflow = verticalReflow({ manifest, track, candidate: plan.candidates[0]! });

    expect(reflow.track.manifestHash).toBe(track.manifestHash);
    const stamped = withManifestHash(reflow.track, "f".repeat(64));
    expect(stamped.manifestHash).toBe("f".repeat(64));
    // Stamping changes nothing else.
    expect(stamped.segments).toEqual(reflow.track.segments);
  });

  it("re-frames per scene and records the decision (not a crop)", async () => {
    const { manifest, track } = await fixtureEpisode();
    const plan = selectShorts({ manifest, track });
    // Take the widest candidate so the layout covers text/media/diagram.
    const candidate =
      plan.candidates.find((entry) => entry.sceneIds.length >= 3) ?? plan.candidates[0]!;

    const reflow = verticalReflow({ manifest, track, candidate });
    const layout = reflow.layout as VerticalLayout;
    const byScene = new Map(layout.scenes.map((scene) => [scene.sceneId, scene]));

    expect(layout.canvas).toEqual({ width: 1080, height: 1920 });
    expect(layout.aspect).toBe("9:16");
    expect(layout.candidateId).toBe(candidate.id);

    for (const source of manifest.scenes.slice(candidate.startIndex, candidate.endIndex + 1)) {
      const sceneLayout = byScene.get(source.id)!;
      const camera = sceneLayout.camera;

      // The framing is a re-composition with a reason — never a bare crop.
      expect(camera.mode).toBe("reflow");
      expect(camera.reason.length).toBeGreaterThan(0);

      // The window is derived from the scene's own focus, clamped to the frame.
      const width = camera.window.width;
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(1);
      const expectedX = Math.min(1 - width, Math.max(0, camera.focusX - width / 2));
      expect(camera.window.x).toBeCloseTo(expectedX, 3);
      expect(camera.window.x).toBeGreaterThanOrEqual(0);
      expect(camera.window.x + width).toBeLessThanOrEqual(1.001);

      // A wide shot never survives unchanged: it becomes a medium in 9:16.
      if (source.camera.shot === "wide") {
        const verticalScene = reflow.manifest.scenes.find((scene) => scene.id === source.id)!;
        expect(verticalScene.camera.shot).toBe("medium");
      }
    }
  });

  it("follows the presenter, moves corner text, and stacks side-by-side media", async () => {
    const { manifest, track } = await fixtureEpisode();
    // Reflow the whole episode so every scene kind is covered.
    const candidate = selectShorts(
      { manifest, track },
      { config: { minDurationSec: 20, maxDurationSec: 45, maxCandidates: 1 } },
    ).candidates[0]!;

    const reflow = verticalReflow({ manifest, track, candidate });
    const layout = reflow.layout as VerticalLayout;
    const byScene = new Map(layout.scenes.map((scene) => [scene.sceneId, scene]));

    // Single presenter: the camera follows her slot, centred.
    const intro = byScene.get("scn_intro")!;
    expect(intro.camera.focusX).toBeCloseTo(0.5, 3);
    expect(intro.camera.reason).toMatch(/presenter|slot/u);

    // Two presenters: the talking one leads.
    const twoshot = byScene.get("scn_twoshot")!;
    expect(twoshot.camera.focusX).toBeCloseTo(0.34, 3);

    // Corner quote text moves to a lower third and gains a line.
    const evidence = byScene.get("scn_evidence")!;
    expect(evidence.text?.position).toBe("lower_third");
    expect(evidence.text?.previousPosition).toBe("corner");
    const verticalEvidence = reflow.manifest.scenes.find((scene) => scene.id === "scn_evidence")!;
    expect(verticalEvidence.text?.position).toBe("lower_third");
    expect(verticalEvidence.text!.maxLines).toBe(
      Math.min(6, manifest.scenes[2]!.text!.maxLines + 1),
    );

    // Side-by-side media stacks as an overlay in the tall frame.
    expect(evidence.media?.treatment).toBe("overlay");
    expect(evidence.media?.previousTreatment).toBe("split_screen");

    // The diagram re-stacks top-to-bottom.
    const diagram = byScene.get("scn_diagram")!;
    expect(diagram.diagram?.flow).toBe("vertical");
    expect(diagram.diagram?.reason).toMatch(/top-to-bottom/u);
  });

  it("keeps the vertical layout inside the safe area and caption band", async () => {
    const { manifest, track } = await fixtureEpisode();
    const plan = selectShorts({ manifest, track });
    const reflow = verticalReflow({ manifest, track, candidate: plan.candidates[0]! });
    const layout = reflow.layout as VerticalLayout;

    // The platform's vertical safe area: UI chrome top, captions bottom.
    expect(layout.safeArea).toEqual({ top: 0.08, bottom: 0.18, left: 0.05, right: 0.05 });
    expect(layout.captionBand).toEqual({ x: 0.06, y: 0.8, width: 0.88, height: 0.1 });
    expect(layout.captionStyle).toEqual({ fontPx: 58, marginPx: 210 });

    // Geometry sanity: every band sits inside the canvas.
    expect(layout.captionBand.x + layout.captionBand.width).toBeLessThanOrEqual(1);
    expect(layout.captionBand.y + layout.captionBand.height).toBeLessThanOrEqual(1);
    // The caption band lives in the lower quarter, inside the canvas.
    expect(layout.captionBand.y).toBeGreaterThanOrEqual(0.75);
    expect(layout.captionBand.y + layout.captionBand.height).toBeLessThanOrEqual(0.95);
  });

  it("re-composes the frame rather than cropping it: focusOf is honest about why", async () => {
    const { manifest } = await fixtureEpisode();
    const intro = manifest.scenes.find((scene) => scene.id === "scn_intro")!;
    const focus = focusOf(intro);
    expect(focus.x).toBeCloseTo(0.5, 3);
    expect(focus.reason).toMatch(/presenter|slot|talking/u);

    // The closer is a one-shot with Maya speaking: the camera finds her again.
    const end = manifest.scenes.find((scene) => scene.id === "scn_end")!;
    const closer = focusOf(end);
    expect(closer.x).toBeCloseTo(0.5, 3);
    expect(closer.reason).toMatch(/presenter/u);
  });
});
