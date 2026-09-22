import { z } from "zod";

import type { Scene, SceneTextPosition } from "@nexus/scenes";

/**
 * The short-form repurposing engine's documents.
 *
 * Two artifacts leave the engine, both versioned and schema-validated like
 * every other document in the system:
 *
 * - **`ShortsPlan`** — the selection: every candidate span the engine
 *   considered, the ones it rejected *and why* (context dependence is a
 *   rejection, not a low score), the survivors' factor-by-factor scores, and
 *   the exact source timecodes each candidate covers.
 * - **`VerticalLayout`** — the reflow: for one candidate, the 9:16 framing
 *   decision per scene (the camera window, where text, media and the caption
 *   band go), recorded as reviewable data next to the re-composed manifest.
 *
 * The engine never touches pixels. It emits documents the planner and the
 * renderer already consume.
 */

export const SHORTS_ENGINE = { name: "nexus-shorts", version: "1.0.0" } as const;

export const SHORTS_PLAN_VERSION = 1;
export const VERTICAL_LAYOUT_VERSION = 1;

/** The default 9:16 delivery canvas (the same geometry a phone expects). */
export const VERTICAL_CANVAS = { width: 1080, height: 1920 } as const;

// ── Scoring factors ──────────────────────────────────────────────────────

export const SHORTS_FACTOR_CODES = [
  "hook",
  "curiosity",
  "surprise",
  "standalone",
  "payoff",
  "emotion",
  "visual",
] as const;
export type ShortsFactorCode = (typeof SHORTS_FACTOR_CODES)[number];

export const ShortsFactorSchema = z.strictObject({
  code: z.enum(SHORTS_FACTOR_CODES),
  /** 0..1, deterministic over the span's own documents. */
  score: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  /** What the factor saw, so a score is never a bare number. */
  reasons: z.array(z.string().min(1).max(200)).max(8).default([]),
});
export type ShortsFactor = z.infer<typeof ShortsFactorSchema>;

// ── Rejections ───────────────────────────────────────────────────────────

export const SHORTS_REJECT_CODES = [
  /** Opens on a subject pronoun or bare demonstrative ("It turns out…"). */
  "context_opener_unresolved",
  /** Opens on a connective that needs the sentence before it ("But…"). */
  "context_connective_open",
  /** Points at content before the span ("as we saw earlier…"). */
  "context_backward_reference",
  /** Ends mid-contrast — the payoff is in the next sentence. */
  "context_unfinished_contrast",
  /** Promises content the span never delivers ("stick around…"). */
  "context_dangling_promise",
] as const;
export type ShortsRejectCode = (typeof SHORTS_REJECT_CODES)[number];

export const ShortsRejectionSchema = z.strictObject({
  code: z.enum(SHORTS_REJECT_CODES),
  sceneIds: z.array(z.string().min(1)).min(1),
  /** Source timecodes of the rejected span (spoken timeline). */
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  reason: z.string().min(1).max(300),
});
export type ShortsRejection = z.infer<typeof ShortsRejectionSchema>;

// ── Configuration ────────────────────────────────────────────────────────

export const ShortsWeightsSchema = z.strictObject({
  hook: z.number().min(0).max(1).default(0.2),
  curiosity: z.number().min(0).max(1).default(0.15),
  surprise: z.number().min(0).max(1).default(0.15),
  standalone: z.number().min(0).max(1).default(0.2),
  payoff: z.number().min(0).max(1).default(0.15),
  emotion: z.number().min(0).max(1).default(0.075),
  visual: z.number().min(0).max(1).default(0.075),
});
export type ShortsWeights = z.infer<typeof ShortsWeightsSchema>;

export const ShortsConfigSchema = z.strictObject({
  /** Candidate duration bounds, on the spoken timeline. */
  minDurationSec: z.number().min(3).max(180).default(15),
  maxDurationSec: z.number().min(5).max(180).default(60),
  /** How many non-overlapping candidates survive. */
  maxCandidates: z.number().int().min(1).max(12).default(3),
  weights: ShortsWeightsSchema.default({}),
  /** How strongly context dependence suppresses a score (0 disables). */
  contextPenaltyWeight: z.number().min(0).max(1).default(0.6),
});
export type ShortsConfig = z.infer<typeof ShortsConfigSchema>;

// ── Candidates ───────────────────────────────────────────────────────────

export const ShortsTranscriptLineSchema = z.strictObject({
  /** Empty for a spoken section transition (it belongs to no single sentence). */
  sentenceId: z.string().default(""),
  sceneId: z.string().min(1),
  text: z.string().min(1),
  /** Where the line sits in the *source* video (spoken timeline). */
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});
export type ShortsTranscriptLine = z.infer<typeof ShortsTranscriptLineSchema>;

export const ShortsScoreSchema = z.strictObject({
  /** clamped 0..1: the weighted factors, times the context suppression. */
  total: z.number().min(0).max(1),
  factors: z.array(ShortsFactorSchema).length(SHORTS_FACTOR_CODES.length),
  /** 0..1 — how much the span leans on its surroundings. */
  contextPenalty: z.number().min(0).max(1),
  penaltyReasons: z.array(z.string().min(1).max(200)).max(8).default([]),
});
export type ShortsScore = z.infer<typeof ShortsScoreSchema>;

export const ShortsCandidateSchema = z.strictObject({
  id: z.string().regex(/^short_[0-9a-z_]+$/u, "candidate id must be short_<slug>"),
  /** A reviewable title: the episode's working title and the hook. */
  title: z.string().min(1).max(200),
  hookSentence: z.string().min(1).max(400),
  sceneIds: z.array(z.string().min(1)).min(1),
  /** Scene positions in the source manifest (inclusive range). */
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(0),
  /** Timecodes in the finished long-form video (spoken timeline). */
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  durationSec: z.number().positive(),
  transcript: z.array(ShortsTranscriptLineSchema).min(1),
  /** Research claims the span shows, carried into the short. */
  claimIds: z.array(z.string().min(1)).default([]),
  /** Research source ids visible in the span. */
  sourceIds: z.array(z.string().min(1)).default([]),
  score: ShortsScoreSchema,
});
export type ShortsCandidate = z.infer<typeof ShortsCandidateSchema>;

// ── The plan ─────────────────────────────────────────────────────────────

export const ShortsSourceSchema = z.strictObject({
  /** Hash of the scene manifest the selection ran over. */
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Hash of the narration track (the narration timestamps). */
  trackHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .or(z.literal("")),
  /** Hash of the script document (the transcript's home). */
  scriptHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .or(z.literal(""))
    .default(""),
  /** Hash of the finished long-form video artifact. */
  videoHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .or(z.literal(""))
    .default(""),
});
export type ShortsSource = z.infer<typeof ShortsSourceSchema>;

export const ShortsPlanSchema = z.strictObject({
  version: z.literal(SHORTS_PLAN_VERSION),
  source: ShortsSourceSchema,
  topic: z.string().min(1).max(400),
  generatedAt: z.string().datetime(),
  config: ShortsConfigSchema,
  /** Survivors, best first, mutually non-overlapping. */
  candidates: z.array(ShortsCandidateSchema).max(12),
  /** Every span that was refused for context dependence, and why. */
  rejected: z.array(ShortsRejectionSchema).max(400),
  /** Spans inside the duration bounds that were scored but not selected. */
  considered: z.number().int().min(0),
  warnings: z.array(z.string().min(1).max(400)).default([]),
  provenance: z.strictObject({
    engine: z.strictObject({ name: z.string(), version: z.string() }),
    /** Deterministic throughout: no model is involved in the selection. */
    deterministic: z.literal(true),
  }),
});
export type ShortsPlan = z.infer<typeof ShortsPlanSchema>;

export function parseShortsPlan(input: unknown): ShortsPlan {
  return ShortsPlanSchema.parse(input);
}

// ── The vertical layout ──────────────────────────────────────────────────

export const NormalizedRectSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;

/**
 * The camera reflow for one scene. The vertical short is **re-composed**, not
 * cropped: `window` records which part of the source 16:9 composition the
 * framing is equivalent to (focus-following, never a blanket centre crop), and
 * the re-composed manifest carries the matching shot/focus so the renderer
 * draws the scene natively vertical.
 */
export const VerticalCameraSchema = z.strictObject({
  mode: z.literal("reflow"),
  sourceAspect: z.string().min(3).max(8),
  /** Where the scene's attention lives in the source frame (0..1). */
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  /** The equivalent 16:9 window: width (0..1) and its left edge. */
  window: z.strictObject({
    x: z.number().min(0).max(1),
    width: z.number().min(0.2).max(1),
  }),
  /** What moved, in one line ("presenter at x=0.34, window follows"). */
  reason: z.string().min(1).max(300),
});
export type VerticalCamera = z.infer<typeof VerticalCameraSchema>;

export const VerticalTextZoneSchema = z.strictObject({
  /** The position the vertical manifest carries. */
  position: z.enum(["lower_third", "center", "upper_third", "corner", "full_screen"]),
  /** The position the 16:9 scene had, when it moved. */
  previousPosition: z
    .enum(["lower_third", "center", "upper_third", "corner", "full_screen"])
    .optional(),
  reason: z.string().min(1).max(300),
});
export type VerticalTextZone = z.infer<typeof VerticalTextZoneSchema>;

export const VerticalMediaZoneSchema = z.strictObject({
  /** The treatment the vertical manifest carries. */
  treatment: z.enum(["full_frame", "overlay", "split_screen", "background", "picture_in_picture"]),
  previousTreatment: z
    .enum(["full_frame", "overlay", "split_screen", "background", "picture_in_picture"])
    .optional(),
  reason: z.string().min(1).max(300),
});
export type VerticalMediaZone = z.infer<typeof VerticalMediaZoneSchema>;

export const VerticalDiagramZoneSchema = z.strictObject({
  /** Diagrams re-stack top-to-bottom in the tall frame. */
  flow: z.literal("vertical"),
  reason: z.string().min(1).max(300),
});
export type VerticalDiagramZone = z.infer<typeof VerticalDiagramZoneSchema>;

export const VerticalSceneLayoutSchema = z.strictObject({
  sceneId: z.string().min(1),
  camera: VerticalCameraSchema,
  text: VerticalTextZoneSchema.optional(),
  media: VerticalMediaZoneSchema.optional(),
  diagram: VerticalDiagramZoneSchema.optional(),
  notes: z.array(z.string().min(1).max(300)).max(6).default([]),
});
export type VerticalSceneLayout = z.infer<typeof VerticalSceneLayoutSchema>;

export const VerticalLayoutSchema = z.strictObject({
  version: z.literal(VERTICAL_LAYOUT_VERSION),
  candidateId: z.string().min(1),
  canvas: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  aspect: z.literal("9:16"),
  /** Platform-safe margins of the canvas, as fractions. */
  safeArea: z.strictObject({
    top: z.number().min(0).max(0.4),
    bottom: z.number().min(0).max(0.4),
    left: z.number().min(0).max(0.3),
    right: z.number().min(0).max(0.3),
  }),
  /** Where burned captions belong on the vertical canvas. */
  captionBand: NormalizedRectSchema,
  /** A caption style that reads at vertical resolution (the render's default is sized for small fixtures). */
  captionStyle: z.strictObject({
    fontPx: z.number().int().min(8).max(200),
    marginPx: z.number().int().min(0).max(600),
  }),
  scenes: z.array(VerticalSceneLayoutSchema).min(1),
  warnings: z.array(z.string().min(1).max(400)).default([]),
});
export type VerticalLayout = z.infer<typeof VerticalLayoutSchema>;

export function parseVerticalLayout(input: unknown): VerticalLayout {
  return VerticalLayoutSchema.parse(input);
}

// Convenience aliases kept for call sites that name the shapes directly.
export type VerticalTextPosition = SceneTextPosition;
export type VerticalMediaTreatment = Scene["media"] extends { treatment: infer T } ? T : never;
export type VerticalSourceShot = Scene["camera"]["shot"];
