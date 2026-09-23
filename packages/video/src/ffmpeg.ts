import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";

import { RenderError } from "./errors.js";

/**
 * The FFmpeg boundary.
 *
 * Every call into FFmpeg goes through one small interface, for three reasons:
 *
 * - **It is testable without FFmpeg.** The pipeline's tests run a recorded
 *   *script* through `FFmpegRunner` (`ScriptedFFmpeg`), so resumability, reuse,
 *   failure handling and metadata are all exercised in CI where no FFmpeg binary
 *   exists, and the real binary is exercised only by the smoke test.
 * - **It is never a shell.** Commands are argument arrays: a path with a space or
 *   a quote in it cannot become a second command.
 * - **It fails in words.** A missing binary, a non-zero exit, a deadline or a
 *   missing output file each produce a `RenderError` with the code and the last
 *   of FFmpeg's own stderr, which is what the render log and the operator see.
 */

export interface FFmpegCommand {
  /** Arguments after the binary's path. */
  readonly args: readonly string[];
  /** Human-readable label for logs (`encode segment 3`, `mux narration`). */
  readonly label: string;
  /** Working directory. */
  readonly cwd?: string | undefined;
  /** Deadline in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

export interface FFmpegResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** `-progress` key/value pairs, when the command asked for them. */
  readonly progress: Readonly<Record<string, string>>;
}

export interface FFmpegRunner {
  readonly path: string;
  readonly version: string;
  /** Version banner: what the metadata records as the tool identity. */
  readonly banner: string;
  readonly encoders: readonly string[];
  run(command: FFmpegCommand): FFmpegResult;
}

export interface FFmpegProbe {
  readonly path: string;
  readonly version: string;
  readonly banner: string;
  readonly encoders: readonly string[];
}

/**
 * Where the binary is.
 *
 * An explicit path — `NEXUS_FFMPEG_PATH`, resolved once by `@nexus/config` — is
 * returned as given, even when it does not exist: the failure should name the path
 * the operator chose, not quietly render with a different FFmpeg. Only when
 * nothing is configured does this search the usual locations, and it ends with the
 * bare name `ffmpeg` so the OS resolves it from `PATH` (the container case).
 */
export function resolveFFmpegPath(configured?: string): string | undefined {
  if (configured !== undefined && configured.trim() !== "") return configured;
  for (const candidate of [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "ffmpeg"; // a bare name: let the OS resolve it from PATH
}

const VERSION_PATTERN = /^ffmpeg version (\S+)/mu;

/**
 * Ask the binary who it is and what it can write. Called once per render, so a
 * missing or ancient FFmpeg fails before a single frame is rasterised.
 */
export function probeFFmpeg(binary: string, timeoutMs = 15_000): FFmpegProbe {
  const version = runSync([binary, "-hide_banner", "-version"], timeoutMs);
  if (version.code !== 0) {
    throw new RenderError(
      `${binary} cannot run: ${firstLine(version.stderr) || firstLine(version.stdout) || `exit ${version.code}`}`,
      { code: "ffmpeg_failed" },
    );
  }
  const banner = version.stdout.split("\n").slice(0, 2).join(" ").trim();
  const parsed = VERSION_PATTERN.exec(version.stdout);
  const encoders = runSync([binary, "-hide_banner", "-encoders"], timeoutMs);
  const names = new Set<string>();
  if (encoders.code === 0) {
    for (const line of encoders.stdout.split("\n")) {
      const match = /^\s*[A-Z.]{6}\s+(\S+)/u.exec(line);
      if (match?.[1] !== undefined) names.add(match[1]);
    }
  }
  return {
    path: binary,
    version: parsed?.[1] ?? "unknown",
    banner,
    encoders: [...names].sort(),
  };
}

/** True when the probe can write this encoder (checked before the first frame). */
export function canEncode(probe: FFmpegProbe, encoder: string): boolean {
  if (probe.encoders.length === 0) return true; // the probe could not list them
  return probe.encoders.includes(encoder);
}

export interface RealFFmpegOptions {
  readonly binary: string;
  readonly timeoutMs?: number;
  readonly probe?: FFmpegProbe | undefined;
  /** Called with each stderr line, for the render log. */
  readonly onStderr?: ((line: string) => void) | undefined;
}

/** The real runner: a child process, a deadline, and structured progress. */
export function createFFmpegRunner(options: RealFFmpegOptions): FFmpegRunner {
  const probe = options.probe ?? probeFFmpeg(options.binary, options.timeoutMs);
  return {
    // The configured binary decides what runs; the probe only contributes the
    // identity (version, banner, encoders) that the metadata records.
    path: options.binary,
    version: probe.version,
    banner: probe.banner,
    encoders: probe.encoders,
    run: (command) => {
      const timeoutMs = command.timeoutMs ?? options.timeoutMs ?? 30 * 60 * 1000;
      const result = runSync(command.args, timeoutMs, { binary: options.binary, cwd: command.cwd });
      const progress = parseProgress(result.stdout);
      if (options.onStderr !== undefined) {
        for (const line of result.stderr.split("\n")) {
          if (line.trim() !== "") options.onStderr(line);
        }
      }
      if (result.timedOut) {
        throw new RenderError(`ffmpeg ${command.label} exceeded its ${timeoutMs}ms deadline`, {
          code: "ffmpeg_timeout",
          retryable: true,
        });
      }
      if (result.code !== 0) {
        throw new RenderError(
          `ffmpeg ${command.label} failed with exit ${result.code}: ${tail(result.stderr)}`,
          { code: "ffmpeg_failed" },
        );
      }
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        progress,
      };
    },
  };
}

/** `-progress pipe:1` key/value output, as a record. */
export function parseProgress(stdout: string): Record<string, string> {
  const progress: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^([a-z_]+)=(.*)$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) progress[match[1]] = match[2];
  }
  return progress;
}

interface SyncResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

const DEFAULT_BINARY = "ffmpeg";

function runSync(
  args: readonly string[],
  timeoutMs: number,
  options: { readonly binary?: string; readonly cwd?: string | undefined } = {},
): SyncResult {
  const binary = options.binary ?? args[0] ?? DEFAULT_BINARY;
  const rest = options.binary === undefined && args[0] === binary ? args.slice(1) : args;
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
  const started = Date.now();
  const child = spawnSync(binary, [...rest], spawnOptions);
  const durationMs = Date.now() - started;
  if (child.error !== undefined && child.error !== null) {
    const failure = child.error as NodeJS.ErrnoException;
    if (failure.code === "ETIMEDOUT") {
      // The deadline, not the command: reported as a timeout so the caller can
      // decide (the pipeline marks it retryable and names the command).
      return {
        code: -1,
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
        durationMs,
        timedOut: true,
      };
    }
    if (failure.code === "ENOENT") {
      throw new RenderError(
        `no FFmpeg binary at ${binary} (set NEXUS_FFMPEG_PATH or NEXUS_RENDER_FFMPEG)`,
        { code: "ffmpeg_missing" },
      );
    }
    throw new RenderError(`ffmpeg could not be started: ${failure.message}`, {
      code: "ffmpeg_failed",
      retryable: failure.code === "EAGAIN" || failure.code === "EMFILE",
    });
  }
  return {
    code: child.status ?? -1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    durationMs,
    timedOut: child.signal === "SIGTERM" || child.signal === "SIGKILL",
  };
}

/** The last few lines of stderr: FFmpeg's own words for why it stopped. */
export function tail(text: string, lines = 6): string {
  const kept = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-lines);
  return kept.join(" | ");
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}
