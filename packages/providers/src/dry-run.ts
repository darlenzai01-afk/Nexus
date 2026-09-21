import type { AppConfig } from "@nexus/config";

/**
 * `--dry-run`: the whole pipeline, none of the outside world.
 *
 * A dry run is how the operator sees an episode end to end before spending a
 * cent of a free tier — every remote capability is served by its deterministic
 * fake, so the run is reproducible and offline.
 *
 * Storage is the deliberate exception: it stays on the real (local) CAS. A dry
 * run whose artifacts evaporate when the process exits would not let anyone
 * inspect the render, the audio or the upload kit, which is most of the point.
 */
export function dryRunConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      llm: "fake",
      tts: "fake",
      research: "fake",
      media: "fake",
      publishing: "fake",
      // storage unchanged on purpose — see above.
    },
  };
}

/** The environment equivalent of `dryRunConfig`, for CLI/`tsx` invocations. */
export const DRY_RUN_ENV: Readonly<Record<string, string>> = {
  NEXUS_LLM_PROVIDER: "fake",
  NEXUS_TTS_PROVIDER: "fake",
  NEXUS_RESEARCH_PROVIDER: "fake",
  NEXUS_MEDIA_PROVIDER: "fake",
  NEXUS_PUBLISHING_PROVIDER: "fake",
};
