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
import { MANUAL_INPUT_GATE, MemoryBlobStore, synthesizeWav } from "@nexus/providers";
import { sceneManifestBytes, type SceneManifest } from "@nexus/scenes";
import { sha256 } from "@nexus/storage";
import { beforeEach, describe, expect, it } from "vitest";

import {
  FIXTURE_CLOCK,
  ScriptedTtsProvider,
  castingFixture,
  fakeTts,
  fixedClock,
  twoSceneManifest,
} from "./fixtures.js";
import { loadAudioTrack, persistAudioTrack } from "./persist.js";
import type { AudioTrack } from "./schema.js";
import { createVoiceTask, type VoiceTaskDeps } from "./task.js";

/**
 * The `voice` stage inside the real job runner: real SQLite, real repository, real
 * lease/step machinery. The one double is the `plan` stage, which is stubbed down
 * to its contract (it published a manifest and said where it is), so this test
 * exercises the *hand-off* rather than the scene planner again.
 */

interface Harness {
  readonly repo: Repo;
  readonly storage: MemoryBlobStore;
  readonly job: PipelineJobRow;
  readonly episode: EpisodeRow;
  readonly task: ReturnType<typeof createVoiceTask>;
  readonly manifestHash: string;
  stepArtifacts(): readonly ArtifactRef[];
  run(): Promise<Awaited<ReturnType<typeof runJob>>>;
}

describe("voice stage task", () => {
  let repo: Repo;
  let storage: MemoryBlobStore;

  beforeEach(() => {
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    storage = new MemoryBlobStore();
  });

  function harness(
    options: {
      readonly steps?: readonly string[];
      readonly params?: Record<string, unknown>;
      readonly tts?: (storage: MemoryBlobStore) => VoiceTaskDeps["tts"];
      readonly casting?: VoiceTaskDeps["casting"];
      readonly manifest?: SceneManifest;
    } = {},
  ): Harness {
    const manifest = options.manifest ?? twoSceneManifest();
    const manifestHash = storage.put(sceneManifestBytes(manifest)).hash;
    repo.registerArtifact({ hash: manifestHash, kind: "scene_graph", bytes: 1_024 });

    // The `plan` stage, stubbed down to its contract: it published a manifest and
    // told the runner where to find it.
    const planStage: Task = {
      stageKey: "plan",
      execute: async () => ({
        output: { manifestHash, workingTitle: manifest.workingTitle },
        artifacts: [{ hash: manifestHash, kind: "scene_graph", role: "scene_manifest" }],
      }),
    };

    const task = createVoiceTask({
      storage,
      repo,
      clock: fixedClock(),
      tts: options.tts?.(storage) ?? fakeTts(storage),
      ...(options.casting !== undefined ? { casting: options.casting } : {}),
    });

    const project = repo.createProject({
      name: "Channel",
      slug: `channel-${Math.random().toString(36).slice(2, 8)}`,
    });
    const episode = repo.createEpisode({
      projectId: project.id,
      topic: "The Kira bridge",
      outline: ["intro", "traffic"],
    });
    repo.setEpisodeState(episode.id, "SCENE_PLANNING", null);
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: [...(options.steps ?? ["plan", "voice"])],
    }).job;

    const deps: RunnerDeps = {
      repo,
      tasks: createTaskRegistry([planStage, task]),
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
      task,
      manifestHash,
      stepArtifacts: () =>
        JSON.parse(repo.getJobStep(job.id, "voice")?.artifacts ?? "[]") as ArtifactRef[],
      async run() {
        repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
        return runJob(deps, job.id);
      },
    };
  }

  it("voices the manifest the previous stage published and stores the track", async () => {
    const h = harness({});
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed", jobId: h.job.id });
    expect(repo.requireEpisode(h.episode.id).state).toBe("CAPTIONING");

    // The artifacts: the track, then one reference per clip.
    const step = repo.getJobStep(h.job.id, "voice")!;
    expect(step.state).toBe("DONE");
    const refs = h.stepArtifacts();
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ kind: "audio", role: "voice_track" });
    expect(refs.slice(1)).toEqual([
      expect.objectContaining({ kind: "audio", role: "voice_segment" }),
      expect.objectContaining({ kind: "audio", role: "voice_segment" }),
    ]);

    const artifact = repo.getArtifact(refs[0]!.hash)!;
    expect(artifact.kind).toBe("audio");
    expect(JSON.parse(artifact.meta)).toMatchObject({ durationSec: 5.12, codec: "json" });
    // Every clip the track names is registered too, so nothing references bytes
    // the artifacts table has never heard of.
    for (const ref of refs.slice(1)) expect(repo.getArtifact(ref.hash)).not.toBeNull();

    // The document in the CAS is the one the stage reported.
    const track = loadAudioTrack(h.storage, refs[0]!.hash);
    expect(track.manifestHash).toBe(h.manifestHash);
    expect(track.segments.map((segment) => segment.sceneId)).toEqual(["scn_one", "scn_two"]);
    expect(track.totals.spokenDurationSec).toBe(5.12);
    expect(track.provenance.aiSteps).toEqual(["voice.synthesize"]);

    // The step output tells the caption stage what to caption, without the blob.
    const output = JSON.parse(step.output ?? "{}") as Record<string, unknown>;
    expect(output).toMatchObject({
      trackHash: refs[0]!.hash,
      manifestHash: h.manifestHash,
      adapter: "fake",
      language: "en",
      format: "wav",
      totals: { scenes: 2, segments: 2, failedSegments: 0 },
      calls: { providerCalls: 2, cacheHits: 0 },
      quality: { ok: true, hardIssues: 0 },
    });
    expect(output.segments).toHaveLength(2);
    expect(output.scenes).toEqual([
      expect.objectContaining({ sceneId: "scn_one", verdict: "short" }),
      expect.objectContaining({ sceneId: "scn_two", verdict: "short" }),
    ]);

    const logs = repo.listJobLogs(h.job.id).filter((row) => row.step_key === "voice");
    expect(logs.map((row) => row.event)).toEqual(
      expect.arrayContaining(["voice.started", "voice.segment.completed", "voice.completed"]),
    );
  });

  it("parks at the manual gate when a scene cannot be voiced, and says how to unblock it", async () => {
    const h = harness({
      tts: (store) =>
        new ScriptedTtsProvider(store, [{ kind: "ok" }, { kind: "throw", retryable: false }]),
    });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "waiting", gate: MANUAL_INPUT_GATE });
    expect(repo.requireJob(h.job.id).waiting_gate).toBe(MANUAL_INPUT_GATE);
    expect(repo.getJobStep(h.job.id, "voice")!.state).toBe("WAITING");

    const logs = repo.listJobLogs(h.job.id).filter((row) => row.step_key === "voice");
    expect(logs.map((row) => row.event)).toEqual(
      expect.arrayContaining(["voice.completed", "voice.manual_required"]),
    );
    // The parked step has no output yet, so the instructions travel in the log.
    const gate = logs.find((row) => row.event === "gate.waiting");
    expect(gate?.message).toContain("params.operatorAudio");
    // And so does the summary of what *did* work: one clip of two.
    expect(logs.find((row) => row.event === "voice.completed")?.message).toContain("1 segment(s)");
  });

  it("adopts an operator's clip through params.operatorAudio", async () => {
    const wav = synthesizeWav({
      text: "The bridge carries forty thousand crossings a day.",
      voiceId: "fake-warm",
      sampleRate: 8_000,
      durationMs: 1_500,
    });
    // Content-addressed, so the operator's hash is known before the harness
    // exists — which is exactly how an upload hands a clip to a stage.
    const hash = sha256(wav.bytes);
    const h = harness({
      params: { operatorAudio: [{ sceneId: "scn_one", hash, durationMs: 1_500 }] },
      // Only scene two reaches the adapter: the operator supplied scene one.
      tts: (store) => new ScriptedTtsProvider(store, [{ kind: "ok" }], { durationMs: 2_000 }),
    });
    h.storage.put(wav.bytes);
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed" });
    const refs = h.stepArtifacts();
    const track = loadAudioTrack(h.storage, refs[0]!.hash);
    expect(track.segments[0]).toMatchObject({
      sceneId: "scn_one",
      provider: "operator",
      durationMethod: "probed",
      audio: { hash, durationMs: 1_500 },
    });
    expect(track.totals.operatorSegments).toBe(1);
    expect(track.totals.segments).toBe(2);
  });

  it("refuses params.operatorAudio that is not a list of clips", async () => {
    const h = harness({ params: { operatorAudio: "scn_one" } });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("params.operatorAudio");
  });

  it("fails permanently when the plan stage has not run", async () => {
    const h = harness({ steps: ["voice"] });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("has no scene manifest");
    expect(repo.getJobStep(h.job.id, "voice")!.state).toBe("FAILED");
  });

  it("takes the manifest hash from the job params when no stage published one", async () => {
    const h = harness({ steps: ["voice"], params: { manifestHash: "f".repeat(64) } });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("cannot read scene manifest");
  });

  it("adopts a reused track, and refuses one that is incomplete or from another manifest", async () => {
    const h = harness({});
    await h.run();
    const refs = h.stepArtifacts();
    const run = {
      jobId: h.job.id,
      stepKey: "voice",
      output: null,
      artifacts: [...refs],
      finishedAt: null,
    };

    // What the runner hands a reuse guard: this job, and the outputs of the
    // stages that already completed.
    const ctx = {
      upstream: { plan: { manifestHash: h.manifestHash } },
      inputs: { job: {} },
    } as never;
    expect(() => h.task.validateReuse!(ctx, run)).not.toThrow();
    expect(() => h.task.validateReuse!(ctx, { ...run, artifacts: [] })).toThrow(PermanentError);

    // A track with a scene that has no audio is never good enough to reuse: the
    // caption stage would burn captions in over the gap.
    const loaded = loadAudioTrack(h.storage, refs[0]!.hash);
    const broken = persistAudioTrack({ storage: h.storage, repo: h.repo }, {
      ...loaded,
      issues: [
        {
          code: "provider_failed",
          severity: "error",
          sceneId: "scn_two",
          segmentId: "seg_scn_two",
          message: "the adapter failed",
        },
      ],
    } satisfies AudioTrack);
    expect(() =>
      h.task.validateReuse!(ctx, {
        ...run,
        artifacts: [{ hash: broken.hash, kind: "audio", role: "voice_track" }],
      }),
    ).toThrow(/incomplete/u);

    // A track that voices a different manifest is stale, whatever its quality.
    const stale = persistAudioTrack(
      { storage: h.storage, repo: h.repo },
      { ...loaded, manifestHash: "f".repeat(64) },
    );
    expect(() =>
      h.task.validateReuse!(ctx, {
        ...run,
        artifacts: [{ hash: stale.hash, kind: "audio", role: "voice_track" }],
      }),
    ).toThrow(/voices manifest/u);
  });

  it("records the casting it voiced with, and the clock it ran on", async () => {
    const h = harness({
      casting: castingFixture({
        narrator: { voiceId: "fake-deep", label: "Reader", language: "en", rate: 1 },
      }),
    });
    await h.run();
    const refs = h.stepArtifacts();
    const track = loadAudioTrack(h.storage, refs[0]!.hash);
    // Scene one is presented by maya (`fake-narrator` from the casting); a
    // listening-only scene would fall to the narrator's `fake-deep`.
    expect(track.segments.map((segment) => segment.voice.voiceId)).toEqual([
      "fake-narrator",
      "fake-narrator",
    ]);
    expect(track.casting.narrator).toMatchObject({ voiceId: "fake-deep", label: "Reader" });
    expect(track.generatedAt).toBe(FIXTURE_CLOCK);
  });
});
