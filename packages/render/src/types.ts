import type {
  CharacterFacing,
  CharacterPalette,
  CharacterRole,
  CharacterSlot,
} from "@nexus/characters";
import type {
  Scene,
  SceneCamera,
  SceneCharacterState,
  SceneDiagramKind,
  SceneMedia,
  SceneTextKind,
  SceneType,
} from "@nexus/scenes";

/**
 * What a composed frame *is*.
 *
 * The engine composes **documents, not pixels**: a `Frame` is a complete,
 * deterministic description of one frame of video — every element, where it is,
 * how big, how rotated, how transparent, which character layers it draws and in
 * what order, where the camera is looking and how deep the transition into the
 * next scene has got. That is the contract the rest of the pipeline (rasteriser,
 * captions, QA) can be written against, and it is what makes the engine testable
 * without a browser.
 *
 * Two conventions run through every type here:
 *
 * 1. **Frame pixels.** Positions and sizes are in the frame's own pixels
 *    (`1920 × 1080` unless the manifest says otherwise). Y grows *downwards*,
 *    matching SVG and every raster format the pipeline will ever write.
 * 2. **Transforms are about an origin.** An element's own box is drawn at
 *    `(x, y)` with `scale`, rotated by `rotationDeg` about the point
 *    `origin` — expressed as a fraction of the element's own box, so `{x, y}`
 *    of `{0.5, 1}` means "the bottom centre of the element stays put".
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Transform {
  /** Where the element's origin lands in the frame, in frame pixels. */
  readonly x: number;
  readonly y: number;
  /** Uniform scale applied to the element's own box. */
  readonly scale: number;
  /** Clockwise rotation about the origin, in degrees. */
  readonly rotationDeg: number;
  /** The pivot, as a fraction of the element's own box. */
  readonly origin: Point;
}

export type RevealMode = "none" | "wipe" | "split";

/** A partial reveal, so an element can wipe or split onto screen. */
export interface Reveal {
  readonly mode: RevealMode;
  /** 0 = nothing visible, 1 = fully revealed. */
  readonly amount: number;
}

export interface CameraState {
  readonly shot: SceneCamera["shot"];
  readonly movement: SceneCamera["movement"];
  readonly angle: SceneCamera["angle"];
  readonly focus: SceneCamera["focus"];
  /** 1 = the layout as authored; bigger is tighter. */
  readonly scale: number;
  /** Where the camera is pointed, as a fraction of the frame. */
  readonly aim: Point;
  readonly rotationDeg: number;
}

/** Colours the engine itself draws with: background, type, panels, accents. */
export interface Look {
  readonly background: string;
  readonly ink: string;
  readonly accent: string;
  readonly panel: string;
  readonly panelInk: string;
  readonly caption: string;
  /** Font stack the SVG writer emits; a real renderer may substitute. */
  readonly fontFamily: string;
}

export type DiagnosticSeverity = "warning" | "error";

export type DiagnosticCode =
  /** The scene names a cast member no character definition backs. */
  | "missing_character"
  /** The character exists, but the performance it was asked for does not. */
  | "unresolved_performance"
  /** An animation event targets an element this scene does not have. */
  | "unknown_target"
  /** The event is fine, but it cannot apply to that kind of element. */
  | "kind_not_applicable"
  /** A layer the frame draws has no readable file behind it. */
  | "missing_asset"
  /** On-screen text did not fit its box and was truncated at `maxLines`. */
  | "text_overflow"
  /** A parameter was missing or of the wrong type; the documented default applied. */
  | "defaulted_parameter";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  /** The scene the problem is in; `""` when it is about the manifest. */
  readonly sceneId: string;
  /** Dotted path into the manifest, when there is one. */
  readonly path: string;
  readonly message: string;
}

export interface CharacterLayer {
  readonly assetId: string;
  /** Path inside the character library root. */
  readonly path: string;
  readonly hash: string;
  readonly slot: CharacterSlot;
  /** The variant that asked for the layer: `pose:talk`, `base`, `clothing:field`. */
  readonly source: string;
  /** Draw order across the whole figure, lowest first. */
  readonly drawIndex: number;
  /** The layer's own pixel size (its SVG canvas). */
  readonly size: Size;
}

export interface CharacterElement {
  readonly kind: "character";
  readonly id: string;
  readonly z: number;
  readonly characterId: string;
  readonly name: string;
  readonly shortName: string;
  readonly role: CharacterRole;
  readonly palette: CharacterPalette;
  /** What the character is doing in this frame. */
  readonly pose: string;
  readonly expression: string;
  /** `""` when the character has no gesture on. */
  readonly gesture: string;
  readonly clothing: readonly string[];
  readonly accessories: readonly string[];
  readonly facing: CharacterFacing;
  /** The definition's own canvas and anchor, so a renderer can place the figure. */
  readonly canvas: Size;
  readonly anchor: Point;
  readonly layers: readonly CharacterLayer[];
  readonly opacity: number;
  readonly reveal: Reveal;
  readonly transform: Transform;
  /** `front` characters stand nearer the camera than the ones they listen to. */
  readonly depth: "front" | "back";
}

export interface TextStyle {
  readonly fontSizePx: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly align: "left" | "center";
  readonly colour: string;
}

export interface TextElement {
  readonly kind: "text";
  readonly id: string;
  readonly z: number;
  readonly textKind: SceneTextKind;
  /** The words as the frame shows them, after `count_up` has run. */
  readonly value: string;
  /** The value wrapped into the box; what a renderer draws, line by line. */
  readonly lines: readonly string[];
  /** How many characters of `lines` a `type_on` event has revealed. */
  readonly revealChars: number;
  /** The words' source, when the scene shows someone else's material. */
  readonly attribution: string;
  /** How far a `highlight` band behind the type has faded in. */
  readonly highlight: number;
  readonly rect: Rect;
  readonly style: TextStyle;
  readonly opacity: number;
  readonly reveal: Reveal;
  readonly transform: Transform;
}

export interface DiagramElement {
  readonly kind: "diagram";
  readonly id: string;
  readonly z: number;
  readonly diagramKind: SceneDiagramKind;
  readonly title: string;
  readonly annotations: readonly string[];
  readonly series: readonly {
    readonly label: string;
    readonly value: number;
    readonly unit: string;
  }[];
  readonly rect: Rect;
  readonly opacity: number;
  readonly reveal: Reveal;
  readonly transform: Transform;
}

export interface MediaElement {
  readonly kind: "media";
  readonly id: string;
  readonly z: number;
  readonly mediaKind: SceneMedia["kind"];
  readonly treatment: SceneMedia["treatment"];
  /** Asset ids in the manifest's inventory, in order. */
  readonly assetIds: readonly string[];
  /** Filled once the media stage resolves the asset; empty while it is only planned. */
  readonly uri: string;
  readonly description: string;
  readonly rect: Rect;
  readonly opacity: number;
  readonly reveal: Reveal;
  readonly transform: Transform;
}

export interface EffectElement {
  readonly kind: "effect";
  readonly id: string;
  readonly z: number;
  /** `card` sits behind on-screen text, `band` behind a highlighted figure. */
  readonly effect: "card" | "band";
  readonly rect: Rect;
  readonly colour: string;
  readonly opacity: number;
  readonly reveal: Reveal;
  readonly transform: Transform;
}

export type FrameElement =
  CharacterElement | TextElement | DiagramElement | MediaElement | EffectElement;

/** The seam between this scene and the next, as the frame sees it. */
export interface FrameTransition {
  readonly kind: Scene["transition"]["kind"];
  readonly durationSec: number;
  /** The scene this seam hands over to; `""` on the last scene. */
  readonly toSceneId: string;
  /** 0 at the start of the seam, 1 at its end. */
  readonly progress: number;
  /** `progress` with the seam's easing applied — what a renderer mixes with. */
  readonly mix: number;
}

export interface FrameNarration {
  readonly text: string;
  readonly words: number;
  readonly sectionId: string;
  readonly sentenceIds: readonly string[];
}

export interface Frame {
  readonly fps: number;
  /** Global frame index from the start of the video. */
  readonly index: number;
  readonly timeSec: number;
  readonly sceneId: string;
  readonly sceneIndex: number;
  readonly sceneType: SceneType;
  /** Seconds from the start of the scene. */
  readonly localSec: number;
  readonly durationSec: number;
  readonly resolution: Size;
  readonly background: string;
  readonly camera: CameraState;
  /** Draw order is `z` ascending; ties keep the order the elements were built in. */
  readonly elements: readonly FrameElement[];
  readonly transition: FrameTransition;
  readonly narration: FrameNarration;
  readonly diagnostics: readonly Diagnostic[];
}

/** A character on screen in a scene, before the frame's camera moves. */
export interface Blocking {
  readonly characterId: string;
  readonly state: SceneCharacterState;
  readonly elementId: string;
  readonly depth: "front" | "back";
  /** Height the figure occupies on screen, in frame pixels. */
  readonly heightPx: number;
  /** Where the figure's anchor point lands, in frame pixels. */
  readonly position: Point;
  readonly z: number;
}
