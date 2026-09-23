import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv, type AppConfig } from "@nexus/config";
import { migrate, type PipelineJobRow, type Repo } from "@nexus/db";
import { createScriptedFFmpeg } from "@nexus/video";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { openRuntime, type Runtime } from "./runtime.js";
import { createPipelineWorker } from "./worker.js";

/**
 * The dashboard, end to end, with the real pipeline behind it.
 *
 * These are the acceptance tests of the phase, run the way production runs:
 * the app process (routes + forms) and the worker process (real task registry,
 * fake providers, scripted FFmpeg) share one data directory; an episode goes
 * from a typed topic to a rendered, QA-approved video through the same HTTP
 * surface a browser uses. Every required capability is exercised: create,
 * start, watch state, inspect research/sources/script/scenes/artifacts/QA,
 * approve, reject, rewind, retry a failed stage.
 */

const FORM = { "content-type": "application/x-www-form-urlencoded" };

interface Stack {
  readonly config: AppConfig;
  readonly runtime: Runtime;
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly worker: ReturnType<typeof createPipelineWorker>;
  readonly repo: Repo;
  close(): void;
}

/** One self-contained dashboard + worker pair over a temp data directory. */
async function start(env: Record<string, string> = {}): Promise<Stack> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "nexus-dash-"));
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
      // The dashboard's shipped QA default (see env-defaults.ts): the plan's
      // reading room means the spoken track legitimately runs shorter.
      NEXUS_QA_DURATION_TOLERANCE_SEC: "15",
      ...env,
    },
  });
  const runtime = openRuntime(config);
  migrate(runtime.db);
  const app = await buildApp(config, { repo: runtime.repo, storage: runtime.storage });
  const worker = createPipelineWorker(config, {
    runtime,
    ffmpeg: createScriptedFFmpeg({ width: 192, height: 108, fps: 10 }),
    pollIntervalMs: 20,
  });
  return {
    config,
    runtime,
    app,
    worker,
    repo: runtime.repo,
    close: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

async function createEpisode(s: Stack, topic: string): Promise<string> {
  const response = await s.app.inject({
    method: "POST",
    url: "/episodes",
    payload: new URLSearchParams({ topic }).toString(),
    headers: FORM,
  });
  expect(response.statusCode).toBe(303);
  const location = response.headers.location as string;
  expect(location).toMatch(/^\/episodes\/[0-9a-f-]+/u);
  return location.replace("/episodes/", "").split("?")[0]!;
}

async function startPipeline(s: Stack, episodeId: string): Promise<string> {
  const response = await s.app.inject({ method: "POST", url: `/episodes/${episodeId}/start` });
  expect(response.statusCode).toBe(303);
  const job = s.repo.listJobs(episodeId).at(-1);
  expect(job).toBeDefined();
  return job!.id;
}

/** Run the worker until the job settles at a gate or a terminal state. */
async function settle(
  s: Stack,
  jobId: string,
): Promise<{ job: PipelineJobRow; gate: string | null }> {
  for (let round = 0; round < 60; round += 1) {
    const job = s.repo.requireJob(jobId);
    if (job.state === "WAITING_GATE") return { job, gate: job.waiting_gate ?? null };
    if (["DONE", "FAILED", "CANCELED"].includes(job.state)) return { job, gate: null };
    await s.worker.worker.drain();
  }
  throw new Error("the run never settled at a gate or a terminal state");
}

async function decide(
  s: Stack,
  jobId: string,
  action: "approve" | "reject" | "changes" | "retry",
  fields: Record<string, string> = {},
): Promise<void> {
  const response = await s.app.inject({
    method: "POST",
    url: `/jobs/${jobId}/${action}`,
    payload: new URLSearchParams(fields).toString(),
    headers: FORM,
  });
  expect(response.statusCode).toBe(303);
  expect(response.headers.location as string).not.toContain("error=");
}

describe("the dashboard, end to end", () => {
  it("walks an episode from a typed topic to an approved video, through every gate", async () => {
    const s = await start({ NEXUS_PUBLISHING_PROVIDER: "fake" });
    try {
      // ── create ──
      const episodeId = await createEpisode(s, "Why the Kira bridge hums at dusk");
      expect(s.repo.requireEpisode(episodeId).state).toBe("QUEUED");

      // The home page lists it, unstarted.
      const home = await s.app.inject({ method: "GET", url: "/" });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain("Why the Kira bridge hums at dusk");
      expect(home.body).toContain("NOT STARTED");

      // Inspection pages say so honestly before the stages run.
      for (const suffix of ["research", "script", "scenes", "qa"]) {
        const missing = await s.app.inject({
          method: "GET",
          url: `/episodes/${episodeId}/${suffix}`,
        });
        expect(missing.statusCode).toBe(404);
      }

      // ── start ──
      const jobId = await startPipeline(s, episodeId);
      // Starting twice does not duplicate a run.
      const again = await s.app.inject({ method: "POST", url: `/episodes/${episodeId}/start` });
      expect(again.headers.location as string).toContain("already");

      // ── run to the approval gate, approving the fact gate on the way ──
      let { job, gate } = await settle(s, jobId);
      while (gate !== null && gate !== "FINAL_APPROVAL") {
        expect(gate).toBe("FACT_REVIEW");
        const parked = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}` });
        expect(parked.body).toContain("Decision needed: FACT_REVIEW");
        await decide(s, jobId, "approve", { notes: "the research looks sound" });
        ({ job, gate } = await settle(s, jobId));
      }
      expect(job.state).toBe("WAITING_GATE");
      expect(gate).toBe("FINAL_APPROVAL");

      // ── inspect everything the pipeline produced ──
      const episode = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}` });
      expect(episode.statusCode).toBe(200);
      expect(episode.body).toContain("RENDER_COMPLETE");
      expect(episode.body).toContain("QA_COMPLETE");

      const research = await s.app.inject({
        method: "GET",
        url: `/episodes/${episodeId}/research`,
      });
      expect(research.statusCode).toBe(200);
      expect(research.body).toContain("Research");

      const sources = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}/sources` });
      expect(sources.statusCode).toBe(200);

      const script = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}/script` });
      expect(script.statusCode).toBe(200);

      const scenes = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}/scenes` });
      expect(scenes.statusCode).toBe(200);
      expect(scenes.body).toContain("1920×1080");

      const artifacts = await s.app.inject({
        method: "GET",
        url: `/episodes/${episodeId}/artifacts`,
      });
      expect(artifacts.statusCode).toBe(200);
      expect(artifacts.body).toContain("video/mp4");

      const qa = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}/qa` });
      expect(qa.statusCode).toBe(200);
      expect(qa.body).toMatch(/verdict <strong>(pass|pass_with_warnings)<\/strong>/u);
      expect(qa.body).toContain("publishable yes");

      // ── the raw artifact endpoint serves real bytes ──
      const planStep = s.repo.getJobStep(jobId, "plan")!;
      const manifestHash = (JSON.parse(planStep.output ?? "{}") as { manifestHash: string })
        .manifestHash;
      expect(manifestHash).toMatch(/^[0-9a-f]{64}$/u);
      const raw = await s.app.inject({ method: "GET", url: `/artifacts/${manifestHash}` });
      expect(raw.statusCode).toBe(200);
      expect(JSON.parse(raw.body)).toMatchObject({ resolution: { width: 1920 } });
      const notAnArtifact = await s.app.inject({ method: "GET", url: "/artifacts/deadbeef" });
      expect(notAnArtifact.statusCode).toBe(404);

      // ── publishing refuses while a run is still open (nothing queues
      // behind an unresolved run) — the CRITICAL state/QA refusals are pinned
      // by the reject and QA-blocked tests below ──
      const premature = await s.app.inject({
        method: "POST",
        url: `/episodes/${episodeId}/publish`,
        payload: new URLSearchParams({ title: "Premature", privacyStatus: "public" }).toString(),
        headers: FORM,
      });
      expect(premature.statusCode).toBe(303);
      expect(premature.headers.location as string).toContain("error=");

      // ── approve the final gate: the job completes, the episode is READY ──
      await decide(s, jobId, "approve", { notes: "ship it" });
      // The approval step itself still needs one worker pass to finish.
      const finished = (await settle(s, jobId)).job;
      expect(finished.state).toBe("DONE");
      expect(s.repo.requireEpisode(episodeId).state).toBe("READY");
      expect(finished.failure_step).toBeNull();

      // The publish stage was never part of the run — nothing was uploaded
      // without the operator asking for it.
      expect(s.repo.listJobSteps(jobId).map((step) => step.step_key)).not.toContain("publish");

      // ── publish: an explicit second job, queued by the operator ──
      const publish = await s.app.inject({
        method: "POST",
        url: `/episodes/${episodeId}/publish`,
        payload: new URLSearchParams({
          title: "Why the Kira bridge hums at dusk",
          description: "A resonance, explained.",
          privacyStatus: "unlisted",
          tags: "bridges, acoustics",
        }).toString(),
        headers: FORM,
      });
      expect(publish.statusCode).toBe(303);
      expect(publish.headers.location as string).not.toContain("error=");
      const publishJob = s.repo.listJobs(episodeId).at(-1)!;
      expect(publishJob.id).not.toBe(jobId);
      expect(s.repo.listJobSteps(publishJob.id).map((step) => step.step_key)).toEqual(["publish"]);

      // The worker runs it: the publish task re-checks the QA state itself,
      // then uploads through the fake publisher.
      const published = (await settle(s, publishJob.id)).job;
      expect(published.state).toBe("DONE");
      expect(s.repo.requireEpisode(episodeId).state).toBe("PUBLISHED");
      const publishStep = s.repo.getJobStep(publishJob.id, "publish")!;
      expect(publishStep.state).toBe("DONE");
      const output = JSON.parse(publishStep.output ?? "{}") as {
        refId: string;
        url: string;
        mode: string;
        recordHash: string;
      };
      expect(output.mode).toBe("api");
      expect(output.url).toContain("https://");
      const page = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}` });
      expect(page.body).toContain("Published");
      expect(page.body).toContain(output.url);

      // Publishing again does not upload twice: the route says so and no job
      // is created.
      const jobsAfterPublish = s.repo.listJobs(episodeId).length;
      const republish = await s.app.inject({
        method: "POST",
        url: `/episodes/${episodeId}/publish`,
        payload: new URLSearchParams({ title: "Why the Kira bridge hums at dusk" }).toString(),
        headers: FORM,
      });
      expect(republish.headers.location as string).toContain("already+published");
      expect(s.repo.listJobs(episodeId).length).toBe(jobsAfterPublish);
    } finally {
      s.close();
    }
  }, 900_000);

  it("rejects a parked episode: the job cancels and the episode needs changes", async () => {
    const s = await start();
    try {
      const episodeId = await createEpisode(s, "Rejected: inland ferry subsidies");
      const jobId = await startPipeline(s, episodeId);
      const parked = await settle(s, jobId);
      expect(parked.gate).not.toBeNull();

      await decide(s, jobId, "reject");
      expect(s.repo.requireJob(jobId).state).toBe("CANCELED");
      expect(s.repo.requireEpisode(episodeId).state).toBe("NEEDS_CHANGES");

      const page = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}` });
      expect(page.body).toContain("NEEDS_CHANGES");
      expect(page.body).toContain("Start a new run");

      // A rejected episode must not be publishable.
      const jobsBefore = s.repo.listJobs(episodeId).length;
      const refused = await s.app.inject({
        method: "POST",
        url: `/episodes/${episodeId}/publish`,
        payload: new URLSearchParams({ title: "Should not work" }).toString(),
        headers: FORM,
      });
      expect(refused.headers.location as string).toContain("error=");
      expect(s.repo.listJobs(episodeId).length).toBe(jobsBefore);
    } finally {
      s.close();
    }
  }, 900_000);

  it("rewinds a parked run to a chosen stage and re-executes from there", async () => {
    const s = await start();
    try {
      const episodeId = await createEpisode(s, "Rewound: night market economics");
      const jobId = await startPipeline(s, episodeId);
      const parked = await settle(s, jobId);
      expect(parked.gate).not.toBeNull();

      await decide(s, jobId, "changes", { targetStage: "research", notes: "find a second source" });
      expect(s.repo.requireJob(jobId).state).toBe("PENDING");

      const after = await settle(s, jobId);
      expect(after.job.state).toBe("WAITING_GATE");
      expect(after.gate).toBe(parked.gate);
      // Stages before the rewind point kept their work.
      const doneAfter = s.repo
        .listJobSteps(jobId)
        .filter((step) => step.state === "DONE")
        .map((step) => step.step_key);
      expect(doneAfter).toContain("idea");
    } finally {
      s.close();
    }
  }, 900_000);

  it("retries an eligible failed stage: a QA-blocked run is FAILED, retry re-enters at QA", async () => {
    // Strict type rules make QA block the fake episode deterministically.
    const s = await start({ NEXUS_QA_MIN_FONT_PX: "140" });
    try {
      const episodeId = await createEpisode(s, "Blocked: too-small type everywhere");
      const jobId = await startPipeline(s, episodeId);
      let { job, gate } = await settle(s, jobId);
      while (gate !== null) {
        await decide(s, jobId, "approve");
        ({ job, gate } = await settle(s, jobId));
      }
      // QA refused the episode, and that refusal failed the run.
      expect(job.state).toBe("FAILED");
      expect(job.error_kind).toBe("permanent");
      expect(job.failure_step).toBe("qa");

      const page = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}` });
      expect(page.body).toContain("Run failed");
      const qa = await s.app.inject({ method: "GET", url: `/episodes/${episodeId}/qa` });
      expect(qa.body).toContain("publishable NO");
      expect(qa.body).toContain("visual_text_unreadable");

      // Retry: the run re-enters at the failed stage and fails the same way
      // (the underlying defect is unchanged), on a new attempt.
      await decide(s, jobId, "retry");
      expect(s.repo.requireJob(jobId).state).toBe("PENDING");
      const again = await settle(s, jobId);
      expect(again.job.state).toBe("FAILED");
      expect(again.job.attempt).toBeGreaterThan(job.attempt);
      expect(again.job.failure_step).toBe("qa");

      // CRITICAL: a QA-blocked episode must not be publishable — the route
      // refuses before any job is created.
      const jobsBefore = s.repo.listJobs(episodeId).length;
      const blocked = await s.app.inject({
        method: "POST",
        url: `/episodes/${episodeId}/publish`,
        payload: new URLSearchParams({ title: "Should never upload" }).toString(),
        headers: FORM,
      });
      expect(blocked.statusCode).toBe(303);
      expect(blocked.headers.location as string).toContain("error=");
      expect(blocked.headers.location as string).toMatch(/failed QA|approved/u);
      expect(s.repo.listJobs(episodeId).length).toBe(jobsBefore);
    } finally {
      s.close();
    }
  }, 900_000);

  it("creates projects, refuses an empty topic, and answers health checks", async () => {
    const s = await start();
    try {
      const project = await s.app.inject({
        method: "POST",
        url: "/projects",
        payload: new URLSearchParams({ name: "Kira Docs", slug: "kira-docs" }).toString(),
        headers: FORM,
      });
      expect(project.statusCode).toBe(303);
      expect(s.repo.listProjects().map((entry) => entry.slug)).toContain("kira-docs");

      const bad = await s.app.inject({
        method: "POST",
        url: "/episodes",
        payload: new URLSearchParams({ topic: "   " }).toString(),
        headers: FORM,
      });
      expect(bad.statusCode).toBe(303);
      expect(bad.headers.location as string).toContain("error=");

      const health = await s.app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "ok", service: "nexus" });
    } finally {
      s.close();
    }
  });
});
