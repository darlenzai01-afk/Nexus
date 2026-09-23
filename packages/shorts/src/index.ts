/**
 * @nexus/shorts — the short-form repurposing engine (Phase 14).
 *
 * A finished long-form episode (video, transcript, narration timestamps, scene
 * manifest, scene visual metadata) becomes structured vertical short
 * candidates, and each candidate becomes a re-composed 9:16 plan — scored on
 * seven factors, rejected when it depends on missing context, reflowed for
 * vertical viewing (never center-cropped), and rendered by the existing
 * pipeline like any other scene manifest.
 *
 * - `selectShorts` — the selection engine (deterministic, model-free).
 * - `verticalReflow` — the 9:16 re-composition + re-based narration track.
 * - `withManifestHash` — stamp the re-based track with the vertical plan's hash.
 */
export {
  SHORTS_ENGINE,
  SHORTS_PLAN_VERSION,
  VERTICAL_LAYOUT_VERSION,
  VERTICAL_CANVAS,
  SHORTS_FACTOR_CODES,
  SHORTS_REJECT_CODES,
  ShortsFactorSchema,
  ShortsRejectionSchema,
  ShortsConfigSchema,
  ShortsCandidateSchema,
  ShortsScoreSchema,
  ShortsPlanSchema,
  ShortsSourceSchema,
  VerticalLayoutSchema,
  VerticalSceneLayoutSchema,
  VerticalCameraSchema,
  parseShortsPlan,
  parseVerticalLayout,
} from "./schema.js";
export type {
  ShortsFactor,
  ShortsFactorCode,
  ShortsRejection,
  ShortsRejectCode,
  ShortsConfig,
  ShortsWeights,
  ShortsCandidate,
  ShortsScore,
  ShortsTranscriptLine,
  ShortsPlan,
  ShortsSource,
  VerticalLayout,
  VerticalSceneLayout,
  VerticalCamera,
  VerticalTextZone,
  VerticalMediaZone,
  VerticalDiagramZone,
  NormalizedRect,
} from "./schema.js";

export {
  selectShorts,
  sceneWindowsOf,
  topicKeywordOf,
  sentencesOf,
  spanTextOf,
  type SelectShortsInput,
  type SelectShortsOptions,
  type SceneWindow,
} from "./select.js";

export {
  verticalReflow,
  withManifestHash,
  focusOf,
  type ReflowInput,
  type ReflowOptions,
  type ReflowResult,
} from "./layout.js";
