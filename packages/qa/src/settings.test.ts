import { loadEnv } from "@nexus/config";
import { describe, expect, it } from "vitest";

import { DEFAULT_QA_SETTINGS, resolveQASettings, settingsHash } from "./settings.js";

/**
 * The thresholds, and where they come from.
 *
 * The engine takes its rules as an argument and never reads the environment; the
 * app layer validates `NEXUS_QA_*` and hands over a block shaped exactly like
 * these settings. These tests hold that promise: the defaults are the documented
 * ones, an operator's environment is accepted without translation, and a typo is
 * refused rather than silently ignored.
 */
describe("QA settings", () => {
  it("starts from the documented thresholds", () => {
    expect(DEFAULT_QA_SETTINGS).toMatchObject({
      durationToleranceSec: 0.5,
      durationWarnSec: 0.15,
      sceneDriftToleranceSec: 1,
      minFontPx: 18,
      tightFontPx: 24,
      safeAreaRatio: 0.04,
      silenceRms: 0.006,
      silenceWindowSec: 0.6,
      minClipRms: 0.004,
      videoToleranceSec: 0.25,
      minVideoBytes: 1_024,
      checkCaptionSafeArea: true,
    });
  });

  it("takes the app's validated environment block unchanged", () => {
    const relaxed = resolveQASettings(loadEnv({ env: {} }).qa);
    expect(relaxed).toEqual(DEFAULT_QA_SETTINGS);

    const strict = resolveQASettings(
      loadEnv({
        env: {
          NEXUS_QA_MIN_FONT_PX: "40",
          NEXUS_QA_TIGHT_FONT_PX: "48",
          NEXUS_QA_SILENCE_RMS: "0.002",
          NEXUS_QA_CAPTION_SAFE_AREA: "off",
        },
      }).qa,
    );
    expect(strict.minFontPx).toBe(40);
    expect(strict.tightFontPx).toBe(48);
    expect(strict.silenceRms).toBe(0.002);
    expect(strict.checkCaptionSafeArea).toBe(false);
    expect(strict.durationToleranceSec).toBe(DEFAULT_QA_SETTINGS.durationToleranceSec);
    expect(settingsHash(strict)).not.toBe(settingsHash(relaxed));
  });

  it("refuses a threshold it does not know", () => {
    expect(() => resolveQASettings({ minFont: 20 } as never)).toThrow();
  });

  it("hashes the same rules to the same value, whatever the order", () => {
    const first = resolveQASettings({ minFontPx: 20, tightFontPx: 30 });
    const second = resolveQASettings({ tightFontPx: 30, minFontPx: 20 });
    expect(settingsHash(second)).toBe(settingsHash(first));
    expect(settingsHash(first)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
