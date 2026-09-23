import { DEFAULT_LOOK } from "@nexus/render";
import type { DiagramElement, Frame, FrameElement, Look, MediaElement } from "@nexus/render";

import {
  createCanvas,
  fillLinearGradient,
  fillPath,
  fillRect,
  parseColour,
  strokePolyline,
  type Canvas,
  type Colour,
  type Point,
  type Rect,
} from "./canvas.js";
import type { FontSet } from "./font.js";
import { drawSvg, parseSvg } from "./svg-shapes.js";
import { drawTextElement, drawTextRun, type TextRun } from "./text-raster.js";
import {
  compose,
  composeAll,
  rotation,
  scaling,
  transformRect,
  translation,
  type Matrix,
} from "./transform.js";

/**
 * The frame rasteriser: a composed **frame document** becomes pixels.
 *
 * This is the step Phase 9 stopped short of. It reads exactly the document the
 * engine produced (`Frame` — background, camera, elements with their z, rects,
 * transforms, reveals and text), so there is no second interpretation of the
 * scene: the animation maths stays in `@nexus/render`, and this module only turns
 * geometry into coverage.
 *
 * What it draws itself: backgrounds, character layers (through the SVG subset
 * parser), panels, diagrams, media placeholders, effect cards, on-screen text and
 * panel labels. What it deliberately does not: media files (the media stage does
 * not exist yet, so a planned asset keeps its placeholder panel), camera motion
 * (already folded into the frame) and anything the frame document does not
 * describe.
 */

export interface RasterDiagnostic {
  readonly code:
    "missing_asset" | "unreadable_svg" | "empty_diagram" | "reveal_rotated" | "text_skipped";
  readonly severity: "error" | "warning";
  readonly elementId: string;
  readonly message: string;
}

export interface RasterDeps {
  /** Character layer source by manifest path — the character library's reader. */
  readonly readAsset?: ((path: string) => string | undefined) | undefined;
  /** Fonts for on-screen text and panel labels; without them text is skipped. */
  readonly fonts?: FontSet | undefined;
}

export interface RasterOptions {
  /**
   * Output resolution. The frame's own resolution is the default; a different one
   * must keep the aspect ratio, because a video that stretches its own scene plan
   * is a misconfiguration, not a style decision.
   */
  readonly resolution?: { readonly width: number; readonly height: number } | undefined;
  /** Ink colours for panels and labels (the frame document owns the rest). */
  readonly look?: Look | undefined;
}

export interface DrawnElement {
  readonly id: string;
  readonly kind: FrameElement["kind"];
  readonly z: number;
  /** Device-space box the element occupies after its transform. */
  readonly box: Rect;
  readonly opacity: number;
  readonly reveal: number;
}

export interface RasterResult {
  readonly canvas: Canvas;
  readonly diagnostics: readonly RasterDiagnostic[];
  readonly elements: readonly DrawnElement[];
  /** The scale from the frame's own coordinates to the rendered ones. */
  readonly scale: number;
  readonly resolution: { readonly width: number; readonly height: number };
}

/** Panel geometry and fills, mirroring Phase 9's SVG writer so both agree. */
export const PIXEL_LOOK = {
  diagramPanel: "#161c24",
  diagramStroke: "#2b3542",
  mediaPanel: "#0d1218",
  mediaStroke: "#2b3542",
  floorTint: "#000000",
  floorOpacity: 0.38,
  panelRadius: { diagram: 18, media: 14, effect: 16 } as const,
  placeholderInk: "#c0574a",
} as const;

export function rasteriseFrame(
  frame: Frame,
  deps: RasterDeps = {},
  options: RasterOptions = {},
): RasterResult {
  const resolution = options.resolution ?? frame.resolution;
  const scale = assertAspect(frame, resolution);
  const look = options.look ?? DEFAULT_LOOK;
  const canvas = createCanvas(resolution.width, resolution.height);
  const diagnostics: RasterDiagnostic[] = [];
  const drawn: DrawnElement[] = [];

  drawBackground(canvas, frame, scale);

  const ordered = frame.elements
    .map((element, index) => ({ element, index }))
    .sort((left, right) => left.element.z - right.element.z || left.index - right.index);

  for (const { element } of ordered) {
    const matrix = elementMatrix(element, scale);
    const clip = revealClip(element, matrix, scale, diagnostics);
    switch (element.kind) {
      case "character":
        drawCharacter(canvas, element, matrix, clip, deps, diagnostics);
        break;
      case "text":
        if (deps.fonts === undefined) {
          diagnostics.push({
            code: "text_skipped",
            severity: "warning",
            elementId: element.id,
            message: `no font is configured, so on-screen text ${element.id} was not drawn`,
          });
        } else {
          drawTextElement(canvas, element, { fonts: deps.fonts, matrix, clip });
        }
        break;
      case "diagram":
        drawDiagram(canvas, element, matrix, clip, deps, diagnostics, look);
        break;
      case "media":
        drawMedia(canvas, element, matrix, clip, deps, look);
        break;
      case "effect":
        drawEffect(canvas, element, matrix, clip);
        break;
    }
    drawn.push({
      id: element.id,
      kind: element.kind,
      z: element.z,
      box: transformRect(matrix, elementBox(element, scale)),
      opacity: element.opacity,
      reveal: element.reveal.amount,
    });
  }

  return { canvas, diagnostics, elements: drawn, scale, resolution };
}

/** The frame's own coordinates → the rendered ones. */
function assertAspect(
  frame: Frame,
  resolution: { readonly width: number; readonly height: number },
): number {
  const sourceAspect = frame.resolution.width / frame.resolution.height;
  const targetAspect = resolution.width / resolution.height;
  if (Math.abs(sourceAspect - targetAspect) > 1e-3) {
    throw new TypeError(
      `render resolution ${resolution.width}x${resolution.height} is ${targetAspect.toFixed(3)}:1 but the scene plan is ` +
        `${frame.resolution.width}x${frame.resolution.height} (${sourceAspect.toFixed(3)}:1); a render must not stretch its own plan`,
    );
  }
  return resolution.width / frame.resolution.width;
}

function drawBackground(canvas: Canvas, frame: Frame, scale: number): void {
  void scale;
  const width = canvas.width;
  const height = canvas.height;
  fillRect(canvas, { x: 0, y: 0, width, height }, parseColour(frame.background), { alpha: 1 });
  // The SVG writer's floor wash: black, transparent at the top, 38% at the bottom.
  fillLinearGradient(
    canvas,
    { x: 0, y: height * 0.62, width, height: height * 0.38 },
    { r: 0, g: 0, b: 0, a: 0 },
    { r: 0, g: 0, b: 0, a: PIXEL_LOOK.floorOpacity },
    { alpha: 1 },
  );
}

function elementBox(element: FrameElement, scale: number): Rect {
  switch (element.kind) {
    case "character":
      return { x: 0, y: 0, width: element.canvas.width, height: element.canvas.height };
    case "text":
    case "diagram":
    case "media":
    case "effect":
      return { x: 0, y: 0, width: element.rect.width, height: element.rect.height };
  }
  void scale;
}

/** `translate(x y) rotate(deg) scale(s) translate(-origin × box)`, as the SVG says. */
export function elementMatrix(element: FrameElement, scale: number): Matrix {
  const box = elementBox(element, scale);
  return composeAll(
    translation(element.transform.x * scale, element.transform.y * scale),
    rotation(element.transform.rotationDeg),
    scaling(element.transform.scale),
    translation(
      -element.transform.origin.x * box.width * scale,
      -element.transform.origin.y * box.height * scale,
    ),
  );
}

/**
 * The element's reveal, as a device-space clip.
 *
 * The SVG writer clips in the element's own coordinate space. A rotated element
 * would need a rotated clip region here, so the clip is the transformed box of the
 * same region and the rotation is *reported* — the wipe still lands in the right
 * place, its edge is square to the frame rather than to the element.
 */
function revealClip(
  element: FrameElement,
  matrix: Matrix,
  scale: number,
  diagnostics: RasterDiagnostic[],
): Rect | undefined {
  if (element.reveal.mode === "none" || element.reveal.amount >= 1) return undefined;
  const box = elementBox(element, scale);
  const width = box.width * scale;
  const height = box.height * scale;
  const local =
    element.reveal.mode === "wipe"
      ? { x: 0, y: 0, width: width * element.reveal.amount, height }
      : {
          x: (width * (1 - element.reveal.amount)) / 2,
          y: 0,
          width: width * element.reveal.amount,
          height,
        };
  if (element.transform.rotationDeg !== 0) {
    diagnostics.push({
      code: "reveal_rotated",
      severity: "warning",
      elementId: element.id,
      message: `${element.id} reveals while rotated ${element.transform.rotationDeg}°, so its clip is the axis-aligned box of the rotated region`,
    });
  }
  return transformRect(matrix, local);
}

function drawCharacter(
  canvas: Canvas,
  element: Extract<FrameElement, { kind: "character" }>,
  matrix: Matrix,
  clip: Rect | undefined,
  deps: RasterDeps,
  diagnostics: RasterDiagnostic[],
): void {
  const layers = element.layers.slice().sort((left, right) => left.drawIndex - right.drawIndex);
  let painted = 0;
  for (const layer of layers) {
    const source = deps.readAsset?.(layer.path);
    if (source === undefined || source === "") {
      diagnostics.push({
        code: "missing_asset",
        severity: "error",
        elementId: element.id,
        message: `layer ${layer.assetId} of ${element.characterId} could not be read (${layer.path})`,
      });
      continue;
    }
    let parsed;
    try {
      parsed = parseSvg(source);
    } catch (error) {
      diagnostics.push({
        code: "unreadable_svg",
        severity: "error",
        elementId: element.id,
        message: `layer ${layer.assetId} of ${element.characterId}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const layerMatrix = compose(
      matrix,
      scaling(element.canvas.width / parsed.width, element.canvas.height / parsed.height),
    );
    drawSvg(canvas, parsed, { matrix: layerMatrix, alpha: element.opacity, clip });
    painted += 1;
  }
  if (painted === 0) drawCharacterPlaceholder(canvas, element, matrix, clip, deps);
}

/** What the SVG writer draws when a cast member has no readable layers. */
function drawCharacterPlaceholder(
  canvas: Canvas,
  element: Extract<FrameElement, { kind: "character" }>,
  matrix: Matrix,
  clip: Rect | undefined,
  deps: RasterDeps,
): void {
  const box = { x: 0, y: 0, width: element.canvas.width, height: element.canvas.height };
  const device = transformRect(matrix, box);
  strokePolyline(
    canvas,
    [
      { x: device.x, y: device.y },
      { x: device.x + device.width, y: device.y },
      { x: device.x + device.width, y: device.y + device.height },
      { x: device.x, y: device.y + device.height },
      { x: device.x, y: device.y },
    ],
    parseColour(PIXEL_LOOK.placeholderInk),
    Math.max(1, 6 * (device.width / Math.max(1, box.width))),
    { alpha: element.opacity, clip },
  );
  if (deps.fonts === undefined) return;
  drawTextRun(
    canvas,
    {
      text: element.shortName,
      x: box.width / 2,
      baselineY: box.height / 2,
      fontSizePx: 54,
      weight: 400,
      italic: false,
      anchor: "middle",
      colour: PIXEL_LOOK.placeholderInk,
      alpha: element.opacity,
    },
    { fonts: deps.fonts, matrix, clip },
  );
}

function drawEffect(
  canvas: Canvas,
  element: Extract<FrameElement, { kind: "effect" }>,
  matrix: Matrix,
  clip: Rect | undefined,
): void {
  const box = { x: 0, y: 0, width: element.rect.width, height: element.rect.height };
  fillPath(canvas, [projectRect(matrix, box)], parseColour(element.colour), {
    alpha: 0.94 * element.opacity,
    clip,
  });
  fillPath(
    canvas,
    [
      projectRect(matrix, {
        x: 0,
        y: box.height * 0.18,
        width: 8,
        height: box.height * 0.64,
      }),
    ],
    parseColour(DEFAULT_LOOK.accent),
    { alpha: element.opacity, clip },
  );
}

function drawDiagram(
  canvas: Canvas,
  element: DiagramElement,
  matrix: Matrix,
  clip: Rect | undefined,
  deps: RasterDeps,
  diagnostics: RasterDiagnostic[],
  look: Look,
): void {
  const box = { x: 0, y: 0, width: element.rect.width, height: element.rect.height };
  fillPath(canvas, [projectRect(matrix, box)], parseColour(PIXEL_LOOK.diagramPanel), {
    alpha: element.opacity,
    clip,
  });
  strokeRectOutline(canvas, PIXEL_LOOK.diagramStroke, 2, element.opacity, clip, matrix, box);

  const titleSize = Math.round(box.height * 0.07);
  const fonts = deps.fonts;
  if (fonts === undefined) return;
  const label = (run: TextRun): void => {
    drawTextRun(canvas, { ...run, alpha: element.opacity }, { fonts, matrix, clip });
  };
  label({
    text: element.title === "" ? element.diagramKind : element.title,
    x: 28,
    baselineY: titleSize + 18,
    fontSizePx: titleSize,
    weight: 600,
    italic: false,
    anchor: "start",
    colour: look.panelInk,
  });

  const plotTop = titleSize + 40;
  const plotHeight = box.height - plotTop - 28;
  const plotWidth = box.width - 56;

  if (element.diagramKind === "bar_chart" || element.diagramKind === "comparison") {
    const max = Math.max(1, ...element.series.map((point) => Math.abs(point.value)));
    const slot = plotWidth / Math.max(1, element.series.length);
    element.series.forEach((point, index) => {
      const height = (Math.abs(point.value) / max) * plotHeight;
      fillPath(
        canvas,
        [
          projectRect(matrix, {
            x: 28 + index * slot + slot * 0.15,
            y: plotTop + plotHeight - height,
            width: slot * 0.7,
            height,
          }),
        ],
        parseColour(look.accent),
        { alpha: element.opacity, clip },
      );
      label({
        text: point.label,
        x: 28 + index * slot + slot * 0.5,
        baselineY: box.height - 10,
        fontSizePx: Math.round(box.height * 0.045),
        weight: 400,
        italic: false,
        anchor: "middle",
        colour: look.panelInk,
      });
    });
    return;
  }

  if (
    (element.diagramKind === "line_chart" || element.diagramKind === "timeline") &&
    element.series.length > 1
  ) {
    const max = Math.max(1, ...element.series.map((point) => Math.abs(point.value)));
    const step = plotWidth / (element.series.length - 1);
    const points = element.series.map((point, index) =>
      projectPoint(matrix, {
        x: 28 + index * step,
        y: plotTop + plotHeight - (Math.abs(point.value) / max) * plotHeight,
      }),
    );
    strokePolyline(canvas, points, parseColour("#7fd1c8"), 6 * scaleOf(matrix), {
      alpha: element.opacity,
      clip,
    });
    return;
  }

  element.annotations.forEach((annotation, index) => {
    label({
      text: annotation,
      x: 28,
      baselineY: plotTop + titleSize * 0.6 + index * titleSize * 1.4,
      fontSizePx: titleSize * 0.8,
      weight: 400,
      italic: false,
      anchor: "start",
      colour: look.panelInk,
    });
  });
  const first = element.series[0];
  if (first !== undefined) {
    label({
      text: `${first.value}${first.unit}`,
      x: 28,
      baselineY: box.height - 40,
      fontSizePx: titleSize,
      weight: 800,
      italic: false,
      anchor: "start",
      colour: look.accent,
    });
  }
  if (element.series.length === 0 && element.annotations.length === 0) {
    diagnostics.push({
      code: "empty_diagram",
      severity: "warning",
      elementId: element.id,
      message: `diagram ${element.id} has neither annotations nor series to draw`,
    });
  }
}

function drawMedia(
  canvas: Canvas,
  element: MediaElement,
  matrix: Matrix,
  clip: Rect | undefined,
  deps: RasterDeps,
  look: Look,
): void {
  const box = { x: 0, y: 0, width: element.rect.width, height: element.rect.height };
  fillPath(canvas, [projectRect(matrix, box)], parseColour(PIXEL_LOOK.mediaPanel), {
    alpha: element.opacity,
    clip,
  });
  strokeRectOutline(canvas, PIXEL_LOOK.mediaStroke, 2, element.opacity, clip, matrix, box);
  if (element.uri === "") {
    // Planned, not resolved: the SVG writer crosses the placeholder out.
    strokePolyline(
      canvas,
      [projectPoint(matrix, { x: 0, y: 0 }), projectPoint(matrix, { x: box.width, y: box.height })],
      parseColour(PIXEL_LOOK.mediaStroke),
      2,
      { alpha: element.opacity, clip },
    );
    strokePolyline(
      canvas,
      [projectPoint(matrix, { x: box.width, y: 0 }), projectPoint(matrix, { x: 0, y: box.height })],
      parseColour(PIXEL_LOOK.mediaStroke),
      2,
      { alpha: element.opacity, clip },
    );
  }
  const fonts = deps.fonts;
  if (fonts === undefined) return;
  const size = Math.round(box.height * 0.055);
  const label = (run: TextRun): void => {
    drawTextRun(canvas, { ...run, alpha: element.opacity }, { fonts, matrix, clip });
  };
  label({
    text: `${element.mediaKind} · ${element.treatment} · ${element.uri === "" ? "planned" : element.uri}`,
    x: 24,
    baselineY: size + 20,
    fontSizePx: size,
    weight: 400,
    italic: false,
    anchor: "start",
    colour: look.caption,
  });
  label({
    text: element.description,
    x: 24,
    baselineY: box.height - 24,
    fontSizePx: size * 1.1,
    weight: 400,
    italic: false,
    anchor: "start",
    colour: look.panelInk,
  });
}

function strokeRectOutline(
  canvas: Canvas,
  colour: string,
  width: number,
  alpha: number,
  clip: Rect | undefined,
  matrix: Matrix,
  box: Rect,
): void {
  const corners = projectRect(matrix, box);
  const first = corners[0];
  strokePolyline(
    canvas,
    first === undefined ? corners : [...corners, first],
    parseColour(colour),
    width * scaleOf(matrix),
    { alpha, clip },
  );
}

function projectPoint(matrix: Matrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

function projectRect(matrix: Matrix, rect: Rect): Point[] {
  return [
    projectPoint(matrix, { x: rect.x, y: rect.y }),
    projectPoint(matrix, { x: rect.x + rect.width, y: rect.y }),
    projectPoint(matrix, { x: rect.x + rect.width, y: rect.y + rect.height }),
    projectPoint(matrix, { x: rect.x, y: rect.y + rect.height }),
  ];
}

function scaleOf(matrix: Matrix): number {
  return Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
}

/** The colour under a pixel — what a test asserts on. */
export function colourAt(canvas: Canvas, x: number, y: number): Colour {
  const index = (y * canvas.width + x) * 4;
  return {
    r: canvas.data[index] ?? 0,
    g: canvas.data[index + 1] ?? 0,
    b: canvas.data[index + 2] ?? 0,
    a: (canvas.data[index + 3] ?? 0) / 255,
  };
}

/** A hex string for a pixel, for readable assertions and logs. */
export function hexAt(canvas: Canvas, x: number, y: number): string {
  const colour = colourAt(canvas, x, y);
  const hex = (value: number): string => Math.round(value).toString(16).padStart(2, "0");
  return `#${hex(colour.r)}${hex(colour.g)}${hex(colour.b)}`;
}
