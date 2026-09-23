import type { Scene, SceneManifest } from "@nexus/scenes";
import { vi, describe, expect, it } from "vitest";

// The first fixture build renders a real (scripted-FFmpeg) file, which costs a
// few seconds — and more on a loaded machine. The 5 s defaults are for unit tests,
// not for the tests that wait on a render.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { qaFixture, QA_NARRATION, type QAFixture } from "./fixtures.js";
import { DEFAULT_QA_SETTINGS } from "./settings.js";
import { checkVisual } from "./visual.js";
import type { QACode } from "./schema.js";

/**
 * Visual QA, measured on the composed frames.
 *
 * Every case mutates the *plan* (or the documents around it) and then lets the
 * check compose it, because that is what the checker does: it reads the frames the
 * composer produces, not the manifest's prose. The clean run is asserted first —
 * with the real DejaVu faces, so the readability rules are actually measured.
 */

type Scenes = (scenes: Scene[]) => Scene[];

function patch(fixture: QAFixture, mutate: Scenes, assets = true): SceneManifest {
  const draft = fixture.manifest as unknown as { scenes: Scene[]; assets: SceneManifest["assets"] };
  return {
    ...(fixture.manifest as unknown as SceneManifest),
    scenes: mutate([...draft.scenes]),
    assets: assets
      ? draft.assets
      : draft.assets.map((asset) => ({ ...asset, status: "planned" as const, uri: "" })),
  } as unknown as SceneManifest;
}

function codes(fixture: QAFixture, manifest: SceneManifest, settings = {}) {
  const result = checkVisual(fixture.with({ manifest }), fixture.depsWith(settings), {
    ...DEFAULT_QA_SETTINGS,
    ...settings,
  });
  return {
    result,
    codes: result.findings.map((finding) => finding.code) as readonly QACode[],
    messages: result.findings.map((finding) => finding.message),
  };
}

describe("visual checks", () => {
  it("passes the fixture plan", async () => {
    const fixture = await qaFixture();
    const result = checkVisual(fixture.evidence, fixture.deps, DEFAULT_QA_SETTINGS);
    expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual([]);
    expect(result.report.examined).toBeGreaterThan(100);
  });

  it("reports an asset the media stage never resolved", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) => scenes, false);
    const { codes: found, messages } = codes(fixture, manifest);
    // Two findings per scene: the asset is unresolved, and the scene therefore draws
    // a placeholder where the picture should be.
    expect(found.filter((code) => code === "visual_asset_missing").length).toBe(
      manifest.scenes.length * 2,
    );
    expect(messages.some((message) => message.includes("is still planned"))).toBe(true);
    expect(messages.some((message) => message.includes("with no file behind it"))).toBe(true);
  });

  it("reports a scene that draws media with no file behind it", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene) => ({ ...scene, media: { ...scene.media, assets: [] } }) as Scene),
    );
    // An empty asset list draws a placeholder: the composer reports the hole.
    const { codes: found } = codes(fixture, manifest);
    expect(found).toContain("visual_asset_missing");
  });

  it("reports a transition into a scene the plan does not have", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene, index) =>
        index === 0
          ? { ...scene, transition: { ...scene.transition, toSceneId: "scn_ghost" } }
          : scene,
      ),
    );
    const { result } = codes(fixture, manifest);
    const finding = result.findings.find((entry) => entry.code === "visual_scene_missing");
    expect(finding?.message).toContain("scn_ghost");
  });

  it("reports a scene with no narration", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene, index) =>
        index === 2 ? { ...scene, narration: { ...scene.narration, text: " " } } : scene,
      ),
    );
    const { result } = codes(fixture, manifest);
    expect(
      result.findings.some(
        (finding) =>
          finding.code === "visual_scene_missing" && finding.message.includes("has no narration"),
      ),
    ).toBe(true);
  });

  it("reports a scene in the middle that hands over to nothing", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene, index) =>
        index === 0 ? { ...scene, transition: { ...scene.transition, toSceneId: "" } } : scene,
      ),
    );
    const { messages } = codes(fixture, manifest);
    expect(messages.some((message) => message.includes("hands over to nothing"))).toBe(true);
  });

  it("reports a cast member the manifest does not have", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene, index) =>
        index === 0
          ? { ...scene, characters: [...scene.characters, { characterId: "ghost", state: "idle" }] }
          : scene,
      ),
    );
    const { result } = codes(fixture, manifest);
    const finding = result.findings.find((entry) => entry.subject === "scn_hook_0/ghost");
    expect(finding?.code).toBe("visual_asset_reference_broken");
    expect(finding?.message).toContain("not in the manifest's cast");
  });

  it("reports a cast member the character library does not have", async () => {
    const fixture = await qaFixture();
    const draft = fixture.manifest as unknown as SceneManifest;
    const manifest = {
      ...draft,
      cast: [
        ...draft.cast,
        {
          id: "ghost",
          name: "Ghost",
          role: "character" as const,
          description: "",
          definition: { characterId: "ghost", version: 1, hash: "a".repeat(64) },
        },
      ],
      scenes: draft.scenes.map((scene, index) =>
        index === 0
          ? {
              ...scene,
              characters: [...scene.characters, { characterId: "ghost", state: "idle" as const }],
            }
          : scene,
      ),
    } as unknown as SceneManifest;
    const { result } = codes(fixture, manifest);
    const finding = result.findings.find((entry) => entry.subject === "scn_hook_0/ghost");
    expect(finding?.message).toContain("the character library does not have");
  });

  it("reports a manifest pinned to a character version the library does not have", async () => {
    const fixture = await qaFixture();
    const draft = fixture.manifest as unknown as SceneManifest;
    const manifest = {
      ...draft,
      cast: draft.cast.map((member) =>
        member.id === "maya" && member.definition !== undefined
          ? { ...member, definition: { ...member.definition, version: 99 } }
          : member,
      ),
    } as unknown as SceneManifest;
    const { result } = codes(fixture, manifest);
    const finding = result.findings.find((entry) => entry.code === "visual_asset_reference_broken");
    expect(finding?.message).toContain("v99");
  });

  it("reports a character layer whose file no longer matches its hash", async () => {
    const fixture = await qaFixture();
    const real = fixture.deps.characters!;
    const brokenLibrary = {
      get: (id: string) => real.get(id),
      verifyAssets: () => [
        {
          characterId: "maya",
          checks: [
            {
              assetId: "maya_idle_body",
              path: "characters/maya/idle_body.svg",
              ok: false,
              problem: "hash" as const,
              expected: { bytes: 1_024, hash: "a".repeat(64) },
              actual: { bytes: 980, hash: "b".repeat(64) },
            },
          ],
        },
      ],
    } as unknown as typeof real;
    const result = checkVisual(
      fixture.evidence,
      fixture.depsWith({}, { characters: brokenLibrary }),
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "visual_asset_reference_broken");
    expect(finding?.subject).toBe("maya/maya_idle_body");
    expect(finding?.evidence.problem).toBe("hash");
  });

  it("reports type that is too small to read", async () => {
    const fixture = await qaFixture();
    const { result } = codes(fixture, fixture.manifest, { minFontPx: 140, tightFontPx: 150 });
    const finding = result.findings.find((entry) => entry.code === "visual_text_unreadable");
    expect(finding).toBeDefined();
    expect(Number(finding?.evidence.deviceFontPx)).toBeLessThan(140);
  });

  it("warns about type that is tight but readable", async () => {
    const fixture = await qaFixture();
    const { result } = codes(fixture, fixture.manifest, { tightFontPx: 130 });
    expect(result.findings.map((entry) => entry.code)).toContain("visual_text_tight");
    expect(result.findings.some((entry) => entry.severity === "error")).toBe(false);
  });

  it("reports characters the font cannot draw", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene, index) =>
        index === 0 && scene.text !== undefined
          ? { ...scene, text: { ...scene.text, value: "語 語 語 語" } }
          : scene,
      ),
    );
    const { result } = codes(fixture, manifest);
    const finding = result.findings.find((entry) => entry.code === "visual_text_undrawable");
    expect(finding).toBeDefined();
    expect(String(finding?.evidence.missing)).toContain("語");
  });

  it("reports text that overflows its own box", async () => {
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene, index) =>
        index === 0 && scene.text !== undefined
          ? { ...scene, text: { ...scene.text, value: "Unbreakable".repeat(6) } }
          : scene,
      ),
    );
    const { result } = codes(fixture, manifest);
    const finding = result.findings.find(
      (entry) => entry.code === "visual_layout_invalid" && entry.message.includes("overflows"),
    );
    expect(finding).toBeDefined();
  });

  it("warns, without blocking, when a shot crops part of an element", async () => {
    // A camera with a movement carries every element with it: a lower third that
    // fits at rest can leave the frame under a zoom. Cropping is a look, not a
    // defect, so it is a warning — only an element that lands *entirely* outside
    // (never seen at all) blocks publication.
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene) =>
        scene.index === 0
          ? ({
              ...scene,
              camera: {
                ...scene.camera,
                shot: "medium_close",
                movement: "zoom_in",
                focus: "presenter",
              },
              text:
                scene.text === undefined ? scene.text : { ...scene.text, position: "lower_third" },
            } as Scene)
          : scene,
      ),
    );
    const { result, codes: found } = codes(fixture, manifest, { checkCaptionSafeArea: false });
    expect(found).toContain("visual_layout_clipped");
    expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    const clipped = result.findings.find((finding) => finding.code === "visual_layout_clipped");
    expect(clipped?.message).toContain("partly outside the frame");
    expect(clipped?.subject).toBe("scn_hook_0/text");
  });

  it("reports the caption band colliding with on-screen text", async () => {
    // The demonstration scene's own lower third, which this check found sitting
    // inside the caption band (ISSUES.md, found by Phase 12): the fixture normally
    // lifts its text clear of the band, and this puts it back.
    const fixture = await qaFixture();
    const manifest = patch(fixture, (scenes) =>
      scenes.map((scene) =>
        scene.text === undefined
          ? scene
          : { ...scene, text: { ...scene.text, position: "lower_third" } },
      ),
    );
    const { result } = codes(fixture, manifest);
    expect(
      result.findings.some(
        (entry) => entry.code === "visual_layout_invalid" && entry.message.includes("caption"),
      ),
    ).toBe(true);
  });

  it("reports a caption line wider than the safe width", async () => {
    const fixture = await qaFixture();
    const captions = {
      doc: {
        ...fixture.captions.doc,
        cues: fixture.captions.doc.cues.map((cue, index) =>
          index === 0
            ? {
                ...cue,
                lines: [
                  { ...cue.lines[0]!, text: `${QA_NARRATION[0]} ${"and more words".repeat(12)}` },
                ],
              }
            : cue,
        ),
      },
      hash: fixture.captions.hash,
    };
    const result = checkVisual(fixture.with({ captions }), fixture.deps, DEFAULT_QA_SETTINGS);
    expect(
      result.findings.some(
        (entry) => entry.code === "visual_layout_invalid" && entry.message.includes("safe width"),
      ),
    ).toBe(true);
  });

  it("says readability was not measured when no font is available", async () => {
    const fixture = await qaFixture();
    const result = checkVisual(
      fixture.evidence,
      fixture.depsWith({}, { fonts: undefined }),
      DEFAULT_QA_SETTINGS,
    );
    expect(result.findings.map((entry) => entry.code)).toContain("qa_check_skipped");
    expect(result.findings.filter((entry) => entry.severity === "error")).toEqual([]);
  });
});
