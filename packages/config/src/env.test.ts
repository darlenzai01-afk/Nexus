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
});
