import type { Repo } from "@nexus/db";
import { PermanentError, type Task, type TaskContext, type TaskResult } from "@nexus/jobs";
import {
  MANUAL_INPUT_GATE,
  describeIssues,
  isManualRequired,
  toJobError,
  type Clock,
  type LLMProvider,
  type ResearchProvider,
} from "@nexus/providers";
import type { BlobStore } from "@nexus/storage";

import { persistResearchPackage, researchArtifactRef, loadResearchPackage } from "./persist.js";
import {
  OperatorSourceListSchema,
  runResearch,
  type OperatorSource,
  type ResearchTuning,
} from "./pipeline.js";
import { normalizeWhitespace } from "./text.js";
import type { ResearchPackage } from "./types.js";

/**
 * The `research` stage task: the orchestrator's entry point into the engine.
 *
 * It owns the two orchestration decisions the engine itself must not make:
 *
 * - a capability that degraded to `manual` (or a run that found no sources at
 *   all) **parks the job at the MANUAL_INPUT gate** — nothing is invented to
 *   keep the pipeline moving, and the operator can supply sources through
 *   `params.operatorSources` before the stage is retried;
 * - provider failures are translated with `toJobError`, so a 429 is retried by
 *   the runner and a 401 fails the stage as permanent.
 */

export const RESEARCH_STAGE_KEY = "research";

export interface ResearchTaskDeps {
  readonly llm: LLMProvider;
  readonly research: ResearchProvider;
  readonly storage: BlobStore;
  readonly repo?: Repo;
  readonly clock?: Clock;
  readonly tuning?: Partial<ResearchTuning>;
}

export function createResearchTask(deps: ResearchTaskDeps): Task {
  return {
    stageKey: RESEARCH_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const operatorSources = operatorSourcesFrom(ctx);
      const topic = normalizeWhitespace(ctx.episode.topic);
      const outline = parseOutline(ctx.episode.outline);
      ctx.log("research.started", `topic: ${topic}`, {
        operatorSources: operatorSources.length,
        llm: deps.llm.id,
        research: deps.research.id,
      });

      let pkg: ResearchPackage;
      try {
        pkg = await runResearch(
          {
            topic,
            outline,
            projectId: ctx.episode.project_id,
            episodeId: ctx.episode.id,
            ...(operatorSources.length > 0 ? { operatorSources } : {}),
            signal: ctx.signal,
            correlationId: ctx.job.id,
          },
          {
            llm: deps.llm,
            research: deps.research,
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            ...(deps.tuning !== undefined ? { options: deps.tuning } : {}),
          },
        );
      } catch (error) {
        if (isManualRequired(error)) {
          // The capability is human-in-the-loop now; park instead of burning
          // the remaining budget on retries.
          return {
            waiting: MANUAL_INPUT_GATE,
            waitingReason: `${error.request.summary}. ${error.request.instructions.join(" ")}`,
          };
        }
        throw toJobError(error);
      }

      for (const warning of pkg.warnings) ctx.log("research.warning", warning);
      for (const item of pkg.dropped.slice(0, 20)) {
        ctx.log("research.rejected", `${item.stage}/${item.reason}: ${item.detail}`, {
          value: item.value,
        });
      }

      if (pkg.sources.length === 0) {
        // Never invent a source: hand the empty result to a human instead.
        return {
          waiting: MANUAL_INPUT_GATE,
          waitingReason:
            `research found no usable sources for "${topic}" (${pkg.dropped.length} rejected). ` +
            "Supply sources via params.operatorSources (url + content) and resolve this gate.",
        };
      }

      if (pkg.claims.length === 0) {
        ctx.log("research.no_claims", "sources were found but no verifiable claim was extracted");
      }

      const persisted = persistResearchPackage(deps, pkg, {
        episodeId: ctx.episode.id,
        generatedBy: primaryGeneratedBy(deps.llm.id, pkg),
      });

      ctx.log(
        "research.completed",
        `${pkg.sources.length} source(s), ${pkg.evidence.length} evidence passage(s), ` +
          `${pkg.claims.length} claim(s), ${pkg.conflicts.length} conflict(s)`,
        {
          packageHash: persisted.hash,
          established: pkg.verification.established,
          reviewRequired: pkg.verification.reviewRequired,
        },
      );
      if (pkg.verification.reviewRequired) {
        ctx.log(
          "research.review_required",
          `${pkg.verification.blockingClaimIds.length} claim(s) are not established and must not be stated as fact`,
          { blockingClaimIds: pkg.verification.blockingClaimIds },
        );
      }

      return {
        output: {
          topic: pkg.topic,
          packageHash: persisted.hash,
          questions: pkg.questions.map((question) => ({
            id: question.id,
            question: question.question,
          })),
          sourceIds: persisted.sourceIds,
          counts: {
            sources: pkg.sources.length,
            evidence: pkg.evidence.length,
            claims: pkg.claims.length,
            conflicts: pkg.conflicts.length,
          },
          verification: pkg.verification,
          warnings: pkg.warnings,
          partial: pkg.partial,
        },
        artifacts: [researchArtifactRef(persisted)],
      };
    },

    /**
     * Reuse guard: an identical episode re-run adopts the previous stage output
     * only if the package in the CAS still parses. A truncated or drifted blob
     * means the stage re-executes instead of feeding garbage downstream.
     */
    validateReuse(_ctx, run) {
      const ref = run.artifacts.find((artifact) => artifact.kind === "document");
      if (ref === undefined) throw new PermanentError("research step has no package artifact");
      loadResearchPackage(deps.storage, ref.hash);
    },
  };
}

/**
 * Provenance for the package artifact (`artifacts.meta.generatedBy`): the
 * adapter plus the model/template of the last AI step that shaped it, so the
 * artifact row alone answers "what produced this".
 */
function primaryGeneratedBy(
  provider: string,
  pkg: ResearchPackage,
): { provider: string; model?: string; templateVersion?: string } {
  const aiSteps = pkg.provenance.steps.filter(
    (step) => step.model !== undefined || step.templateVersion !== undefined,
  );
  const last = aiSteps[aiSteps.length - 1];
  return {
    provider,
    ...(last?.model !== undefined ? { model: last.model } : {}),
    ...(last?.templateVersion !== undefined ? { templateVersion: last.templateVersion } : {}),
  };
}

/** Operator-supplied sources reach the stage through the runner's params. */
function operatorSourcesFrom(ctx: TaskContext): readonly OperatorSource[] {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return [];
  const raw = (params as { operatorSources?: unknown }).operatorSources;
  if (raw === undefined) return [];
  const parsed = OperatorSourceListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermanentError(
      `params.operatorSources is invalid: ${describeIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

function parseOutline(outline: string): string[] {
  try {
    const parsed: unknown = JSON.parse(outline);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((line): line is string => typeof line === "string" && line.trim() !== "");
  } catch {
    return [];
  }
}
