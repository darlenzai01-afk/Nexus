import type { Scene, SceneMedia, SceneText } from "@nexus/scenes";

import {
  SCENE_EVENT_TARGET,
  appliesTo,
  effectElementId,
  elementIdForEvent,
  foldAnimation,
  foldSceneAnimation,
  overridesAt,
  type AnimState,
} from "./animation.js";
import { applyCamera, cameraStateAt } from "./camera.js";
import { frameDigest } from "./digest.js";
import { blockScene, depthOpacity, presenterCentre } from "./layout.js";
import { clamp01, round } from "./numbers.js";
import { performanceFor, type CharacterStage } from "./performance.js";
import {
  TEXT_STYLE,
  countUpValue,
  fitText,
  revealCharsFor,
  textCentreY,
  textRect,
  textStyle,
} from "./text.js";
import {
  frameTime,
  sceneTimelineById,
  sceneTimelineForFrame,
  transitionAt,
  type SceneTimeline,
  type Timeline,
} from "./timeline.js";
import type {
  Blocking,
  CameraState,
  CharacterElement,
  DiagramElement,
  Diagnostic,
  EffectElement,
  Frame,
  FrameElement,
  Look,
  MediaElement,
  Point,
  Rect,
  Size,
  TextElement,
  Transform,
} from "./types.js";

/**
 * The composer.
 *
 * `composeFrame(timeline, index)` is the whole engine in one call: it blocks the
 * cast, resolves their performances through the character library, lays out text,
 * media and diagrams, folds the scene's animation events at that moment, puts the
 * result through the camera and returns a frame document. It is pure — the same
 * timeline, the same library and the same index always give the same frame — and
 * total: anything that cannot be drawn becomes a diagnostic on the frame rather
 * than an exception, because a video that stops at frame 137 is worse than one
 * that shows a placeholder and says why.
 *
 * Draw order (`z`) is a fixed sheet, lowest first:
 *
 * | z    | Layer                                                        |
 * | ---- | ------------------------------------------------------------ |
 * | 5–6  | media as background or full frame                             |
 * | 10   | characters standing behind (the listening side)               |
 * | 20   | characters in front (the presenting side)                     |
 * | 25   | split-screen media, diagrams                                  |
 * | 30   | callout cards                                                 |
 * | 35+  | overlay and picture-in-picture media                          |
 * | 40   | on-screen text                                                |
 */

/** Where each media treatment puts its plate, as fractions of the frame. */
export const MEDIA_BOX: Readonly<Record<SceneMedia["treatment"], Rect>> = {
  background: { x: 0, y: 0, width: 1, height: 1 },
  full_frame: { x: 0.04, y: 0.06, width: 0.92, height: 0.88 },
  split_screen: { x: 0.04, y: 0.1, width: 0.56, height: 0.8 },
  overlay: { x: 0.2, y: 0.16, width: 0.6, height: 0.5 },
  picture_in_picture: { x: 0.66, y: 0.6, width: 0.3, height: 0.32 },
};

const MEDIA_Z: Readonly<Record<SceneMedia["treatment"], number>> = {
  background: 5,
  full_frame: 6,
  split_screen: 25,
  overlay: 35,
  picture_in_picture: 36,
};

/** Where a diagram is drawn, as fractions of the frame. */
export const DIAGRAM_BOX: Rect = { x: 0.2, y: 0.18, width: 0.6, height: 0.62 };

/** Padding a callout card adds around the text it belongs to. */
export const CALLOUT_PADDING = { x: 0.03, y: 0.9 } as const;

export const TEXT_Z = 40;
export const DIAGRAM_Z = 25;
export const EFFECT_Z = 30;

export interface ComposeDeps {
  /** The character library, as a stage. Without it, cast members cannot be drawn. */
  readonly characters?: CharacterStage | undefined;
}

export interface ComposeSceneOptions {
  /** Compose every n-th frame; 1 (the default) composes all of them. */
  readonly every?: number;
  readonly deps?: ComposeDeps;
}

export interface ComposedScene {
  readonly sceneId: string;
  readonly sceneIndex: number;
  readonly fps: number;
  readonly frames: readonly Frame[];
  readonly diagnostics: readonly Diagnostic[];
  /** `sha256` over the composed frames. */
  readonly digest: string;
  /** Every character layer these frames draw, in first-seen order. */
  readonly assets: readonly ComposedAsset[];
}

export interface ComposedAsset {
  readonly assetId: string;
  readonly path: string;
  readonly hash: string;
}

export interface ComposedVideo {
  readonly fps: number;
  readonly frameCount: number;
  readonly durationSec: number;
  readonly resolution: Size;
  readonly scenes: readonly ComposedScene[];
  readonly diagnostics: readonly Diagnostic[];
  readonly digest: string;
  readonly assets: readonly ComposedAsset[];
}

function scaleRect(box: Rect, resolution: Size): Rect {
  return {
    x: round(box.x * resolution.width),
    y: round(box.y * resolution.height),
    width: round(box.width * resolution.width),
    height: round(box.height * resolution.height),
  };
}

function centreOf(rect: Rect): Point {
  return { x: round(rect.x + rect.width / 2), y: round(rect.y + rect.height / 2) };
}

function transformAt(
  position: Point,
  origin: Point,
  anim: AnimState,
  camera: CameraState,
  resolution: Size,
  baseScale = 1,
): Transform {
  return applyCamera(
    {
      x: round(position.x + anim.offsetX),
      y: round(position.y + anim.offsetY),
      scale: round(baseScale * anim.scale),
      rotationDeg: round(anim.rotationDeg),
      origin,
    },
    camera,
    resolution,
  );
}

/** The animation of a frame-level effect: the scene's own state, plus this element's. */
function combine(sceneAnim: AnimState, elementAnim: AnimState): AnimState {
  const stricterReveal =
    sceneAnim.reveal.amount <= elementAnim.reveal.amount ? sceneAnim.reveal : elementAnim.reveal;
  return {
    opacity: round(clamp01(sceneAnim.opacity * elementAnim.opacity)),
    offsetX: round(sceneAnim.offsetX + elementAnim.offsetX),
    offsetY: round(sceneAnim.offsetY + elementAnim.offsetY),
    scale: round(sceneAnim.scale * elementAnim.scale),
    rotationDeg: round(sceneAnim.rotationDeg + elementAnim.rotationDeg),
    reveal: { mode: stricterReveal.mode, amount: round(stricterReveal.amount) },
    highlight: Math.max(sceneAnim.highlight, elementAnim.highlight),
    typeOn: elementAnim.typeOn,
    countUp: elementAnim.countUp,
  };
}

interface FrameContext {
  readonly timeline: Timeline;
  readonly scene: SceneTimeline;
  readonly sceneAnim: AnimState;
  readonly camera: CameraState;
  readonly look: Look;
  readonly resolution: Size;
  readonly localSec: number;
  readonly blocking: readonly Blocking[];
  readonly deps: ComposeDeps;
  readonly diagnostics: Diagnostic[];
}

function diagnostic(
  context: FrameContext,
  code: Diagnostic["code"],
  path: string,
  message: string,
  severity: Diagnostic["severity"] = "warning",
): void {
  context.diagnostics.push({ code, severity, sceneId: context.scene.scene.id, path, message });
}

function characterElement(context: FrameContext, entry: Blocking): CharacterElement | undefined {
  const characterId = entry.characterId;
  const path = `scenes.${context.scene.index}.characters`;
  const overrides = overridesAt(context.scene.events, context.localSec, characterId);
  const performance = performanceFor(context.deps.characters, {
    characterId,
    state: entry.state,
    overrides,
  });
  if (!performance.ok || performance.resolved === undefined) {
    diagnostic(
      context,
      "missing_character",
      path,
      `cast member "${characterId}" cannot be drawn: ${performance.notes.join("; ")}`,
    );
    return undefined;
  }
  for (const note of performance.notes) diagnostic(context, "unresolved_performance", path, note);

  const resolved = performance.resolved;
  const canvas = resolved.placement.canvas;
  const anchor = resolved.placement.anchor;
  const anim = combine(
    context.sceneAnim,
    foldAnimation(context.scene.events, context.localSec, entry.elementId, context.resolution),
  );
  const figureHeightPx = entry.heightPx * resolved.placement.scale;

  return {
    kind: "character",
    id: entry.elementId,
    z: entry.z,
    characterId,
    name: resolved.name,
    shortName: resolved.shortName,
    role: resolved.role,
    palette: resolved.palette,
    pose: performance.pose,
    expression: performance.expression,
    gesture: performance.gesture,
    clothing: performance.clothing,
    accessories: performance.accessories,
    facing: performance.facing,
    canvas,
    anchor,
    layers: resolved.layers.map((layer) => ({
      assetId: layer.assetId,
      path: layer.path,
      slot: layer.slot,
      source: layer.source,
      drawIndex: layer.drawIndex,
      hash: layer.hash,
      size: { width: layer.width, height: layer.height },
    })),
    opacity: round(clamp01(depthOpacity(entry.depth) * anim.opacity)),
    reveal: anim.reveal,
    // The shot decides how tall the figure stands; its own canvas and placement
    // scale decide how many pixels that is.
    transform: transformAt(
      entry.position,
      anchor,
      anim,
      context.camera,
      context.resolution,
      figureHeightPx / canvas.height,
    ),
    depth: entry.depth,
  };
}

function textElement(context: FrameContext, text: SceneText): TextElement {
  const events = context.scene.events;
  const anim = combine(
    context.sceneAnim,
    foldAnimation(events, context.localSec, "text", context.resolution),
  );
  const rect = textRect(text, context.resolution);
  const baseSize = TEXT_STYLE[text.kind].sizeFactor * context.resolution.height;

  let value = text.value;
  if (anim.countUp !== null) {
    const event = events.find(
      (candidate) => candidate.kind === "count_up" && elementIdForEvent(candidate) === "text",
    );
    if (event !== undefined) {
      const counted = countUpValue(event, anim.countUp, text.value);
      value = counted.value;
      if (!counted.usedTemplate) {
        diagnostic(
          context,
          "defaulted_parameter",
          `scenes.${context.scene.index}.animation`,
          `count_up on ${event.id}: the text has no {n} placeholder, so it shows the number itself`,
        );
      }
    }
  }

  const fitted = fitText(value, rect, baseSize, text.maxLines);
  if (fitted.overflow) {
    diagnostic(
      context,
      "text_overflow",
      `scenes.${context.scene.index}.text`,
      `text "${text.kind}" does not fit ${text.maxLines} line(s) at ${fitted.fontSizePx}px and was truncated`,
    );
  }

  return {
    kind: "text",
    id: "text",
    z: TEXT_Z,
    textKind: text.kind,
    value,
    lines: fitted.lines,
    revealChars: revealCharsFor(fitted.lines, anim.typeOn),
    attribution: text.attribution,
    highlight: anim.highlight,
    rect,
    style: textStyle(text.kind, fitted.fontSizePx, context.look),
    opacity: anim.opacity,
    reveal: anim.reveal,
    transform: transformAt(
      centreOf(rect),
      { x: 0.5, y: 0.5 },
      anim,
      context.camera,
      context.resolution,
    ),
  };
}

function mediaElement(context: FrameContext, media: SceneMedia): MediaElement {
  const events = context.scene.events;
  const first = media.assets[0] ?? "";
  const id = `media:${first === "" ? "plate" : first}`;
  const anim = combine(
    context.sceneAnim,
    foldAnimation(events, context.localSec, id, context.resolution),
  );
  const rect = scaleRect(MEDIA_BOX[media.treatment], context.resolution);
  const asset = context.timeline.manifest.assets.find((candidate) => candidate.id === first);
  return {
    kind: "media",
    id,
    z: MEDIA_Z[media.treatment],
    mediaKind: media.kind,
    treatment: media.treatment,
    assetIds: media.assets,
    uri: asset?.uri ?? "",
    description: media.description,
    rect,
    opacity: anim.opacity,
    reveal: anim.reveal,
    transform: transformAt(
      centreOf(rect),
      { x: 0.5, y: 0.5 },
      anim,
      context.camera,
      context.resolution,
    ),
  };
}

function diagramElement(context: FrameContext, scene: Scene): DiagramElement | undefined {
  const diagram = scene.diagram;
  if (diagram === undefined) return undefined;
  const anim = combine(
    context.sceneAnim,
    foldAnimation(context.scene.events, context.localSec, "diagram", context.resolution),
  );
  const rect = scaleRect(DIAGRAM_BOX, context.resolution);
  return {
    kind: "diagram",
    id: "diagram",
    z: DIAGRAM_Z,
    diagramKind: diagram.kind,
    title: diagram.title,
    annotations: diagram.annotations,
    series: diagram.series,
    rect,
    opacity: anim.opacity,
    reveal: anim.reveal,
    transform: transformAt(
      centreOf(rect),
      { x: 0.5, y: 0.5 },
      anim,
      context.camera,
      context.resolution,
    ),
  };
}

/**
 * The card a `callout` event draws behind its target. It moves with the target (a
 * card that stayed put while its text slid would read as a bug), so the target's
 * animation is added on top of the card's own fade-and-settle.
 */
function calloutCards(
  context: FrameContext,
  targetId: string,
  targetRect: Rect,
  targetAnim: AnimState,
): EffectElement[] {
  const cards: EffectElement[] = [];
  for (const event of context.scene.events) {
    if (event.kind !== "callout" || elementIdForEvent(event) !== targetId) continue;
    const anim = combine(
      context.sceneAnim,
      foldAnimation(
        context.scene.events,
        context.localSec,
        effectElementId(event),
        context.resolution,
      ),
    );
    const rect: Rect = {
      x: round(targetRect.x - CALLOUT_PADDING.x * context.resolution.width),
      y: round(targetRect.y),
      width: round(targetRect.width + 2 * CALLOUT_PADDING.x * context.resolution.width),
      height: round(targetRect.height + (1 - CALLOUT_PADDING.y) * targetRect.height),
    };
    cards.push({
      kind: "effect",
      id: effectElementId(event),
      z: EFFECT_Z,
      effect: "card",
      rect,
      colour: context.look.panel,
      opacity: round(clamp01(anim.opacity)),
      reveal: anim.reveal,
      transform: transformAt(
        {
          x: round(centreOf(rect).x + targetAnim.offsetX - anim.offsetX),
          y: round(centreOf(rect).y + targetAnim.offsetY - anim.offsetY),
        },
        { x: 0.5, y: 0.5 },
        anim,
        context.camera,
        context.resolution,
      ),
    });
  }
  return cards;
}

/** Every element a scene shows at one moment. */
function elementsOf(context: FrameContext): FrameElement[] {
  const scene = context.scene.scene;
  const elements: FrameElement[] = [];

  if (scene.media !== undefined) elements.push(mediaElement(context, scene.media));
  for (const entry of context.blocking) {
    const element = characterElement(context, entry);
    if (element !== undefined) elements.push(element);
  }
  const diagram = diagramElement(context, scene);
  if (diagram !== undefined) elements.push(diagram);

  if (scene.text !== undefined) {
    const text = textElement(context, scene.text);
    const targetAnim = foldAnimation(
      context.scene.events,
      context.localSec,
      "text",
      context.resolution,
    );
    elements.push(...calloutCards(context, "text", text.rect, targetAnim), text);
  }
  if (scene.diagram !== undefined) {
    elements.push(
      ...calloutCards(
        context,
        "diagram",
        scaleRect(DIAGRAM_BOX, context.resolution),
        foldAnimation(context.scene.events, context.localSec, "diagram", context.resolution),
      ),
    );
  }

  // Draw order is `z`, and a stable sort keeps the build order inside a layer.
  return elements.sort((left, right) => left.z - right.z);
}

const TARGETABLE_ELEMENTS: readonly FrameElement["kind"][] = [
  "character",
  "text",
  "diagram",
  "media",
];

/** Animation events that name an element this scene does not have, or misuse one it does. */
function eventDiagnostics(context: FrameContext, elements: readonly FrameElement[]): void {
  const ids = new Set(elements.map((element) => element.id));
  const kinds = new Map(elements.map((element) => [element.id, element.kind]));
  for (const event of context.scene.events) {
    const elementId = elementIdForEvent(event);
    if (elementId === SCENE_EVENT_TARGET) continue;
    if (!ids.has(elementId)) {
      diagnostic(
        context,
        "unknown_target",
        `scenes.${context.scene.index}.animation`,
        `animation ${event.id} targets "${event.targetId || event.target}", which scene ${context.scene.scene.id} does not show`,
      );
      continue;
    }
    const elementKind = kinds.get(elementId);
    if (
      elementKind !== undefined &&
      TARGETABLE_ELEMENTS.includes(elementKind) &&
      !appliesTo(event.kind, elementKind)
    ) {
      diagnostic(
        context,
        "kind_not_applicable",
        `scenes.${context.scene.index}.animation`,
        `animation ${event.id} is a ${event.kind}, which cannot animate a ${elementKind} element`,
      );
    }
  }
}

/**
 * Compose one frame of the video.
 *
 * Everything the frame needs comes from the timeline (blocking, camera, events)
 * and the character stage (performances, layers); nothing is read from disk here,
 * and nothing is remembered between calls.
 */
export function composeFrame(timeline: Timeline, index: number, deps: ComposeDeps = {}): Frame {
  const scene = sceneTimelineForFrame(timeline, index);
  const timeSec = frameTime(timeline, index);
  const localSec = round(timeSec - scene.scene.startSec);
  const resolution = timeline.resolution;
  const blocking = blockScene(scene.scene, resolution);
  const diagnostics: Diagnostic[] = [];
  const context: FrameContext = {
    timeline,
    scene,
    sceneAnim: foldSceneAnimation(scene.events, localSec, resolution),
    camera: cameraStateAt(
      {
        scene: scene.scene,
        resolution,
        presenterX: presenterCentre(blocking, resolution),
        textCentreY:
          scene.scene.text === undefined ? undefined : textCentreY(scene.scene.text, resolution),
      },
      localSec,
    ),
    look: timeline.look,
    resolution,
    localSec,
    blocking,
    deps,
    diagnostics,
  };
  const elements = elementsOf(context);
  eventDiagnostics(context, elements);

  return {
    fps: timeline.fps,
    index,
    timeSec: round(timeSec),
    sceneId: scene.scene.id,
    sceneIndex: scene.index,
    sceneType: scene.type,
    localSec,
    durationSec: scene.scene.durationSec,
    resolution,
    background: timeline.look.background,
    camera: context.camera,
    elements,
    transition: transitionAt(scene, localSec),
    narration: {
      text: scene.scene.narration.text,
      words: scene.scene.narration.words,
      sectionId: scene.scene.narration.sectionId,
      sentenceIds: scene.scene.narration.sentenceIds,
    },
    diagnostics,
  };
}

/** The frame indices a scene composition samples. */
export function sampledFrames(scene: SceneTimeline, every: number): number[] {
  const step = Math.max(1, Math.floor(every));
  const frames: number[] = [];
  for (let index = scene.startFrame; index <= scene.endFrame; index += step) frames.push(index);
  const last = scene.endFrame;
  if (frames[frames.length - 1] !== last) frames.push(last);
  return frames;
}

function uniqueDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.code}|${entry.sceneId}|${entry.path}|${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function assetsOf(frames: readonly Frame[]): ComposedAsset[] {
  const seen = new Set<string>();
  const assets: ComposedAsset[] = [];
  for (const frame of frames) {
    for (const element of frame.elements) {
      if (element.kind !== "character") continue;
      for (const layer of element.layers) {
        if (seen.has(layer.path)) continue;
        seen.add(layer.path);
        assets.push({ assetId: layer.assetId, path: layer.path, hash: layer.hash });
      }
    }
  }
  return assets;
}

/**
 * Compose a scene — every frame, or every n-th for a storyboard pass — and hand
 * back the frames, the diagnostics they raised and a digest over the lot.
 */
export function composeScene(
  timeline: Timeline,
  sceneId: string,
  options: ComposeSceneOptions = {},
): ComposedScene {
  const scene = sceneTimelineById(timeline, sceneId);
  if (scene === undefined) {
    throw new Error(`${sceneId} is not in this timeline`);
  }
  const deps = options.deps ?? {};
  const frames = sampledFrames(scene, options.every ?? 1).map((index) =>
    composeFrame(timeline, index, deps),
  );
  return {
    sceneId,
    sceneIndex: scene.index,
    fps: timeline.fps,
    frames,
    diagnostics: uniqueDiagnostics(frames.flatMap((frame) => frame.diagnostics)),
    digest: frameDigest(frames),
    assets: assetsOf(frames),
  };
}

/** Compose the whole manifest. */
export function composeVideo(timeline: Timeline, options: ComposeSceneOptions = {}): ComposedVideo {
  const scenes = timeline.scenes.map((scene) => composeScene(timeline, scene.scene.id, options));
  const assets = new Map<string, ComposedAsset>();
  for (const scene of scenes) {
    for (const asset of scene.assets) assets.set(asset.path, asset);
  }
  const frames = scenes.flatMap((scene) => scene.frames);
  return {
    fps: timeline.fps,
    frameCount: timeline.frameCount,
    durationSec: timeline.durationSec,
    resolution: timeline.resolution,
    scenes,
    diagnostics: uniqueDiagnostics(scenes.flatMap((scene) => scene.diagnostics)),
    digest: frameDigest(frames),
    assets: [...assets.values()],
  };
}

export interface AssetReport {
  readonly path: string;
  readonly assetId: string;
  readonly ok: boolean;
}

/**
 * Read every layer a composition draws, once, through the character stage — the
 * asset-resolution step of the pipeline, as a check. A frame never touches the
 * filesystem; this is the one place that does, and it says exactly which paths it
 * could not read.
 */
export function verifyAssets(
  composed: ComposedScene | ComposedVideo,
  stage: CharacterStage | undefined,
): { readonly report: readonly AssetReport[]; readonly diagnostics: readonly Diagnostic[] } {
  const assets =
    "scenes" in composed ? composed.scenes.flatMap((scene) => scene.assets) : composed.assets;
  const report: AssetReport[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.path)) continue;
    seen.add(asset.path);
    const readable = stage?.read(asset.path) !== undefined;
    report.push({ path: asset.path, assetId: asset.assetId, ok: readable });
    if (!readable) {
      diagnostics.push({
        code: "missing_asset",
        severity: "error",
        sceneId: "",
        path: asset.path,
        message: `layer ${asset.assetId} (${asset.path}) has no readable file behind it`,
      });
    }
  }
  return { report, diagnostics };
}
