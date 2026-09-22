import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EnvValidationError, loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("returns safe defaults when no variables are set", () => {
    const config = loadEnv({ env: {} });

    expect(config.env).toBe("development");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
    expect(config.workerHeartbeatMs).toBe(30_000);
    // Every capability starts unconfigured (the pipeline fails actionably
    // rather than reaching for a network), except storage: the local CAS needs
    // no account and is what makes the system runnable out of the box.
    expect(config.providers).toEqual({
      llm: "none",
      tts: "none",
      research: "none",
      media: "none",
      storage: "local",
      publishing: "none",
    });
    expect(config.providerPolicy).toEqual({
      timeoutMs: 30_000,
      maxAttempts: 3,
      cacheEnabled: true,
      degradeRatio: 0.9,
      rateLimitPerMinute: 0,
      llmBaseUrl: "https://openrouter.ai/api/v1",
      defaultLlmModel: "meta-llama/llama-3.1-8b-instruct",
    });
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    // The voice defaults are the ones `@nexus/audio` documents: wav at 24 kHz,
    // the adapter's own first voice ("" = let it choose) and no segment cache.
    expect(config.audio).toEqual({
      voice: "",
      format: "wav",
      sampleRate: 24_000,
      rate: 1,
      segmentCache: "off",
    });
  });

  it("applies and coerces valid overrides", () => {
    const config = loadEnv({
      env: {
        NEXUS_ENV: "production",
        NEXUS_PORT: "9090",
        NEXUS_LOG_LEVEL: "debug",
        NEXUS_LLM_PROVIDER: "fake",
      },
    });

    expect(config.env).toBe("production");
    expect(config.port).toBe(9090);
    expect(config.logLevel).toBe("debug");
    expect(config.providers.llm).toBe("fake");
    expect(config.providers.tts).toBe("none");
  });

  it("accepts the whole provider surface (selection, policy, base URL, model)", () => {
    const config = loadEnv({
      env: {
        NEXUS_LLM_PROVIDER: "openai-compatible:mistralai/mistral-nemo",
        NEXUS_TTS_PROVIDER: "fake",
        NEXUS_RESEARCH_PROVIDER: "manual",
        NEXUS_MEDIA_PROVIDER: "fake",
        NEXUS_STORAGE_PROVIDER: "fake",
        NEXUS_PUBLISHING_PROVIDER: "manual",
        NEXUS_PROVIDER_TIMEOUT_MS: "45000",
        NEXUS_PROVIDER_MAX_ATTEMPTS: "5",
        NEXUS_PROVIDER_CACHE: "off",
        NEXUS_PROVIDER_DEGRADE_RATIO: "0.8",
        NEXUS_PROVIDER_RATE_LIMIT_PER_MIN: "30",
        NEXUS_LLM_BASE_URL: "https://api.groq.com/openai/v1",
        NEXUS_LLM_MODEL: "llama-3.1-8b-instant",
      },
    });

    expect(config.providers).toEqual({
      llm: "openai-compatible:mistralai/mistral-nemo",
      tts: "fake",
      research: "manual",
      media: "fake",
      storage: "fake",
      publishing: "manual",
    });
    expect(config.providerPolicy).toEqual({
      timeoutMs: 45_000,
      maxAttempts: 5,
      cacheEnabled: false,
      degradeRatio: 0.8,
      rateLimitPerMinute: 30,
      llmBaseUrl: "https://api.groq.com/openai/v1",
      defaultLlmModel: "llama-3.1-8b-instant",
    });
  });

  it("accepts the whole voice surface (voice, container, sample rate, rate, cache)", () => {
    const config = loadEnv({
      env: {
        NEXUS_TTS_VOICE: "aurora",
        NEXUS_TTS_FORMAT: "mp3",
        NEXUS_TTS_SAMPLE_RATE: "44100",
        NEXUS_TTS_RATE: "0.9",
        NEXUS_AUDIO_SEGMENT_CACHE: "/var/lib/nexus/segments.json",
      },
    });

    expect(config.audio).toEqual({
      voice: "aurora",
      format: "mp3",
      sampleRate: 44_100,
      rate: 0.9,
      segmentCache: "/var/lib/nexus/segments.json",
    });
  });

  it("rejects a nonsense voice option instead of guessing", () => {
    // A container the probes cannot verify, a sample rate no adapter would
    // honour, and a pace outside the plausible range all fail at startup.
    expect(() => loadEnv({ env: { NEXUS_TTS_FORMAT: "ogg" } })).toThrow(/NEXUS_TTS_FORMAT/);
    expect(() => loadEnv({ env: { NEXUS_TTS_SAMPLE_RATE: "500" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_TTS_SAMPLE_RATE: "96000" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_TTS_RATE: "0" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_TTS_RATE: "3" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_AUDIO_SEGMENT_CACHE: "" } })).toThrow(EnvValidationError);
  });

  it("rejects a nonsense provider policy instead of guessing", () => {
    expect(() => loadEnv({ env: { NEXUS_PROVIDER_TIMEOUT_MS: "0" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_PROVIDER_MAX_ATTEMPTS: "0" } })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ env: { NEXUS_PROVIDER_DEGRADE_RATIO: "2" } })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ env: { NEXUS_PROVIDER_CACHE: "maybe" } })).toThrow(
      /NEXUS_PROVIDER_CACHE/,
    );
    expect(() => loadEnv({ env: { NEXUS_PROVIDER_RATE_LIMIT_PER_MIN: "-1" } })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ env: { NEXUS_LLM_BASE_URL: "not a url" } })).toThrow(EnvValidationError);
  });

  it("fails fast with an actionable error on invalid values", () => {
    expect(() => loadEnv({ env: { NEXUS_PORT: "not-a-port" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_PORT: "0" } })).toThrow(EnvValidationError);
    expect(() => loadEnv({ env: { NEXUS_ENV: "staging" } })).toThrow(/NEXUS_ENV/);
  });

  it("resolves absolute data dirs and relative ones against cwd", () => {
    const absolute = loadEnv({ env: { NEXUS_DATA_DIR: "/var/lib/nexus" } });
    expect(absolute.dataDir).toBe("/var/lib/nexus");

    const relative = loadEnv({ env: { NEXUS_DATA_DIR: "state" }, cwd: "/srv/nexus" });
    expect(relative.dataDir).toBe(path.resolve("/srv/nexus/state"));
  });

  it("reads .env from cwd without mutating process.env, with process.env taking precedence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-config-test-"));
    try {
      writeFileSync(
        path.join(dir, ".env"),
        ["NEXUS_PORT=9001", "NEXUS_LOG_LEVEL=warn", "NEXUS_TTS_PROVIDER=manual"].join("\n"),
      );

      const fromFile = loadEnv({ cwd: dir });
      expect(fromFile.port).toBe(9001);
      expect(fromFile.logLevel).toBe("warn");
      expect(fromFile.providers.tts).toBe("manual");

      process.env.NEXUS_PORT = "9002";
      try {
        const overridden = loadEnv({ cwd: dir });
        expect(overridden.port).toBe(9002);
      } finally {
        delete process.env.NEXUS_PORT;
      }

      // loadEnv must not have leaked file values into the real environment.
      expect(process.env.NEXUS_TTS_PROVIDER).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("exposes the QA thresholds with their documented defaults", () => {
    const config = loadEnv({ env: {} });

    expect(config.qa).toEqual({
      minFontPx: 18,
      tightFontPx: 24,
      durationToleranceSec: 0.5,
      silenceRms: 0.006,
      silenceWindowSec: 0.6,
      videoToleranceSec: 0.25,
      checkCaptionSafeArea: true,
    });
  });

  it("takes the QA thresholds from the environment", () => {
    const config = loadEnv({
      env: {
        NEXUS_QA_MIN_FONT_PX: "40",
        NEXUS_QA_TIGHT_FONT_PX: "48",
        NEXUS_QA_DURATION_TOLERANCE_SEC: "0.2",
        NEXUS_QA_SILENCE_RMS: "0.002",
        NEXUS_QA_SILENCE_WINDOW_SEC: "1.5",
        NEXUS_QA_VIDEO_TOLERANCE_SEC: "0.5",
        NEXUS_QA_CAPTION_SAFE_AREA: "off",
      },
    });

    expect(config.qa).toEqual({
      minFontPx: 40,
      tightFontPx: 48,
      durationToleranceSec: 0.2,
      silenceRms: 0.002,
      silenceWindowSec: 1.5,
      videoToleranceSec: 0.5,
      checkCaptionSafeArea: false,
    });
  });
});
