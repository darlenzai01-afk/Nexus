import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RenderError } from "./errors.js";
import type { FFmpegCommand, FFmpegResult, FFmpegRunner } from "./ffmpeg.js";

/**
 * A scripted FFmpeg, for tests that must not depend on FFmpeg.
 *
 * The pipeline treats FFmpeg as a boundary — it hands over a list of arguments and
 * reads files back — so the boundary can be scripted. This double answers the two
 * probes (version, encoders) and handles the four things the pipeline asks for
 * (encode a segment, concat, mux, thumbnail, measure loudness) by writing a
 * **structurally valid MP4** of the right shape: the correct resolution, codecs,
 * frame count and duration, with `moov` before `mdat` when `+faststart` was asked
 * for.
 *
 * That matters because the pipeline *verifies* its own output by parsing the
 * container (see `mp4.ts`): with a real container from the double, the tests
 * exercise verification, duration math, resume, reuse and failure reporting
 * without a binary anywhere near CI — and the smoke test then repeats the whole
 * thing against real FFmpeg.
 */

export interface ScriptedFFmpegOptions {
  readonly path?: string;
  readonly version?: string;
  readonly encoders?: readonly string[];
  /** Frame size the encoded segments should claim (the frames themselves are PNGs). */
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  /** Return a failure for a call, by label or argument match. */
  readonly fail?:
    ((command: FFmpegCommand, index: number) => ScriptedFailure | undefined) | undefined;
  /** Rewrite a written file, to test what happens when something on disk changes. */
  readonly tamper?: ((file: string) => Uint8Array | undefined) | undefined;
}

export interface ScriptedFailure {
  readonly message: string;
  readonly stderr?: string;
  readonly retryable?: boolean;
}

export interface ScriptedFFmpeg extends FFmpegRunner {
  readonly calls: FFmpegCommand[];
  readonly labels: string[];
  /** Files the double wrote, with what it claims they contain. */
  readonly written: Map<string, SyntheticVideo>;
}

export function createScriptedFFmpeg(options: ScriptedFFmpegOptions = {}): ScriptedFFmpeg {
  const calls: FFmpegCommand[] = [];
  const labels: string[] = [];
  const written = new Map<string, SyntheticVideo>();
  const width = options.width ?? 320;
  const height = options.height ?? 180;
  const fps = options.fps ?? 30;

  const write = (file: string, bytes: Uint8Array, info: SyntheticVideo): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tampered = options.tamper?.(file);
    writeFileSync(file, tampered ?? bytes);
    written.set(file, info);
  };

  const runner: ScriptedFFmpeg = {
    path: options.path ?? "/scripted/ffmpeg",
    version: options.version ?? "scripted-1.0 (a test double, not a real FFmpeg)",
    banner: "scripted ffmpeg test double",
    encoders: options.encoders ?? ["libx264", "libx265", "aac", "libmp3lame", "mjpeg"],
    calls,
    labels,
    written,

    run(command: FFmpegCommand): FFmpegResult {
      const index = calls.length;
      calls.push(command);
      labels.push(command.label);
      const failure = options.fail?.(command, index);
      if (failure !== undefined) {
        throw new RenderError(`${command.label} failed: ${failure.stderr ?? failure.message}`, {
          code: failure.retryable === true ? "ffmpeg_timeout" : "ffmpeg_failed",
          retryable: failure.retryable === true,
        });
      }
      const started = Date.now();
      const output = command.args[command.args.length - 1] ?? "";
      const stderr = handle(command, output, { width, height, fps, write, written });
      return {
        code: 0,
        stdout: "",
        stderr,
        durationMs: Date.now() - started,
        progress: { frame: "0", fps: "0.0", out_time_ms: "0", progress: "end" },
      };
    },
  };
  return runner;
}

interface WriteContext {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly write: (file: string, bytes: Uint8Array, info: SyntheticVideo) => void;
  readonly written: Map<string, SyntheticVideo>;
}

function handle(command: FFmpegCommand, output: string, context: WriteContext): string {
  const args = command.args;

  // loudnorm analysis: `-af loudnorm=print_format=json -f null -`
  const filter = args[args.indexOf("-af") + 1] ?? "";
  if (filter.startsWith("loudnorm=print_format=json")) {
    return `[Parsed_loudnorm_0 @ 0x0] \n${JSON.stringify({
      input_i: "-17.42",
      input_tp: "-1.85",
      input_lra: "3.10",
      target_offset: "1.42",
    })}\n`;
  }

  if (command.label.startsWith("encode segment")) {
    const frames = Number(args[args.indexOf("-frames:v") + 1] ?? 0);
    const codec = args[args.indexOf("-c:v") + 1] ?? "libx264";
    writeVideo(context, output, {
      frames,
      durationSec: frames / context.fps,
      fps: context.fps,
      videoCodec: codec,
    });
    return "";
  }

  if (command.label === "concat segments") {
    // The concat demuxer reads a list of files; the double mirrors that, so the
    // duration of the joined video is the sum of its parts.
    let frames = 0;
    const list = args[args.indexOf("-i") + 1] ?? "";
    try {
      for (const line of readFileSync(list, "utf8").split("\n")) {
        const match = /^file '(.*)'$/u.exec(line.trim());
        if (match === null) continue;
        frames += context.written.get(match[1] ?? "")?.frames ?? 0;
      }
    } catch {
      frames = 0;
    }
    writeVideo(context, output, {
      frames,
      durationSec: frames / context.fps,
      fps: context.fps,
      videoCodec: "libx264",
    });
    return "";
  }

  if (command.label === "mux narration") {
    const input = args[args.indexOf("-i") + 1] ?? "";
    const base = context.written.get(input);
    const wantsAudio = args.includes("-c:a");
    const audioCodec = wantsAudio ? (args[args.indexOf("-c:a") + 1] ?? "aac") : "none";
    const sampleRate = wantsAudio ? Number(args[args.indexOf("-ar") + 1] ?? 48_000) : 0;
    const channels = wantsAudio ? Number(args[args.indexOf("-ac") + 1] ?? 1) : 0;
    const frames = base?.frames ?? Math.round((base?.durationSec ?? 0) * context.fps);
    const bytes = syntheticMp4({
      width: context.width,
      height: context.height,
      fps: context.fps,
      frames,
      videoCodec: base?.videoCodec ?? "libx264",
      fastStart: args.includes("+faststart"),
      ...(wantsAudio
        ? { audio: { codec: audioCodec, sampleRate, channels, durationSec: frames / context.fps } }
        : {}),
    });
    context.write(output, bytes, {
      frames,
      durationSec: frames / context.fps,
      fps: context.fps,
      videoCodec: base?.videoCodec ?? "libx264",
      hasAudio: wantsAudio,
    });
    return "";
  }

  if (command.label === "thumbnail") {
    context.write(output, TINY_JPEG, {
      frames: 1,
      durationSec: 0,
      fps: context.fps,
      videoCodec: "mjpeg",
    });
    return "";
  }

  throw new RenderError(
    `the scripted FFmpeg was asked for something it does not script: ${command.label}`,
    {
      code: "ffmpeg_failed",
    },
  );
}

function writeVideo(context: WriteContext, output: string, video: SyntheticVideo): void {
  context.write(
    output,
    syntheticMp4({
      width: context.width,
      height: context.height,
      fps: video.fps ?? context.fps,
      frames: video.frames,
      videoCodec: video.videoCodec ?? "libx264",
      fastStart: true,
      ...(video.hasAudio === true
        ? {
            audio: {
              codec: "aac",
              sampleRate: 48_000,
              channels: 1,
              durationSec: video.durationSec,
            },
          }
        : {}),
    }),
    video,
  );
}

export interface SyntheticVideo {
  readonly frames: number;
  readonly durationSec: number;
  readonly fps: number;
  readonly videoCodec?: string;
  readonly hasAudio?: boolean;
}

export interface SyntheticMp4Options {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly videoCodec?: string;
  readonly fastStart?: boolean;
  readonly audio?: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly durationSec: number;
  };
}

/**
 * A minimal but spec-shaped MP4: `ftyp`, then `moov` (`mvhd` + one `trak` per
 * stream, each with `mdhd`/`hdlr`/`minf`/`stbl`/`stsd`/`stsz`) and an `mdat`.
 * Every sample table is a stub — this is for verification, not playback.
 */
export function syntheticMp4(options: SyntheticMp4Options): Uint8Array {
  const timescale = Math.max(1, Math.round(options.fps * 1_000));
  const duration = Math.round((options.frames / options.fps) * timescale);
  const video = track(
    "vide",
    options.videoCodec ?? "libx264",
    timescale,
    duration,
    options.frames,
    {
      width: options.width,
      height: options.height,
    },
  );
  const audio =
    options.audio === undefined
      ? undefined
      : track(
          "soun",
          options.audio.codec,
          options.audio.sampleRate,
          Math.round(options.audio.durationSec * options.audio.sampleRate),
          Math.round((options.audio.durationSec * options.audio.sampleRate) / 1024),
          { channels: options.audio.channels, sampleRate: options.audio.sampleRate },
        );

  const moov = box(
    "moov",
    concat([mvhd(timescale, duration), video, ...(audio !== undefined ? [audio] : [])]),
  );
  const mdat = box("mdat", new Uint8Array(1_024));
  const ftyp = ftypBox();
  return options.fastStart === false ? concat([ftyp, mdat, moov]) : concat([ftyp, moov, mdat]);
}

function track(
  handler: "vide" | "soun",
  codec: string,
  timescale: number,
  duration: number,
  sampleCount: number,
  format: {
    readonly width?: number;
    readonly height?: number;
    readonly channels?: number;
    readonly sampleRate?: number;
  },
): Uint8Array {
  const entry =
    handler === "vide"
      ? visualSampleEntry(sampleEntryType(codec, "vide"), format.width ?? 0, format.height ?? 0)
      : audioSampleEntry(
          sampleEntryType(codec, "soun"),
          format.channels ?? 0,
          format.sampleRate ?? 0,
        );
  const stsd = box("stsd", concat([uint8(0), uint24(0), uint32(1), entry]));
  const stsz = box("stsz", concat([uint8(0), uint24(0), uint32(0), uint32(sampleCount)]));
  const stbl = box("stbl", concat([stsd, stsz]));
  const minf = box("minf", stbl);
  const hdlr = box(
    "hdlr",
    concat([uint8(0), uint24(0), uint32(0), ascii(handler), new Uint8Array(12)]),
  );
  const mdhd = box(
    "mdhd",
    concat([
      uint8(0),
      uint24(0),
      uint32(0),
      uint32(0),
      uint32(timescale),
      uint32(duration),
      new Uint8Array(4),
    ]),
  );
  const mdia = box("mdia", concat([mdhd, hdlr, minf]));
  const tkhd = box("tkhd", new Uint8Array(84));
  return box("trak", concat([tkhd, mdia]));
}

function mvhd(timescale: number, duration: number): Uint8Array {
  return box(
    "mvhd",
    concat([
      uint8(0),
      uint24(0),
      uint32(0),
      uint32(0),
      uint32(timescale),
      uint32(duration),
      new Uint8Array(80),
    ]),
  );
}

function visualSampleEntry(codec: string, width: number, height: number): Uint8Array {
  return box(
    codec,
    concat([
      new Uint8Array(6),
      uint16(1), // data_reference_index
      uint16(0),
      uint16(0),
      new Uint8Array(12),
      uint16(width),
      uint16(height),
      uint32(0x0048_0000),
      uint32(0x0048_0000),
      uint32(0),
      uint16(1),
      new Uint8Array(32),
      uint16(0x0018),
      uint16(0xffff),
    ]),
  );
}

function audioSampleEntry(codec: string, channels: number, sampleRate: number): Uint8Array {
  return box(
    codec,
    concat([
      new Uint8Array(6),
      uint16(1), // data_reference_index
      new Uint8Array(8), // reserved
      uint16(channels),
      uint16(16), // sample size
      uint16(0),
      uint16(0),
      uint32(sampleRate * 65_536),
    ]),
  );
}

/**
 * An encoder name is not a sample-entry type: `libx264` writes `avc1` samples,
 * `aac` writes `mp4a`. A four-character box type is all the parser can hold, so
 * anything the double cannot name is refused instead of written as a lie.
 */
function sampleEntryType(codec: string, handler: "vide" | "soun"): string {
  const known: Readonly<Record<string, { vide: string; soun: string }>> = {
    libx264: { vide: "avc1", soun: "mp4a" },
    x264: { vide: "avc1", soun: "mp4a" },
    h264: { vide: "avc1", soun: "mp4a" },
    libx265: { vide: "hvc1", soun: "mp4a" },
    hevc: { vide: "hvc1", soun: "mp4a" },
    mpeg4: { vide: "mp4v", soun: "mp4a" },
    mjpeg: { vide: "jpeg", soun: "mp4a" },
    "libvpx-vp9": { vide: "vp09", soun: "mp4a" },
    aac: { vide: "avc1", soun: "mp4a" },
    mp3: { vide: "avc1", soun: "mp3 " },
    libmp3lame: { vide: "avc1", soun: "mp3 " },
    pcm_s16le: { vide: "avc1", soun: "sowt" },
  };
  const mapped = known[codec]?.[handler];
  if (mapped !== undefined) return mapped;
  if (codec.length === 4) return codec;
  throw new Error(`the scripted FFmpeg cannot describe the codec "${codec}" as a sample entry`);
}

function ftypBox(): Uint8Array {
  return box(
    "ftyp",
    concat([ascii("isom"), uint32(512), ascii("isom"), ascii("iso2"), ascii("mp41")]),
  );
}

function box(type: string, payload: Uint8Array): Uint8Array {
  return concat([uint32(payload.byteLength + 8), ascii(type), payload]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function uint24(value: number): Uint8Array {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** A 1×1 JPEG: real bytes, so the thumbnail artifact is a real file. */
export const TINY_JPEG: Uint8Array = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
]);
