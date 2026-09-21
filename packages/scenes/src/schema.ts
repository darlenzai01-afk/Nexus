import { Sha256Schema, ScriptSectionRoleSchema } from "@nexus/db";
import { z } from "zod";

import { SCENE_TYPE_SPECS, type SceneRequirement } from "./scene-types.js";
import { wordCount } from "@nexus/script";

/**
 * The scene manifest contract (Phase 7).
 *
 * A scene manifest is the *only* thing downstream stages are allowed to read a
 * video from: media sourcing needs the asset inventory and search hints, voice
 * needs the narration in shot order, captions need the same, the renderer needs
 * camera, animation events and transitions — and the fact-check/QA path needs
 * every scene still pointing at the research claims and sources behind it.
 *
 * Two layers, on purpose:
 *
 * 1. **These schemas** reject malformed documents. Every object is *strict*: an
 *    unknown field is an error, not a silent drop, so a manifest cannot carry
 *    a `durtionSec` that nobody notices. Cross-block rules that hold for any
 *    document (unique ids, sequential indices, transitions pointing at the next
 *    scene, assets that exist, characters that are in the cast, animation inside
 *    its scene) are enforced here too.
 * 2. **`validateSceneManifest()`** (`./validate.ts`) adds what needs context or
 *    arithmetic: scene durations against the narration they carry, the timeline,
 *    narration and claim references resolved against the script the manifest came
 *    from, and the soft pacing warnings. It maps every schema failure onto the
 *    same coded issue list, so a caller never has to read a zod message to know
 *    *what kind* of thing is wrong.
 */

export const SCENE_MANIFEST_VERSION = 1 as const;
/** No single shot lasts longer than this, whatever the narration says. */
export const MAX_SCENE_DURATION_SEC = 120;
export const MIN_SCENE_DURATION_SEC = 0.25;
export const MAX_ANIMATION_EVENTS = 12;
export const MAX_DIAGRAM_SERIES = 12;

/** Ids are opaque to the schema but must be readable in a log line. */
const IdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u,
    "expected a 1-64 char id (letters, digits, . _ : -)",
  );

/** A sha256 hex — the CAS identity of the script this manifest was planned from. */
export const SceneScriptHashSchema = Sha256Schema;

// ── Scene types and issue vocabulary ─────────────────────────────────────

export const SCENE_TYPES = [
  "CHARACTER",
  "EVIDENCE",
  "HYBRID",
  "DIAGRAM",
  "ENVIRONMENT",
  "TRANSITION",
] as const;
export const SceneTypeSchema = z.enum(SCENE_TYPES);
export type SceneType = z.infer<typeof SceneTypeSchema>;

/**
 * Every way a manifest can be wrong, as data. The strict schemas tag their own
 * failures with these (`params.code`), the validator reports all of them, and
 * `docs/architecture/scene-planner.md` documents them.
 */
export const SCENE_ISSUE_CODES = [
  // structure
  "invalid_manifest",
  "unsupported_scene_type",
  "empty_manifest",
  "duplicate_scene_id",
  "invalid_timeline",
  // durations
  "invalid_duration",
  "duration_mismatch",
  "long_scene",
  // narration
  "missing_narration",
  "dangling_narration",
  "narration_mismatch",
  // type requirements
  "missing_characters",
  "missing_text",
  "missing_diagram",
  "missing_assets",
  // references
  "unknown_asset",
  "unowned_asset",
  "duplicate_asset_id",
  "orphan_asset",
  "unknown_scene",
  "unknown_character",
  "unused_character",
  // character definitions (Phase 8)
  "unknown_character_definition",
  "character_definition_mismatch",
  "missing_character_definition",
  "unknown_claim",
  "unknown_source",
  "missing_source_refs",
  // motion
  "invalid_animation",
  "invalid_transition",
  "dangling_transition",
] as const;
export const SceneIssueCodeSchema = z.enum(SCENE_ISSUE_CODES);
export type SceneIssueCode = z.infer<typeof SceneIssueCodeSchema>;

export const SceneIssueSeveritySchema = z.enum(["hard", "soft"]);
export type SceneIssueSeverity = z.infer<typeof SceneIssueSeveritySchema>;

/** Codes that make a manifest unfit to hand to a renderer. */
export const HARD_SCENE_ISSUE_CODES: readonly SceneIssueCode[] = [
  "invalid_manifest",
  "unsupported_scene_type",
  "empty_manifest",
  "duplicate_scene_id",
  "invalid_timeline",
  "invalid_duration",
  "duration_mismatch",
  "missing_narration",
  "dangling_narration",
  "narration_mismatch",
  "missing_characters",
  "missing_text",
  "missing_diagram",
  "missing_assets",
  "unknown_asset",
  "unowned_asset",
  "duplicate_asset_id",
  "unknown_scene",
  "unknown_character",
  "unknown_character_definition",
  "character_definition_mismatch",
  "unknown_claim",
  "unknown_source",
  "missing_source_refs",
  "invalid_animation",
  "invalid_transition",
  "dangling_transition",
];

export function sceneIssueSeverity(code: SceneIssueCode): SceneIssueSeverity {
  return HARD_SCENE_ISSUE_CODES.includes(code) ? "hard" : "soft";
}

// ── Cast and on-screen characters ────────────────────────────────────────

export const SceneCastRoleSchema = z.enum(["host", "narrator", "guest", "expert", "character"]);
export type SceneCastRole = z.infer<typeof SceneCastRoleSchema>;

/**
 * Which revision of a character definition a cast member was planned against —
 * the id, the schema version and the sha256 of the definition's canonical bytes.
 *
 * This is the *whole* character link: a manifest records the reference, never the
 * pose list, palette or asset paths, so a character can be fixed in one place
 * (`@nexus/characters`) without rewriting a single scene.
 */
export const SceneCharacterDefinitionSchema = z.strictObject({
  characterId: IdSchema,
  version: z.number().int().positive(),
  hash: Sha256Schema,
});
export type SceneCharacterDefinition = z.infer<typeof SceneCharacterDefinitionSchema>;

/** A person the video may show. The script never invents one; the planner takes it as input. */
export const SceneCastMemberSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(80),
  role: SceneCastRoleSchema,
  description: z.string().max(400).default(""),
  /** The character definition behind this member, when one exists. */
  definition: SceneCharacterDefinitionSchema.optional(),
});
export type SceneCastMember = z.infer<typeof SceneCastMemberSchema>;

/** How a cast member is doing on screen — the rig the renderer will pose. */
export const SceneCharacterStateSchema = z.enum([
  "idle",
  "talking",
  "listening",
  "gesturing",
  "pointing",
  "reacting",
  "entering",
  "exiting",
]);
export type SceneCharacterState = z.infer<typeof SceneCharacterStateSchema>;

export const SceneCastEntrySchema = z.strictObject({
  characterId: IdSchema,
  state: SceneCharacterStateSchema,
});
export type SceneCastEntry = z.infer<typeof SceneCastEntrySchema>;

// ── Camera ───────────────────────────────────────────────────────────────

export const SceneShotSchema = z.enum([
  "wide",
  "medium",
  "medium_close",
  "close_up",
  "extreme_close_up",
  "over_shoulder",
  "pov",
  "insert",
]);
export const SceneCameraMovementSchema = z.enum([
  "static",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_in",
  "dolly_out",
  "zoom_in",
  "zoom_out",
  "handheld",
  "crane_up",
  "crane_down",
  "whip_pan",
]);
export const SceneCameraAngleSchema = z.enum(["eye_level", "high", "low", "overhead", "dutch"]);
export const SceneCameraFocusSchema = z.enum([
  "presenter",
  "screen",
  "diagram",
  "background",
  "action",
]);

export const SceneCameraSchema = z.strictObject({
  shot: SceneShotSchema,
  movement: SceneCameraMovementSchema,
  angle: SceneCameraAngleSchema,
  focus: SceneCameraFocusSchema,
});
export type SceneCamera = z.infer<typeof SceneCameraSchema>;

// ── Media ────────────────────────────────────────────────────────────────

export const SceneMediaKindSchema = z.enum(["image", "video", "document", "generated"]);
export type SceneMediaKind = z.infer<typeof SceneMediaKindSchema>;
export const SceneMediaOrientationSchema = z.enum(["landscape", "portrait", "square", "any"]);
export const SceneMediaTreatmentSchema = z.enum([
  "full_frame",
  "overlay",
  "split_screen",
  "background",
  "picture_in_picture",
]);

export const SceneMediaSchema = z.strictObject({
  kind: SceneMediaKindSchema,
  /** What the audience should see, in the planner's own words. */
  description: z.string().min(1).max(400),
  /** Optional hint for the media search stage (licence rules apply there, AD-09). */
  searchHint: z.string().max(200).default(""),
  orientation: SceneMediaOrientationSchema.default("landscape"),
  treatment: SceneMediaTreatmentSchema.default("full_frame"),
  /** Ids in the manifest's `assets` inventory; the schema refuses dangling ones. */
  assets: z.array(IdSchema).max(8).default([]),
});
export type SceneMedia = z.infer<typeof SceneMediaSchema>;

// ── On-screen text ───────────────────────────────────────────────────────

export const SceneTextKindSchema = z.enum([
  "title",
  "claim",
  "quote",
  "number",
  "label",
  "callout",
]);
export type SceneTextKind = z.infer<typeof SceneTextKindSchema>;
export const SceneTextPositionSchema = z.enum([
  "lower_third",
  "center",
  "upper_third",
  "corner",
  "full_screen",
]);

export const SceneTextSchema = z.strictObject({
  kind: SceneTextKindSchema,
  /** Verbatim from the script or its evidence — never re-written by the planner. */
  value: z.string().min(1).max(300),
  /** Where the words came from, when the scene shows someone else's material. */
  attribution: z.string().max(200).default(""),
  position: SceneTextPositionSchema.default("lower_third"),
  maxLines: z.number().int().min(1).max(6).default(2),
});
export type SceneText = z.infer<typeof SceneTextSchema>;

// ── Diagrams ─────────────────────────────────────────────────────────────

export const SceneDiagramKindSchema = z.enum([
  "number_highlight",
  "bar_chart",
  "line_chart",
  "table",
  "timeline",
  "map",
  "flow",
  "comparison",
  "schematic",
]);
export type SceneDiagramKind = z.infer<typeof SceneDiagramKindSchema>;
/** Diagram kinds that plot researched numbers, so they must cite claims. */
export const DATA_DIAGRAM_KINDS: readonly SceneDiagramKind[] = [
  "number_highlight",
  "bar_chart",
  "line_chart",
  "table",
];

export const SceneDiagramSeriesSchema = z.strictObject({
  label: z.string().min(1).max(80),
  value: z.number().finite(),
  unit: z.string().max(24).default(""),
});

export const SceneDiagramSchema = z.strictObject({
  kind: SceneDiagramKindSchema,
  title: z.string().max(160).default(""),
  /** Labels or verbatim figures shown on the drawing (from the claim text). */
  annotations: z.array(z.string().min(1).max(200)).max(12).default([]),
  /** Optional plotted numbers; the media/diagram stage fills this when it has data. */
  series: z.array(SceneDiagramSeriesSchema).max(MAX_DIAGRAM_SERIES).default([]),
  /** The claims the drawing is made of — a diagram may not invent numbers. */
  claimIds: z.array(IdSchema).max(8).default([]),
});
export type SceneDiagram = z.infer<typeof SceneDiagramSchema>;

// ── Animation events ─────────────────────────────────────────────────────

export const SceneAnimationKindSchema = z.enum([
  "fade_in",
  "fade_out",
  "slide_in",
  "slide_out",
  "scale_in",
  "type_on",
  "count_up",
  "highlight",
  "lower_third",
  "callout",
  "wipe_in",
  "push_in",
  "zoom_to",
  "pulse",
  "split_open",
  "dissolve_out",
]);
export type SceneAnimationKind = z.infer<typeof SceneAnimationKindSchema>;
export const SceneAnimationTargetSchema = z.enum([
  "scene",
  "character",
  "media",
  "text",
  "diagram",
]);

export const SceneAnimationEventSchema = z.strictObject({
  id: IdSchema,
  /** Seconds from the start of the scene. */
  atSec: z.number().nonnegative(),
  durationSec: z.number().positive().max(MAX_SCENE_DURATION_SEC),
  kind: SceneAnimationKindSchema,
  target: SceneAnimationTargetSchema,
  /** Character id, asset id, or "" when the event targets the scene itself. */
  targetId: z.string().max(64).default(""),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type SceneAnimationEvent = z.infer<typeof SceneAnimationEventSchema>;

// ── Transitions ──────────────────────────────────────────────────────────

export const SceneTransitionKindSchema = z.enum([
  "cut",
  "dissolve",
  "fade_to_black",
  "fade_from_black",
  "wipe_left",
  "wipe_right",
  "slide_up",
  "slide_down",
  "match_cut",
  "zoom_through",
  "dip_to_white",
]);
export type SceneTransitionKind = z.infer<typeof SceneTransitionKindSchema>;
export const SceneTransitionAudioSchema = z.enum(["none", "crossfade", "whoosh", "impact", "beat"]);

export const SceneTransitionSchema = z.strictObject({
  kind: SceneTransitionKindSchema,
  /** Overlap the renderer applies at the seam; `cut` is 0. */
  durationSec: z.number().nonnegative().max(2).default(0),
  /** The scene this one hands over to; "" on the last scene of the manifest. */
  toSceneId: z.string().max(64).default(""),
  audio: SceneTransitionAudioSchema.default("crossfade"),
});
export type SceneTransition = z.infer<typeof SceneTransitionSchema>;

// ── Source references (the claim/evidence chain, per scene) ──────────────

export const SceneEvidenceRefSchema = z.strictObject({
  sourceId: IdSchema,
  url: z.string().url().max(2048),
  /** Verbatim characters from the source — the same excerpt the script ledger holds. */
  excerpt: z.string().min(1).max(2000),
  /** `start:end` offsets into that source's stored text. */
  locator: z.string().regex(/^\d+:\d+$/u, "expected start:end offsets"),
});
export type SceneEvidenceRef = z.infer<typeof SceneEvidenceRefSchema>;

export const SceneClaimRefSchema = z.strictObject({
  claimId: IdSchema,
  statement: z.string().min(1).max(600),
  /** How the narration uses the claim: asserted, or reported with attribution. */
  usage: z.enum(["fact", "attributed"]),
  status: z.enum(["supported", "contradicted", "unverified", "unsupportable", "overridden"]),
  certainty: z.enum(["established", "likely", "disputed", "unsupported", "uncertain"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(SceneEvidenceRefSchema).max(8).default([]),
});
export type SceneClaimRef = z.infer<typeof SceneClaimRefSchema>;

// ── Asset inventory ──────────────────────────────────────────────────────

export const SceneAssetKindSchema = z.enum(["image", "video", "document", "audio", "generated"]);
export type SceneAssetKind = z.infer<typeof SceneAssetKindSchema>;
export const SceneAssetPurposeSchema = z.enum([
  "broll",
  "still",
  "portrait",
  "document",
  "chart",
  "map",
  "music",
  "sfx",
  "texture",
]);
export type SceneAssetPurpose = z.infer<typeof SceneAssetPurposeSchema>;
export const SceneAssetStatusSchema = z.enum(["planned", "resolved", "missing", "rejected"]);
export const SceneAssetLicenceSchema = z.enum([
  "unknown",
  "public_domain",
  "cc0",
  "cc_by",
  "cc_by_sa",
  "licensed",
  "operator_supplied",
  "generated",
]);

export const SceneAssetSchema = z.strictObject({
  id: IdSchema,
  /** The scene this asset exists for. */
  sceneId: IdSchema,
  kind: SceneAssetKindSchema,
  purpose: SceneAssetPurposeSchema,
  description: z.string().min(1).max(400),
  searchHint: z.string().max(200).default(""),
  orientation: SceneMediaOrientationSchema.default("landscape"),
  /** For footage: how many seconds it has to fill. */
  minDurationSec: z.number().nonnegative().max(MAX_SCENE_DURATION_SEC).default(0),
  status: SceneAssetStatusSchema.default("planned"),
  /** Filled by the media stage; empty while the asset is only planned. */
  uri: z.string().max(2048).default(""),
  licence: SceneAssetLicenceSchema.default("unknown"),
});
export type SceneAsset = z.infer<typeof SceneAssetSchema>;

// ── Narration reference ──────────────────────────────────────────────────

/**
 * How a scene's narration refers back into the script.
 *
 * - `sentence` — the scene speaks these script sentences, verbatim (the planner's
 *   output, and the only form that can be traced sentence by sentence).
 * - `paragraph` — the scene speaks script narration that is not addressable by
 *   sentence id: a legacy v1 script artifact, or a hand-written plan. The words
 *   still have to appear in the script, they just cannot be pinned to a sentence.
 * - `transition` — the scene speaks a section's spoken bridge (`section.transition`).
 */
export const SceneNarrationKindSchema = z.enum(["sentence", "paragraph", "transition"]);
export type SceneNarrationKind = z.infer<typeof SceneNarrationKindSchema>;

export const SceneNarrationSchema = z.strictObject({
  kind: SceneNarrationKindSchema,
  /** The spoken words on this scene, verbatim from the script. */
  text: z.string().min(1).max(2000),
  sectionId: IdSchema,
  role: ScriptSectionRoleSchema,
  /** Script sentence ids this scene speaks; empty for `paragraph` and `transition`. */
  sentenceIds: z.array(IdSchema).max(4).default([]),
  words: z.number().int().positive(),
  /** Words ÷ the manifest's `wordsPerSecond`, to one decimal. */
  estimatedDurationSec: z.number().positive().max(MAX_SCENE_DURATION_SEC),
});
export type SceneNarration = z.infer<typeof SceneNarrationSchema>;

// ── A scene ──────────────────────────────────────────────────────────────

const REQUIREMENT_ISSUES: Readonly<
  Record<SceneRequirement, { code: SceneIssueCode; message: string; path: readonly string[] }>
> = {
  characters: {
    code: "missing_characters",
    message: "a scene of this type has to show a cast member, but names none",
    path: ["characters"],
  },
  text: {
    code: "missing_text",
    message: "a scene of this type has to carry on-screen text, but has none",
    path: ["text"],
  },
  diagram: {
    code: "missing_diagram",
    message: "a scene of this type has to carry a diagram, but has none",
    path: ["diagram"],
  },
  media_assets: {
    code: "missing_assets",
    message: "a scene of this type has to name at least one asset, but names none",
    path: ["media", "assets"],
  },
};

function requirementPresent(scene: SceneShape, requirement: SceneRequirement): boolean {
  switch (requirement) {
    case "characters":
      return scene.characters.length > 0;
    case "text":
      return scene.text !== undefined;
    case "diagram":
      return scene.diagram !== undefined;
    case "media_assets":
      return scene.media !== undefined && scene.media.assets.length > 0;
  }
}

interface SceneShape {
  readonly characters: readonly SceneCastEntry[];
  readonly media?: SceneMedia | undefined;
  readonly text?: SceneText | undefined;
  readonly diagram?: SceneDiagram | undefined;
}

export const SceneSchema = z
  .strictObject({
    id: IdSchema,
    /** Position in the manifest; the validator insists it is 0-based and gapless. */
    index: z.number().int().nonnegative(),
    type: SceneTypeSchema,
    /** Where this scene came from in the script. */
    sectionId: IdSchema,
    role: ScriptSectionRoleSchema,
    /** Seconds from the start of the video. */
    startSec: z.number().nonnegative(),
    durationSec: z.number().gt(0).max(MAX_SCENE_DURATION_SEC),
    narration: SceneNarrationSchema,
    /** Who is on screen and what they are doing. */
    characters: z.array(SceneCastEntrySchema).max(6).default([]),
    media: SceneMediaSchema.optional(),
    text: SceneTextSchema.optional(),
    diagram: SceneDiagramSchema.optional(),
    camera: SceneCameraSchema,
    animation: z.array(SceneAnimationEventSchema).max(MAX_ANIMATION_EVENTS).default([]),
    transition: SceneTransitionSchema,
    /** Research claims this scene shows, with their verbatim evidence. */
    sources: z.array(SceneClaimRefSchema).max(6).default([]),
    /** Flat list of research source ids visible in this scene. */
    sourceIds: z.array(IdSchema).max(8).default([]),
    /** Planner/operator notes about this specific scene. */
    notes: z.array(z.string().max(300)).max(6).default([]),
  })
  .superRefine((scene, ctx) => {
    // The type decides which blocks must be present.
    for (const requirement of SCENE_TYPE_SPECS[scene.type].requires) {
      if (!requirementPresent(scene, requirement)) {
        const issue = REQUIREMENT_ISSUES[requirement];
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...issue.path],
          message: `${scene.type} scene ${scene.id}: ${issue.message}`,
          params: { code: issue.code },
        });
      }
    }

    // A cut has no overlap to render; anything else needs one to be visible.
    if (scene.transition.kind === "cut" && scene.transition.durationSec !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transition", "durationSec"],
        message: `scene ${scene.id}: a cut is instant, not ${scene.transition.durationSec}s`,
        params: { code: "invalid_duration" },
      });
    }

    // The narration block has to be internally consistent with the type's shape.
    const spec = SCENE_TYPE_SPECS[scene.type];
    const narrationIssue = (path: string, message: string, code: SceneIssueCode): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message, params: { code } });
    };
    if (spec.narration === "sentence") {
      if (scene.narration.kind === "sentence" && scene.narration.sentenceIds.length === 0) {
        narrationIssue(
          "narration.sentenceIds",
          `scene ${scene.id}: a ${scene.type} scene speaks script sentences, but references none`,
          "missing_narration",
        );
      }
      if (scene.narration.kind === "paragraph" && scene.narration.sentenceIds.length > 0) {
        narrationIssue(
          "narration.sentenceIds",
          `scene ${scene.id}: narration that cannot name its sentences must not list any`,
          "invalid_manifest",
        );
      }
      if (scene.narration.kind === "transition") {
        narrationIssue(
          "narration.kind",
          `scene ${scene.id}: a ${scene.type} scene carries spoken narration, not a section bridge`,
          "invalid_manifest",
        );
      }
    } else {
      if (scene.narration.kind !== "transition") {
        narrationIssue(
          "narration.kind",
          `scene ${scene.id}: a ${scene.type} scene carries the section's spoken bridge`,
          "invalid_manifest",
        );
      }
      if (scene.narration.sentenceIds.length > 0) {
        narrationIssue(
          "narration.sentenceIds",
          `scene ${scene.id}: a spoken transition comes from a section, not from a sentence`,
          "invalid_manifest",
        );
      }
    }
    const words = wordCount(scene.narration.text);
    if (words !== scene.narration.words) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["narration", "words"],
        message: `scene ${scene.id}: narration says ${scene.narration.words} word(s) but the text has ${words}`,
        params: { code: "narration_mismatch" },
      });
    }

    // Animation events have to fit inside the scene, in order, once each.
    const seen = new Set<string>();
    let previous = -1;
    for (const [position, event] of scene.animation.entries()) {
      const at = ["animation", position] as const;
      if (seen.has(event.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...at, "id"],
          message: `scene ${scene.id}: animation event id ${event.id} is used twice`,
          params: { code: "invalid_animation" },
        });
      }
      seen.add(event.id);
      if (event.atSec < previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...at, "atSec"],
          message: `scene ${scene.id}: animation events must be ordered, ${event.id} starts before the one before it`,
          params: { code: "invalid_animation" },
        });
      }
      if (event.atSec + event.durationSec > scene.durationSec + 0.05) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...at, "durationSec"],
          message: `scene ${scene.id}: animation ${event.id} ends at ${(event.atSec + event.durationSec).toFixed(1)}s, past the scene's ${scene.durationSec}s`,
          params: { code: "invalid_animation" },
        });
      }
      previous = event.atSec;
    }
  });
export type Scene = z.infer<typeof SceneSchema>;

// ── The manifest ─────────────────────────────────────────────────────────

export const SceneAspectSchema = z.enum(["16:9", "9:16", "1:1"]);
export type SceneAspect = z.infer<typeof SceneAspectSchema>;

export const SceneResolutionSchema = z.strictObject({
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});
export type SceneResolution = z.infer<typeof SceneResolutionSchema>;

export const SCENE_ENGINE = { name: "nexus-scenes", version: "1.0.0" } as const;

export const ScenePlanningStepSchema = z.enum([
  "cast",
  "types",
  "timing",
  "camera",
  "animation",
  "assets",
  "validate",
]);
export type ScenePlanningStep = z.infer<typeof ScenePlanningStepSchema>;

export const SceneStepTraceSchema = z.strictObject({
  step: ScenePlanningStepSchema,
  /** `none` for every step today: planning is deterministic (AD-07). */
  engine: z.enum(["none", "llm"]),
  notes: z.array(z.string().max(400)).default([]),
});
export type SceneStepTrace = z.infer<typeof SceneStepTraceSchema>;

export const SceneManifestProvenanceSchema = z.strictObject({
  engine: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  steps: z.array(SceneStepTraceSchema).default([]),
  aiSteps: z.array(ScenePlanningStepSchema).default([]),
  deterministicSteps: z.array(ScenePlanningStepSchema).default([]),
  generatedAt: z.string().datetime(),
});
export type SceneManifestProvenance = z.infer<typeof SceneManifestProvenanceSchema>;

export const SceneManifestSchema = z
  .strictObject({
    version: z.literal(SCENE_MANIFEST_VERSION),
    topic: z.string().min(1).max(400),
    workingTitle: z.string().min(1).max(200),
    /** The database row, when the script has one. */
    scriptId: z.string().max(64).default(""),
    scriptHash: SceneScriptHashSchema,
    generatedAt: z.string().datetime(),
    fps: z.number().int().positive().max(120).default(30),
    aspect: SceneAspectSchema.default("16:9"),
    resolution: SceneResolutionSchema,
    /** Narration pace every duration in the manifest was computed with. */
    wordsPerSecond: z.number().positive().max(10).default(2.5),
    /** Must equal the sum of the scene durations (validated, not assumed). */
    totalDurationSec: z
      .number()
      .positive()
      .max(10 * 60 * 60),
    cast: z.array(SceneCastMemberSchema).max(12).default([]),
    scenes: z.array(SceneSchema).min(1),
    /** Every asset the scenes need, in one place, for the media stage. */
    assets: z.array(SceneAssetSchema).max(200).default([]),
    warnings: z.array(z.string().max(400)).default([]),
    provenance: SceneManifestProvenanceSchema,
  })
  .superRefine((manifest, ctx) => {
    const add = (
      code: SceneIssueCode,
      message: string,
      path: readonly (string | number)[],
    ): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message, params: { code } });
    };

    // Scene ids and indices: the manifest is a gapless, ordered timeline.
    const sceneIds = new Set<string>();
    for (const [position, scene] of manifest.scenes.entries()) {
      if (sceneIds.has(scene.id)) {
        add("duplicate_scene_id", `scene id ${scene.id} is used twice`, ["scenes", position, "id"]);
      }
      sceneIds.add(scene.id);
      if (scene.index !== position) {
        add(
          "invalid_timeline",
          `scene ${scene.id} is at position ${position} but declares index ${scene.index}`,
          ["scenes", position, "index"],
        );
      }
    }

    // Every scene hands over to the next one, and the last one ends the video.
    for (const [position, scene] of manifest.scenes.entries()) {
      const next = manifest.scenes[position + 1];
      const expected = next?.id ?? "";
      if (scene.transition.toSceneId !== expected) {
        add(
          "dangling_transition",
          next === undefined
            ? `the last scene ${scene.id} must end the video (toSceneId ""), not hand over to "${scene.transition.toSceneId}"`
            : `scene ${scene.id} hands over to "${scene.transition.toSceneId}" instead of the next scene ${next.id}`,
          ["scenes", position, "transition", "toSceneId"],
        );
      }
    }

    // The cast is closed: a scene may only show someone who exists. (A cast member
    // nobody shows is a note, not a shape error — `validate.ts` reports it softly.)
    const castIds = new Set(manifest.cast.map((member) => member.id));
    for (const [position, scene] of manifest.scenes.entries()) {
      for (const [slot, entry] of scene.characters.entries()) {
        if (!castIds.has(entry.characterId)) {
          add(
            "unknown_character",
            `scene ${scene.id} shows "${entry.characterId}", who is not in the cast`,
            ["scenes", position, "characters", slot, "characterId"],
          );
        }
      }
    }

    // Assets: unique, owned by a real scene, and referenced by the scene that owns them.
    const assetIds = new Set<string>();
    const referenced = new Set<string>();
    for (const [position, asset] of manifest.assets.entries()) {
      if (assetIds.has(asset.id)) {
        add("duplicate_asset_id", `asset id ${asset.id} is used twice`, ["assets", position, "id"]);
      }
      assetIds.add(asset.id);
      if (!sceneIds.has(asset.sceneId)) {
        add(
          "unknown_scene",
          `asset ${asset.id} belongs to scene "${asset.sceneId}", which is not in the manifest`,
          ["assets", position, "sceneId"],
        );
      }
    }
    for (const [position, scene] of manifest.scenes.entries()) {
      for (const [slot, assetId] of (scene.media?.assets ?? []).entries()) {
        referenced.add(assetId);
        const asset = manifest.assets.find((candidate) => candidate.id === assetId);
        if (asset === undefined) {
          add(
            "unknown_asset",
            `scene ${scene.id} needs asset "${assetId}", which is not in the inventory`,
            ["scenes", position, "media", "assets", slot],
          );
        } else if (asset.sceneId !== scene.id) {
          add(
            "unowned_asset",
            `scene ${scene.id} uses asset "${assetId}", but that asset belongs to scene ${asset.sceneId}`,
            ["scenes", position, "media", "assets", slot],
          );
        }
      }
    }
  });
export type SceneManifest = z.infer<typeof SceneManifestSchema>;
/** What a caller may hand the parser: defaults filled in, planning fields optional. */
export type SceneManifestInput = z.input<typeof SceneManifestSchema>;

/** Parse + validate a manifest read back from anywhere. Throws on the first pass. */
export function parseSceneManifest(input: unknown): SceneManifest {
  return SceneManifestSchema.parse(input);
}

/** Canonical bytes of a scene manifest — what the CAS artifact holds. */
export function sceneManifestBytes(manifest: SceneManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Scenes of one type, in shot order. */
export function scenesOfType(manifest: SceneManifest, type: SceneType): Scene[] {
  return manifest.scenes.filter((scene) => scene.type === type);
}

/** Every narration line in shot order — what the voice stage reads. */
export function manifestNarration(manifest: SceneManifest): string[] {
  return manifest.scenes.map((scene) => scene.narration.text);
}
