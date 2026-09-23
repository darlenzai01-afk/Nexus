import {
  buildCaptionTrack,
  castingFor,
  persistAudioTrack,
  persistCaptionTrack,
  synthesizeNarration,
} from "@nexus/audio";
import { CharacterLibrary } from "@nexus/characters";
import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeTTSProvider,
  FixedClock,
  MemoryProviderCache,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type InvokeRuntime,
} from "@nexus/providers";
import { loadDemoScene, createCharacterStage, type CharacterStage } from "@nexus/render";
import { SceneManifestSchema, persistSceneManifest, type SceneManifest } from "@nexus/scenes";
import type { BlobStore } from "@nexus/storage";

import { resolveRenderConfig } from "./config.js";
import type { RenderConfigInput } from "./schema.js";

/**
 * Fixtures for the rendering pipeline.
 *
 * A render test needs four things that all have to be *real*, or the test proves
 * nothing: a scene plan, a character stage with actual SVGs, a narration track
 * whose clips are actually in the store, and a configuration. So the plan is a
 * **trimmed copy of the Phase 9 demonstration scene** (same cast, same kinds of
 * animation, a couple of seconds long), the narration comes from the Phase 10
 * pipeline driven by the deterministic fake TTS, and the captions from the
 * caption builder — the modules the real stages use, only smaller.
 */

export const FIXTURE_CLOCK = "2024-05-01T00:00:00.000Z";

/** A small frame size: enough to rasterise text and figures, fast enough for CI. */
export const FIXTURE_WIDTH = 320;
export const FIXTURE_HEIGHT = 180;

export interface FixtureManifestOptions {
  /** Seconds of the demonstration scene to keep. */
  readonly seconds?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The demonstration scene, cut down to a couple of seconds.
 *
 * Trimming keeps the events that fall inside the window and drops the rest, so
 * the result is a valid plan of the same shape — a fade-in, a slide-in, a lower
 * third, a type-on and a wipe — rather than a synthetic manifest no stage would
 * ever produce.
 */
export function fixtureManifest(options: FixtureManifestOptions = {}): SceneManifest {
  const seconds = options.seconds ?? 2;
  const width = options.width ?? FIXTURE_WIDTH;
  const height = options.height ?? FIXTURE_HEIGHT;
  const demo = loadDemoScene();
  const scenes = demo.scenes.map((scene) => {
    const duration = Math.min(seconds, scene.durationSec);
    return {
      ...scene,
      durationSec: duration,
      // Cues that start inside the window are kept, clipped to its end: the plan
      // schema refuses an animation that runs past the scene it belongs to.
      animation: scene.animation
        .filter((event) => event.atSec < duration)
        .map((event) => ({
          ...event,
          durationSec: Math.min(event.durationSec, Math.max(0.1, duration - event.atSec)),
        })),
      narration:
        scene.narration === undefined
          ? undefined
          : { ...scene.narration, estimatedDurationSec: duration },
    };
  });
  const trimmed = scenes.map((scene, index) => ({
    ...scene,
    startSec: index === 0 ? 0 : scenes[index - 1]!.durationSec,
    durationSec: scene.durationSec,
  }));
  return SceneManifestSchema.parse({
    ...demo,
    generatedAt: FIXTURE_CLOCK,
    resolution: { width, height },
    totalDurationSec: trimmed.reduce((sum, scene) => sum + scene.durationSec, 0),
    scenes: trimmed,
    assets: demo.assets.map((asset) => ({ ...asset, minDurationSec: 1 })),
    warnings: [],
  });
}

/**
 * The deterministic fake TTS, wired through the provider layer's real `invoke`
 * pipeline — the same plumbing the audio package's own tests use, written here
 * against `@nexus/providers`' public API so a render test never needs an account,
 * a network or a paid call.
 */
function fakeTtsFor(storage: BlobStore): FakeTTSProvider {
  const clock = new FixedClock(FIXTURE_CLOCK);
  const budget = new BudgetGuard({ clock });
  const cache = new MemoryProviderCache();
  const policy = { ...DEFAULT_PROVIDER_POLICY, timeoutMs: 1_000, maxAttempts: 1 };
  const runtime: InvokeRuntime = createRuntime({
    adapterId: "fake",
    kind: "tts",
    storage,
    clock,
    logger: silentProviderLogger,
    env: {},
    policy,
    budget,
    limiter: unlimitedRateLimiter,
    cache,
    credentialsEnv: "NEXUS_TTS_API_KEY",
    transport: (): Promise<never> =>
      Promise.reject(new Error("the fixture never touches the network")),
    invoke: (spec) =>
      invoke(
        {
          adapterId: "fake",
          kind: "tts",
          policy,
          budget,
          cache,
          logger: silentProviderLogger,
          clock,
          sleep: async (): Promise<void> => undefined,
        },
        spec,
      ),
  });
  return new FakeTTSProvider(runtime);
}

/** The bundled demonstration cast, loaded from disk exactly as the stage loads it. */
export function fixtureStage(): CharacterStage {
  return createCharacterStage(CharacterLibrary.load());
}

export interface FixtureManifest {
  readonly manifest: SceneManifest;
  readonly hash: string;
}

/** Persist a fixture plan, so the pipeline reads it back through the real loader. */
export function fixtureManifestIn(
  storage: BlobStore,
  repo: Parameters<typeof persistSceneManifest>[0]["repo"],
  options: FixtureManifestOptions = {},
): FixtureManifest {
  const manifest = fixtureManifest(options);
  const persisted = persistSceneManifest({ storage, repo }, manifest);
  return { manifest, hash: persisted.hash };
}

export interface FixtureAudio {
  readonly trackHash: string;
  readonly captionTrackHash: string;
  readonly clips: number;
  readonly cues: number;
}

/**
 * Voice the fixture plan with the deterministic fake TTS and build the captions
 * the way the `voice` and `captions` stages do — same pipeline, same store, real
 * PCM WAV clips behind real hashes.
 */
export async function fixtureAudio(
  storage: BlobStore,
  repo: Parameters<typeof persistSceneManifest>[0]["repo"],
  manifest: SceneManifest,
  options: { readonly persist?: boolean } = {},
): Promise<FixtureAudio> {
  const report = await synthesizeNarration(
    {
      manifest,
      manifestHash: "0".repeat(64),
      casting: castingFor(manifest, { language: "en", sampleRate: 8_000, rate: 1 }),
      now: FIXTURE_CLOCK,
    },
    { tts: fakeTtsFor(storage), storage, clock: new FixedClock(FIXTURE_CLOCK) },
  );
  const captions = buildCaptionTrack(report.track);
  if (options.persist === false) {
    return {
      trackHash: "",
      captionTrackHash: "",
      clips: report.track.segments.length,
      cues: captions.cues.length,
    };
  }
  const audio = persistAudioTrack({ storage, repo }, report.track);
  const captionArtifact = persistCaptionTrack({ storage, repo }, captions);
  return {
    trackHash: audio.hash,
    captionTrackHash: captionArtifact.hash,
    clips: report.track.segments.length,
    cues: captions.cues.length,
  };
}

/**
 * The default configuration for a fixture render: the fixture's own resolution,
 * short segments (so resume and reuse tests have several units to reuse), no
 * loudness measurement (a second FFmpeg decode that a test does not need) and no
 * audio normalisation (which would need a real filter graph).
 */
export function fixtureRenderConfig(
  overrides: RenderConfigInput = {},
): ReturnType<typeof resolveRenderConfig> {
  return resolveRenderConfig({
    width: FIXTURE_WIDTH,
    height: FIXTURE_HEIGHT,
    fps: 30,
    segmentFrames: 10,
    measureLoudness: false,
    threads: 1,
    fontFile: "",
    ...overrides,
  });
}
