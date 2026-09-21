import { Db, Repo, migrate, scriptDocBytes, type EpisodeRow, type PipelineJobRow } from "@nexus/db";
import {
  PermanentError,
  createTaskRegistry,
  runJob,
  type RunnerDeps,
  type Task,
} from "@nexus/jobs";
import { FixedClock, MemoryBlobStore } from "@nexus/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { SCRIPT_HASH, scriptFixture } from "./fixtures.js";
import { loadSceneManifest } from "./persist.js";
import { createScenePlanTask, type ScenePlanTaskDeps } from "./task.js";

/**
 * The `plan` stage inside the real job runner: real SQLite, real repository, real
 * lease/step machinery. The one double is the `script` stage, which is stubbed so
 * this test exercises the *hand-off* (a script artifact and its hash travelling
 * from one stage to the next) rather than the script engine again.
 */

const CLOCK_ISO = "2024-05-01T00:00:00.000Z";

interface Harness {
  readonly repo: Repo;
  readonly storage: MemoryBlobStore;
  readonly job: PipelineJobRow;
  readonly episode: EpisodeRow;
  readonly task: ReturnType<typeof createScenePlanTask>;
  readonly scriptHash: string;
  run(): Promise<Awaited<ReturnType<typeof runJob>>>;
}

describe("plan stage task", () => {
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
      readonly taskOptions?: ScenePlanTaskDeps["options"];
      readonly withScriptStep?: boolean;
    } = {},
  ): Harness {
    const scriptHash = storage.put(scriptDocBytes(scriptFixture())).hash;
    repo.registerArtifact({ hash: scriptHash, kind: "script", bytes: 1024 });

    // The `script` stage, stubbed down to its contract: it produced a document and
    // told the runner where to find it.
    const scriptStage: Task = {
      stageKey: "script",
      execute: async () => ({
        output: {
          scriptId: "script_1",
          docHash: scriptHash,
          workingTitle: "Forty Thousand Crossings a Day",
        },
        artifacts: [{ hash: scriptHash, kind: "script", role: "script_doc" }],
      }),
    };

    const task = createScenePlanTask({
      storage,
      repo,
      clock: new FixedClock(CLOCK_ISO),
      ...(options.taskOptions !== undefined ? { options: options.taskOptions } : {}),
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
    // Where the fact-check hand-off leaves an episode: the script stage is next.
    repo.setEpisodeState(episode.id, "FACT_CHECKING", null);
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: [...(options.steps ?? ["script", "plan"])],
    }).job;

    const deps: RunnerDeps = {
      repo,
      tasks: createTaskRegistry([scriptStage, task]),
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
      scriptHash,
      async run() {
        repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
        return runJob(deps, job.id);
      },
    };
  }

  it("plans the script the previous stage produced and stores the manifest", async () => {
    const h = harness({});
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed", jobId: h.job.id });
    expect(repo.requireEpisode(h.episode.id).state).toBe("MEDIA_GATHERING");

    // The artifact: kind + role the stage declares it produces.
    const step = repo.getJobStep(h.job.id, "plan")!;
    expect(step.state).toBe("DONE");
    const refs = JSON.parse(step.artifacts) as { hash: string; kind: string; role: string }[];
    expect(refs).toEqual([
      {
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        kind: "scene_graph",
        role: "scene_manifest",
      },
    ]);
    const artifact = repo.getArtifact(refs[0]!.hash)!;
    expect(artifact.kind).toBe("scene_graph");
    expect(JSON.parse(artifact.meta)).toMatchObject({
      durationSec: 65.3,
      fps: 30,
      width: 1920,
      height: 1080,
    });

    // The manifest in the CAS is the manifest the stage reported.
    const manifest = loadSceneManifest(h.storage, refs[0]!.hash);
    expect(manifest.scriptHash).toBe(h.scriptHash);
    expect(manifest.scriptId).toBe("script_1");
    expect(manifest.scenes).toHaveLength(13);
    expect(manifest.warnings).toEqual([]);

    // The step output tells the media stage what to fetch, without opening the blob.
    const output = JSON.parse(step.output ?? "{}") as Record<string, unknown>;
    expect(output).toMatchObject({
      manifestHash: refs[0]!.hash,
      scriptHash: h.scriptHash,
      durationSec: 65.3,
      cast: ["presenter"],
      counts: { scenes: 13, assets: 4, words: 141 },
      quality: { ok: true, hardIssues: 0, softIssues: 0 },
    });
    expect(output.assets).toEqual([
      expect.objectContaining({ id: "asset_scn_sec2_1", kind: "video", status: "planned" }),
      expect.objectContaining({ id: "asset_scn_sec4_1", kind: "image" }),
      expect.objectContaining({ id: "asset_scn_sec4_3", kind: "image" }),
      expect.objectContaining({ id: "asset_scn_sec5_1", kind: "video" }),
    ]);

    // Nothing here was generated by a model: the plan is a projection of the script.
    expect(manifest.provenance.aiSteps).toEqual([]);
    const logs = repo.listJobLogs(h.job.id).filter((row) => row.step_key === "plan");
    expect(logs.map((row) => row.event)).toEqual(
      expect.arrayContaining(["scene_plan.started", "scene_plan.completed"]),
    );
    expect(logs.map((row) => row.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("13 scene(s)")]),
    );
    expect(logs.some((row) => row.event === "scene_plan.review_required")).toBe(false);
  });

  it("fails permanently when the script stage has not run", async () => {
    const h = harness({ steps: ["plan"] });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("has no script");
    expect(repo.getJobStep(h.job.id, "plan")!.state).toBe("FAILED");
  });

  it("fails permanently when the script artifact is not in the store", async () => {
    const h = harness({ steps: ["plan"], params: { scriptHash: "f".repeat(64) } });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("cannot read script artifact");
  });

  it("fails permanently when the plan is configured for a cast nobody can be", async () => {
    const h = harness({ taskOptions: { cast: [] } });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("needs someone on screen");
  });

  it("takes the script hash from the job params when no stage published one", async () => {
    const h = harness({ steps: ["plan"], params: { scriptHash: SCRIPT_HASH } });
    const outcome = await h.run();

    // The named hash is not a real artifact, so this fails — but for the right
    // reason: the plan tried to read the script it was pointed at.
    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain(SCRIPT_HASH.slice(0, 12));
  });

  it("adopts a reused plan, and refuses to reuse something that is not one", async () => {
    const h = harness({});
    await h.run();
    const refs = JSON.parse(repo.getJobStep(h.job.id, "plan")!.artifacts) as {
      hash: string;
      kind: "scene_graph";
      role: string;
    }[];
    const run = {
      jobId: h.job.id,
      stepKey: "plan",
      output: null,
      artifacts: refs,
      finishedAt: null,
    };

    expect(() => h.task.validateReuse!({} as never, run)).not.toThrow();
    expect(() => h.task.validateReuse!({} as never, { ...run, artifacts: [] })).toThrow(
      PermanentError,
    );

    // A manifest with no scenes is never good enough to reuse: planning again is
    // cheaper than rendering nothing.
    const empty = h.storage.put(
      new TextEncoder().encode(
        JSON.stringify(
          { ...loadSceneManifest(h.storage, refs[0]!.hash), scenes: [], photos: undefined },
          null,
          2,
        ),
      ),
    );
    expect(() =>
      h.task.validateReuse!({} as never, {
        ...run,
        artifacts: [{ ...refs[0]!, hash: empty.hash }],
      }),
    ).toThrow();
  });
});
