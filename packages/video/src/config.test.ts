import { loadEnv } from "@nexus/config";
import { describe, expect, it } from "vitest";

import { DEFAULTS, configHash, resolveRenderConfig, validateAgainstManifest } from "./config.js";
import { RenderError } from "./errors.js";
import { fixtureManifest } from "./fixtures.js";

/**
 * Deterministic configuration.
 *
 * The configuration is the render's identity: the same configuration hash means
 * the same video, a different one means a rebuild. So these tests are about the
 * two properties that make that true — the defaults are complete, and anything
 * that contradicts the scene plan is refused before a frame is rasterised.
 */

describe("resolveRenderConfig", () => {
  it("fills in every field from the defaults", () => {
    const config = resolveRenderConfig({});
    expect(config).toEqual(DEFAULTS);
    expect(config.width).toBe(1920);
    expect(config.fps).toBe(30);
    expect(config.videoCodec).toBe("libx264");
    expect(config.captions).toBe("burn");
  });

  it("takes explicit overrides", () => {
    const config = resolveRenderConfig({ width: 640, height: 360, crf: 30, segmentFrames: 15 });
    expect(config).toMatchObject({ width: 640, height: 360, crf: 30, segmentFrames: 15 });
  });

  it("refuses an unknown field rather than ignoring a typo", () => {
    expect(() => resolveRenderConfig({ widht: 640 } as never)).toThrow(RenderError);
    expect(() => resolveRenderConfig({ width: 10 })).toThrow(/invalid_config|invalid/u);
  });

  it("hashes the same configuration to the same value, and a different one apart", () => {
    expect(configHash(resolveRenderConfig({ crf: 23 }))).toBe(
      configHash(resolveRenderConfig({ crf: 23 })),
    );
    expect(configHash(resolveRenderConfig({ crf: 23 }))).not.toBe(
      configHash(resolveRenderConfig({ crf: 24 })),
    );
  });

  it("reads the app's validated render block unchanged", () => {
    // `AppConfig.render` is written in the same shape as the pipeline's own
    // configuration, so the environment needs no translation table and a typo in
    // either place is caught by one schema.
    const app = loadEnv({ env: { NEXUS_RENDER_WIDTH: "1280", NEXUS_RENDER_HEIGHT: "720" } });
    const config = resolveRenderConfig(app.render);
    expect(config.width).toBe(1280);
    expect(config.height).toBe(720);
    expect(config.ffmpegPath).toBe(app.render.ffmpegPath);
    expect(app.render.fontFile).toBe("");
  });
});

describe("validateAgainstManifest", () => {
  const manifest = fixtureManifest({ seconds: 1, width: 320, height: 180 });

  it("accepts a configuration that agrees with the plan", () => {
    expect(() =>
      validateAgainstManifest(resolveRenderConfig({ width: 320, height: 180, fps: 30 }), manifest),
    ).not.toThrow();
  });

  it("refuses a frame rate the plan does not use, instead of re-timing it", () => {
    try {
      validateAgainstManifest(resolveRenderConfig({ width: 320, height: 180, fps: 24 }), manifest);
      throw new Error("the configuration should have been refused");
    } catch (error) {
      expect((error as RenderError).code).toBe("invalid_config");
      expect((error as RenderError).message).toContain("timed in frames");
    }
  });

  it("refuses a resolution that would stretch the plan", () => {
    expect(() =>
      validateAgainstManifest(resolveRenderConfig({ width: 321, height: 180 }), manifest),
    ).toThrow(/does not match the scene plan/u);
  });

  it("accepts the same aspect ratio at another size", () => {
    expect(() =>
      validateAgainstManifest(resolveRenderConfig({ width: 1280, height: 720 }), manifest),
    ).not.toThrow();
  });
});

describe("the environment's render block", () => {
  it("defaults to a 1080p30 h264 render with burn-in captions", () => {
    const render = loadEnv({ env: {} }).render;
    expect(render).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "libx264",
      crf: 23,
      preset: "veryfast",
      captions: "burn",
      segmentFrames: 90,
      ffmpegPath: "",
      fontFile: "",
    });
  });

  it("rejects a value it cannot use, at startup", () => {
    expect(() => loadEnv({ env: { NEXUS_RENDER_PRESET: "ludicrous" } })).toThrow(
      /NEXUS_RENDER_PRESET/u,
    );
    expect(() => loadEnv({ env: { NEXUS_RENDER_FPS: "0" } })).toThrow(/NEXUS_RENDER_FPS/u);
  });
});
