import { hashInputs } from "@nexus/providers";
import type { SceneManifest } from "@nexus/scenes";

import { RenderError } from "./errors.js";
import { RenderConfigSchema, type RenderConfig, type RenderConfigInput } from "./schema.js";

/**
 * Deterministic configuration.
 *
 * The render configuration is resolved once — from the environment, through
 * `@nexus/config`'s validated `render` block, or from explicit overrides — and
 * then *hashed*. That hash travels into every artifact, into the reuse decision
 * and into the journal's key, so "render it again" either means exactly the same
 * render (and reuses everything) or a different one (and rebuilds what changed).
 *
 * This module never reads `process.env` itself: the environment is the app's
 * business (`loadEnv` validates it at startup), and the pipeline takes the
 * resolved values as arguments. That is what makes a render reproducible from its
 * metadata alone — nothing about the machine can leak in behind the hash.
 */

export function resolveRenderConfig(overrides: RenderConfigInput = {}): RenderConfig {
  const parsed = RenderConfigSchema.safeParse(overrides);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RenderError(`render configuration is invalid: ${detail}`, { code: "invalid_config" });
  }
  return parsed.data;
}

/** Every field's default, so `resolveRenderConfig({})` is a complete 1080p30 render. */
export const DEFAULTS: RenderConfig = RenderConfigSchema.parse({});

export function configHash(config: RenderConfig): string {
  return hashInputs({ kind: "video.render.config", version: 1, config });
}

/**
 * The configuration has to agree with the scene plan it renders. Two things are
 * not preferences but contradictions, and both are caught before a frame is
 * rasterised: a frame rate the timeline does not use (the animation is timed in
 * frames) and a resolution with a different aspect ratio (the plan's geometry is
 * laid out in its own coordinates).
 */
export function validateAgainstManifest(config: RenderConfig, manifest: SceneManifest): void {
  if (config.fps !== manifest.fps) {
    throw new RenderError(
      `render fps ${config.fps} does not match the scene plan's ${manifest.fps} fps; the plan's animation is timed in frames, so a different rate would re-time it`,
      { code: "invalid_config" },
    );
  }
  const planAspect = manifest.resolution.width / manifest.resolution.height;
  const renderAspect = config.width / config.height;
  if (Math.abs(planAspect - renderAspect) > 1e-3) {
    throw new RenderError(
      `render resolution ${config.width}x${config.height} (${renderAspect.toFixed(3)}:1) does not match the scene plan's ` +
        `${manifest.resolution.width}x${manifest.resolution.height} (${planAspect.toFixed(3)}:1)`,
      { code: "invalid_config" },
    );
  }
}
