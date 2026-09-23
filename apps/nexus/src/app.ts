import type { AppConfig } from "@nexus/config";
import { NotFoundError, Repo, ValidationError } from "@nexus/db";
import type { ArtifactRow, EpisodeRow } from "@nexus/db";
import { getJobStatus, resolveGate, retryFailedJob, type JobStatusView } from "@nexus/jobs";
import { loadQAReport } from "@nexus/qa";
import { loadResearchPackage } from "@nexus/research";
import { loadSceneManifest } from "@nexus/scenes";
import { loadScriptDoc } from "@nexus/script";
import type { BlobStore } from "@nexus/storage";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import {
  DASHBOARD_PIPELINE,
  DASHBOARD_STEPS,
  PUBLISH_RECORD_ROLE,
  type PublishRequest,
} from "./pipeline.js";
import { SHORTS_DASHBOARD_PIPELINE, SHORTS_DASHBOARD_STEPS } from "./shorts-pipeline.js";
import {
  artifactsPage,
  episodePage,
  errorPage,
  homePage,
  qaPage,
  researchPage,
  scenesPage,
  scriptPage,
  sourcesPage,
  type ArtifactRowView,
  contentTypeOf,
} from "./views.js";

/** Kept in sync with apps/nexus/package.json version by hand for now (0.0.0 = foundation phase). */
export const SERVICE_VERSION = "0.0.0";

export interface BuildAppOptions {
  /** Fastify logger options; disabled by default so tests stay quiet. */
  readonly logger?: FastifyServerOptions["logger"];
}

/**
 * What the routes need. The composition root opens the durable things once
 * (runtime.ts); the app never opens a socket to reach them.
 */
export interface AppDeps {
  readonly repo: Repo;
  readonly storage: BlobStore;
  /** Injected clock (tests fix time); the machine clock by default. */
  readonly now?: () => Date;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "nexus";
  readonly role: "app";
  readonly env: AppConfig["env"];
  readonly version: string;
  readonly episodes: number;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const FORM = "application/x-www-form-urlencoded";

function form(body: unknown): URLSearchParams {
  return body instanceof URLSearchParams ? body : new URLSearchParams();
}

function field(body: unknown, name: string): string {
  return form(body).get(name)?.trim() ?? "";
}

/** The step outputs of an episode's latest job, keyed by stage. */
function latestJob(repo: Repo, episodeId: string): JobStatusView | undefined {
  const jobs = repo.listJobs(episodeId);
  const job = jobs.at(-1);
  return job === undefined ? undefined : getJobStatus(repo, job.id, { logLimit: 60 });
}

function stepOutput(repo: Repo, jobId: string, stage: string): Record<string, unknown> {
  const step = repo.getJobStep(jobId, stage);
  if (step === undefined || step.output === null) return {};
  try {
    const parsed: unknown = JSON.parse(step.output);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hashOf(output: Record<string, unknown>, key: string): string | null {
  const value = output[key];
  return typeof value === "string" && HEX64.test(value) ? value : null;
}

/**
 * The episode's latest successful publish — the URL and status the episode
 * page shows, read back from the publish stage's durable record.
 */
function publishedView(
  repo: Repo,
  storage: BlobStore,
  episodeId: string,
): {
  url: string | null;
  status: string;
  refId: string;
  provider: string;
  mode: string;
  jobState: string;
} | null {
  const jobs = [...repo.listJobs(episodeId)].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  );
  for (const job of jobs) {
    for (const step of repo.listJobSteps(job.id)) {
      if (step.state !== "DONE") continue;
      if (step.step_key !== "publish" && step.step_key !== "short_publish") continue;
      let artifacts: { hash: string; kind: string; role: string }[] = [];
      try {
        const parsed: unknown = JSON.parse(step.artifacts);
        if (Array.isArray(parsed)) artifacts = parsed as typeof artifacts;
      } catch {
        continue;
      }
      const recordRef = artifacts.find((entry) => entry.role === PUBLISH_RECORD_ROLE);
      if (recordRef === undefined) continue;
      try {
        const record = JSON.parse(new TextDecoder().decode(storage.read(recordRef.hash))) as {
          ref?: { id?: string; url?: string; status?: string; provider?: string; mode?: string };
        };
        if (record.ref?.id === undefined) continue;
        return {
          url: typeof record.ref.url === "string" ? record.ref.url : null,
          status: typeof record.ref.status === "string" ? record.ref.status : "?",
          refId: record.ref.id,
          provider: typeof record.ref.provider === "string" ? record.ref.provider : "?",
          mode: typeof record.ref.mode === "string" ? record.ref.mode : "?",
          jobState: job.state,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** An episode's key artifact hashes, resolved from the latest job's steps. */
function episodeHashes(
  repo: Repo,
  episodeId: string,
): {
  job: JobStatusView | undefined;
  researchPackage: string | null;
  script: string | null;
  manifest: string | null;
  qa: string | null;
  video: string | null;
  thumbnail: string | null;
} {
  const job = latestJob(repo, episodeId);
  if (job === undefined) {
    return {
      job,
      researchPackage: null,
      script: null,
      manifest: null,
      qa: null,
      video: null,
      thumbnail: null,
    };
  }
  const research = stepOutput(repo, job.id, "research");
  const script = stepOutput(repo, job.id, "script");
  const plan = stepOutput(repo, job.id, "plan");
  const media = stepOutput(repo, job.id, "source_media");
  const qa = stepOutput(repo, job.id, "qa");
  const videoArtifact = job.steps
    .find((step) => step.key === "render")
    ?.artifacts.find((artifact) => artifact.kind === "video");
  const thumbnailArtifact = job.steps
    .find((step) => step.key === "render")
    ?.artifacts.find((artifact) => artifact.kind === "thumbnail");
  // A blocked QA run fails the step, so its output is empty — but the report
  // itself is attached to the failed step as evidence. Show it.
  const qaReportArtifact = job.steps
    .find((step) => step.key === "qa")
    ?.artifacts.find((artifact) => artifact.kind === "qa_report");
  return {
    job,
    researchPackage: hashOf(research, "packageHash"),
    script: hashOf(script, "docHash"),
    manifest: hashOf(media, "manifestHash") ?? hashOf(plan, "manifestHash"),
    qa: hashOf(qa, "reportHash") ?? qaReportArtifact?.hash ?? null,
    video: videoArtifact?.hash ?? null,
    thumbnail: thumbnailArtifact?.hash ?? null,
  };
}

/**
 * Build the dashboard application (routes only — no listening).
 *
 * Server-rendered HTML over the orchestration read models: the dashboard is a
 * thin, reliable surface on the DB and the CAS — no client framework, no
 * client-side fetching, every action a form POST that redirects. The pipeline
 * itself runs in the worker process; the app only creates jobs and records
 * gate decisions, so a slow render never blocks a page.
 */
export async function buildApp(
  config: AppConfig,
  deps: AppDeps,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  // Plain HTML forms post urlencoded bodies; Fastify's default parser only
  // knows JSON. One small parser, no plugin dependency.
  app.addContentTypeParser(FORM, { parseAs: "string" }, (_request, body, done) => {
    done(null, new URLSearchParams(String(body)));
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof NotFoundError || error.statusCode === 404) {
      void reply.status(404).type("text/html").send(errorPage(404, "That page does not exist."));
      return;
    }
    const message =
      error instanceof ValidationError || error instanceof Error
        ? error.message
        : "unexpected error";
    request.log.error({ err: message }, "request failed");
    void reply
      .status(error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500)
      .type("text/html")
      .send(errorPage(500, message.slice(0, 500)));
  });

  const redirectToEpisode = (
    reply: { redirect: (url: string, code: number) => unknown },
    episodeId: string,
    flashes: { error?: string; notice?: string },
  ): void => {
    const params = new URLSearchParams();
    if (flashes.error !== undefined && flashes.error !== "")
      params.set("error", flashes.error.slice(0, 400));
    if (flashes.notice !== undefined && flashes.notice !== "")
      params.set("notice", flashes.notice.slice(0, 300));
    const query = params.toString();
    void reply.redirect(`/episodes/${episodeId}${query === "" ? "" : `?${query}`}`, 303);
  };

  // ── health ───────────────────────────────────────────────────────────────
  app.get("/healthz", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "nexus",
      role: "app",
      env: config.env,
      version: SERVICE_VERSION,
      episodes: deps.repo.listEpisodes().length,
    };
  });

  // ── home ─────────────────────────────────────────────────────────────────
  app.get("/", async (request, reply) => {
    const query = request.query as { error?: string; notice?: string };
    const episodes = [...deps.repo.listEpisodes()].reverse();
    void reply.type("text/html").send(
      homePage({
        projects: deps.repo
          .listProjects()
          .map((project) => ({ id: project.id, name: project.name, slug: project.slug })),
        episodes: episodes.map((episode) => {
          const jobs = deps.repo.listJobs(episode.id);
          const job = jobs.at(-1);
          return {
            episode,
            job: job === undefined ? undefined : getJobStatus(deps.repo, job.id, { logLimit: 0 }),
          };
        }),
        flashes: { error: query.error, notice: query.notice },
      }),
    );
  });

  // ── create project / episode ─────────────────────────────────────────────
  app.post("/projects", async (request, reply) => {
    try {
      const name = field(request.body, "name");
      const slug = field(request.body, "slug");
      const project = deps.repo.createProject({
        name,
        slug,
        description: "created from the dashboard",
      });
      void reply.redirect(`/?notice=project+${encodeURIComponent(project.name)}+created`, 303);
    } catch (error) {
      void reply.redirect(`/?error=${encodeURIComponent(errorMessage(error))}`, 303);
    }
  });

  app.post("/episodes", async (request, reply) => {
    try {
      const topic = field(request.body, "topic");
      const outline = field(request.body, "outline")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const projectId = field(request.body, "projectId");

      let project = projectId === "" ? undefined : deps.repo.getProject(projectId);
      if (project === undefined) {
        // First run: one project is provisioned automatically; every later
        // episode can join it (or a new one via the Projects form).
        const existing = deps.repo.listProjects()[0];
        project = existing ?? deps.repo.createProject({ name: "My channel", slug: "my-channel" });
      }
      const episode = deps.repo.createEpisode({
        projectId: project.id,
        topic,
        ...(outline.length > 0 ? { outline } : {}),
        kind: "long",
      });
      void reply.redirect(`/episodes/${episode.id}?notice=episode+created`, 303);
    } catch (error) {
      void reply.redirect(`/?error=${encodeURIComponent(errorMessage(error))}`, 303);
    }
  });

  // ── start the pipeline ───────────────────────────────────────────────────
  app.post("/episodes/:id/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const episode = deps.repo.requireEpisode(id);
      const existing = deps.repo.listJobs(episode.id);
      const active = existing.find((job) =>
        ["PENDING", "RUNNING", "WAITING_GATE"].includes(job.state),
      );
      if (active !== undefined) {
        redirectToEpisode(reply, id, {
          error: `a run is already ${active.state.toLowerCase()} — resolve it first`,
        });
        return;
      }
      // A short episode runs the shorts graph (transcript → candidates →
      // script → 9:16 layout → render → QA → SHORT_APPROVAL); a long episode
      // runs the dashboard long-form graph. Publishing is in neither.
      const pipeline = episode.kind === "short" ? SHORTS_DASHBOARD_PIPELINE : DASHBOARD_PIPELINE;
      const steps = episode.kind === "short" ? SHORTS_DASHBOARD_STEPS : DASHBOARD_STEPS;
      const job = deps.repo.createJob({
        episodeId: episode.id,
        pipeline: pipeline.id,
        steps,
        // One key per run: a re-run of a canceled episode is a *new* job, and
        // stage fingerprints (not this key) are what make its stages reusable.
        idempotencyKey: `dash:${episode.id}:${existing.length + 1}`,
        maxAttempts: 3,
      });
      void redirectToEpisode(reply, id, {
        notice: `${pipeline.label} started (job ${job.job.id.slice(0, 8)}…) — the worker picks it up within a second`,
      });
    } catch (error) {
      void redirectToEpisode(reply, id, { error: errorMessage(error) });
    }
  });

  // ── create a short from a finished long-form episode ────────────────────
  app.post("/episodes/:id/shorts", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const parent = deps.repo.requireEpisode(id);
      if (parent.kind !== "long") {
        redirectToEpisode(reply, id, { error: "only a long-form episode can be cut into shorts" });
        return;
      }
      if (parent.state !== "READY") {
        redirectToEpisode(reply, id, {
          error:
            "cutting a short requires the finished, approved episode — this one is " + parent.state,
        });
        return;
      }
      const child = deps.repo.createEpisode({
        projectId: parent.project_id,
        topic: `${parent.topic} — vertical short`,
        kind: "short",
        parentEpisodeId: parent.id,
      });
      void reply.redirect(
        `/episodes/${child.id}?notice=${encodeURIComponent("short episode created — start it when ready")}`,
        303,
      );
    } catch (error) {
      void redirectToEpisode(reply, id, { error: errorMessage(error) });
    }
  });

  // ── publish (explicit, QA-gated, Phase 15) ──────────────────────────────
  app.post("/episodes/:id/publish", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const episode = deps.repo.requireEpisode(id);
      const title = field(request.body, "title").slice(0, 100);
      const description = field(request.body, "description").slice(0, 5000);
      const privacyRaw = field(request.body, "privacyStatus");
      const privacyStatus =
        privacyRaw === "unlisted" || privacyRaw === "public" ? privacyRaw : "private";
      const scheduledAt = field(request.body, "scheduledAt");
      const tags = field(request.body, "tags")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");

      // The same guards the publish task enforces, here for fast feedback —
      // the task re-checks everything from durable state before any bytes move.
      const active = deps.repo
        .listJobs(id)
        .find((job) => ["PENDING", "RUNNING", "WAITING_GATE"].includes(job.state));
      if (active !== undefined) {
        redirectToEpisode(reply, id, {
          error: `a run is already ${active.state.toLowerCase()} — resolve it first`,
        });
        return;
      }
      // A second press after a successful publish is a no-op, not a duplicate
      // (checked before the state guard: PUBLISHED is the *good* outcome).
      const existing = publishedView(deps.repo, deps.storage, id);
      if (existing !== null) {
        redirectToEpisode(reply, id, {
          notice:
            `already published (${existing.url ?? existing.refId}) — the record stands; ` +
            "nothing was uploaded again",
        });
        return;
      }
      if (episode.state !== "READY") {
        redirectToEpisode(reply, id, {
          error:
            "publishing requires an approved episode — this one is " +
            `${episode.state} (failed or rejected runs are not publishable)`,
        });
        return;
      }
      const hashes = episodeHashes(deps.repo, id);
      if (hashes.qa === null) {
        redirectToEpisode(reply, id, {
          error: "publishing requires an approved QA state — no QA report exists yet",
        });
        return;
      }
      const report = loadQAReport(deps.storage, hashes.qa);
      if (report.verdict === "fail" || !report.publishable) {
        redirectToEpisode(reply, id, {
          error: `the episode failed QA (verdict ${report.verdict}) — it must not be published`,
        });
        return;
      }
      const approved = deps.repo
        .listApprovals(id)
        .find(
          (approval) =>
            approval.decision === "approved" &&
            (approval.gate === "FINAL_APPROVAL" || approval.gate === "SHORT_APPROVAL"),
        );
      if (approved === undefined) {
        redirectToEpisode(reply, id, {
          error:
            "publishing requires the operator's approval — approve the episode's final gate first",
        });
        return;
      }
      if (hashes.video === null) {
        redirectToEpisode(reply, id, {
          error: "nothing to publish — the render stage has not produced a video",
        });
        return;
      }
      if (title === "") {
        redirectToEpisode(reply, id, { error: "a publish title is required" });
        return;
      }

      // The operator's choices travel content-addressed: the request is an
      // artifact, and its hash rides the job's idempotency key — the publish
      // task reads it back from durable state (never from a request body).
      const publishRequest: PublishRequest = {
        version: 1,
        episodeId: id,
        title,
        description: description !== "" ? description : episode.topic.trim(),
        privacyStatus,
        ...(scheduledAt !== "" ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        requestedBy: "dashboard",
        requestedAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
      if (
        publishRequest.scheduledAt !== undefined &&
        Number.isNaN(Date.parse(publishRequest.scheduledAt))
      ) {
        redirectToEpisode(reply, id, { error: "scheduled date is not a valid date" });
        return;
      }
      const requestBytes = new TextEncoder().encode(JSON.stringify(publishRequest));
      const stored = deps.storage.put(requestBytes);
      deps.repo.registerArtifact({ hash: stored.hash, kind: "metadata", bytes: stored.bytes });

      const steps = episode.kind === "long" ? (["publish"] as const) : (["short_publish"] as const);
      const pipeline = episode.kind === "long" ? "longform_v1" : "shorts_v1";
      const jobs = deps.repo.listJobs(id);
      deps.repo.createJob({
        episodeId: id,
        pipeline,
        steps,
        idempotencyKey: `publish:${id}:${stored.hash}`,
        maxAttempts: 3,
      });
      void redirectToEpisode(reply, id, {
        notice: `publish job queued (${jobs.length + 1} jobs total) — publishing re-checks the approved QA state before uploading`,
      });
    } catch (error) {
      void redirectToEpisode(reply, id, { error: errorMessage(error) });
    }
  });

  // ── gate decisions + retry ───────────────────────────────────────────────
  app.post("/jobs/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const job = deps.repo.requireJob(id);
      const notes = field(request.body, "notes");
      const result = resolveGate(deps.repo, id, {
        decision: "approved",
        reviewedBy: "dashboard",
        ...(notes !== "" ? { notes } : {}),
      });
      void redirectToEpisode(reply, job.episode_id, {
        notice: `${result.gate} approved — the run continues`,
      });
    } catch (error) {
      const job = deps.repo.getJob(id);
      void redirectToEpisode(reply, job?.episode_id ?? "", { error: errorMessage(error) });
    }
  });

  app.post("/jobs/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const job = deps.repo.requireJob(id);
      const notes = field(request.body, "notes");
      resolveGate(deps.repo, id, {
        decision: "rejected",
        reviewedBy: "dashboard",
        ...(notes !== "" ? { notes } : {}),
      });
      void redirectToEpisode(reply, job.episode_id, {
        notice: "episode rejected and canceled — its state is NEEDS_CHANGES",
      });
    } catch (error) {
      const job = deps.repo.getJob(id);
      void redirectToEpisode(reply, job?.episode_id ?? "", { error: errorMessage(error) });
    }
  });

  app.post("/jobs/:id/changes", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const job = deps.repo.requireJob(id);
      const targetStage = field(request.body, "targetStage");
      const notes = field(request.body, "notes");
      const result = resolveGate(deps.repo, id, {
        decision: "needs_changes",
        targetStage,
        reviewedBy: "dashboard",
        ...(notes !== "" ? { notes } : {}),
      });
      void redirectToEpisode(reply, job.episode_id, {
        notice: `rewound to ${result.invalidatedStages.length} stage(s) from ${targetStage} — the run re-executes them`,
      });
    } catch (error) {
      const job = deps.repo.getJob(id);
      void redirectToEpisode(reply, job?.episode_id ?? "", { error: errorMessage(error) });
    }
  });

  app.post("/jobs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const job = deps.repo.requireJob(id);
      retryFailedJob(deps.repo, id);
      void redirectToEpisode(reply, job.episode_id, {
        notice: "run requeued — the worker retries the failed stage (completed stages are reused)",
      });
    } catch (error) {
      const job = deps.repo.getJob(id);
      void redirectToEpisode(reply, job?.episode_id ?? "", { error: errorMessage(error) });
    }
  });

  // ── episode pages ────────────────────────────────────────────────────────
  const requireEpisode = (id: string): EpisodeRow => deps.repo.requireEpisode(id);

  const enabled = (hashes: {
    job: JobStatusView | undefined;
    researchPackage: string | null;
    script: string | null;
    manifest: string | null;
    qa: string | null;
  }): Record<string, boolean> => ({
    research: hashes.researchPackage !== null,
    sources: hashes.researchPackage !== null,
    script: hashes.script !== null,
    scenes: hashes.manifest !== null,
    artifacts:
      hashes.job !== undefined && hashes.job.steps.some((step) => step.artifacts.length > 0),
    qa: hashes.qa !== null,
  });

  app.get("/episodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const query = request.query as { error?: string; notice?: string };
    const hashes = episodeHashes(deps.repo, id);
    const qaVerdict = (() => {
      if (hashes.qa === null) return null;
      try {
        return loadQAReport(deps.storage, hashes.qa).verdict;
      } catch {
        return null;
      }
    })();
    const published = publishedView(deps.repo, deps.storage, id);
    void reply.type("text/html").send(
      episodePage({
        episode,
        job: hashes.job,
        project: deps.repo.getProject(episode.project_id),
        artifactPages: enabled(hashes),
        flashes: { error: query.error, notice: query.notice },
        qaVerdict,
        canPublish:
          episode.state === "READY" &&
          hashes.qa !== null &&
          qaVerdict !== null &&
          qaVerdict !== "fail" &&
          hashes.video !== null,
        canCreateShort: episode.kind === "long" && episode.state === "READY",
        ...(published !== null ? { published } : {}),
      }),
    );
  });

  app.get("/episodes/:id/research", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const hashes = episodeHashes(deps.repo, id);
    if (hashes.researchPackage === null) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "The research stage has not produced a package yet."));
      return;
    }
    void reply
      .type("text/html")
      .send(
        researchPage(
          episode,
          loadResearchPackage(deps.storage, hashes.researchPackage),
          enabled(hashes),
          hashes.researchPackage,
        ),
      );
  });

  app.get("/episodes/:id/sources", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const hashes = episodeHashes(deps.repo, id);
    if (hashes.researchPackage === null) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "The research stage has not produced a package yet."));
      return;
    }
    void reply
      .type("text/html")
      .send(
        sourcesPage(
          episode,
          loadResearchPackage(deps.storage, hashes.researchPackage),
          enabled(hashes),
        ),
      );
  });

  app.get("/episodes/:id/script", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const hashes = episodeHashes(deps.repo, id);
    if (hashes.script === null) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "The script stage has not produced a script yet."));
      return;
    }
    void reply
      .type("text/html")
      .send(scriptPage(episode, loadScriptDoc(deps.storage, hashes.script), enabled(hashes)));
  });

  app.get("/episodes/:id/scenes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const hashes = episodeHashes(deps.repo, id);
    if (hashes.manifest === null) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "The plan stage has not produced a scene manifest yet."));
      return;
    }
    void reply
      .type("text/html")
      .send(scenesPage(episode, loadSceneManifest(deps.storage, hashes.manifest), enabled(hashes)));
  });

  app.get("/episodes/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const hashes = episodeHashes(deps.repo, id);
    const items: ArtifactRowView[] = (hashes.job?.steps ?? []).flatMap((step) =>
      step.artifacts.map((artifact) => ({
        stage: step.key,
        role: artifact.role,
        kind: artifact.kind,
        hash: artifact.hash,
        missing: !deps.storage.has(artifact.hash),
      })),
    );
    void reply
      .type("text/html")
      .send(artifactsPage(episode, items, enabled(hashes), hashes.video, hashes.thumbnail));
  });

  app.get("/episodes/:id/qa", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = requireEpisode(id);
    const hashes = episodeHashes(deps.repo, id);
    if (hashes.qa === null) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "The QA stage has not produced a report yet."));
      return;
    }
    void reply
      .type("text/html")
      .send(qaPage(episode, loadQAReport(deps.storage, hashes.qa), enabled(hashes)));
  });

  // ── raw artifact bytes ───────────────────────────────────────────────────

  app.get("/artifacts/:hash", async (request, reply) => {
    const { hash } = request.params as { hash: string };
    if (!HEX64.test(hash)) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "Not an artifact address (expected a sha256 hash)."));
      return;
    }
    const row: ArtifactRow | undefined = deps.repo.getArtifact(hash);
    if (row === undefined || !deps.storage.has(hash)) {
      void reply
        .status(404)
        .type("text/html")
        .send(errorPage(404, "No artifact with that hash, or its bytes are gone."));
      return;
    }
    const query = request.query as { download?: string };
    const type = contentTypeOf(row.kind);
    void reply
      .type(type)
      .header(
        "content-disposition",
        query.download === "1" ? `attachment; filename="${hash.slice(0, 12)}"` : "inline",
      )
      .send(deps.storage.read(hash));
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
