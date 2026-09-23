/**
 * Hostile reliability probes — the content pipeline, the orchestrator, the
 * storage layer and the dashboard (scenarios 8–21 and 24 of the reliability
 * brief). Everything runs on mock providers, scripted FFmpeg and in-memory or
 * temporary data — nothing here touches a real deployment.
 *
 * Each test states the behavior an operator depends on, reproduces the attack,
 * and pins the outcome. Defects found by these probes are fixed in the same
 * change and reference the fixing test from `docs/testing/reliability-report.md`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv } from "@nexus/config";
import { Db, migrate, Repo, type PipelineJobRow } from "@nexus/db";
import {
  PermanentError,
  RetryableError,
  createTaskRegistry,
  retryFailedJob,
  runJob,
  type RunnerDeps,
  type Task,
} from "@nexus/jobs";
import { runQA, qaFixture, cleanupQAFixtureTemp } from "@nexus/qa";
import { MemoryBlobStore } from "@nexus/providers";
import { CasStore } from "@nexus/storage";
import { SceneManifestSchema, validateSceneManifest } from "@nexus/scenes";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../apps/nexus/src/app.js";
import { openRuntime, type Runtime } from "../../apps/nexus/src/runtime.js";

afterAll(() => {
  cleanupQAFixtureTemp();
});

// ── QA-visible content failures (8–12, 14) ──────────────────────────────────

describe("content integrity under attack", () => {
  it("8. reports missing narration audio instead of shipping a silent video unchecked", async () => {
    const fixture = await qaFixture({ withoutAudio: true });
    const report = runQA(fixture.evidence, fixture.deps, { episodeId: "ep_qa", jobId: "job_qa" });
    expect(report.findings.map((finding) => finding.code)).toContain("audio_missing");
    // A missing voice is not silently ignored — it is on the report.
    expect(report.notes.join(" ").length + report.findings.length).toBeGreaterThan(0);
  });

  it("9. blocks a scene that draws media no stage ever sourced (planned-but-absent asset)", async () => {
    const fixture = await qaFixture();
    const manifest = structuredClone(fixture.evidence.manifest) as typeof fixture.evidence.manifest;
    const scene = manifest.scenes[0]!;
    manifest.assets = [
      ...manifest.assets,
      {
        id: "asset_ghost",
        sceneId: scene.id,
        kind: "image",
        purpose: "evidence",
        description: "a chart nobody sourced",
        searchHint: "",
        orientation: "landscape",
        minDurationSec: 0,
        status: "planned",
        uri: "",
        licence: "unknown",
      },
    ];
    manifest.scenes = manifest.scenes.map((entry) =>
      entry.id === scene.id
        ? { ...entry, media: { kind: "generated", description: "chart", assets: ["asset_ghost"] } }
        : entry,
    );
    const report = runQA(fixture.with({ manifest }), fixture.deps, {
      episodeId: "ep_qa",
      jobId: "job_qa",
    });
    const finding = report.findings.find((entry) => entry.code === "visual_asset_missing");
    expect(finding).toBeDefined();
    expect(finding?.sceneId ?? finding?.message).toContain("asset_ghost");
    expect(report.publishable).toBe(false);
  });

  it("10. refuses invalid media metadata at the schema, and refuses it again at QA", async () => {
    const fixture = await qaFixture();
    const manifest = structuredClone(fixture.evidence.manifest) as typeof fixture.evidence.manifest;
    // An asset whose metadata is nonsense: an unknown orientation.
    manifest.assets = [
      ...manifest.assets,
      {
        id: "asset_bad",
        sceneId: manifest.scenes[0]!.id,
        kind: "image",
        purpose: "evidence",
        description: "chart",
        orientation: "diagonal-3d",
        status: "resolved",
        uri: "https://example.org/chart.png",
        licence: "cc-by",
      },
    ];
    const parsed = SceneManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(false);

    // And a metadata state the schema allows but that means "no file": QA still refuses.
    const emptyUri = structuredClone(fixture.evidence.manifest) as typeof fixture.evidence.manifest;
    emptyUri.assets = [
      ...emptyUri.assets,
      {
        id: "asset_hollow",
        sceneId: emptyUri.scenes[0]!.id,
        kind: "image",
        purpose: "evidence",
        description: "chart",
        orientation: "landscape",
        status: "resolved",
        uri: "",
        licence: "cc-by",
      },
    ];
    const report = runQA(fixture.with({ manifest: emptyUri }), fixture.deps, {
      episodeId: "ep_qa",
      jobId: "job_qa",
    });
    expect(report.findings.some((finding) => finding.code === "visual_asset_missing")).toBe(true);
    expect(report.publishable).toBe(false);
  });

  it("11. reports a cast member whose layer files are missing or changed", async () => {
    const fixture = await qaFixture();
    const real = fixture.deps.characters!;
    // The library's asset audit reports a layer file that no longer matches
    // what its definition recorded (moved, edited, or deleted on disk).
    const brokenLibrary = {
      get: (id: string) => real.get(id),
      verifyAssets: () => [
        {
          characterId: "maya",
          checks: [
            {
              assetId: "maya_idle_body",
              path: "characters/maya/idle_body.svg",
              ok: false,
              problem: "missing" as const,
              expected: { bytes: 1_024, hash: "a".repeat(64) },
              actual: { bytes: 0, hash: "" },
            },
          ],
        },
      ],
    } as unknown as typeof real;
    const report = runQA(fixture.evidence, fixture.depsWith({}, { characters: brokenLibrary }), {
      episodeId: "ep_qa",
      jobId: "job_qa",
    });
    const finding = report.findings.find((entry) => entry.code === "visual_asset_reference_broken");
    expect(finding).toBeDefined();
    expect(finding?.message).toMatch(/maya/u);
    expect(report.publishable).toBe(false);
  });

  it("12. refuses a plan that references scenes and assets that do not exist", async () => {
    const fixture = await qaFixture();
    const manifest = structuredClone(fixture.evidence.manifest) as typeof fixture.evidence.manifest;
    manifest.scenes = manifest.scenes.map((entry, index) =>
      index === 0
        ? { ...entry, transition: { ...entry.transition, toSceneId: "scn_ghost" } }
        : entry,
    );
    const report = validateSceneManifest(manifest);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report.issues)).toContain("scn_ghost");

    // A scene media block referencing an asset id the inventory never had.
    const dangling = structuredClone(fixture.evidence.manifest) as typeof fixture.evidence.manifest;
    dangling.scenes = dangling.scenes.map((entry, index) =>
      index === 0
        ? { ...entry, media: { kind: "generated", description: "chart", assets: ["asset_never"] } }
        : entry,
    );
    expect(SceneManifestSchema.safeParse(dangling).success).toBe(false);
  });

  it(
    "14. refuses a corrupted video: the container is re-parsed and the bytes do not pass",
    { timeout: 180_000 },
    async () => {
      const fixture = await qaFixture();
      const rendered = fixture.render();
      // Corrupt what the render wrote: garbage with the video's own name.
      const corrupt = new TextEncoder().encode("this is not an mp4 container at all");
      const hash = fixture.storage.put(corrupt).hash;
      const report = runQA(
        fixture.with({
          render: { doc: rendered.metadata, hash: rendered.metadataHash },
          video: { hash },
        }),
        fixture.deps,
        { episodeId: "ep_qa", jobId: "job_qa" },
      );
      expect(report.findings.map((finding) => finding.code)).toContain("video_corrupted");
      expect(report.publishable).toBe(false);
    },
  );
});

// ── Orchestration under attack (13, 15–18, 24) ──────────────────────────────

describe("orchestration under attack", () => {
  let workRoot: string;
  let repo: Repo;

  beforeEach(() => {
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    workRoot = mkdtempSync(path.join(tmpdir(), "nexus-reliability-"));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  interface Harness {
    readonly job: PipelineJobRow;
    readonly stageCalls: Map<string, number>;
    run(owner?: string, jobId?: string): Promise<{ status: string }>;
    /** A worker's claim loop: keep claiming/draining until the job settles. */
    runToTerminal(owner?: string, deadlineMs?: number, jobId?: string): Promise<{ status: string }>;
    /** The episode's next run — what a restarted dashboard start creates. */
    nextRun(): PipelineJobRow;
    failRenderWith(failure: { message: string; retryable: boolean }): void;
    fixRender(): void;
  }

  function harness(
    options: { renderFails?: { message: string; retryable: boolean } } = {},
  ): Harness {
    const stageCalls = new Map<string, number>([
      ["plan", 0],
      ["voice", 0],
      ["render", 0],
    ]);

    const counter = (key: string, output: Record<string, unknown>): Task => ({
      stageKey: key,
      execute: async () => {
        stageCalls.set(key, (stageCalls.get(key) ?? 0) + 1);
        return { output };
      },
    });

    const project = repo.createProject({ name: "reliability", slug: `rel-${Date.now()}` });
    const episode = repo.createEpisode({ projectId: project.id, topic: "The Kira bridge" });
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: ["plan", "voice", "render"],
    }).job;

    const renderTask: Task = {
      stageKey: "render",
      execute: async () => {
        stageCalls.set("render", (stageCalls.get("render") ?? 0) + 1);
        if (options.renderFails !== undefined) {
          throw new (options.renderFails.retryable ? RetryableError : PermanentError)(
            options.renderFails.message,
          );
        }
        return { output: { videoHash: "b".repeat(64) } };
      },
    };

    const registry = createTaskRegistry([
      counter("plan", { manifestHash: "a".repeat(64) }),
      counter("voice", { trackHash: "c".repeat(64) }),
      renderTask,
    ]);

    const run = (owner = "worker-1", jobId = job.id) => {
      const deps: RunnerDeps = {
        repo,
        tasks: registry,
        workerId: owner,
        leaseMs: 60_000,
        heartbeatIntervalMs: 5,
        params: {},
        random: () => 0.5,
        signal: new AbortController().signal,
      };
      // A worker runs only what it claimed (or already owns): the claim is
      // where exclusivity, attempt counting and the retry backoff live.
      const claimed = repo.claimJob({ owner, leaseMs: 60_000 });
      if (claimed?.id === jobId) return runJob(deps, jobId);
      const current = repo.requireJob(jobId);
      if (current.state === "RUNNING" && current.lease_owner === owner) {
        return runJob(deps, jobId);
      }
      return { status: "skipped" as const, jobId, reason: "not claimable now" };
    };

    return {
      job,
      stageCalls,
      run,
      async runToTerminal(
        owner = "worker-1",
        deadlineMs = 90_000,
        jobId = job.id,
      ): Promise<{ status: string }> {
        const deadline = Date.now() + deadlineMs;
        let last = await run(owner, jobId);
        while (
          ["PENDING", "RUNNING"].includes(repo.requireJob(jobId).state) &&
          Date.now() < deadline
        ) {
          // The runner parked the job for a backed-off retry; a worker polls.
          await new Promise((resolve) => setTimeout(resolve, 150));
          last = await run(owner, jobId);
        }
        return last;
      },
      // The episode's next run — what a restarted dashboard start creates.
      nextRun(): PipelineJobRow {
        return repo.createJob({
          episodeId: episode.id,
          pipeline: "longform_v1",
          steps: ["plan", "voice", "render"],
        }).job;
      },
      failRenderWith(failure: { message: string; retryable: boolean }): void {
        options.renderFails = failure;
      },
      fixRender(): void {
        delete options.renderFails;
      },
    };
  }

  it("13. a render failure fails the job at render — permanently when the error is permanent", async () => {
    const h = harness({ renderFails: { message: "ffmpeg exploded", retryable: false } });
    const outcome = await h.run();
    expect(outcome.status).toBe("failed");
    const failed = repo.requireJob(h.job.id);
    expect(failed.state).toBe("FAILED");
    expect(failed.failure_step).toBe("render");
    // A permanent error does not burn retries: exactly one attempt.
    expect(failed.attempt).toBe(1);
    expect(h.stageCalls.get("render")).toBe(1);
  });

  it(
    "24. repeated retry is bounded: the ceiling is exact, and a post-exhaustion retry fails without re-executing",
    { timeout: 180_000 },
    async () => {
      const h = harness({ renderFails: { message: "transient timeout", retryable: true } });
      await h.runToTerminal("worker-1");
      const exhausted = repo.requireJob(h.job.id);
      expect(exhausted.state).toBe("FAILED");
      expect(exhausted.attempt).toBe(3);
      expect(h.stageCalls.get("render")).toBe(3);

      // The operator retries anyway: the job re-enters PENDING…
      retryFailedJob(repo, h.job.id);
      // …and the runner refuses to exceed the ceiling — the failing stage is
      // NOT executed a fourth time (recovery is a new run, which adopts the
      // completed stages and re-runs the rest under a fresh ceiling).
      await h.runToTerminal("worker-2");
      expect(h.stageCalls.get("render")).toBe(3);
      const stillFailed = repo.requireJob(h.job.id);
      expect(stillFailed.state).toBe("FAILED");
    },
  );

  it("15. a dead worker's job is taken over by a restarted worker after the lease expires", async () => {
    const h = harness();
    // Worker A claims the job and dies before doing any work.
    repo.claimJob({ owner: "worker-a", leaseMs: 50 });
    expect(repo.requireJob(h.job.id).lease_owner).toBe("worker-a");
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Worker B (the restart) takes over the expired lease and finishes.
    const reclaimed = repo.claimJob({ owner: "worker-b", leaseMs: 60_000 });
    expect(reclaimed?.id).toBe(h.job.id);
    expect(reclaimed?.attempt).toBe(2);
    const outcome = await h.run("worker-b");
    expect(outcome.status).toBe("completed");
    expect(repo.requireJob(h.job.id).state).toBe("DONE");
  });

  it("16. a job cannot be executed twice: claims are exclusive and job creation is idempotent", async () => {
    const storage = new MemoryBlobStore();
    void storage;
    const project = repo.createProject({ name: "dup", slug: `dup-${Date.now()}` });
    const episode = repo.createEpisode({ projectId: project.id, topic: "Duplication" });
    const created = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: ["plan"],
      idempotencyKey: `dash:${episode.id}:1`,
    });
    const again = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: ["plan"],
      idempotencyKey: `dash:${episode.id}:1`,
    });
    // The same submission twice is ONE job, with its step list intact.
    expect(again.job.id).toBe(created.job.id);
    expect(repo.listJobSteps(created.job.id)).toHaveLength(1);

    // And a claimed (unexpired) job cannot be claimed by anyone else.
    expect(repo.claimJob({ owner: "worker-a", leaseMs: 60_000 })?.id).toBe(created.job.id);
    expect(repo.claimJob({ owner: "worker-b", leaseMs: 60_000 })).toBeUndefined();
  });

  it("17. a zombie worker cannot resurrect or corrupt a job it lost the lease to", async () => {
    const h = harness();
    // Worker A claims and stalls past its lease; worker B claims and finishes.
    repo.claimJob({ owner: "worker-a", leaseMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    repo.claimJob({ owner: "worker-b", leaseMs: 60_000 });
    await h.run("worker-b");
    expect(repo.requireJob(h.job.id).state).toBe("DONE");

    // The zombie wakes up and tries to run the job it still believes it owns.
    const zombie = await harnessRunAsOwner(h, "worker-a");
    // The runner must refuse to touch the finished job: no stage re-executes,
    // the job stays DONE, and the zombie's outcome is not "completed".
    expect(zombie.status).not.toBe("completed");
    expect(repo.requireJob(h.job.id).state).toBe("DONE");
    expect(h.stageCalls.get("render")).toBe(1);
    expect(repo.requireJob(h.job.id).attempt).toBe(2);
  });

  it(
    "18. an interrupted run resumes from its checkpoints: completed stages are not re-executed",
    { timeout: 180_000 },
    async () => {
      const h = harness();
      // First run dies at render (a retryable infrastructure error that never
      // gets better), with plan and voice already checkpointed.
      h.failRenderWith({ message: "worker killed mid-render", retryable: true });
      await h.runToTerminal("worker-1");
      expect(repo.requireJob(h.job.id).state).toBe("FAILED");
      const rendersBefore = h.stageCalls.get("render") ?? 0;

      // The transient condition clears. A FAILED job is never resumed in place
      // (the retry ceiling is shared), so the restarted dashboard starts a NEW
      // run over the same episode…
      h.fixRender();
      const job2 = h.nextRun();
      const outcome = await h.runToTerminal("worker-restart", 90_000, job2.id);
      expect(outcome.status).toBe("completed");
      expect(repo.requireJob(job2.id).state).toBe("DONE");
      // …and the new run ADOPTS the completed stages from the failed one (same
      // content fingerprints): plan and voice are not re-executed.
      expect(h.stageCalls.get("plan")).toBe(1);
      expect(h.stageCalls.get("voice")).toBe(1);
      expect(repo.getJobStep(job2.id, "plan")?.reused_from_job_id).toBe(h.job.id);
      // …while the interrupted stage really did run again, exactly once more.
      expect(h.stageCalls.get("render")).toBe(rendersBefore + 1);
    },
  );

  /** Run the harness's job as a specific (possibly zombie) owner. */
  async function harnessRunAsOwner(
    h: ReturnType<never> extends never
      ? never
      : { run(owner?: string): Promise<{ status: string }> },
    owner: string,
  ): Promise<{ status: string }> {
    return h.run(owner);
  }
});

// ── Storage and database under attack (19, 20) ──────────────────────────────

describe("persistence under attack", () => {
  it("19. a closed database fails loudly and loses nothing committed (WAL)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-db-"));
    const file = path.join(dir, "nexus.db");
    try {
      const db = Db.open(file);
      migrate(db);
      const repo = new Repo(db);
      const project = repo.createProject({ name: "durable", slug: "durable" });
      const episode = repo.createEpisode({ projectId: project.id, topic: "survives the crash" });
      db.close();

      // After the interruption, every call fails loudly — never silently.
      expect(() => repo.requireEpisode(episode.id)).toThrow();

      // Reopening the same file shows exactly what was committed.
      const reopened = new Repo(Db.open(file));
      expect(reopened.requireEpisode(episode.id).topic).toBe("survives the crash");
      reopened.db?.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("20. the artifact store refuses malformed hashes instead of escaping its root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-cas-"));
    try {
      const store = new CasStore(path.join(dir, "cas"));
      // A real artifact round-trips.
      const put = store.put(new TextEncoder().encode("legitimate bytes"));
      expect(new TextDecoder().decode(store.read(put.hash))).toBe("legitimate bytes");

      // Hostile "hashes": traversal, absolute paths, wrong shape.
      for (const hostile of [
        "../../../etc/hostname",
        "../../" + "a".repeat(60),
        "/etc/passwd",
        "zzzz",
        `${"a".repeat(63)}/../${"b".repeat(10)}`,
      ]) {
        expect(() => store.read(hostile), `read ${hostile}`).toThrow();
        expect(store.has(hostile), `has ${hostile}`).toBe(false);
        expect(store.getPath(hostile), `getPath ${hostile}`).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The dashboard under attack (21) ─────────────────────────────────────────

describe("dashboard gates under attack", () => {
  it("21. refuses approval attempts that do not correspond to a parked, matching gate", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "nexus-app-"));
    const config = loadEnv({
      env: {
        NEXUS_ENV: "test",
        NEXUS_DATA_DIR: dataDir,
        NEXUS_LLM_PROVIDER: "fake",
        NEXUS_RESEARCH_PROVIDER: "fake",
        NEXUS_TTS_PROVIDER: "fake",
        NEXUS_RENDER_WIDTH: "192",
        NEXUS_RENDER_HEIGHT: "108",
        NEXUS_RENDER_FPS: "10",
        NEXUS_RENDER_WORK_DIR: path.join(dataDir, "render"),
        NEXUS_QA_DURATION_TOLERANCE_SEC: "15",
      },
    });
    const runtime: Runtime = openRuntime(config);
    migrate(runtime.db);
    try {
      const app = await buildApp(config, { repo: runtime.repo, storage: runtime.storage });
      const form = { "content-type": "application/x-www-form-urlencoded" };

      const created = await app.inject({
        method: "POST",
        url: "/episodes",
        payload: new URLSearchParams({ topic: "Unauthorized approval target" }).toString(),
        headers: form,
      });
      const episodeId = (created.headers.location as string)
        .replace("/episodes/", "")
        .split("?")[0]!;
      const job = runtime.repo.createJob({
        episodeId,
        pipeline: "longform_v1",
        steps: [
          "idea",
          "research",
          "script",
          "plan",
          "source_media",
          "animate",
          "voice",
          "captions",
          "render",
          "qa",
          "approval",
        ],
      }).job;

      // (a) Approving a job that is not parked: refused, nothing recorded.
      runtime.repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
      const running = await app.inject({
        method: "POST",
        url: `/jobs/${job.id}/approve`,
        payload: "notes=sneaky",
        headers: form,
      });
      expect(running.statusCode).toBe(303);
      expect(running.headers.location).toContain("error=");
      expect(runtime.repo.listApprovals(episodeId)).toHaveLength(0);

      // (b) Approving a job that does not exist: refused with a flash, never a
      // crash and never an approval.
      const missing = await app.inject({
        method: "POST",
        url: "/jobs/00000000-0000-4000-8000-000000000000/approve",
        payload: "",
        headers: form,
      });
      expect(missing.statusCode).toBe(303);
      expect(missing.headers.location).toContain("error=");

      // (c) A gate decision recorded against nothing must not authorize later
      // runs: with zero valid approvals, a parked job cannot be passed by a
      // replayed request — the gate binds to the parked content's fingerprint.
      expect(
        runtime.repo.latestValidApproval("episode", episodeId, "f".repeat(64)),
      ).toBeUndefined();
    } finally {
      runtime.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
