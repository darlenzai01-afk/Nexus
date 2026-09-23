import { castingFor, synthesizeNarration, type AudioTrack, type VoiceCasting } from "@nexus/audio";
import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeTTSProvider,
  FixedClock,
  MemoryBlobStore,
  MemoryProviderCache,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type Clock,
  type InvokeRuntime,
} from "@nexus/providers";
import { SceneManifestSchema, SceneSchema, type Scene, type SceneManifest } from "@nexus/scenes";
import type { BlobStore } from "@nexus/storage";

/**
 * A small finished long-form episode, built by the real planners so the shorts
 * engine is exercised against documents the pipeline actually produces:
 *
 * - the **manifest** is schema-valid (wired transitions, gapless timeline,
 *   claim references) and carries the scene visual metadata the reflow reads —
 *   a two-shot, sourced evidence with corner text, a diagram, a presenter;
 * - the **narration track** comes from the real audio pipeline over the
 *   deterministic fake TTS, so the narration timestamps are the real spoken
 *   windows, not hand-written numbers.
 */

export const FIXTURE_CLOCK = "2024-06-01T00:00:00.000Z";
export const FIXTURE_FPS = 10;
export const SOURCE_RESOLUTION = { width: 640, height: 360 } as const;

interface SceneOptions {
  readonly id: string;
  readonly role: Scene["role"];
  readonly type: Scene["type"];
  readonly text: string;
  readonly characters?: Scene["characters"];
  readonly media?: Scene["media"];
  readonly textCard?: Scene["text"];
  readonly diagram?: Scene["diagram"];
  readonly sources?: Scene["sources"];
  readonly sourceIds?: Scene["sourceIds"];
}

function buildScene(options: SceneOptions, index: number, startSec: number): Scene {
  const words = options.text.split(/\s+/u).filter((word) => word !== "").length;
  const sentenceCount = options.text.split(/(?<=[.!?])\s+/u).length;
  return SceneSchema.parse({
    id: options.id,
    index,
    type: options.type,
    sectionId: `sec_${options.role}`,
    role: options.role,
    startSec,
    durationSec: Math.round((words / 2.5) * 10) / 10 + 0.6,
    narration: {
      kind: options.type === "TRANSITION" ? "transition" : "sentence",
      text: options.text,
      sectionId: `sec_${options.role}`,
      role: options.role,
      // A spoken transition comes from the section, not from one sentence.
      sentenceIds:
        options.type === "TRANSITION"
          ? []
          : Array.from({ length: sentenceCount }, (_, position) => `snt_${index}_${position}`),
      words,
      estimatedDurationSec: Math.round((words / 2.5) * 10) / 10,
    },
    characters: options.characters ?? [],
    ...(options.media !== undefined ? { media: options.media } : {}),
    ...(options.textCard !== undefined ? { text: options.textCard } : {}),
    ...(options.diagram !== undefined ? { diagram: options.diagram } : {}),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    ...(options.sourceIds !== undefined ? { sourceIds: options.sourceIds } : {}),
    camera:
      options.type === "DIAGRAM"
        ? { shot: "insert", movement: "static", angle: "overhead", focus: "diagram" }
        : {
            shot: (options.characters?.length ?? 0) > 1 ? "wide" : "medium",
            movement: "static",
            angle: "eye_level",
            focus: (options.characters?.length ?? 0) > 0 ? "presenter" : "screen",
          },
    animation: [],
    transition: { kind: "cut", durationSec: 0, toSceneId: "", audio: "none" },
  });
}

export interface FixtureEpisode {
  readonly manifest: SceneManifest;
  readonly track: AudioTrack;
  readonly casting: VoiceCasting;
}

/**
 * "Why the Kira bridge hums at dusk" — six scenes with the metadata the reflow
 * has to handle: a hook question, a presenter intro, sourced evidence with
 * corner text and a side-by-side treatment, a diagram, a two-shot, and a
 * payoff conclusion.
 */
export async function fixtureEpisode(): Promise<FixtureEpisode> {
  const raw: SceneOptions[] = [
    {
      id: "scn_hook",
      role: "hook",
      type: "TRANSITION",
      text: "Why does the Kira bridge hum at dusk? The answer took engineers thirty years to find.",
    },
    {
      id: "scn_intro",
      role: "introduction",
      type: "CHARACTER",
      text: "The bridge opened in 1973, and today it carries forty thousand vehicles a day.",
      characters: [{ characterId: "maya", state: "talking" }],
    },
    {
      id: "scn_evidence",
      role: "narrative",
      type: "EVIDENCE",
      text: "Engineers first blamed the wind, but the recordings told a different story.",
      media: {
        kind: "generated",
        description: "Waveform of the hum recording",
        searchHint: "waveform",
        orientation: "landscape",
        treatment: "split_screen",
        assets: [],
      },
      textCard: {
        kind: "quote",
        value: '"It is not the wind."',
        attribution: "the 1991 report",
        position: "corner",
        maxLines: 2,
        sizeScale: 1,
      },
      sources: [
        {
          claimId: "cl_kira001",
          statement: "Engineers' early wind theory did not survive the recordings.",
          usage: "attributed",
          status: "supported",
          certainty: "established",
          confidence: 0.9,
          evidence: [
            {
              sourceId: "src_kira_report_1991",
              url: "https://fixtures.nexus.invalid/kira-report-1991",
              excerpt: "The wind hypothesis was retired after the 1991 recordings.",
              locator: "12:60",
            },
          ],
        },
      ],
      sourceIds: ["src_kira_report_1991"],
    },
    {
      id: "scn_diagram",
      role: "narrative",
      type: "DIAGRAM",
      text: "The hum matches the cables at exactly 2.7 hertz.",
      diagram: {
        kind: "number_highlight",
        title: "Cable frequency",
        annotations: ["2.7 Hz", "measured at dusk"],
        series: [{ label: "frequency", value: 2.7, unit: "Hz" }],
        claimIds: ["cl_kira001"],
      },
      sources: [
        {
          claimId: "cl_kira001",
          statement: "The hum matches the cables' resonant frequency at 2.7 hertz.",
          usage: "attributed",
          status: "supported",
          certainty: "established",
          confidence: 0.9,
          evidence: [
            {
              sourceId: "src_kira_report_1991",
              url: "https://fixtures.nexus.invalid/kira-report-1991",
              excerpt: "Recordings place the resonance at 2.7 Hz.",
              locator: "0:41",
            },
          ],
        },
      ],
      sourceIds: ["src_kira_report_1991"],
    },
    {
      id: "scn_twoshot",
      role: "narrative",
      type: "CHARACTER",
      text: "Maya and Tomas finally agree the dampers were the answer all along.",
      characters: [
        { characterId: "maya", state: "talking" },
        { characterId: "tomas", state: "listening" },
      ],
    },
    {
      id: "scn_end",
      role: "conclusion",
      type: "CHARACTER",
      text: "So the bridge keeps humming, and the city keeps listening.",
      characters: [{ characterId: "maya", state: "talking" }],
    },
  ];

  const scenes: Scene[] = [];
  for (const [index, options] of raw.entries()) {
    const previous = scenes[scenes.length - 1];
    const startSec =
      previous === undefined ? 0 : Math.round((previous.startSec + previous.durationSec) * 10) / 10;
    scenes.push(buildScene(options, index, startSec));
  }
  const wired = scenes.map((item, position) => ({
    ...item,
    transition: { ...item.transition, toSceneId: scenes[position + 1]?.id ?? "" },
  }));

  const total = Math.round(wired.reduce((sum, scene) => sum + scene.durationSec, 0) * 10) / 10;
  const manifest = SceneManifestSchema.parse({
    version: 1,
    topic: "Why the Kira bridge hums at dusk",
    workingTitle: "The Kira Bridge Hum",
    scriptId: "",
    scriptHash: "c".repeat(64),
    generatedAt: FIXTURE_CLOCK,
    fps: FIXTURE_FPS,
    aspect: "16:9",
    resolution: SOURCE_RESOLUTION,
    wordsPerSecond: 2.5,
    totalDurationSec: total,
    cast: [
      { id: "maya", name: "Maya Okonkwo", role: "host", description: "" },
      { id: "tomas", name: "Tomás Reyes", role: "expert", description: "" },
    ],
    scenes: wired,
    assets: [],
    warnings: [],
    provenance: {
      engine: { name: "nexus-shorts-fixtures", version: "1.0.0" },
      steps: [{ step: "validate", engine: "none", notes: ["fixture episode"] }],
      aiSteps: [],
      deterministicSteps: ["cast", "types", "timing", "camera", "validate"],
      generatedAt: FIXTURE_CLOCK,
    },
  });

  const casting = castingFor(manifest, { language: "en", sampleRate: 8_000, rate: 1 });
  const report = await synthesizeNarration(
    { manifest, manifestHash: "d".repeat(64), casting, now: FIXTURE_CLOCK },
    { tts: fixtureTts(), storage: fixtureStorage(), clock: fixtureClock() },
  );
  if (report.waiting || report.track.totals.failedSegments > 0) {
    throw new Error(`fixture narration failed: ${JSON.stringify(report.calls)}`);
  }
  return { manifest, track: report.track, casting };
}

// ── The fake TTS, wired exactly like the other packages' fixtures ──

let storage: MemoryBlobStore | undefined;

function fixtureStorage(): BlobStore {
  storage ??= new MemoryBlobStore();
  return storage;
}

function fixtureClock(): Clock {
  return new FixedClock(FIXTURE_CLOCK);
}

function fixtureTts(): FakeTTSProvider {
  const clock = fixtureClock();
  const budget = new BudgetGuard({ clock });
  const cache = new MemoryProviderCache();
  const policy = { ...DEFAULT_PROVIDER_POLICY, timeoutMs: 1_000, maxAttempts: 1 };
  const runtime: InvokeRuntime = createRuntime({
    adapterId: "fake",
    kind: "tts",
    storage: fixtureStorage(),
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
