import type { Point } from "./canvas.js";

/**
 * A small TrueType reader.
 *
 * The pipeline draws text — on-screen type, diagram labels and captions — itself,
 * so that a frame's pixels are the whole frame and the same bytes come out on any
 * machine. That needs glyph outlines, and glyph outlines need a font parser. This
 * is a deliberately narrow one: TrueType (not CFF/OpenType-PS), `cmap` formats 4
 * and 12, composite glyphs, and nothing else. Anything it does not understand
 * raises, because a wrong glyph is worse than a missing one.
 *
 * Outlines come out in font units with the y axis pointing *up*, the way the file
 * stores them; the caller flips and scales into device space.
 */

export interface ContourPoint {
  readonly x: number;
  readonly y: number;
  /** On-curve points are corners; off-curve points are quadratic controls. */
  readonly on: boolean;
}

export type Contour = readonly ContourPoint[];

export interface FontMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly numGlyphs: number;
}

export interface Font {
  readonly metrics: FontMetrics;
  /** Glyph index for a Unicode code point; 0 (`.notdef`) when unmapped. */
  glyphIndex(codePoint: number): number;
  /** Advance width in font units. */
  advanceWidth(glyphIndex: number): number;
  /** Outlines in font units, composites resolved; empty for blank glyphs. */
  contours(glyphIndex: number): readonly Contour[];
}

interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

export function parseFont(bytes: Uint8Array): Font {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  if (version === 0x74746366) throw new TypeError("TrueType collections are not supported");
  if (version !== 0x00010000 && version !== 0x74727565) {
    throw new TypeError(
      `not a TrueType font (sfnt version 0x${version.toString(16)}; PostScript outlines are not supported)`,
    );
  }

  const tableCount = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    const name = readTag(view, recordOffset);
    tables.set(name.replace(/[\s]/gu, " "), {
      offset: view.getUint32(recordOffset + 8),
      length: view.getUint32(recordOffset + 12),
    });
  }

  const head = require_(tables, "head");
  const hhea = require_(tables, "hhea");
  const maxp = require_(tables, "maxp");
  const unitsPerEm = view.getUint16(head.offset + 18);
  const indexToLocFormat = view.getInt16(head.offset + 50);
  const metrics: FontMetrics = {
    unitsPerEm,
    ascender: view.getInt16(hhea.offset + 4),
    descender: view.getInt16(hhea.offset + 6),
    lineGap: view.getInt16(hhea.offset + 8),
    numGlyphs: view.getUint16(maxp.offset + 4),
  };
  if (unitsPerEm === 0) throw new TypeError("font has unitsPerEm = 0");

  const hMetricsCount = view.getUint16(hhea.offset + 34);
  const advances = (index: number): number => {
    const metricIndex = Math.min(index, hMetricsCount - 1);
    return view.getUint16(hmtxTable(tables).offset + metricIndex * 4);
  };
  const cmap = parseCmap(view, requireAnyTable(tables, ["cmap"]));
  const loca = parseLoca(view, require_(tables, "loca"), metrics.numGlyphs, indexToLocFormat);
  const glyf = requireAnyTable(tables, ["glyf"]);

  const outline = (glyphIndex: number, depth = 0): readonly Contour[] => {
    if (depth > 4) throw new TypeError("composite glyph nesting is too deep");
    if (glyphIndex < 0 || glyphIndex >= metrics.numGlyphs) return [];
    const start = loca[glyphIndex];
    const end = loca[glyphIndex + 1];
    if (start === undefined || end === undefined || end <= start) return [];
    return parseGlyph(view, glyf.offset + start, glyf.offset + end, outline);
  };

  return {
    metrics,
    glyphIndex: (codePoint) => cmap(codePoint),
    advanceWidth: advances,
    contours: (glyphIndex) => outline(glyphIndex),
  };
}

function require_(tables: Map<string, TableRecord>, name: string): TableRecord {
  const record = tables.get(name);
  if (record === undefined) throw new TypeError(`font is missing the ${name} table`);
  return record;
}

function requireAnyTable(tables: Map<string, TableRecord>, names: readonly string[]): TableRecord {
  for (const name of names) {
    const record = tables.get(name);
    if (record !== undefined) return record;
  }
  throw new TypeError(`font is missing all of: ${names.join(", ")}`);
}

function hmtxTable(tables: Map<string, TableRecord>): TableRecord {
  return require_(tables, "hmtx");
}

function parseLoca(
  view: DataView,
  record: TableRecord,
  numGlyphs: number,
  format: number,
): number[] {
  const offsets: number[] = [];
  for (let index = 0; index <= numGlyphs; index += 1) {
    offsets.push(
      format === 0
        ? view.getUint16(record.offset + index * 2) * 2
        : view.getUint32(record.offset + index * 4),
    );
  }
  return offsets;
}

function parseCmap(view: DataView, record: TableRecord): (codePoint: number) => number {
  const count = view.getUint16(record.offset + 2);
  let best: number | undefined;
  let bestScore = -1;
  let wide: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = record.offset + 4 + index * 8;
    const platform = view.getUint16(entry);
    const encoding = view.getUint16(entry + 2);
    const subtable = record.offset + view.getUint32(entry + 4);
    const format = view.getUint16(subtable);
    if (format === 12 && platform === 3 && encoding === 10) wide = subtable;
    const score =
      platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2 : platform === 3 ? 1 : 0;
    if (format === 4 && score > bestScore) {
      bestScore = score;
      best = subtable;
    }
  }
  if (wide !== undefined) return format12(view, wide);
  if (best !== undefined) return format4(view, best);
  throw new TypeError("font has no cmap format 4 or 12 subtable");
}

function format4(view: DataView, offset: number): (codePoint: number) => number {
  const segments = view.getUint16(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const idDeltas = startCodes + segments * 2;
  const idRangeOffsets = idDeltas + segments * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let segment = 0; segment < segments; segment += 1) {
      const end = view.getUint16(endCodes + segment * 2);
      if (codePoint > end) continue;
      const start = view.getUint16(startCodes + segment * 2);
      if (codePoint < start) return 0;
      const delta = view.getInt16(idDeltas + segment * 2);
      const rangeOffset = view.getUint16(idRangeOffsets + segment * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const address = idRangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2;
      if (address + 2 > view.byteLength) return 0;
      const glyph = view.getUint16(address);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

function format12(view: DataView, offset: number): (codePoint: number) => number {
  const groups = view.getUint32(offset + 12);
  return (codePoint) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const group = offset + 16 + middle * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      if (codePoint < start) high = middle - 1;
      else if (codePoint > end) low = middle + 1;
      else return view.getUint32(group + 8) + (codePoint - start);
    }
    return 0;
  };
}

interface GlyphHeader {
  readonly numberOfContours: number;
  readonly xMin: number;
  readonly yMin: number;
}

function parseGlyph(
  view: DataView,
  start: number,
  end: number,
  outline: (glyphIndex: number, depth: number) => readonly Contour[],
  depth = 0,
): readonly Contour[] {
  if (end - start < 10) return [];
  const header: GlyphHeader = {
    numberOfContours: view.getInt16(start),
    xMin: view.getInt16(start + 2),
    yMin: view.getInt16(start + 4),
  };
  if (header.numberOfContours >= 0) return simpleGlyph(view, start, header.numberOfContours);
  return compositeGlyph(view, start, end, outline, depth);
}

function simpleGlyph(view: DataView, start: number, contours: number): readonly Contour[] {
  let offset = start + 10;
  const ends: number[] = [];
  for (let index = 0; index < contours; index += 1) {
    ends.push(view.getUint16(offset));
    offset += 2;
  }
  const pointCount = (ends[ends.length - 1] ?? -1) + 1;
  if (pointCount <= 0) return [];
  const instructionLength = view.getUint16(offset);
  offset += 2 + instructionLength;

  const flags: number[] = [];
  while (flags.length < pointCount) {
    const flag = view.getUint8(offset);
    offset += 1;
    flags.push(flag);
    if ((flag & 0x08) !== 0) {
      const repeat = view.getUint8(offset);
      offset += 1;
      for (let index = 0; index < repeat; index += 1) flags.push(flag);
    }
  }

  const xs: number[] = [];
  let x = 0;
  for (const flag of flags) {
    if ((flag & 0x02) !== 0) {
      const delta = view.getUint8(offset);
      offset += 1;
      x += (flag & 0x10) !== 0 ? delta : -delta;
    } else if ((flag & 0x10) === 0) {
      x += view.getInt16(offset);
      offset += 2;
    }
    xs.push(x);
  }

  const ys: number[] = [];
  let y = 0;
  for (const flag of flags) {
    if ((flag & 0x04) !== 0) {
      const delta = view.getUint8(offset);
      offset += 1;
      y += (flag & 0x20) !== 0 ? delta : -delta;
    } else if ((flag & 0x20) === 0) {
      y += view.getInt16(offset);
      offset += 2;
    }
    ys.push(y);
  }

  const out: Contour[] = [];
  let contourStart = 0;
  for (const contourEnd of ends) {
    const points: ContourPoint[] = [];
    for (let index = contourStart; index <= contourEnd; index += 1) {
      points.push({
        x: xs[index] ?? 0,
        y: ys[index] ?? 0,
        on: ((flags[index] ?? 0) & 0x01) !== 0,
      });
    }
    if (points.length > 0) out.push(points);
    contourStart = contourEnd + 1;
  }
  return out;
}

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

function compositeGlyph(
  view: DataView,
  start: number,
  end: number,
  outline: (glyphIndex: number, depth: number) => readonly Contour[],
  depth: number,
): readonly Contour[] {
  let offset = start + 10;
  const out: Contour[] = [];
  let guard = 0;
  for (;;) {
    if (guard > 64) throw new TypeError("composite glyph has too many components");
    guard += 1;
    if (offset + 4 > end) break;
    const flags = view.getUint16(offset);
    const componentIndex = view.getUint16(offset + 2);
    offset += 4;
    let dx = 0;
    let dy = 0;
    if ((flags & ARG_1_AND_2_ARE_WORDS) !== 0) {
      if ((flags & ARGS_ARE_XY_VALUES) !== 0) {
        dx = view.getInt16(offset);
        dy = view.getInt16(offset + 2);
      } else {
        throw new TypeError("composite glyph uses point matching, which is not supported");
      }
      offset += 4;
    } else {
      if ((flags & ARGS_ARE_XY_VALUES) !== 0) {
        dx = view.getInt8(offset);
        dy = view.getInt8(offset + 1);
      } else {
        throw new TypeError("composite glyph uses point matching, which is not supported");
      }
      offset += 2;
    }
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if ((flags & WE_HAVE_A_SCALE) !== 0) {
      a = view.getInt16(offset) / 16384;
      d = a;
      offset += 2;
    } else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) {
      a = view.getInt16(offset) / 16384;
      d = view.getInt16(offset + 2) / 16384;
      offset += 4;
    } else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) {
      a = view.getInt16(offset) / 16384;
      b = view.getInt16(offset + 2) / 16384;
      c = view.getInt16(offset + 4) / 16384;
      d = view.getInt16(offset + 6) / 16384;
      offset += 8;
    }
    for (const contour of outline(componentIndex, depth + 1)) {
      out.push(
        contour.map((point) => ({
          x: a * point.x + c * point.y + dx,
          y: b * point.x + d * point.y + dy,
          on: point.on,
        })),
      );
    }
    if ((flags & MORE_COMPONENTS) === 0) break;
  }
  return out;
}

/**
 * Flatten a contour into a polygon.
 *
 * TrueType outlines are quadratic splines: an off-curve point is a control and
 * two consecutive off-curve points imply an on-curve point halfway between them.
 * The flattening step count is fixed, so the polygon — and therefore the pixels —
 * does not depend on the machine.
 */
export function contourToPolygon(contour: Contour, segments = 8): Point[] {
  const points = contour.slice();
  if (points.length === 0) return [];
  let startIndex = points.findIndex((point) => point.on);
  if (startIndex < 0) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) return [];
    startIndex = 0;
    points.unshift({ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2, on: true });
  }
  const polygon: Point[] = [];
  const ordered = [...points.slice(startIndex), ...points.slice(0, startIndex)];
  const first = ordered[0];
  if (first === undefined) return [];
  polygon.push({ x: first.x, y: first.y });
  let index = 1;
  while (index < ordered.length) {
    const point = ordered[index];
    if (point === undefined) break;
    if (point.on) {
      polygon.push({ x: point.x, y: point.y });
      index += 1;
      continue;
    }
    const next = ordered[(index + 1) % ordered.length];
    if (next === undefined) break;
    // The curve runs from the last point placed, through `point` (the control),
    // to `next` — which is either an on-curve point or the implied midpoint
    // between two consecutive off-curve points.
    const from = polygon[polygon.length - 1] ?? { x: first.x, y: first.y };
    const end = next.on ? next : { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
    for (let step = 1; step <= segments; step += 1) {
      const t = step / segments;
      const inverse = 1 - t;
      polygon.push({
        x: inverse * inverse * from.x + 2 * inverse * t * point.x + t * t * end.x,
        y: inverse * inverse * from.y + 2 * inverse * t * point.y + t * t * end.y,
      });
    }
    index += next.on ? 2 : 1;
  }
  return polygon;
}

function readTag(view: DataView, offset: number): string {
  let text = "";
  for (let index = 0; index < 4; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}
