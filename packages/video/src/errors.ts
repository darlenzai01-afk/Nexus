/**
 * Errors the rendering pipeline reports.
 *
 * The split that matters to the runner is the same one every other stage uses:
 * **retryable** (the machine, not the input, was the problem — FFmpeg timed out,
 * a transient disk error) versus permanent (the input cannot produce a video:
 * no FFmpeg binary, a codec it does not have, a manifest that will not parse).
 * Retrying a permanent failure spends an hour of CPU to fail again, so the two
 * are separated here rather than at the call site.
 */

export type RenderErrorCode =
  /** No FFmpeg binary: nothing configured and nothing on `PATH`. */
  | "ffmpeg_missing"
  /** The binary exists but the probe (or a command) failed. */
  | "ffmpeg_failed"
  /** A command exceeded its deadline. */
  | "ffmpeg_timeout"
  /** The configured codec/format is not one this FFmpeg can write. */
  | "unsupported_codec"
  /** No timeline to render: the manifest has no scenes, or no frames. */
  | "empty_timeline"
  /** A frame could not be rasterised or written. */
  | "frame_failed"
  /** The narration audio could not be assembled or was not readable. */
  | "audio_failed"
  /** The segments could not be joined into one video. */
  | "concat_failed"
  /** The render configuration is internally impossible. */
  | "invalid_config"
  /** A segment's bytes were produced but do not match what was promised. */
  | "output_invalid";

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      readonly code: RenderErrorCode;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RenderError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export function isRenderError(error: unknown): error is RenderError {
  return error instanceof RenderError;
}

/** `Error` message or the value itself, for a coded issue. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
