import type { Diagnostic, EffectElement, Frame, FrameElement, Reveal, Size } from "./types.js";
import { formatNumber, round } from "./numbers.js";
import { visibleLines } from "./text.js";

/**
 * The writer: composed frames become SVG.
 *
 * The engine composes documents; this module turns one into a file a browser can
 * draw — which is what makes the engine's output *checkable by eye* in an
 * environment with no rasteriser, and what a real renderer consumes later. The
 * character layers are embedded as nested `<svg>` elements, so the flat-shape art
 * of the character system is drawn with its own view box inside the frame's
 * transform; type, panels, cards and diagram marks are emitted as SVG shapes.
 *
 * The writer is deterministic (same frame + same bytes in ⇒ byte-identical string
 * out) and never throws: a layer whose bytes are missing becomes a marked
 * placeholder plus a diagnostic, because a frame with a hole in it is more useful
 * than no frame at all.
 */

export interface SvgOptions {
  /** Bytes of a character layer, by its path inside the character library. */
  readonly read?: ((path: string) => string | undefined) | undefined;
  /** `true` wraps the frame in `<?xml …?>`; the default emits a bare `<svg>` element. */
  readonly xmlDeclaration?: boolean | undefined;
  /** Prefix for the document's own def ids, when several frames share a document. */
  readonly idPrefix?: string | undefined;
}

export interface SvgResult {
  readonly svg: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly bytes: number;
}

export const STORYBOARD = { columns: 4, tileWidth: 480, gap: 8, captionHeight: 34 } as const;

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function idOf(element: FrameElement): string {
  return `el-${element.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

/** The unwrapped element box: the transform scales it about `origin`. */
function boxOf(element: FrameElement): Size {
  switch (element.kind) {
    case "character":
      return { width: element.canvas.width, height: element.canvas.height };
    case "text":
    case "diagram":
    case "media":
    case "effect":
      return { width: element.rect.width, height: element.rect.height };
  }
}

function clipId(element: FrameElement, prefix: string): string {
  return `${prefix}clip-${element.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

function clipShape(reveal: Reveal, box: Size): string {
  if (reveal.mode === "wipe") {
    return `<rect x="0" y="0" width="${formatNumber(box.width * reveal.amount)}" height="${formatNumber(box.height)}"/>`;
  }
  const inset = box.width * (1 - reveal.amount) * 0.5;
  return `<rect x="${formatNumber(inset)}" y="0" width="${formatNumber(box.width * reveal.amount)}" height="${formatNumber(box.height)}"/>`;
}

function groupAttributes(element: FrameElement, box: Size, prefix: string): string {
  const { transform: t } = element;
  const translate = `translate(${formatNumber(t.x)} ${formatNumber(t.y)})`;
  const rotate = t.rotationDeg === 0 ? "" : ` rotate(${formatNumber(t.rotationDeg)})`;
  const scale = t.scale === 1 ? "" : ` scale(${formatNumber(t.scale)})`;
  const pivot = ` translate(${formatNumber(-t.origin.x * box.width)} ${formatNumber(-t.origin.y * box.height)})`;
  const clip =
    element.reveal.mode === "none" ? "" : ` clip-path="url(#${clipId(element, prefix)})"`;
  const opacity = element.opacity >= 1 ? "" : ` opacity="${formatNumber(element.opacity)}"`;
  return ` transform="${translate}${rotate}${scale}${pivot}"${opacity}${clip}`;
}

function characterBody(
  element: Extract<FrameElement, { kind: "character" }>,
  options: SvgOptions,
  diagnostics: Diagnostic[],
): string {
  const box = boxOf(element);
  const parts: string[] = [];
  for (const layer of element.layers) {
    const source = options.read?.(layer.path);
    if (source === undefined || source === "") {
      diagnostics.push({
        code: "missing_asset",
        severity: "error",
        sceneId: "",
        path: layer.path,
        message: `layer ${layer.assetId} of ${element.characterId} could not be read`,
      });
      continue;
    }
    const open = source.indexOf(">");
    const close = source.lastIndexOf("</svg>");
    const inner = open >= 0 && close > open ? source.slice(open + 1, close) : source;
    parts.push(
      `<svg x="0" y="0" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" ` +
        `viewBox="0 0 ${formatNumber(layer.size.width)} ${formatNumber(layer.size.height)}" ` +
        `preserveAspectRatio="none">${inner}</svg>`,
    );
  }
  if (parts.length === 0) {
    parts.push(
      `<rect x="0" y="0" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" ` +
        `fill="none" stroke="#c0574a" stroke-width="6" stroke-dasharray="18 12"/>` +
        `<text x="${formatNumber(box.width / 2)}" y="${formatNumber(box.height / 2)}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="54" fill="#c0574a">${escapeXml(element.shortName)}</text>`,
    );
  }
  return parts.join("");
}

function textBody(
  element: Extract<FrameElement, { kind: "text" }>,
  look: { caption: string },
): string {
  const box = boxOf(element);
  const lines = visibleLines(element.lines, element.revealChars);
  const { fontSizePx, weight, italic, colour, align } = element.style;
  const lineHeight = round(fontSizePx * 1.25);
  const attribution = element.attribution === "" ? [] : [element.attribution];
  const block = [...lines, ...attribution];
  const startY = box.height / 2 - ((block.length - 1) * lineHeight) / 2 + fontSizePx * 0.35;
  const anchor = align === "center" ? "middle" : "start";
  const x = align === "center" ? box.width / 2 : 0;
  const parts: string[] = [];
  if (element.highlight > 0) {
    parts.push(
      `<rect x="${formatNumber(-12)}" y="${formatNumber(startY - fontSizePx * 1.05)}" ` +
        `width="${formatNumber(box.width + 24)}" height="${formatNumber(block.length * lineHeight + fontSizePx * 0.6)}" ` +
        `rx="10" fill="#e0a33c" opacity="${formatNumber(0.18 * element.highlight)}"/>`,
    );
  }
  parts.push(
    `<text x="${formatNumber(x)}" y="${formatNumber(startY)}" text-anchor="${anchor}" ` +
      `font-family="inherit" font-size="${formatNumber(fontSizePx)}" font-weight="${weight}" ` +
      `font-style="${italic ? "italic" : "normal"}" fill="${colour}">`,
  );
  lines.forEach((line, index) => {
    parts.push(
      `<tspan x="${formatNumber(x)}" y="${formatNumber(startY + index * lineHeight)}">${escapeXml(line)}</tspan>`,
    );
  });
  attribution.forEach((line, index) => {
    const y = startY + (lines.length + index) * lineHeight;
    parts.push(
      `<tspan x="${formatNumber(x)}" y="${formatNumber(y)}" font-size="${formatNumber(fontSizePx * 0.72)}" ` +
        `fill="${look.caption}">${escapeXml(line)}</tspan>`,
    );
  });
  parts.push("</text>");
  return parts.join("");
}

function diagramBody(
  element: Extract<FrameElement, { kind: "diagram" }>,
  look: { panelInk: string },
): string {
  const box = boxOf(element);
  const parts = [
    `<rect x="0" y="0" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" rx="18" ` +
      `fill="#161c24" stroke="#2b3542" stroke-width="2"/>`,
  ];
  const titleSize = round(box.height * 0.07);
  parts.push(
    `<text x="28" y="${formatNumber(titleSize + 18)}" font-family="inherit" font-size="${formatNumber(titleSize)}" ` +
      `font-weight="600" fill="${look.panelInk}">${escapeXml(element.title || element.diagramKind)}</text>`,
  );
  const plotTop = titleSize + 40;
  const plotHeight = box.height - plotTop - 28;
  const plotWidth = box.width - 56;

  if (element.diagramKind === "bar_chart" || element.diagramKind === "comparison") {
    const max = Math.max(1, ...element.series.map((point) => Math.abs(point.value)));
    const slot = plotWidth / Math.max(1, element.series.length);
    element.series.forEach((point, index) => {
      const height = (Math.abs(point.value) / max) * plotHeight;
      parts.push(
        `<rect x="${formatNumber(28 + index * slot + slot * 0.15)}" y="${formatNumber(plotTop + plotHeight - height)}" ` +
          `width="${formatNumber(slot * 0.7)}" height="${formatNumber(height)}" fill="#e0a33c" rx="6"/>`,
      );
      parts.push(
        `<text x="${formatNumber(28 + index * slot + slot * 0.5)}" y="${formatNumber(box.height - 10)}" text-anchor="middle" ` +
          `font-family="inherit" font-size="${formatNumber(round(box.height * 0.045))}" fill="${look.panelInk}">` +
          `${escapeXml(point.label)}</text>`,
      );
    });
  } else if (
    (element.diagramKind === "line_chart" || element.diagramKind === "timeline") &&
    element.series.length > 1
  ) {
    const max = Math.max(1, ...element.series.map((point) => Math.abs(point.value)));
    const step = plotWidth / (element.series.length - 1);
    const points = element.series
      .map(
        (point, index) =>
          `${formatNumber(28 + index * step)},${formatNumber(plotTop + plotHeight - (Math.abs(point.value) / max) * plotHeight)}`,
      )
      .join(" ");
    parts.push(`<polyline points="${points}" fill="none" stroke="#7fd1c8" stroke-width="6"/>`);
  } else {
    element.annotations.forEach((annotation, index) => {
      parts.push(
        `<text x="28" y="${formatNumber(plotTop + titleSize * 0.6 + index * titleSize * 1.4)}" font-family="inherit" ` +
          `font-size="${formatNumber(titleSize * 0.8)}" fill="${look.panelInk}">${escapeXml(annotation)}</text>`,
      );
    });
    const first = element.series[0];
    if (first !== undefined) {
      parts.push(
        `<text x="28" y="${formatNumber(box.height - 40)}" font-family="inherit" ` +
          `font-size="${formatNumber(titleSize)}" font-weight="800" fill="#e0a33c">` +
          `${escapeXml(`${first.value}${first.unit}`)}</text>`,
      );
    }
  }
  return parts.join("");
}

function mediaBody(
  element: Extract<FrameElement, { kind: "media" }>,
  look: { caption: string },
): string {
  const box = boxOf(element);
  const parts = [
    `<rect x="0" y="0" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" rx="14" ` +
      `fill="#0d1218" stroke="#2b3542" stroke-width="2"/>`,
  ];
  if (element.uri === "") {
    parts.push(
      `<line x1="0" y1="0" x2="${formatNumber(box.width)}" y2="${formatNumber(box.height)}" stroke="#2b3542" stroke-width="2"/>`,
      `<line x1="${formatNumber(box.width)}" y1="0" x2="0" y2="${formatNumber(box.height)}" stroke="#2b3542" stroke-width="2"/>`,
    );
  }
  const size = round(box.height * 0.055);
  parts.push(
    `<text x="24" y="${formatNumber(size + 20)}" font-family="inherit" font-size="${formatNumber(size)}" ` +
      `fill="${look.caption}">${escapeXml(`${element.mediaKind} · ${element.treatment} · ${element.uri === "" ? "planned" : element.uri}`)}</text>`,
  );
  parts.push(
    `<text x="24" y="${formatNumber(box.height - 24)}" font-family="inherit" font-size="${formatNumber(size * 1.1)}" ` +
      `fill="#dfe4e0">${escapeXml(element.description)}</text>`,
  );
  return parts.join("");
}

function effectBody(element: EffectElement): string {
  const box = boxOf(element);
  return (
    `<rect x="0" y="0" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" rx="16" ` +
    `fill="${element.colour}" opacity="0.94"/>` +
    `<rect x="0" y="${formatNumber(box.height * 0.18)}" width="8" height="${formatNumber(box.height * 0.64)}" ` +
    `fill="#e0a33c" rx="4"/>`
  );
}

function elementBody(
  element: FrameElement,
  options: SvgOptions,
  diagnostics: Diagnostic[],
): string {
  const look = { caption: "#9fb0bd", panelInk: "#dfe4e0" };
  switch (element.kind) {
    case "character":
      return characterBody(element, options, diagnostics);
    case "text":
      return textBody(element, look);
    case "diagram":
      return diagramBody(element, look);
    case "media":
      return mediaBody(element, look);
    case "effect":
      return effectBody(element);
  }
}

function backgroundOf(frame: Frame, prefix: string): string {
  const { width, height } = frame.resolution;
  return (
    `<rect x="0" y="0" width="${formatNumber(width)}" height="${formatNumber(height)}" fill="${frame.background}"/>` +
    `<rect x="0" y="${formatNumber(height * 0.62)}" width="${formatNumber(width)}" height="${formatNumber(height * 0.38)}" ` +
    `fill="url(#${prefix}floor)"/>`
  );
}

function defsOf(frame: Frame, prefix: string): string {
  const parts = [
    `<linearGradient id="${prefix}floor" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000000" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000000" stop-opacity="0.38"/>` +
      `</linearGradient>`,
  ];
  for (const element of frame.elements) {
    if (element.reveal.mode === "none") continue;
    parts.push(
      `<clipPath id="${clipId(element, prefix)}" clipPathUnits="userSpaceOnUse">` +
        `${clipShape(element.reveal, boxOf(element))}</clipPath>`,
    );
  }
  return `<defs>${parts.join("")}</defs>`;
}

/** The inside of a frame document: background, defs and every element, in `z` order. */
export function frameBody(frame: Frame, options: SvgOptions = {}): SvgResult {
  const prefix = options.idPrefix ?? "";
  const diagnostics: Diagnostic[] = [];
  const parts = [defsOf(frame, prefix), backgroundOf(frame, prefix)];
  for (const element of frame.elements) {
    const box = boxOf(element);
    const body = elementBody(element, options, diagnostics);
    if (body === "") continue;
    parts.push(`<g id="${idOf(element)}"${groupAttributes(element, box, prefix)}>${body}</g>`);
  }
  const svg = parts.join("");
  return { svg, diagnostics, bytes: new TextEncoder().encode(svg).length };
}

/** One frame as a standalone SVG document. */
export function frameToSvg(frame: Frame, options: SvgOptions = {}): SvgResult {
  const body = frameBody(frame, options);
  const { width, height } = frame.resolution;
  const head = options.xmlDeclaration === true ? '<?xml version="1.0" encoding="UTF-8"?>' : "";
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(width)}" height="${formatNumber(height)}" ` +
    `viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}" ` +
    `font-family="Inter, Helvetica, Arial, sans-serif">`;
  const svg = `${head}${open}\n${body.svg}\n</svg>\n`;
  return { svg, diagnostics: body.diagnostics, bytes: new TextEncoder().encode(svg).length };
}

export interface StoryboardOptions extends SvgOptions {
  readonly columns?: number | undefined;
  readonly tileWidth?: number | undefined;
  readonly title?: string | undefined;
}

/**
 * A contact sheet of sampled frames: one file that shows a whole scene evolving.
 * Handy when there is no rasteriser to make a video preview with — and a compact
 * proof that transitions, camera moves and the animation fold are doing what the
 * manifest asked for.
 */
export function storyboardSvg(
  frames: readonly Frame[],
  options: StoryboardOptions = {},
): SvgResult {
  if (frames.length === 0) throw new Error("a storyboard needs at least one frame");
  const first = frames[0]!;
  const columns = Math.max(1, options.columns ?? STORYBOARD.columns);
  const tileWidth = options.tileWidth ?? STORYBOARD.tileWidth;
  const scale = tileWidth / first.resolution.width;
  const tileHeight = round(first.resolution.height * scale);
  const rows = Math.ceil(frames.length / columns);
  const gap = STORYBOARD.gap;
  const caption = STORYBOARD.captionHeight;
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rows * (tileHeight + caption) + (rows + 1) * gap;
  const diagnostics: Diagnostic[] = [];
  const parts: string[] = [
    `<rect x="0" y="0" width="${formatNumber(width)}" height="${formatNumber(height)}" fill="#0b0e12"/>`,
  ];

  frames.forEach((frame, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const tileX = gap + column * (tileWidth + gap);
    const tileY = gap + row * (tileHeight + caption + gap);
    const body = frameBody(frame, { ...options, idPrefix: `${options.idPrefix ?? ""}t${index}-` });
    diagnostics.push(...body.diagnostics);
    parts.push(
      `<svg x="${formatNumber(tileX)}" y="${formatNumber(tileY)}" width="${formatNumber(tileWidth)}" ` +
        `height="${formatNumber(tileHeight)}" viewBox="0 0 ${formatNumber(frame.resolution.width)} ${formatNumber(frame.resolution.height)}">` +
        `${body.svg}</svg>`,
    );
    parts.push(
      `<text x="${formatNumber(tileX)}" y="${formatNumber(tileY + tileHeight + 22)}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
        `font-size="16" fill="#9fb0bd">${escapeXml(
          `#${frame.index} · ${frame.timeSec.toFixed(2)}s · ${frame.sceneId} · ${frame.camera.shot}/${frame.camera.movement}` +
            (frame.transition.mix > 0
              ? ` · ${frame.transition.kind} ${frame.transition.mix.toFixed(2)}`
              : ""),
        )}</text>`,
    );
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(width)}" height="${formatNumber(height)}" ` +
    `viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}">\n${parts.join("\n")}\n</svg>\n`;
  return { svg, diagnostics, bytes: new TextEncoder().encode(svg).length };
}
