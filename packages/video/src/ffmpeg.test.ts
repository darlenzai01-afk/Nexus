import { describe, expect, it } from "vitest";

import { RenderError } from "./errors.js";
import {
  canEncode,
  createFFmpegRunner,
  parseProgress,
  probeFFmpeg,
  resolveFFmpegPath,
  tail,
  type FFmpegProbe,
} from "./ffmpeg.js";

/**
 * The FFmpeg boundary.
 *
 * These tests never need a real FFmpeg: the runner's *contract* is what matters
 * (argument arrays, a deadline, coded failures, stderr), and `/bin/true` and
 * `/bin/false` are enough to exercise it. The real binary is exercised once, by
 * the smoke test, where a video file has to come out.
 */

const probe: FFmpegProbe = {
  path: "/bin/true",
  version: "6.1-test",
  banner: "ffmpeg version 6.1-test",
  encoders: ["libx264", "aac", "mjpeg"],
};

describe("resolveFFmpegPath", () => {
  it("returns an explicitly configured path as given, existing or not", () => {
    expect(resolveFFmpegPath("/opt/tools/ffmpeg")).toBe("/opt/tools/ffmpeg");
  });

  it("finds FFmpeg in the usual places when nothing is configured", () => {
    const found = resolveFFmpegPath();
    // On a machine with FFmpeg installed this is an absolute path; without one it
    // is the bare name, which lets the OS resolve it from PATH.
    expect(found === "ffmpeg" || (found ?? "").endsWith("/ffmpeg")).toBe(true);
  });

  it("treats a blank configuration as 'not configured'", () => {
    expect(resolveFFmpegPath("   ")).not.toBe("   ");
  });
});

describe("canEncode", () => {
  it("accepts an encoder the probe listed", () => {
    expect(canEncode(probe, "libx264")).toBe(true);
  });

  it("rejects one it did not", () => {
    expect(canEncode(probe, "libvpx-vp9")).toBe(false);
  });

  it("assumes yes when the probe could not list encoders", () => {
    expect(canEncode({ ...probe, encoders: [] }, "anything")).toBe(true);
  });
});

describe("parseProgress", () => {
  it("reads key/value progress lines and ignores anything else", () => {
    const progress = parseProgress(
      "frame=42\nfps=29.9\nout_time_ms=1400000\nprogress=continue\nnoise here\n",
    );
    expect(progress).toEqual({
      frame: "42",
      fps: "29.9",
      out_time_ms: "1400000",
      progress: "continue",
    });
  });
});

describe("tail", () => {
  it("keeps the last non-empty lines, joined for a log line", () => {
    expect(tail("first\n\n  second  \nthird\n", 2)).toBe("second | third");
  });
});

describe("createFFmpegRunner", () => {
  it("runs a command and reports success", () => {
    const runner = createFFmpegRunner({ binary: "/bin/true", probe });
    const result = runner.run({ label: "noop", args: ["-hide_banner"] });
    expect(result.code).toBe(0);
    expect(runner.version).toBe("6.1-test");
  });

  it("fails with the label and FFmpeg's own words when the exit code is not zero", () => {
    const runner = createFFmpegRunner({ binary: "/bin/false", probe });
    try {
      runner.run({ label: "encode segment 2", args: [] });
      throw new Error("the runner should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      const renderError = error as RenderError;
      expect(renderError.code).toBe("ffmpeg_failed");
      expect(renderError.retryable).toBe(false);
      expect(renderError.message).toContain("encode segment 2");
    }
  });

  it("reports a deadline as retryable", () => {
    const runner = createFFmpegRunner({ binary: "/bin/sleep", probe });
    try {
      runner.run({ label: "slow", args: ["5"], timeoutMs: 150 });
      throw new Error("the runner should have thrown");
    } catch (error) {
      expect((error as RenderError).code).toBe("ffmpeg_timeout");
      expect((error as RenderError).retryable).toBe(true);
    }
  });

  it("streams stderr through the callback", () => {
    const lines: string[] = [];
    const runner = createFFmpegRunner({
      binary: "/bin/ls",
      probe,
      onStderr: (line) => lines.push(line),
    });
    expect(() => runner.run({ label: "list", args: ["/definitely/not/here"] })).toThrow(
      RenderError,
    );
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("probeFFmpeg", () => {
  it("names a missing binary instead of failing obscurely", () => {
    try {
      probeFFmpeg("/nonexistent/ffmpeg-binary", 2_000);
      throw new Error("probeFFmpeg should have thrown");
    } catch (error) {
      expect((error as RenderError).code).toBe("ffmpeg_missing");
      expect((error as RenderError).message).toContain("NEXUS_FFMPEG_PATH");
    }
  });
});
