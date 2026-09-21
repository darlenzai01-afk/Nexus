import { describe, expect, it } from "vitest";

import { loadEnv } from "@nexus/config";

import { DRY_RUN_ENV, dryRunConfig } from "./dry-run.js";

describe("dry-run", () => {
  it("swaps every remote capability for its fake and keeps storage real", () => {
    const config = loadEnv({
      env: { NEXUS_LLM_PROVIDER: "openai-compatible", NEXUS_PUBLISHING_PROVIDER: "manual" },
    });
    const dry = dryRunConfig(config);

    expect(dry.providers).toEqual({
      llm: "fake",
      tts: "fake",
      research: "fake",
      media: "fake",
      publishing: "fake",
      storage: "local", // artifacts must survive the run to be inspected
    });
    // Everything else is untouched: a dry run is the real pipeline otherwise.
    expect(dry.port).toBe(config.port);
    expect(dry.dataDir).toBe(config.dataDir);
    expect(dry.providerPolicy).toEqual(config.providerPolicy);
    expect(config.providers.llm).toBe("openai-compatible"); // no mutation
  });

  it("exposes the same choice as environment variables for CLI runs", () => {
    const config = loadEnv({ env: { ...DRY_RUN_ENV, NEXUS_LLM_PROVIDER: "none" } });
    // DRY_RUN_ENV only overrides what it names; a later loadEnv sees the fakes.
    expect(config.providers.llm).toBe("none");
    const overridden = loadEnv({ env: DRY_RUN_ENV });
    expect(overridden.providers.llm).toBe("fake");
    expect(overridden.providers.storage).toBe("local");
  });
});
