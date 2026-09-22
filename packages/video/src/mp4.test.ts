import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseMp4, readMp4 } from "./mp4.js";
import { createScriptedFFmpeg, syntheticMp4 } from "./scripted-ffmpeg.js";

/**
 * The container reader, against files whose shape is known by construction.
 *
 * Two files matter here: one written by the scripted FFmpeg (fast-start, with a
 * video and an audio track) and one assembled the other way round (`mdat` first)
 * to prove the fast-start check reads the file rather than assuming.
 */

const workRoot = mkdtempSync(path.join(tmpdir(), "nexus-mp4-"));

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe("readMp4", () => {
  it("reads the duration, tracks and dimensions of a fast-start file", () => {
    const bytes = syntheticMp4({
      width: 640,
      height: 360,
      fps: 30,
      frames: 90,
      videoCodec: "avc1",
      audio: { codec: "mp4a", sampleRate: 48_000, channels: 1, durationSec: 3 },
    });
    const info = parseMp4(bytes);
    expect(info.durationSec).toBeCloseTo(3, 3);
    expect(info.fastStart).toBe(true);
    expect(info.brands[0]).toBe("isom");
    expect(info.video?.codec).toBe("avc1");
    expect(info.video?.width).toBe(640);
    expect(info.video?.height).toBe(360);
    expect(info.video?.frameCount).toBe(90);
    expect(info.audio?.codec).toBe("mp4a");
    expect(info.audio?.sampleRate).toBe(48_000);
    expect(info.audio?.channels).toBe(1);
    expect(info.audio?.durationSec).toBeCloseTo(3, 2);
  });

  it("reports a file that is not fast-start", () => {
    const info = parseMp4(
      syntheticMp4({ width: 320, height: 180, fps: 30, frames: 30, fastStart: false }),
    );
    expect(info.fastStart).toBe(false);
    expect(info.video?.width).toBe(320);
  });

  it("reports no audio track for a silent file", () => {
    const info = parseMp4(syntheticMp4({ width: 320, height: 180, fps: 30, frames: 30 }));
    expect(info.audio).toBeUndefined();
    expect(info.video?.frameCount).toBe(30);
  });

  it("refuses bytes that are not a container", () => {
    expect(() => parseMp4(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/no moov box/u);
  });

  it("stops at a truncated tail instead of reading past it", () => {
    const full = syntheticMp4({ width: 320, height: 180, fps: 30, frames: 15 });
    expect(() => parseMp4(full.subarray(0, 40))).toThrow(TypeError);
  });

  it("reads a file the scripted FFmpeg wrote, the way the pipeline checks its output", () => {
    const file = path.join(workRoot, "seg-0000.mp4");
    const ffmpeg = createScriptedFFmpeg({ width: 160, height: 90, fps: 15 });
    ffmpeg.run({
      label: "encode segment 0",
      args: [
        "-framerate",
        "15",
        "-i",
        "frame-%06d.png",
        "-frames:v",
        "45",
        "-c:v",
        "libx264",
        file,
      ],
    });
    const info = readMp4(file);
    expect(info.video?.frameCount).toBe(45);
    expect(info.video?.width).toBe(160);
    expect(info.durationSec).toBeCloseTo(3, 3);
    expect(info.audio).toBeUndefined();
  });
});
