import {
  Db,
  Repo,
  migrate,
  type ArtifactRef,
  type EpisodeRow,
  type PipelineJobRow,
} from "@nexus/db";
import {
  PermanentError,
  createTaskRegistry,
  runJob,
  type RunnerDeps,
  type Task,
} from "@nexus/jobs";
import { MemoryBlobStore } from "@nexus/providers";
import { sceneManifestBytes, type SceneManifest } from "@nexus/scenes";
import { beforeEach, describe, expect, it } from "vitest";

import { captionTrackBytes, type CaptionTrack } from "./captions.js";
import {
  CAPTIONS_STAGE_KEY,
  createCaptionsTask,
  loadCaptionTrack,
  type CaptionsTaskDeps,
} from "./captions-task.js";
import {
  FIXTURE_CLOCK,
  ScriptedTtsProvider,
  castingFixture,
  fakeTts,
  fixedClock,
  twoSceneManifest,
} from "./fixtures.js";
import { persistAudioTrack } from "./persist.js";
import { synthesizeNarration } from "./pipeline.js";
import { createVoiceTask } from "./task.js";

/**
 * The `captions` stage inside the real job runner.
 *
 * The interesting property is that there is nothing to generate: the stage reads
 * the audio track the `voice` stage published and *derives* the cues from it, so
 * the happy path runs the real voice engine and then the real caption engine, and
 * the failure paths hand it a track that a human would have to notice.
 */

interface Harness {
  readonly repo: Repo;
  readonly storage: MemoryBlobStore;
  readonly job: PipelineJobRow;
  readonly episode: EpisodeRow;
  readonly captionsTask: ReturnType<typeof createCaptionsTask>;
  readonly manifestHash: string;
  stepArtifacts(stepKey: string): readonly ArtifactRef[];
  run(): Promise<Awaited<ReturnType<typeof runJob>>>;
}

describe("captions stage task", () => {
  let repo: Repo;
  let storage: MemoryBlobStore;

  beforeEach(() => {
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    storage = new MemoryBlobStore();
  });

  /** A voice track as the `voice` stage leaves it, for tests that stub that stage. */
  async function voiceTrack(options: { readonly failSecondScene?: boolean } = {}): Promise<string> {
    const manifest = twoSceneManifest();
    const report = await synthesizeNarration(
      {
        manifest,
        manifestHash: storage.put(sceneManifestBytes(manifest)).hash,
        casting: castingFixture(),
      },
      {
        tts:
          options.failSecondScene === true
            ? new ScriptedTtsProvider(storage, [
                { kind: "ok" },
                { kind: "throw", retryable: false },
              ])
            : fakeTts(storage),
        storage,
        clock: fixedClock(),
      },
    );
    return persistAudioTrack({ storage, repo }, report.track).hash;
  }

  function harness(
    options: {
      readonly steps?: readonly string[];
      readonly params?: Record<string, unknown>;
      readonly manifest?: SceneManifest;
      /** Run the real voice engine (the default) or stub it with this track. */
      readonly voiceTrackHash?: string;
    } = {},
  ): Harness {
    const manifest = options.manifest ?? twoSceneManifest();
    const manifestHash = storage.put(sceneManifestBytes(manifest)).hash;
    repo.registerArtifact({ hash: manifestHash, kind: "scene_graph", bytes: 1_024 });

    const planStage: Task = {
      stageKey: "plan",
      execute: async () => ({
        output: { manifestHash },
        artifacts: [{ hash: manifestHash, kind: "scene_graph", role: "scene_manifest" }],
      }),
    };

    // Either the real voice stage, or a stub that published the track a test
    // prepared (which is how an incomplete track reaches the caption stage).
    const voiceStage: Task =
      options.voiceTrackHash === undefined
        ? createVoiceTask({
            storage,
            repo,
            clock: fixedClock(),
            tts: fakeTts(storage),
            casting: castingFixture(),
          })
        : {
            stageKey: "voice",
            execute: async () => ({
              output: { trackHash: options.voiceTrackHash, manifestHash },
              artifacts: [{ hash: options.voiceTrackHash!, kind: "audio", role: "voice_track" }],
            }),
          };

    const captionsTask = createCaptionsTask({ storage, repo, clock: fixedClock() });

    const project = repo.createProject({
      name: "Channel",
      slug: `channel-${Math.random().toString(36).slice(2, 8)}`,
    });
    const episode = repo.createEpisode({
      projectId: project.id,
      topic: "The Kira bridge",
      outline: ["intro", "traffic"],
    });
    repo.setEpisodeState(episode.id, "VOICE_SYNTHESIS", null);
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: [...(options.steps ?? ["plan", "voice", "captions"])],
    }).job;

    const deps: RunnerDeps = {
      repo,
      tasks: createTaskRegistry([planStage, voiceStage, captionsTask]),
      workerId: "worker-1",
      leaseMs: 60_000,
      heartbeatIntervalMs: 5,
      params: options.params ?? {},
      random: () => 0.5,
      signal: new AbortController().signal,
    };

    return {
      repo,
      storage,
      job,
      episode,
      captionsTask,
      manifestHash,
      stepArtifacts: (stepKey) =>
        JSON.parse(repo.getJobStep(job.id, stepKey)?.artifacts ?? "[]") as ArtifactRef[],
      async run() {
        repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
        return runJob(deps, job.id);
      },
    };
  }

  it("captions the audio the voice stage published", async () => {
    const h = harness({});
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed", jobId: h.job.id });
    // The stage after captions is composition.
    expect(repo.requireEpisode(h.episode.id).state).toBe("COMPOSITING");

    const step = repo.getJobStep(h.job.id, CAPTIONS_STAGE_KEY)!;
    expect(step.state).toBe("DONE");
    const refs = h.stepArtifacts(CAPTIONS_STAGE_KEY);
    expect(refs).toEqual([expect.objectContaining({ kind: "captions", role: "caption_track" })]);
    const artifact = repo.getArtifact(refs[0]!.hash)!;
    expect(artifact.kind).toBe("captions");
    expect(JSON.parse(artifact.meta)).toMatchObject({ durationSec: 5.12, codec: "webvtt" });

    // The document in the CAS is derived from the audio track, and nothing in it
    // was typed: captions carry the narration the voice stage spoke.
    const captions = loadCaptionTrack(h.storage, refs[0]!.hash);
    expect(captions.cues.map((cue) => cue.lines.map((line) => line.text).join(" "))).toEqual([
      "The bridge carries forty thousand crossings a day.",
      "Two sentences here.",
      "The second one is shorter.",
    ]);
    expect(captions.generatedAt).toBe(FIXTURE_CLOCK);
    expect(captions.provenance.aiSteps).toEqual([]);
    const audioTrackHash = h.stepArtifacts("voice")[0]!.hash;
    expect(captions.audioTrackHash).toBe(audioTrackHash);
    expect(captions.manifestHash).toBe(h.manifestHash);

    const output = JSON.parse(step.output ?? "{}") as Record<string, unknown>;
    expect(output).toMatchObject({
      captionHash: refs[0]!.hash,
      audioTrackHash,
      cues: 3,
      // Four lines of text in three cues: the first sentence needs two.
      counts: { lines: 4, words: 16, estimatedCues: 0, silentScenes: 0 },
      quality: { ok: true },
    });
    expect(output.firstCue).toMatchObject({ id: "cue_0001", startMs: 0 });
    expect(output.lastCue).toMatchObject({ id: "cue_0003", endMs: 5_120 });

    const logs = repo.listJobLogs(h.job.id).filter((row) => row.step_key === CAPTIONS_STAGE_KEY);
    expect(logs.map((row) => row.event)).toEqual(expect.arrayContaining(["captions.completed"]));
    expect(logs.find((row) => row.event === "captions.completed")?.message).toContain("3 cue(s)");
  });

  it("refuses to caption a track with a scene that has no audio", async () => {
    const h = harness({ voiceTrackHash: await voiceTrack({ failSecondScene: true }) });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("incomplete");
    expect(repo.getJobStep(h.job.id, CAPTIONS_STAGE_KEY)!.state).toBe("FAILED");
  });

  it("takes the audio track hash from the job params when no stage published one", async () => {
    const trackHash = await voiceTrack();
    const h = harness({ steps: ["captions"], params: { audioTrackHash: trackHash } });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed" });
    const captions = loadCaptionTrack(h.storage, h.stepArtifacts(CAPTIONS_STAGE_KEY)[0]!.hash);
    expect(captions.audioTrackHash).toBe(trackHash);
    expect(captions.cues).toHaveLength(3);
  });

  it("fails permanently when the voice stage has not run", async () => {
    const h = harness({ steps: ["captions"] });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("has no audio track");
  });

  it("adopts a reused caption track, and refuses one derived from other audio", async () => {
    const h = harness({});
    await h.run();
    const refs = h.stepArtifacts(CAPTIONS_STAGE_KEY);
    const audioTrackHash = h.stepArtifacts("voice")[0]!.hash;
    const run = {
      jobId: h.job.id,
      stepKey: CAPTIONS_STAGE_KEY,
      output: null,
      artifacts: [...refs],
      finishedAt: null,
    };
    const ctx = {
      upstream: { voice: { trackHash: audioTrackHash } },
      inputs: { job: {} },
    } as never;

    expect(() => h.captionsTask.validateReuse!(ctx, run)).not.toThrow();
    expect(() => h.captionsTask.validateReuse!(ctx, { ...run, artifacts: [] })).toThrow(
      PermanentError,
    );

    const persistCaptions = (track: CaptionTrack): string =>
      h.storage.put(captionTrackBytes(track)).hash;

    // A caption track derived from *another* audio track is stale.
    const loaded = loadCaptionTrack(h.storage, refs[0]!.hash);
    const stale = persistCaptions({ ...loaded, audioTrackHash: "f".repeat(64) });
    expect(() =>
      h.captionsTask.validateReuse!(ctx, {
        ...run,
        artifacts: [{ hash: stale, kind: "captions", role: "caption_track" }],
      }),
    ).toThrow(/derived from audio/u);

    // So is one that leaves a scene uncaptioned.
    const partial = persistCaptions({ ...loaded, totals: { ...loaded.totals, silentScenes: 1 } });
    expect(() =>
      h.captionsTask.validateReuse!(ctx, {
        ...run,
        artifacts: [{ hash: partial, kind: "captions", role: "caption_track" }],
      }),
    ).toThrow(/uncaptioned/u);
  });

  it("can be given a tighter caption tuning", async () => {
    const captionTuning: CaptionsTaskDeps["tuning"] = { maxCharsPerLine: 20, maxLinesPerCue: 1 };
    const trackHash = await voiceTrack();
    const task = createCaptionsTask({ storage, repo, clock: fixedClock(), tuning: captionTuning });
    const project = repo.createProject({ name: "Channel", slug: "tight-captions" });
    const episode = repo.createEpisode({ projectId: project.id, topic: "K", outline: ["intro"] });
    repo.setEpisodeState(episode.id, "CAPTIONING", null);
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: ["captions"],
    }).job;
    repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
    const outcome = await runJob(
      {
        repo,
        tasks: createTaskRegistry([task]),
        workerId: "worker-1",
        leaseMs: 60_000,
        heartbeatIntervalMs: 5,
        params: { audioTrackHash: trackHash },
        random: () => 0.5,
        signal: new AbortController().signal,
      },
      job.id,
    );

    expect(outcome).toMatchObject({ status: "completed" });
    const refs = JSON.parse(repo.getJobStep(job.id, CAPTIONS_STAGE_KEY)!.artifacts) as {
      hash: string;
    }[];
    const captions = loadCaptionTrack(storage, refs[0]!.hash);
    expect(captions.settings).toMatchObject({ maxCharsPerLine: 20, maxLinesPerCue: 1 });
    expect(captions.cues.every((cue) => cue.lines.length === 1)).toBe(true);
    expect(captions.cues.length).toBeGreaterThan(3);
  });
});
