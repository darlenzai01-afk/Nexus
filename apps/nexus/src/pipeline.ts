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
import type { Repo } from "@nexus/db";

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
 * The `publish` stage is deliberately **not** implemented and not registered:
 * uploading (YouTube) arrives in a later phase, so dashboard jobs simply do
 * not include the stage — an approved episode ends at `approval` with the
 * episode `READY`, which is the honest state of "nothing is published yet".
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
