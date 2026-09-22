import { readFileSync } from "node:fs";

/**
 * Just enough ISO-BMFF to *check* what FFmpeg wrote.
 *
 * The pipeline promises a video artifact with a duration, a resolution and an
 * audio track. It should not take FFmpeg's word for it: the file is read back and
 * the facts come from the container itself — which is also how the smoke test
 * proves the deliverable without a second tool (`ffprobe` is a separate binary,
 * and this build has none).
 *
 * Only the boxes that answer those questions are parsed; anything else in the
 * file is skipped by length, which is exactly how a BMFF reader is supposed to
 * walk a file.
 */

export interface Mp4VideoTrack {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly timescale: number;
  readonly durationSec: number;
  readonly frameCount: number;
}

export interface Mp4AudioTrack {
  readonly codec: string;
  readonly channels: number;
  readonly sampleRate: number;
  readonly durationSec: number;
}

export interface Mp4Info {
  readonly durationSec: number;
  readonly timescale: number;
  readonly fastStart: boolean;
  readonly video?: Mp4VideoTrack | undefined;
  readonly audio?: Mp4AudioTrack | undefined;
  readonly brands: readonly string[];
}

export function readMp4(file: string): Mp4Info {
  return parseMp4(new Uint8Array(readFileSync(file)));
}

export function parseMp4(bytes: Uint8Array): Mp4Info {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = readBoxes(view, 0, bytes.byteLength);
  const ftyp = boxes.find((box) => box.type === "ftyp");
  const moov = boxes.find((box) => box.type === "moov");
  if (moov === undefined) throw new TypeError("not an MP4: no moov box");
  // ftyp payload: major_brand, minor_version, then compatible brands — so the
  // first brand sits 8 bytes into the box, after its size and type.
  const brands: string[] = [];
  if (ftyp !== undefined) {
    for (let offset = ftyp.start + 8; offset + 4 <= ftyp.end; offset += 4) {
      brands.push(readType(view, offset));
    }
  }

  let durationSec = 0;
  let timescale = 0;
  let video: Mp4VideoTrack | undefined;
  let audio: Mp4AudioTrack | undefined;

  for (const box of readBoxes(view, moov.start + 8, moov.end)) {
    if (box.type === "mvhd") {
      const header = readMvhd(view, box);
      durationSec = header.durationSec;
      timescale = header.timescale;
      continue;
    }
    if (box.type !== "trak") continue;
    const parsed = readTrak(view, box);
    if (parsed.kind === "video" && video === undefined) video = parsed.track as Mp4VideoTrack;
    if (parsed.kind === "audio" && audio === undefined) audio = parsed.track as Mp4AudioTrack;
  }

  // `fastStart` means the moov box precedes mdat, so a player can start without
  // the whole file — what a streaming upload wants (AD-08's publishing path).
  const mdat = boxes.find((box) => box.type === "mdat");
  const fastStart = mdat === undefined || moov.start < mdat.start;

  return {
    durationSec,
    timescale,
    fastStart,
    brands,
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio } : {}),
  };
}

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/** Walk the boxes in `[start, end)`; a truncated tail simply ends the walk. */
export function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    boxes.push({ type, start: offset, end: offset + size });
    offset += size;
  }
  return boxes;
}

function readMvhd(
  view: DataView,
  box: Box,
): { readonly timescale: number; readonly durationSec: number } {
  const version = view.getUint8(box.start + 8);
  if (version === 1) {
    const timescale = view.getUint32(box.start + 28);
    const duration = Number(view.getBigUint64(box.start + 32));
    return { timescale, durationSec: timescale === 0 ? 0 : duration / timescale };
  }
  const timescale = view.getUint32(box.start + 20);
  const duration = view.getUint32(box.start + 24);
  return { timescale, durationSec: timescale === 0 ? 0 : duration / timescale };
}

function readTrak(
  view: DataView,
  trak: Box,
): { readonly kind: "video" | "audio" | "other"; readonly track?: unknown } {
  const boxes = readBoxes(view, trak.start + 8, trak.end);
  const mdia = boxes.find((box) => box.type === "mdia");
  if (mdia === undefined) return { kind: "other" };
  const media = readBoxes(view, mdia.start + 8, mdia.end);
  const mdhd = media.find((box) => box.type === "mdhd");
  const hdlr = media.find((box) => box.type === "hdlr");
  const minf = media.find((box) => box.type === "minf");
  if (mdhd === undefined || hdlr === undefined) return { kind: "other" };
  const handler = readType(view, hdlr.start + 16);
  const { timescale, duration } = readMdhd(view, mdhd);
  const durationSec = timescale === 0 ? 0 : duration / timescale;
  if (minf === undefined) return { kind: "other" };
  const stbl = readBoxes(view, minf.start + 8, minf.end).find((box) => box.type === "stbl");
  if (stbl === undefined) return { kind: "other" };
  const stblBoxes = readBoxes(view, stbl.start + 8, stbl.end);
  const stsd = stblBoxes.find((box) => box.type === "stsd");
  const stsz = stblBoxes.find((box) => box.type === "stsz");
  const codec = stsd === undefined ? "unknown" : readSampleEntryCodec(view, stsd);
  if (handler === "vide") {
    const dimensions =
      stsd === undefined ? { width: 0, height: 0 } : readVideoDimensions(view, stsd);
    return {
      kind: "video",
      track: {
        codec,
        width: dimensions.width,
        height: dimensions.height,
        timescale,
        durationSec,
        frameCount: stsz === undefined ? 0 : readSampleCount(view, stsz),
      } satisfies Mp4VideoTrack,
    };
  }
  if (handler === "soun") {
    const sound = stsd === undefined ? { channels: 0, sampleRate: 0 } : readAudioFormat(view, stsd);
    return {
      kind: "audio",
      track: {
        codec,
        channels: sound.channels,
        sampleRate: sound.sampleRate,
        durationSec,
      } satisfies Mp4AudioTrack,
    };
  }
  return { kind: "other" };
}

function readMdhd(
  view: DataView,
  box: Box,
): { readonly timescale: number; readonly duration: number } {
  const version = view.getUint8(box.start + 8);
  if (version === 1) {
    return {
      timescale: view.getUint32(box.start + 28),
      duration: Number(view.getBigUint64(box.start + 32)),
    };
  }
  return {
    timescale: view.getUint32(box.start + 20),
    duration: view.getUint32(box.start + 24),
  };
}

function readSampleEntryCodec(view: DataView, stsd: Box): string {
  const entries = readBoxes(view, stsd.start + 16, stsd.end);
  const first = entries[0];
  return first === undefined ? "unknown" : first.type;
}

/**
 * Offsets are the spec's, not this file's convenience: a SampleEntry payload is
 * `reserved[6] + data_reference_index(2)`, so a VisualSampleEntry's width sits 32
 * bytes into its box and an AudioSampleEntry's channel count 24 — with the sample
 * rate as 16.16 fixed point four bytes later.
 */
function readVideoDimensions(view: DataView, stsd: Box): { width: number; height: number } {
  const entry = readBoxes(view, stsd.start + 16, stsd.end)[0];
  if (entry === undefined) return { width: 0, height: 0 };
  return { width: view.getUint16(entry.start + 32), height: view.getUint16(entry.start + 34) };
}

function readAudioFormat(view: DataView, stsd: Box): { channels: number; sampleRate: number } {
  const entry = readBoxes(view, stsd.start + 16, stsd.end)[0];
  if (entry === undefined) return { channels: 0, sampleRate: 0 };
  const channels = view.getUint16(entry.start + 24);
  const sampleRate = view.getUint32(entry.start + 32) / 65_536;
  return { channels, sampleRate: Math.round(sampleRate) };
}

function readSampleCount(view: DataView, stsz: Box): number {
  return view.getUint32(stsz.start + 8 + 8);
}

function readType(view: DataView, offset: number): string {
  let text = "";
  for (let index = 0; index < 4; index += 1) {
    const byte = view.getUint8(offset + index);
    text += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : " ";
  }
  return text;
}
