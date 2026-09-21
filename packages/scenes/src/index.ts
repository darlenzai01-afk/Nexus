/**
 * `@nexus/scenes` — the scene planner (Phase 7).
 *
 * ```ts
 * const manifest = buildSceneManifest(scriptDoc, { scriptHash });
 * const report = validateSceneManifest(manifest, { script: scriptDoc });
 * const persisted = persistSceneManifest({ storage, repo }, manifest, { episodeId });
 * ```
 *
 * `createScenePlanTask` is the same thing wired into the job orchestrator (the
 * `plan` stage), which is what the worker actually runs.
 *
 * Public surface, grouped by what a caller is doing:
 *
 * - **Producing:** `buildSceneManifest`, `sceneTypeFor`, `createScenePlanTask`,
 *   `ScenePlanOptions`, `DEFAULT_CAST`, `ScenePlanError`.
 * - **The contract:** every scene type, block and field lives in `./schema.ts` —
 *   strict zod objects, so an unknown field is an error rather than a silent
 *   drop — together with `parseSceneManifest`, `sceneManifestBytes`,
 *   `manifestNarration` and the coded issue vocabulary.
 * - **Checking:** `validateSceneManifest` (schema + timeline + script
 *   cross-references) and the report schema it returns.
 * - **The rules:** `SCENE_TYPE_SPECS` (what each scene type requires, how long it
 *   lasts, which camera it opens on, which `scenes.kind` it maps to) and
 *   `legacySceneKind`.
 * - **Storing:** `persistSceneManifest`, `loadSceneManifest`,
 *   `sceneManifestArtifactRef`.
 */

// The contract: scene types, blocks, strict schemas, helpers.
export {
  DATA_DIAGRAM_KINDS,
  HARD_SCENE_ISSUE_CODES,
  MAX_ANIMATION_EVENTS,
  MAX_DIAGRAM_SERIES,
  MAX_SCENE_DURATION_SEC,
  MIN_SCENE_DURATION_SEC,
  SCENE_ENGINE,
  SCENE_ISSUE_CODES,
  SCENE_MANIFEST_VERSION,
  SCENE_TYPES,
  SceneAnimationEventSchema,
  SceneAnimationKindSchema,
  SceneAnimationTargetSchema,
  SceneAssetKindSchema,
  SceneAssetLicenceSchema,
  SceneAssetPurposeSchema,
  SceneAssetSchema,
  SceneAssetStatusSchema,
  SceneAspectSchema,
  SceneCameraAngleSchema,
  SceneCameraFocusSchema,
  SceneCameraMovementSchema,
  SceneCameraSchema,
  SceneCastEntrySchema,
  SceneCastMemberSchema,
  SceneCastRoleSchema,
  SceneCharacterStateSchema,
  SceneClaimRefSchema,
  SceneDiagramKindSchema,
  SceneDiagramSchema,
  SceneDiagramSeriesSchema,
  SceneEvidenceRefSchema,
  SceneIssueCodeSchema,
  SceneIssueSeveritySchema,
  SceneManifestProvenanceSchema,
  SceneManifestSchema,
  SceneMediaKindSchema,
  SceneMediaOrientationSchema,
  SceneMediaSchema,
  SceneMediaTreatmentSchema,
  SceneNarrationKindSchema,
  SceneNarrationSchema,
  ScenePlanningStepSchema,
  SceneResolutionSchema,
  SceneSchema,
  SceneScriptHashSchema,
  SceneShotSchema,
  SceneStepTraceSchema,
  SceneTextKindSchema,
  SceneTextPositionSchema,
  SceneTextSchema,
  SceneTransitionAudioSchema,
  SceneTransitionKindSchema,
  SceneTransitionSchema,
  SceneTypeSchema,
  manifestNarration,
  parseSceneManifest,
  sceneIssueSeverity,
  sceneManifestBytes,
  scenesOfType,
  type Scene,
  type SceneAnimationEvent,
  type SceneAnimationKind,
  type SceneAsset,
  type SceneAssetKind,
  type SceneAssetPurpose,
  type SceneAspect,
  type SceneCamera,
  type SceneCastEntry,
  type SceneCastMember,
  type SceneCastRole,
  type SceneCharacterState,
  type SceneClaimRef,
  type SceneDiagram,
  type SceneDiagramKind,
  type SceneEvidenceRef,
  type SceneIssueCode,
  type SceneIssueSeverity,
  type SceneManifest,
  type SceneManifestInput,
  type SceneManifestProvenance,
  type SceneMedia,
  type SceneMediaKind,
  type SceneNarration,
  type ScenePlanningStep,
  type SceneResolution,
  type SceneStepTrace,
  type SceneText,
  type SceneTextKind,
  type SceneTransition,
  type SceneTransitionKind,
  type SceneType,
} from "./schema.js";

// The type table: requirements, timing floors, cameras, legacy kinds.
export {
  CAMERA_MOVEMENT_CYCLE,
  PRESENTER_SHOT_CYCLE,
  SCENE_TYPE_SPECS,
  legacySceneKind,
  type SceneRequirement,
  type SceneTypeSpec,
} from "./scene-types.js";

// Timing (decisecond arithmetic, so the timeline adds up exactly).
export {
  DEFAULT_WORDS_PER_SECOND,
  fromDeciseconds,
  narrationDurationSec,
  sceneDurationSec,
  toDeciseconds,
} from "./timing.js";

// The planner.
export {
  DEFAULT_CAST,
  DEFAULT_RESOLUTION,
  DEFAULT_TRANSITION_DURATION_SEC,
  ScenePlanError,
  buildSceneManifest,
  sceneTypeFor,
  type ScenePlanOptions,
} from "./plan.js";

// Validation, on top of the strict schemas.
export {
  DEFAULT_SCENE_VALIDATION,
  SceneIssueSchema,
  SceneTypeCountsSchema,
  SceneValidationReportSchema,
  SceneValidationStatsSchema,
  manifestWordCount,
  mapZodIssues,
  validateSceneManifest,
  type SceneIssue,
  type SceneTypeCounts,
  type SceneValidationContext,
  type SceneValidationReport,
  type SceneValidationStats,
} from "./validate.js";

// Persistence (CAS artifact + artifact row metadata).
export {
  SCENE_MANIFEST_ARTIFACT_KIND,
  SCENE_MANIFEST_ARTIFACT_ROLE,
  loadSceneManifest,
  persistSceneManifest,
  sceneManifestArtifactRef,
  type PersistSceneManifestDeps,
  type PersistedSceneManifest,
} from "./persist.js";

// Orchestration wiring (the `plan` stage task).
export { SCENE_PLAN_STAGE_KEY, createScenePlanTask, type ScenePlanTaskDeps } from "./task.js";
