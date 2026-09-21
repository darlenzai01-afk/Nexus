import { describe, expect, it } from "vitest";

import {
  CHARACTER_DEFINITION_HASH,
  characterLibraryView,
  editManifest,
  handWritten,
  handWrittenManifest,
  manifestFixture,
  scriptFixture,
} from "./fixtures.js";
import {
  SCENE_ISSUE_CODES,
  scenesOfType,
  type SceneIssueSeverity,
  type SceneManifest,
} from "./schema.js";
import { sceneIssueSeverity } from "./schema.js";
import {
  validateSceneManifest,
  type SceneValidationContext,
  type SceneValidationReport,
} from "./validate.js";

/**
 * Validation: everything a manifest must satisfy before anything acts on it.
 *
 * The cases below are the ones that matter in production — a manifest that is
 * merely the wrong *shape*, one whose assets cannot be sourced, one whose
 * durations cannot be trusted, one that speaks words the script never wrote, and
 * one whose scene type is not in the vocabulary. Each test asserts the *coded*
 * issue, because that is what an operator acts on.
 */

const script = scriptFixture();
const context: SceneValidationContext = { script };

const breakManifest = (
  edit: (draft: SceneManifest) => void,
  ctx: SceneValidationContext = context,
): SceneValidationReport => validateSceneManifest(editManifest(manifestFixture(), edit), ctx);

const codesOf = (report: SceneValidationReport): string[] =>
  report.issues.map((entry) => entry.code);
const sceneAt = (draft: SceneManifest, index: number) => draft.scenes[index]!;
const sceneIndexOfType = (
  draft: SceneManifest,
  type: SceneManifest["scenes"][number]["type"],
): number => draft.scenes.findIndex((scene) => scene.type === type);

describe("a valid manifest", () => {
  it("passes, with the numbers a status view wants", () => {
    const report = validateSceneManifest(manifestFixture(), context);
    expect(report).toMatchObject({ ok: true, issues: [] });
    expect(report.stats).toMatchObject({
      scenes: 13,
      assets: 4,
      words: 141,
      byType: { CHARACTER: 2, EVIDENCE: 2, HYBRID: 2, DIAGRAM: 1, ENVIRONMENT: 2, TRANSITION: 4 },
    });
    expect(report.stats.totalDurationSec).toBeCloseTo(65.3, 1);
  });

  it("accepts a hand-written manifest, filling in the defaults", () => {
    const report = validateSceneManifest(handWrittenManifest());
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("accepts a hand-written manifest without the script it came from", () => {
    const report = validateSceneManifest(handWritten());
    expect(report).toMatchObject({ ok: true, issues: [] });
    expect(report.stats.byType).toMatchObject({ CHARACTER: 1, ENVIRONMENT: 1 });
  });

  it("accepts narration quoted from the script without naming sentences", () => {
    const report = breakManifest((draft) => {
      const index = sceneIndexOfType(draft, "CHARACTER");
      const scene = sceneAt(draft, index);
      scene.narration.kind = "paragraph";
      scene.narration.sentenceIds = [];
    });
    expect(report.ok).toBe(true);
  });
});

describe("invalid manifests", () => {
  it("rejects a manifest with no scenes at all", () => {
    const report = breakManifest((draft) => {
      draft.scenes = [];
      draft.assets = [];
      draft.totalDurationSec = 1;
    });
    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain("empty_manifest");
  });

  it("rejects an unknown field instead of dropping it", () => {
    const report = breakManifest((draft) => {
      (sceneAt(draft, 0) as unknown as Record<string, unknown>).colour = "teal";
    });
    expect(report.ok).toBe(false);
    const issue = report.issues[0]!;
    expect(issue.code).toBe("invalid_manifest");
    expect(issue.message).toContain("colour");
    expect(issue.sceneId).toBe(sceneAt(manifestFixture(), 0).id);
  });

  it("rejects a scene whose index does not match its position", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 3).index = 9;
    });
    expect(codesOf(report)).toContain("invalid_timeline");
    expect(report.ok).toBe(false);
  });

  it("rejects two scenes with the same id", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 1).id = sceneAt(draft, 0).id;
    });
    expect(codesOf(report)).toContain("duplicate_scene_id");
    expect(report.ok).toBe(false);
  });

  it("rejects a transition that points somewhere other than the next scene", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 0).transition.toSceneId = "scn_nowhere";
    });
    expect(codesOf(report)).toContain("dangling_transition");
    expect(report.ok).toBe(false);
  });

  it("rejects a scene showing somebody who is not in the cast", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 0).characters = [{ characterId: "ghost", state: "talking" }];
    });
    expect(codesOf(report)).toContain("unknown_character");
    expect(report.ok).toBe(false);
  });

  it("flags a cast member nobody ever sees, without blocking the plan", () => {
    const report = breakManifest((draft) => {
      draft.cast.push({ id: "guest", name: "Guest", role: "guest", description: "" });
    });
    expect(codesOf(report)).toContain("unused_character");
    expect(report.issues.find((entry) => entry.code === "unused_character")!.severity).toBe("soft");
    expect(report.ok).toBe(true);
  });

  it("rejects a scene that is missing the block its type requires", () => {
    const cases: readonly [
      SceneManifest["scenes"][number]["type"],
      (scene: SceneManifest["scenes"][number]) => void,
      string,
    ][] = [
      ["CHARACTER", (scene) => (scene.characters = []), "missing_characters"],
      ["EVIDENCE", (scene) => (scene.text = undefined), "missing_text"],
      ["DIAGRAM", (scene) => (scene.diagram = undefined), "missing_diagram"],
      ["ENVIRONMENT", (scene) => (scene.media = undefined), "missing_assets"],
    ];
    for (const [type, edit, code] of cases) {
      const report = breakManifest((draft) => edit(sceneAt(draft, sceneIndexOfType(draft, type))));
      expect(codesOf(report), `${type} → ${code}`).toContain(code);
      expect(report.ok, type).toBe(false);
    }
  });

  it("rejects a figure card or a data diagram with no claim behind it", () => {
    const card = breakManifest((draft) => {
      const index = sceneIndexOfType(draft, "EVIDENCE");
      const scene = sceneAt(draft, index);
      scene.text = { ...scene.text!, kind: "number" };
      scene.sources = [];
      scene.sourceIds = [];
    });
    expect(codesOf(card)).toContain("missing_source_refs");

    const diagram = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "DIAGRAM"));
      scene.diagram!.claimIds = [];
      scene.sources = [];
      scene.sourceIds = [];
    });
    expect(codesOf(diagram)).toContain("missing_source_refs");
    expect(diagram.ok).toBe(false);
  });

  it("rejects claim and source references the script cannot back", () => {
    const claim = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "DIAGRAM"));
      scene.sources[0]!.claimId = "cl_ghost";
      scene.diagram!.claimIds = ["cl_ghost"];
    });
    expect(codesOf(claim)).toContain("unknown_claim");

    const excerpt = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "DIAGRAM"));
      scene.sources[0]!.evidence[0]!.excerpt = "Words the source never contained.";
    });
    expect(codesOf(excerpt)).toContain("unknown_source");

    const source = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "DIAGRAM"));
      scene.sourceIds = ["src_ghost"];
    });
    expect(codesOf(source)).toContain("unknown_source");
    expect(source.ok).toBe(false);
  });
});

describe("missing assets", () => {
  it("rejects a scene that needs an asset nobody planned", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, sceneIndexOfType(draft, "ENVIRONMENT")).media!.assets = ["asset_ghost"];
    });
    expect(codesOf(report)).toContain("unknown_asset");
    expect(report.ok).toBe(false);
  });

  it("rejects a scene using an asset that belongs to another scene", () => {
    const report = breakManifest((draft) => {
      const hybrid = sceneAt(draft, sceneIndexOfType(draft, "HYBRID"));
      const assetId = hybrid.media!.assets[0]!;
      const asset = draft.assets.find((candidate) => candidate.id === assetId)!;
      asset.sceneId = sceneAt(draft, 0).id;
    });
    expect(codesOf(report)).toContain("unowned_asset");
    expect(report.ok).toBe(false);
  });

  it("rejects the same asset id planned twice", () => {
    const report = breakManifest((draft) => {
      draft.assets.push({ ...draft.assets[0]! });
    });
    expect(codesOf(report)).toContain("duplicate_asset_id");
    expect(report.ok).toBe(false);
  });

  it("rejects an asset that belongs to no scene in the manifest", () => {
    const report = breakManifest((draft) => {
      draft.assets.push({
        ...draft.assets[0]!,
        id: "asset_lost",
        sceneId: "scn_nowhere",
      });
    });
    expect(codesOf(report)).toContain("unknown_scene");
    expect(report.ok).toBe(false);
  });

  it("flags an asset no scene asks for, without blocking the plan", () => {
    const report = breakManifest((draft) => {
      draft.assets.push({ ...draft.assets[0]!, id: "asset_spare" });
    });
    expect(codesOf(report)).toContain("orphan_asset");
    expect(
      report.issues.every((entry) => entry.code !== "orphan_asset" || entry.severity === "soft"),
    ).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("rejects footage shorter than the scene it has to fill", () => {
    const report = breakManifest((draft) => {
      draft.assets[0]!.minDurationSec = 60;
    });
    expect(codesOf(report)).toContain("invalid_duration");
    expect(report.ok).toBe(false);
  });
});

describe("invalid durations", () => {
  it("rejects a scene too short for the words it speaks", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, 2);
      scene.animation = []; // isolate the duration from the motion it would imply
      scene.durationSec = 1;
    });
    expect(codesOf(report)).toContain("invalid_duration");
    expect(report.issues.some((entry) => entry.message.includes("carries"))).toBe(true);
  });

  it("rejects a scene held far longer than its narration", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 2).durationSec = 30;
    });
    expect(codesOf(report)).toContain("invalid_duration");
    expect(codesOf(report)).toContain("long_scene");
    expect(report.ok).toBe(false);
  });

  it("rejects a total that is not the sum of the scenes", () => {
    const report = breakManifest((draft) => {
      draft.totalDurationSec = 99;
    });
    expect(codesOf(report)).toContain("duration_mismatch");
    expect(report.ok).toBe(false);
  });

  it("rejects an animation event that outlives its scene", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, 2);
      scene.animation.push({
        id: "too_late",
        atSec: scene.durationSec,
        durationSec: 1,
        kind: "fade_out",
        target: "scene",
        targetId: "",
        params: {},
      });
    });
    expect(codesOf(report)).toContain("invalid_animation");
  });

  it("rejects a cut with a duration to render", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, 0);
      scene.transition = { ...scene.transition, kind: "cut", durationSec: 0.5 };
    });
    expect(codesOf(report)).toContain("invalid_duration");
  });

  it("flags a long scene softly, so it can be reviewed rather than rejected", () => {
    const report = validateSceneManifest(manifestFixture(), { ...context, longSceneSec: 5 });
    expect(codesOf(report)).toContain("long_scene");
    expect(
      report.issues
        .filter((entry) => entry.code === "long_scene")
        .every((entry) => entry.severity === "soft"),
    ).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("rejects a narration estimate that does not follow from its word count", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 0).narration.estimatedDurationSec = 9.9;
    });
    expect(codesOf(report)).toContain("invalid_duration");
  });
});

describe("missing narration", () => {
  it("rejects a scene that speaks but names no sentence", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 0).narration.sentenceIds = [];
    });
    expect(codesOf(report)).toContain("missing_narration");
    expect(report.ok).toBe(false);
  });

  it("rejects narration that is not the sentence it claims", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, 0);
      scene.narration.text = "Words the script never wrote.";
      scene.narration.words = 5;
    });
    expect(codesOf(report)).toContain("narration_mismatch");
  });

  it("rejects a scene pointing at sentences the script does not have", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 0).narration.sentenceIds = ["s9_9"];
    });
    expect(codesOf(report)).toContain("dangling_narration");
    expect(report.ok).toBe(false);
  });

  it("rejects a word count that does not match the words on screen", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 0).narration.words = 99;
    });
    expect(codesOf(report)).toContain("narration_mismatch");
  });

  it("rejects a spoken bridge that is not the section's bridge", () => {
    const report = breakManifest((draft) => {
      const index = sceneIndexOfType(draft, "TRANSITION");
      const scene = sceneAt(draft, index);
      scene.narration.text = "Meanwhile, somewhere else entirely.";
      scene.narration.words = 4;
    });
    expect(codesOf(report)).toContain("narration_mismatch");
  });

  it("rejects narration the script does not contain when no sentence is named", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "CHARACTER"));
      scene.narration.kind = "paragraph";
      scene.narration.sentenceIds = [];
      scene.narration.text = "A line that only the planner knows.";
      scene.narration.words = 7;
    });
    expect(codesOf(report)).toContain("narration_mismatch");
  });

  it("rejects a scene that belongs to a section the script does not have", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "TRANSITION"));
      scene.sectionId = "sec9";
      scene.narration.sectionId = "sec9";
    });
    expect(codesOf(report)).toContain("dangling_narration");
  });
});

describe("unsupported scene types", () => {
  it("rejects a scene type outside the six-type vocabulary", () => {
    const report = breakManifest((draft) => {
      (sceneAt(draft, 0) as unknown as Record<string, unknown>).type = "SONG";
    });
    expect(codesOf(report)).toContain("unsupported_scene_type");
    expect(report.ok).toBe(false);
    expect(report.issues[0]!.path).toBe("scenes.0.type");
  });

  it("rejects a type whose narration does not match what it speaks", () => {
    const report = breakManifest((draft) => {
      const scene = sceneAt(draft, sceneIndexOfType(draft, "TRANSITION"));
      scene.narration = { ...scene.narration, kind: "sentence", sentenceIds: ["s1_1"] };
    });
    expect(codesOf(report)).toContain("invalid_manifest");
    expect(report.ok).toBe(false);
  });

  it("accepts all six types when they are shaped correctly", () => {
    const report = validateSceneManifest(manifestFixture(), context);
    expect(report.ok).toBe(true);
    const manifest = manifestFixture();
    for (const type of [
      "CHARACTER",
      "EVIDENCE",
      "HYBRID",
      "DIAGRAM",
      "ENVIRONMENT",
      "TRANSITION",
    ] as const) {
      expect(scenesOfType(manifest, type).length, type).toBeGreaterThan(0);
    }
  });
});

describe("the issue vocabulary", () => {
  it("gives every code a severity and keeps the hard list meaningful", () => {
    const severities = new Set<SceneIssueSeverity>(
      SCENE_ISSUE_CODES.map((code) => sceneIssueSeverity(code)),
    );
    expect([...severities].sort()).toEqual(["hard", "soft"]);
    expect(sceneIssueSeverity("narration_mismatch")).toBe("hard");
    expect(sceneIssueSeverity("long_scene")).toBe("soft");
  });

  it("reports the scene an issue belongs to", () => {
    const report = breakManifest((draft) => {
      sceneAt(draft, 4).durationSec = 0.4; // its own animation no longer fits
    });
    expect(report.issues.map((entry) => entry.sceneId)).toContain(sceneAt(manifestFixture(), 4).id);
    expect(report.issues[0]!.path.startsWith("scenes.4.")).toBe(true);
  });

  it("leaves a manifest-wide issue unattributed", () => {
    const report = breakManifest((draft) => {
      draft.totalDurationSec = 99;
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "duration_mismatch", sceneId: "", path: "totalDurationSec" }),
    ]);
  });
});

describe("cast against a character library", () => {
  const withLibrary = (library = characterLibraryView()): SceneValidationContext => ({
    script,
    characters: library,
  });

  it("reports a cast member the library does not define, hard", () => {
    const report = validateSceneManifest(manifestFixture(), withLibrary());
    const issue = report.issues.find((entry) => entry.code === "missing_character_definition");
    expect(issue).toMatchObject({ severity: "soft", path: "cast.0.definition" });
    expect(issue?.message).toContain("does not record the definition");
    expect(report.ok).toBe(true);
  });

  it("checks a recorded definition for staleness", () => {
    const matching = breakManifest((draft) => {
      draft.cast[0]!.definition = {
        characterId: "presenter",
        version: 1,
        hash: CHARACTER_DEFINITION_HASH,
      };
    }, withLibrary());
    expect(matching).toMatchObject({ ok: true, issues: [] });

    const stale = breakManifest((draft) => {
      draft.cast[0]!.definition = {
        characterId: "presenter",
        version: 1,
        hash: "d".repeat(64),
      };
    }, withLibrary());
    expect(stale.ok).toBe(false);
    const issue = stale.issues.find((entry) => entry.code === "character_definition_mismatch");
    expect(issue).toMatchObject({ severity: "hard", path: "cast.0.definition" });
    expect(issue?.message).toContain("was planned against version 1");
  });

  it("reports a cast member the library has never heard of, hard", () => {
    const report = validateSceneManifest(
      manifestFixture(),
      withLibrary(characterLibraryView({ ids: ["someone_else"] })),
    );
    expect(report.ok).toBe(false);
    expect(codesOf(report)).toContain("unknown_character_definition");
    const issue = report.issues.find((entry) => entry.code === "unknown_character_definition");
    expect(issue).toMatchObject({ severity: "hard", path: "cast.0.id" });
    expect(issue?.detail).toContain("someone_else");
  });

  it("leaves the character checks off when no library is given", () => {
    const report = validateSceneManifest(manifestFixture(), context);
    expect(codesOf(report)).not.toContain("missing_character_definition");
    expect(codesOf(report)).not.toContain("unknown_character_definition");
    expect(codesOf(report)).not.toContain("character_definition_mismatch");
  });
});
