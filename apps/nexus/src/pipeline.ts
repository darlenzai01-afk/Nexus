import { loadQAReport } from "@nexus/qa";
import type {
  PublishMetadata,
  PublishProvider,
  PublishRef,
  PublishStatusReport,
} from "@nexus/providers";
import { PermanentError, type Task, type TaskContext, type TaskResult } from "@nexus/jobs";
import { loadResearchPackage, type ResearchPackage } from "@nexus/research";
import {
  SCENE_MANIFEST_ARTIFACT_KIND,
  loadSceneManifest,
  persistSceneManifest,
  type SceneManifest,
} from "@nexus/scenes";
import type { BlobStore } from "@nexus/storage";
import type { AppConfig } from "@nexus/config";
import type { ArtifactKind, Repo } from "@nexus/db";

import { LONG_FORM_PIPELINE, stageKeys, type PipelineDef } from "@nexus/jobs";

/**
 * The stage tasks that belong to no single domain package.
 *
 * Every *engine* stage — research, script, plan, voice, captions, render, qa —
 * ships its own task beside its engine. The remaining stages of the long-form
 * pipeline are glue: they move documents between stages, apply the one
 * policy this app owns (what to do when no media adapter is configured), and
 * park the job when a human must decide. They live here, in the app layer,
 * because that policy *is* the app's, not an engine's.
 *
 * The `publish` stage is *not* part of the dashboard run: an approved episode
 * ends at `approval` with the episode `READY` — the honest state of "nothing
 * is published yet". Publishing is an explicit second job the operator starts
 * from the episode page (`createPublishTask`), and it re-checks the QA verdict
 * itself: nothing uploads unless the episode is in an approved QA state.
 */

/**
 * The pipeline the dashboard runs: the long-form graph minus `publish`.
 *
 * The id stays `longform_v1` — the stage graph itself is unchanged; a job
 * declares which of its stages it executes, and `publish` joins when a
 * publishing provider exists (plan-Phase 5).
 */
export const DASHBOARD_PIPELINE: PipelineDef = {
  ...LONG_FORM_PIPELINE,
  stages: LONG_FORM_PIPELINE.stages.filter((stage) => stage.key !== "publish"),
};

export const DASHBOARD_STEPS: readonly string[] = stageKeys(DASHBOARD_PIPELINE);

/**
 * Cache-affecting configuration, part of every stage fingerprint: switching a
 * provider or changing the render/QA rules invalidates the stages that ran
 * under the old ones, so a re-run rebuilds exactly what changed. Deliberately
 * excludes machine-specific paths (the FFmpeg binary's location does not make
 * the same plan a different plan).
 */
export function fingerprintParams(config: AppConfig): Record<string, unknown> {
  return {
    providers: {
      llm: config.providers.llm,
      research: config.providers.research,
      tts: config.providers.tts,
      media: config.providers.media,
    },
    plan: { fps: config.render.fps, aspect: "16:9" },
    voice: {
      voice: config.audio.voice,
      format: config.audio.format,
      sampleRate: config.audio.sampleRate,
      rate: config.audio.rate,
    },
    render: {
      width: config.render.width,
      height: config.render.height,
      fps: config.render.fps,
      captions: config.render.captions,
      segmentFrames: config.render.segmentFrames,
      crf: config.render.crf,
      preset: config.render.preset,
    },
    qa: config.qa,
  };
}

// ── The upstream-hash helper ────────────────────────────────────────────────
// (The domain tasks each carry a private copy; the app's tasks need the same
// three lines, and exporting one from @nexus/jobs would couple the runner to
// its outputs' shapes.)

function upstreamHash(ctx: TaskContext, stage: string, key: string): string | undefined {
  const output = ctx.upstream[stage];
  if (typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function namedParam(ctx: TaskContext, key: string): string | undefined {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

// ── idea ────────────────────────────────────────────────────────────────────

/**
 * Normalize the episode's brief into the pipeline's first output.
 *
 * No model call: the topic and outline are the operator's words, and the rest
 * of the pipeline reads exactly them. The stage exists so the graph has one
 * explicit "what are we making" checkpoint (and so an episode whose brief is
 * empty fails here, actionably, before any provider is spent).
 */
export function createIdeaTask(): Task {
  return {
    stageKey: "idea",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const topic = ctx.episode.topic.trim();
      if (topic === "") {
        throw new PermanentError("idea stage: the episode has no topic to research");
      }
      const outline = (ctx.inputs.job as { outline?: unknown }).outline;
      const points = Array.isArray(outline)
        ? outline.filter((point): point is string => typeof point === "string")
        : [];
      ctx.log("idea.ready", `topic: ${topic}`, { outlinePoints: points.length });
      return {
        output: {
          topic,
          outline: points,
          words: topic.split(/\s+/u).length,
        },
      };
    },
  };
}

// ── fact_check ──────────────────────────────────────────────────────────────

/**
 * The fact gate (AD-07): nothing unproven reaches the script.
 *
 * Reads the verification summary the research engine computed and parks the
 * job at `FACT_REVIEW` when the package says a human must resolve something —
 * unsupported, disputed or uncertain claims, a contested claim, or a package
 * with nothing verified at all. Approving the gate does not *change* the
 * package; it records who accepted the risk and binds that acceptance to the
 * package's fingerprint, so a re-researched package parks again.
 */
export function createFactCheckTask(deps: { readonly storage: BlobStore }): Task {
  return {
    stageKey: "fact_check",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const packageHash =
        upstreamHash(ctx, "research", "packageHash") ?? namedParam(ctx, "packageHash");
      if (packageHash === undefined) {
        throw new PermanentError(
          "fact_check stage has no research package: run the research stage first, or pass params.packageHash",
        );
      }
      let pkg: ResearchPackage;
      try {
        pkg = loadResearchPackage(deps.storage, packageHash);
      } catch (error) {
        throw new PermanentError(
          `fact_check stage cannot read the research package ${packageHash.slice(0, 12)}…: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const verification = pkg.verification;
      const summary = {
        packageHash,
        claims: pkg.claims.length,
        established: verification.established,
        contested: verification.contested,
        conflicts: pkg.conflicts.length,
        reviewRequired: verification.reviewRequired,
        blockingClaimIds: verification.blockingClaimIds,
      };
      if (verification.reviewRequired) {
        const blocking = verification.blockingClaimIds.length;
        ctx.log(
          "fact_check.review_required",
          `${blocking} claim(s) are not established; the job parks for review before scripting`,
          { blockingClaimIds: verification.blockingClaimIds },
        );
        return {
          waiting: "FACT_REVIEW",
          waitingReason:
            `${blocking} research claim(s) are not established (and ${summary.contested} contested) — ` +
            "review them on the episode's Research page, then approve or reject",
          output: summary,
          // The gated document exists (the research package); keep it attached
          // to the step so the stage's declared output is never empty.
          artifacts: [{ hash: packageHash, kind: "document", role: "fact_check_review" }],
        };
      }
      return {
        output: summary,
        artifacts: [{ hash: packageHash, kind: "document", role: "fact_check_review" }],
      };
    },

    // An adopted fact-check is only as good as the package behind it.
    validateReuse(_ctx, run) {
      const ref = run.artifacts.find((artifact) => artifact.kind === "document");
      if (ref === undefined) throw new PermanentError("fact_check step has no package artifact");
      loadResearchPackage(deps.storage, ref.hash);
    },
  };
}

// ── source_media ────────────────────────────────────────────────────────────

/**
 * Media resolution, placeholder edition.
 *
 * The plan's asset inventory arrives with `planned` assets and search hints.
 * A real media engine (licence-checked search, operator uploads — plan-Phase 3)
 * will fill them from the world. Until one is configured, this stage does the
 * one honest thing available: it resolves every planned asset to a **generated
 * placeholder plate** (`generated://…`, licence `generated` — the renderer
 * draws plates for these deterministically, and the episode is visibly a
 * placeholder rather than a broken picture), republishes the manifest, and
 * writes a resolution report naming every decision.
 *
 * QA checks the manifest this stage publishes (the render draws it), so a
 * `planned` asset left behind fails the episode — this stage is where that is
 * decided, not hidden.
 */
export function createSourceMediaTask(deps: {
  readonly storage: BlobStore;
  readonly repo: Repo;
}): Task {
  return {
    stageKey: "source_media",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const planHash = upstreamHash(ctx, "plan", "manifestHash") ?? namedParam(ctx, "manifestHash");
      if (planHash === undefined) {
        throw new PermanentError(
          "source_media stage has no scene plan: run the plan stage first, or pass params.manifestHash",
        );
      }
      const manifest = loadSceneManifest(deps.storage, planHash);
      const planned = manifest.assets.filter((asset) => asset.status === "planned");

      const resolvedAssets = planned.map((asset) => ({
        id: asset.id,
        sceneId: asset.sceneId,
        uri: `generated://plates/${asset.sceneId}/${asset.id}`,
        licence: "generated",
        note: "placeholder plate; the media engine (plan-Phase 3) replaces this",
      }));

      let manifestHash = planHash;
      if (resolvedAssets.length > 0) {
        const updated: SceneManifest = {
          ...manifest,
          assets: manifest.assets.map((asset) => {
            const resolved = resolvedAssets.find((entry) => entry.id === asset.id);
            return resolved === undefined
              ? asset
              : {
                  ...asset,
                  status: "resolved" as const,
                  uri: resolved.uri,
                  licence: "generated" as const,
                };
          }),
        };
        manifestHash = persistSceneManifest(
          { storage: deps.storage, repo: deps.repo },
          updated,
        ).hash;
        ctx.log(
          "source_media.resolved",
          `${resolvedAssets.length} planned asset(s) resolved to generated placeholder plates`,
          { from: planHash, manifestHash },
        );
      } else {
        ctx.log("source_media.nothing_planned", "the plan has no planned assets to resolve", {
          manifestHash: planHash,
        });
      }

      // The resolution report: the stage's declared deliverable, readable in
      // the artifact store without re-deriving anything.
      const report = {
        engine: "nexus-media-placeholder",
        plan: planHash,
        manifest: manifestHash,
        planned: planned.length,
        resolved: resolvedAssets,
        policy:
          "no media adapter is configured, so every planned asset becomes a generated placeholder plate",
      };
      const put = deps.storage.put(
        new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
      );
      const artifact = deps.repo.registerArtifact({
        hash: put.hash,
        kind: "document",
        bytes: put.bytes,
        meta: { report: "media_resolution", planned: planned.length },
      });

      return {
        output: { manifestHash, reportHash: put.hash, resolved: resolvedAssets.length },
        artifacts: [
          {
            hash: manifestHash,
            kind: SCENE_MANIFEST_ARTIFACT_KIND,
            role: "media_resolved_manifest",
          },
          { hash: artifact.hash, kind: "document", role: "media_resolution_report" },
        ],
      };
    },
  };
}

// ── animate ─────────────────────────────────────────────────────────────────

/**
 * Hand the media-resolved manifest to the render stage.
 *
 * In the shipped architecture the animation timeline is not a separate
 * artifact: the render pipeline folds the manifest's events deterministically
 * (the Phase 9 fold inside `renderVideo`). This stage is the seam where a
 * storyboard/preview artifact could land later; today it moves the manifest
 * forward and says so.
 */
export function createAnimateTask(): Task {
  return {
    stageKey: "animate",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const manifestHash =
        upstreamHash(ctx, "source_media", "manifestHash") ??
        upstreamHash(ctx, "plan", "manifestHash") ??
        namedParam(ctx, "manifestHash");
      if (manifestHash === undefined) {
        throw new PermanentError(
          "animate stage has no scene plan: run the plan stage first, or pass params.manifestHash",
        );
      }
      // Reference the bytes (already registered by plan/source_media) without
      // re-registering them: the runner requires every returned hash to exist.
      ctx.log("animate.ready", "animation events fold at render time; manifest handed forward", {
        manifestHash,
      });
      return {
        output: { manifestHash },
        artifacts: [
          { hash: manifestHash, kind: SCENE_MANIFEST_ARTIFACT_KIND, role: "animation_timeline" },
        ],
      };
    },
  };
}

// ── approval ────────────────────────────────────────────────────────────────

/**
 * The final gate. The runner parks gate stages *before* dispatching a task —
 `stage.gate` is checked first — so this task is a safety net, not the
 * mechanism: it executes only if the runner's gate handling ever changes, and
 * then still parks the job at the same gate with the same fingerprint.
 */
export function createApprovalTask(): Task {
  return {
    stageKey: "approval",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      return {
        waiting: ctx.stage.gate ?? "FINAL_APPROVAL",
        waitingReason: "awaiting the operator's decision on the finished episode",
      };
    },
  };
}

// ── publish ─────────────────────────────────────────────────────────────────

/** The kind/role the publish stage's durable record is registered under. */
export const PUBLISH_RECORD_KIND = "metadata" as const;
export const PUBLISH_RECORD_ROLE = "publish_record" as const;
export const PUBLISH_CONFIRMATION_ROLE = "publish_confirmation" as const;

export interface PublishTaskDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
  /** The configured publishing capability (fake / manual / youtube). */
  readonly publisher: PublishProvider;
  /** `"publish"` (long-form) or `"short_publish"`; default `"publish"`. */
  readonly stageKey?: "publish" | "short_publish";
}

/**
 * The publish stage: the LAST thing that runs, and the one that must never run
 * by accident.
 *
 * **The QA gate is the task's own, re-checked here** — defence in depth. The
 * stage graph only lets `publish` follow `approval`, but this task does not
 * trust wiring: it loads the QA report the episode was approved on and refuses
 * (a `PermanentError`, so no retry can sneak past) unless
 *
 *   1. the report exists, reads back, `verdict` is `pass`/`pass_with_warnings`
 *      and `publishable` is true — a *failed* QA report means the episode must
 *      not be published, full stop;
 *   2. an `approved` decision exists at the episode's approval gate
 *      (`FINAL_APPROVAL` / `SHORT_APPROVAL`) — QA passing alone is not consent;
 *   3. the episode is in an approved state (`READY`/`PUBLISHING`).
 *
 * Retry handling: gate violations and invalid metadata are permanent (the
 * runner fails the step, evidence attached); transport/5xx/429 failures stay
 * retryable inside the provider call (backoff) and across stage attempts. A
 * re-invocation of an already-published episode returns the recorded ref
 * without uploading again — YouTube has no idempotency key, so the record is
 * the dedup.
 */
export function createPublishTask(deps: PublishTaskDeps): Task {
  const stageKey = deps.stageKey ?? "publish";
  return {
    stageKey,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      // ── The inputs: the same job when the stage rides it, else the
      // episode's latest completed stages (a standalone publish job has no
      // upstream — the episode's own run is the source of truth). ──
      const qaReportHash =
        upstreamHash(ctx, "qa", "reportHash") ?? latestEpisodeHash(deps, ctx.job.episode_id, "qa");
      const videoHash =
        upstreamHash(ctx, "render", "videoHash") ??
        latestEpisodeHash(deps, ctx.job.episode_id, "video");
      const thumbnailHash =
        upstreamHash(ctx, "render", "thumbnailHash") ??
        latestEpisodeHash(deps, ctx.job.episode_id, "thumbnail");

      // ── GATE 1: an approved QA state, verified from the report itself ──
      if (qaReportHash === undefined) {
        throw new PermanentError(
          "publishing requires an approved QA state: no QA report was produced for this episode",
        );
      }
      let report;
      try {
        report = loadQAReport(deps.storage, qaReportHash);
      } catch (error) {
        throw new PermanentError(
          `publishing requires an approved QA state: the QA report ${qaReportHash.slice(0, 12)}… cannot be read: ${messageOf(error)}`,
        );
      }
      if (report.verdict === "fail" || !report.publishable) {
        throw new PermanentError(
          `the episode failed QA (verdict ${report.verdict}, publishable ${report.publishable}) — ` +
            "it must not be published" +
            (report.blocking.length > 0 ? ` (blocking: ${report.blocking.join(", ")})` : ""),
        );
      }

      // ── GATE 2: the operator's approval at the episode's gate ──
      const approvals = deps.repo.listApprovals(ctx.job.episode_id);
      const approved = approvals.find(
        (approval) =>
          approval.decision === "approved" &&
          (approval.gate === "FINAL_APPROVAL" || approval.gate === "SHORT_APPROVAL"),
      );
      if (approved === undefined) {
        throw new PermanentError(
          "publishing requires the operator's approval: no approved FINAL_APPROVAL/" +
            "SHORT_APPROVAL decision exists for this episode",
        );
      }

      // ── Dedup: never upload the same episode twice ──
      if (videoHash !== undefined) {
        const existing = findPublishedRecord(deps, ctx.job.episode_id, videoHash);
        if (existing !== undefined) {
          const refId = (existing.output as { refId?: string } | undefined)?.refId ?? "?";
          ctx.log("publish.already", `episode already published as ${refId} — not re-uploading`);
          return existing;
        }
      }

      // ── GATE 3: the episode sits in an approved state ──
      const state = ctx.episode.state;
      if (state !== "READY" && state !== "PUBLISHING") {
        throw new PermanentError(
          `publishing requires an approved episode: this one is ${state} (an episode that failed ` +
            "QA or was rejected must not be publishable)",
        );
      }

      // ── The upload itself ──
      if (videoHash === undefined) {
        throw new PermanentError(
          "publish stage has no video: run the render stage first, or pass params.videoHash",
        );
      }
      const metadata = publishMetadataOf(ctx, publishRequestOf(deps.storage, ctx.job));
      const correlationId = ctx.job.id;
      const uploaded = await deps.publisher.upload(videoHash, metadata, {
        correlationId,
        signal: ctx.signal,
      });
      const ref: PublishRef = uploaded.value;

      // Where does the video stand? Best effort: a probe failure must not
      // fail the stage *after* a successful upload.
      let status: PublishStatusReport | undefined;
      if (ref.mode === "api" && deps.publisher.status !== undefined) {
        try {
          status = (await deps.publisher.status(ref, { correlationId, signal: ctx.signal })).value;
        } catch (error) {
          ctx.log(
            "publish.status_failed",
            `upload succeeded but the status probe failed: ${messageOf(error)}`,
          );
        }
      }

      // ── The durable record + the human-readable confirmation ──
      // `output` is stored inside the record so a re-run can adopt the exact
      // prior result (the dedup reads the record back).
      const output = {
        refId: ref.id,
        provider: ref.provider,
        mode: ref.mode,
        status: ref.status,
        ...(ref.url !== undefined ? { url: ref.url } : {}),
        ...(status !== undefined ? { uploadStatus: status.uploadStatus } : {}),
        recordHash: "",
        videoHash,
        qaReportHash,
      };
      const record = {
        version: 1,
        episodeId: ctx.job.episode_id,
        jobId: ctx.job.id,
        videoHash,
        ...(thumbnailHash !== undefined ? { thumbnailHash } : {}),
        qaReportHash,
        metadata: { ...metadata },
        ref,
        ...(status !== undefined ? { status } : {}),
        output,
        publishedAt: new Date().toISOString(),
      };
      const recordBytes = new TextEncoder().encode(JSON.stringify(record, null, 2));
      const stored = deps.storage.put(recordBytes);
      deps.repo.registerArtifact({
        hash: stored.hash,
        kind: PUBLISH_RECORD_KIND,
        bytes: stored.bytes,
      });

      const confirmation =
        ref.mode === "manual" && ref.kit !== undefined
          ? [
              `# Upload kit for "${metadata.title}"`,
              "",
              ...ref.kit.instructions,
              "",
              ...ref.kit.files.map(
                (file) =>
                  `- ${file.role}: ${file.suggestedName} (${file.mime}) — ${file.hash.slice(0, 12)}…`,
              ),
              "",
              "The episode is published when you upload these files; the record above stays as the audit trail.",
            ].join("\n")
          : [
              `# Published: ${metadata.title}`,
              "",
              `- provider: ${ref.provider} (${ref.mode})`,
              `- status: ${ref.status}${status !== undefined ? ` / upload ${status.uploadStatus}` : ""}`,
              ref.url !== undefined ? `- url: ${ref.url}` : "- url: (none)",
              `- video: ${videoHash.slice(0, 12)}…`,
              `- QA report: ${qaReportHash.slice(0, 12)}…`,
            ].join("\n");
      const docBytes = new TextEncoder().encode(confirmation);
      const docStored = deps.storage.put(docBytes);
      deps.repo.registerArtifact({
        hash: docStored.hash,
        kind: "document",
        bytes: docStored.bytes,
      });

      ctx.log("publish.done", `${ref.status}: ${metadata.title}`, {
        provider: ref.provider,
        mode: ref.mode,
        url: ref.url ?? "",
      });

      return {
        output: { ...output, recordHash: stored.hash, confirmationHash: docStored.hash },
        artifacts: [
          { hash: stored.hash, kind: PUBLISH_RECORD_KIND, role: PUBLISH_RECORD_ROLE },
          { hash: docStored.hash, kind: "document", role: PUBLISH_CONFIRMATION_ROLE },
        ],
      };
    },
  };
}

/**
 * The operator's publish request, carried content-addressed in the job's
 * idempotency key (`publish:<episodeId>:<requestHash>` — the route registered
 * the request as an artifact). A job created without one publishes with the
 * honest defaults (the topic as title and description, private).
 */
function publishRequestOf(storage: BlobStore, job: TaskContext["job"]): PublishRequest | undefined {
  const key = job.idempotency_key ?? "";
  const match = /^publish:[^:]+:([0-9a-f]{64})$/u.exec(key);
  if (match === null) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(storage.read(match[1]!))) as PublishRequest;
    if (parsed.version !== 1 || typeof parsed.title !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface PublishRequest {
  readonly version: 1;
  readonly episodeId: string;
  readonly title: string;
  readonly description: string;
  readonly privacyStatus: PublishMetadata["privacyStatus"];
  readonly scheduledAt?: string;
  readonly tags?: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
}

/** The metadata the stage publishes with — the request first, honest defaults. */
function publishMetadataOf(ctx: TaskContext, request: PublishRequest | undefined): PublishMetadata {
  const topic = ctx.episode.topic.trim();
  const title = (request?.title ?? topic).trim().slice(0, 100);
  const description = (request?.description ?? topic).trim();
  return {
    title: title !== "" ? title : "Untitled episode",
    description,
    ...(request?.tags !== undefined && request.tags.length > 0 ? { tags: [...request.tags] } : {}),
    privacyStatus: request?.privacyStatus ?? "private",
    ...(request?.scheduledAt !== undefined && request.scheduledAt.trim() !== ""
      ? { scheduledAt: request.scheduledAt.trim() }
      : {}),
  };
}

/**
 * The episode's latest hash of one kind, from its runs' completed steps —
 * the QA report from the `qa` step (output first, evidence artifact as
 * fallback), the video/thumbnail from the `render` step's artifacts.
 */
function latestEpisodeHash(
  deps: PublishTaskDeps,
  episodeId: string,
  what: "qa" | "video" | "thumbnail",
): string | undefined {
  const jobs = deps.repo.listJobs(episodeId);
  for (const job of [...jobs].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  )) {
    for (const step of deps.repo.listJobSteps(job.id)) {
      if (step.state !== "DONE") continue;
      if (what === "qa") {
        if (step.step_key !== "qa" && step.step_key !== "short_qa") continue;
        const output = parseStepOutput(step.output);
        const fromOutput = readHash(output?.reportHash);
        if (fromOutput !== undefined) return fromOutput;
        const fromArtifacts = parseStepArtifacts(step.artifacts).find(
          (entry) => entry.role === "qa_report",
        );
        if (fromArtifacts !== undefined) return fromArtifacts.hash;
        continue;
      }
      if (step.step_key !== "render" && step.step_key !== "short_render") continue;
      const fromArtifacts = parseStepArtifacts(step.artifacts).find((entry) => entry.kind === what);
      if (fromArtifacts !== undefined) return fromArtifacts.hash;
    }
  }
  return undefined;
}

function parseStepOutput(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

/** Parse the artifacts JSON a step row carries (the runner's own shape). */
function parseStepArtifacts(raw: string): { hash: string; kind: ArtifactKind; role: string }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed as { hash: string; kind: ArtifactKind; role: string }[])
      : [];
  } catch {
    return [];
  }
}

/**
 * The episode's prior publish record, when one exists **for this exact video**.
 * Reading it back is what makes a double "Publish" press (or a stage retry
 * after an ack was lost) a no-op instead of a duplicate upload.
 */
function findPublishedRecord(
  deps: PublishTaskDeps,
  episodeId: string,
  videoHash: string,
): TaskResult | undefined {
  for (const job of deps.repo.listJobs(episodeId)) {
    for (const step of deps.repo.listJobSteps(job.id)) {
      if (step.state !== "DONE") continue;
      if (step.step_key !== "publish" && step.step_key !== "short_publish") continue;
      const artifacts = parseStepArtifacts(step.artifacts);
      const recordRef = artifacts.find((entry) => entry.role === PUBLISH_RECORD_ROLE);
      if (recordRef === undefined) continue;
      try {
        const record = JSON.parse(new TextDecoder().decode(deps.storage.read(recordRef.hash))) as {
          videoHash?: string;
          output?: Record<string, unknown>;
        };
        if (record.videoHash !== videoHash || record.output === undefined) continue;
        return {
          output: record.output,
          artifacts: artifacts.map((entry) => ({
            hash: entry.hash,
            kind: entry.kind,
            role: entry.role,
          })),
        };
      } catch {
        // A record we cannot read is not a record we can trust to dedup.
        continue;
      }
    }
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
