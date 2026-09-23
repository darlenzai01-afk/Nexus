/**
 * `@nexus/render` — the animation and composition engine (Phase 9).
 *
 * Pipeline position: a validated **scene manifest** (Phase 7) plus the
 * **character library** (Phase 8) go in; deterministic **frames** and **SVG**
 * come out. The four steps the engine exists to prove are exactly the four
 * modules below:
 *
 * 1. `buildTimeline` — scene manifest → timeline (frames, scenes, seams).
 * 2. `createCharacterStage` — cast entries → resolved performances and layers,
 *    read back through the character system's own asset checks.
 * 3. `composeFrame` — timeline + stage + a frame index → one frame document, with
 *    position, scale, rotation, opacity, pose, expression, text, camera and the
 *    transition already folded in.
 * 4. `frameToSvg` / `storyboardSvg` — frame documents → files a browser draws.
 *
 * Nothing here reaches a database, a provider or the network, and nothing here
 * renders a whole video: a frame is a *document*, and the rasteriser that turns
 * documents into pixels is a later stage's job.
 */

export { DEFAULT_LOOK, makeLook } from "./look.js";
export {
  FRAME_PRECISION,
  clamp,
  clamp01,
  formatNumber,
  framesBetween,
  lerp,
  mix,
  progress,
  round,
} from "./numbers.js";
export { EASINGS, easeFor, type Ease, type EaseName } from "./easing.js";
export {
  buildTimeline,
  frameIndexForTime,
  frameTime,
  framesOfScene,
  sceneProgress,
  sceneTimelineAt,
  sceneTimelineById,
  sceneTimelineForFrame,
  spanSec,
  transitionAt,
  transitionMix,
  type SceneTimeline,
  type Timeline,
  type TimelineOptions,
} from "./timeline.js";
export {
  DEPTH_BACK,
  DEPTH_Z,
  GROUND_Y,
  PRESENTING_STATES,
  SHOT_FIGURE_HEIGHT,
  SLOT_CENTRES,
  blockScene,
  centreFor,
  depthOpacity,
  presenterCentre,
} from "./layout.js";
export { applyCamera, cameraStateAt, focusPoint, type CameraInput } from "./camera.js";
export {
  GLYPH_WIDTH_FACTOR,
  TEXT_BOX,
  TEXT_SHRINK_STEPS,
  TEXT_STYLE,
  countUpValue,
  fitText,
  revealCharsFor,
  textCentreY,
  textRect,
  textStyle,
  visibleLines,
  type WrappedText,
} from "./text.js";
export {
  CHARACTER_ONLY_KINDS,
  IDENTITY_ANIM,
  SCENE_EVENT_TARGET,
  SLIDE_DISTANCE,
  TEXT_ONLY_KINDS,
  activeEvents,
  appliesTo,
  countUpEvents,
  effectElementId,
  elementIdForEvent,
  foldAnimation,
  foldSceneAnimation,
  hasStarted,
  overridesAt,
  type AnimState,
  type PerformanceOverrides,
} from "./animation.js";
export {
  createCharacterStage,
  performanceAssets,
  performanceFor,
  type CharacterStage,
  type Performance,
  type PerformanceRequest,
} from "./performance.js";
export {
  CALLOUT_PADDING,
  DIAGRAM_BOX,
  DIAGRAM_Z,
  EFFECT_Z,
  MEDIA_BOX,
  TEXT_Z,
  composeFrame,
  composeScene,
  composeVideo,
  sampledFrames,
  verifyAssets,
  type AssetReport,
  type ComposeDeps,
  type ComposeSceneOptions,
  type ComposedAsset,
  type ComposedScene,
  type ComposedVideo,
} from "./compose.js";
export {
  STORYBOARD,
  frameBody,
  frameToSvg,
  storyboardSvg,
  type StoryboardOptions,
  type SvgOptions,
  type SvgResult,
} from "./svg.js";
export {
  DEMO_SCENE_FILE,
  DEMO_SUBDIR,
  demoSceneFile,
  loadDemoScene,
  packageRoot,
  type LoadDemoSceneOptions,
} from "./demo.js";
export { canonicalJson, digestOf, frameDigest } from "./digest.js";
export type {
  Blocking,
  CameraState,
  CharacterElement,
  CharacterLayer,
  DiagramElement,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  EffectElement,
  Frame,
  FrameElement,
  FrameNarration,
  FrameTransition,
  Look,
  MediaElement,
  Point,
  Rect,
  Reveal,
  RevealMode,
  Size,
  TextElement,
  TextStyle,
  Transform,
} from "./types.js";
