import { PermanentError, type Task, type TaskContext, type TaskResult } from "@nexus/jobs";
import { type Clock } from "@nexus/providers";
import { loadScriptDoc } from "@nexus/script";
import type { Repo } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import { buildSceneManifest, ScenePlanError, type ScenePlanOptions } from "./plan.js";
import { loadSceneManifest, persistSceneManifest, sceneManifestArtifactRef } from "./persist.js";
import { validateSceneManifest } from "./validate.js";

/**
 * The `plan` stage task: the orchestrator's entry point into the scene planner.
 *
 * It reads the script the `script` stage published (from the CAS, by the hash
 * that stage put in its output), plans the scenes, and stores the manifest as a
 * `scene_graph` artifact for everything downstream — media sourcing, voice,
 * captions, the renderer — to read.
 *
 * Unlike a generated document, the plan is a projection of a validated script, so
 * there is nothing to park on: the work is deterministic and offline. What it can
 * do is *report*: a manifest that fails its own validation still gets stored (so
 * an operator can see exactly what is wrong) and its issue count travels with the
 * step output and the job log.
 */

export const SCENE_PLAN_STAGE_KEY = "plan";

export interface ScenePlanTaskDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
  readonly clock?: Clock;
  /** Cast, frame size and pacing for every plan this worker produces. */
  readonly options?: Omit<ScenePlanOptions, "scriptHash" | "scriptId" | "clock">;
}

export function createScenePlanTask(deps: ScenePlanTaskDeps): Task {
  return {
    stageKey: SCENE_PLAN_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const scriptHash = scriptHashFrom(ctx);
      if (scriptHash === undefined) {
        throw new PermanentError(
          "plan stage has no script: run the script stage first, or pass params.scriptHash",
        );
      }

      let script;
      try {
        script = loadScriptDoc(deps.storage, scriptHash);
      } catch (error) {
        throw new PermanentError(
          `plan stage cannot read script artifact ${scriptHash}: ${messageOf(error)}`,
          { cause: error },
        );
      }

      ctx.log("scene_plan.started", `planning scenes from script ${scriptHash.slice(0, 12)}`, {
        topic: script.topic,
        sections: script.sections.length,
        sentences: script.sections.reduce((total, section) => total + section.sentences.length, 0),
        claims: script.claims.length,
      });

      let manifest;
      try {
        manifest = buildSceneManifest(script, {
          ...deps.options,
          scriptHash,
          ...(scriptIdFrom(ctx) !== undefined ? { scriptId: scriptIdFrom(ctx)! } : {}),
          ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        });
      } catch (error) {
        if (error instanceof ScenePlanError) {
          // Bad planning configuration (an empty cast, a nonsense pace) is not
          // worth retrying: the job fails with the operator's own message.
          throw new PermanentError(error.message, { cause: error });
        }
        throw error;
      }

      const report = validateSceneManifest(manifest, { script });
      for (const warning of manifest.warnings) ctx.log("scene_plan.warning", warning);

      const persisted = persistSceneManifest(deps, manifest, { episodeId: ctx.episode.id });

      ctx.log(
        "scene_plan.completed",
        `${manifest.scenes.length} scene(s), ${manifest.totalDurationSec}s, ${manifest.assets.length} asset(s) to source`,
        {
          manifestHash: persisted.hash,
          scriptHash,
          scenes: manifest.scenes.length,
          byType: report.stats.byType,
          assets: manifest.assets.length,
          durationSec: manifest.totalDurationSec,
        },
      );
      if (!report.ok) {
        ctx.log(
          "scene_plan.review_required",
          "the scene plan failed its own validation and needs an editor",
          {
            issues: report.issues
              .filter((entry) => entry.severity === "hard")
              .map((entry) => `${entry.code}: ${entry.message}`),
          },
        );
      }

      return {
        output: {
          manifestHash: persisted.hash,
          scriptHash,
          workingTitle: manifest.workingTitle,
          topic: manifest.topic,
          durationSec: manifest.totalDurationSec,
          fps: manifest.fps,
          aspect: manifest.aspect,
          resolution: manifest.resolution,
          counts: {
            scenes: report.stats.scenes,
            byType: report.stats.byType,
            assets: report.stats.assets,
            words: report.stats.words,
          },
          scenes: manifest.scenes.map((scene) => ({
            id: scene.id,
            type: scene.type,
            sectionId: scene.sectionId,
            startSec: scene.startSec,
            durationSec: scene.durationSec,
            sentences: scene.narration.sentenceIds,
            assets: scene.media?.assets ?? [],
          })),
          assets: manifest.assets.map((asset) => ({
            id: asset.id,
            sceneId: asset.sceneId,
            kind: asset.kind,
            purpose: asset.purpose,
            searchHint: asset.searchHint,
            status: asset.status,
          })),
          cast: manifest.cast.map((member) => member.id),
          quality: {
            ok: report.ok,
            hardIssues: report.issues.filter((entry) => entry.severity === "hard").length,
            softIssues: report.issues.filter((entry) => entry.severity === "soft").length,
            issues: report.issues.map((entry) => ({ code: entry.code, message: entry.message })),
          },
          warnings: manifest.warnings,
        },
        artifacts: [sceneManifestArtifactRef(persisted)],
      };
    },

    /**
     * Reuse guard: an identical episode re-run adopts the previous manifest only
     * if it still parses in the CAS and actually contains scenes.
     */
    validateReuse(_ctx, run) {
      const ref = run.artifacts.find((artifact) => artifact.kind === "scene_graph");
      if (ref === undefined) throw new PermanentError("plan step has no scene_graph artifact");
      const manifest = loadSceneManifest(deps.storage, ref.hash);
      if (manifest.scenes.length === 0) {
        throw new PermanentError("scene manifest has no scenes; planning again is safer");
      }
    },
  };
}

/** The script artifact this job produced, or one named explicitly in params. */
function scriptHashFrom(ctx: TaskContext): string | undefined {
  const upstream = ctx.upstream as Record<string, unknown>;
  for (const stageKey of ["script", "fact_check"]) {
    const output = upstream[stageKey];
    if (typeof output !== "object" || output === null) continue;
    const hash = (output as { docHash?: unknown }).docHash;
    if (typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash)) return hash;
  }
  return namedParam(ctx, "scriptHash");
}

function scriptIdFrom(ctx: TaskContext): string | undefined {
  const upstream = ctx.upstream as Record<string, unknown>;
  const script = upstream.script;
  if (typeof script === "object" && script !== null) {
    const id = (script as { scriptId?: unknown }).scriptId;
    if (typeof id === "string" && id !== "") return id;
  }
  return namedParam(ctx, "scriptId");
}

function namedParam(ctx: TaskContext, key: string): string | undefined {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
