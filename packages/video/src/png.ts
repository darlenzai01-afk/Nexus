import { deflateSync, inflateSync } from "node:zlib";

import { createCanvas, type Canvas } from "./canvas.js";

/**
 * PNG encoding and decoding for frames.
 *
 * Frames are written as 8-bit RGBA PNGs because that is what every FFmpeg build
 * can read without a filter, and because a lossless container is the only way to
 * say "these are the pixels the pipeline computed, exactly". No filter type is
 * used (filter 0 on every row) and the deflate level is pinned, so the same
 * canvas produces the same bytes; the encoding never depends on the clock.
 *
 * The decoder exists so that the pipeline (and the tests) can *verify* what was
 * written instead of trusting it: `verifyPngRoundTrip` re-reads a frame and
 * compares it against the canvas that produced it.
 */

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFLATE_LEVEL = 9;

export function encodePng(canvas: Canvas): Uint8Array {
  const { width, height } = canvas;
  const raw = Buffer.allocUnsafe((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    const source = canvas.data.subarray(y * width * 4, (y + 1) * width * 4);
    Buffer.from(source.buffer, source.byteOffset, source.byteLength).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return concatBytes(
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: DEFLATE_LEVEL })),
    chunk("IEND", Buffer.alloc(0)),
  );
}

/** `{ width, height }` from a PNG's IHDR, without decoding the pixels. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const header = readIhdr(bytes);
  return { width: header.width, height: header.height };
}

export function decodePng(bytes: Uint8Array): Canvas {
  const header = readIhdr(bytes);
  if (header.bitDepth !== 8 || header.colourType !== 6) {
    throw new TypeError(
      `only 8-bit RGBA PNGs are supported, got bit depth ${header.bitDepth} / colour type ${header.colourType}`,
    );
  }
  const idat = idatBytes(bytes);
  const raw = new Uint8Array(inflateSync(Buffer.from(idat)));
  const canvas = createCanvas(header.width, header.height);
  const stride = header.width * 4;
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  let offset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[offset] ?? 0;
    offset += 1;
    current.set(raw.subarray(offset, offset + stride));
    offset += stride;
    unfilter(filter, current, previous, 4);
    canvas.data.set(current, y * stride);
    previous.set(current);
  }
  return canvas;
}

/**
 * Re-read written PNG bytes and compare them with the canvas that produced them.
 * Returns a human-readable problem, or `undefined` when the frame is intact.
 */
export function verifyPngRoundTrip(bytes: Uint8Array, expected: Canvas): string | undefined {
  let decoded: Canvas;
  try {
    decoded = decodePng(bytes);
  } catch (error) {
    return `PNG does not decode: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (decoded.width !== expected.width || decoded.height !== expected.height) {
    return `PNG is ${decoded.width}x${decoded.height}, expected ${expected.width}x${expected.height}`;
  }
  for (let index = 0; index < decoded.data.length; index += 1) {
    if (decoded.data[index] !== expected.data[index]) {
      const pixel = Math.floor(index / 4);
      return `PNG differs at pixel ${pixel % decoded.width},${Math.floor(pixel / decoded.width)} (channel ${index % 4})`;
    }
  }
  return undefined;
}

function readIhdr(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
} {
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) throw new TypeError("not a PNG: bad signature");
  }
  if (readAscii(bytes, 12, 4) !== "IHDR") throw new TypeError("not a PNG: no IHDR chunk");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24] ?? 0,
    colourType: bytes[25] ?? 0,
  };
}

function idatBytes(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = readAscii(bytes, offset + 4, 4);
    const start = offset + 8;
    if (type === "IDAT") parts.push(bytes.subarray(start, start + length));
    if (type === "IEND") break;
    offset = start + length + 4;
  }
  if (parts.length === 0) throw new TypeError("not a PNG: no IDAT chunk");
  return concatBytes(...parts);
}

function unfilter(filter: number, row: Uint8Array, previous: Uint8Array, bpp: number): void {
  const length = row.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let index = bpp; index < length; index += 1) {
        row[index] = ((row[index] ?? 0) + (row[index - bpp] ?? 0)) & 0xff;
      }
      return;
    case 2:
      for (let index = 0; index < length; index += 1) {
        row[index] = ((row[index] ?? 0) + (previous[index] ?? 0)) & 0xff;
      }
      return;
    case 3:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bpp ? (row[index - bpp] ?? 0) : 0;
        row[index] = ((row[index] ?? 0) + ((left + (previous[index] ?? 0)) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let index = 0; index < length; index += 1) {
        const a = index >= bpp ? (row[index - bpp] ?? 0) : 0;
        const b = previous[index] ?? 0;
        const c = index >= bpp ? (previous[index - bpp] ?? 0) : 0;
        row[index] = ((row[index] ?? 0) + paeth(a, b, c)) & 0xff;
      }
      return;
    default:
      throw new TypeError(`unknown PNG filter ${filter}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32(Buffer.from(out.buffer, out.byteOffset + 4, data.length + 4));
  out.writeUInt32BE(crc >>> 0, data.length + 8);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}
