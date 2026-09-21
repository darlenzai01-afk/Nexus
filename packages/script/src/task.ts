import type { Repo } from "@nexus/db";
import { PermanentError, type Task, type TaskContext, type TaskResult } from "@nexus/jobs";
import {
  MANUAL_INPUT_GATE,
  isManualRequired,
  toJobError,
  type Clock,
  type LLMProvider,
} from "@nexus/providers";
import { loadResearchPackage } from "@nexus/research";
import type { BlobStore } from "@nexus/storage";

import { NoUsableClaimsError, generateScript, type ScriptTuning } from "./pipeline.js";
import { loadScriptDoc, persistScript, scriptArtifactRef } from "./persist.js";
import { normalizeWhitespace } from "./text.js";

/**
 * The `script` stage task: the orchestrator's entry point into the script
 * engine.
 *
 * It reads the research package the earlier stage produced (from the CAS, by
 * the hash that stage published), writes the script, and stores both halves of
 * the result — the artifact and the claim/evidence rows. Two outcomes leave the
 * pipeline to a human instead of guessing:
 *
 * - the AI capability degraded to `manual` (AD-06), and
 * - research left nothing that may be written about, because every claim lacked
 *   verified evidence.
 */

export const SCRIPT_STAGE_KEY = "script";

export interface ScriptTaskDeps {
  readonly llm: LLMProvider;
  readonly storage: BlobStore;
  readonly repo: Repo;
  readonly clock?: Clock;
  readonly tuning?: Partial<ScriptTuning>;
}

export function createScriptTask(deps: ScriptTaskDeps): Task {
  return {
    stageKey: SCRIPT_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const topic = normalizeWhitespace(ctx.episode.topic);
      const packageHash = researchPackageHashFrom(ctx);
      if (packageHash === undefined) {
        throw new PermanentError(
          "script stage has no research package: run the research stage first, " +
            "or pass params.researchPackageHash",
        );
      }

      let pkg;
      try {
        pkg = loadResearchPackage(deps.storage, packageHash);
      } catch (error) {
        throw new PermanentError(
          `script stage cannot read research package ${packageHash}: ${messageOf(error)}`,
          { cause: error },
        );
      }

      ctx.log("script.started", `writing from research package ${packageHash.slice(0, 12)}`, {
        topic,
        claims: pkg.claims.length,
        sources: pkg.sources.length,
        cleared: pkg.verification.established,
      });

      let doc;
      try {
        doc = await generateScript(
          {
            topic,
            outline: parseOutline(ctx.episode.outline),
            direction: directionFrom(ctx),
            research: pkg,
            packageHash,
            episodeId: ctx.episode.id,
            projectId: ctx.episode.project_id,
            signal: ctx.signal,
            correlationId: ctx.job.id,
            llmProvider: deps.llm.id,
          },
          {
            llm: deps.llm,
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            ...(deps.tuning !== undefined ? { options: deps.tuning } : {}),
          },
        );
      } catch (error) {
        if (error instanceof NoUsableClaimsError) {
          return {
            waiting: MANUAL_INPUT_GATE,
            waitingReason:
              `${error.message}. Supply sources for the claims (params.operatorSources) and ` +
              "resolve the research gate, or approve writing an opinion piece without facts.",
          };
        }
        if (isManualRequired(error)) {
          return {
            waiting: MANUAL_INPUT_GATE,
            waitingReason: `${error.request.summary}. ${error.request.instructions.join(" ")}`,
          };
        }
        throw toJobError(error);
      }

      for (const warning of doc.warnings) ctx.log("script.warning", warning);

      const persisted = persistScript(deps, doc, pkg, { episodeId: ctx.episode.id });
      if (persisted.unresolvedEvidence.length > 0) {
        ctx.log(
          "script.warning",
          `${persisted.unresolvedEvidence.length} evidence link(s) had no matching source row`,
          { unresolved: persisted.unresolvedEvidence },
        );
      }

      ctx.log(
        "script.completed",
        `${doc.stats.words} words across ${doc.stats.sections} section(s); ` +
          `${doc.claims.length} claim(s) linked to evidence`,
        {
          scriptId: persisted.script.id,
          docHash: persisted.hash,
          words: doc.stats.words,
          estimatedDurationSec: doc.stats.estimatedDurationSec,
          claims: doc.claims.length,
          hardIssues: doc.quality.issues.filter((issue) => issue.severity === "hard").length,
          dropped: doc.quality.droppedSentences.length,
        },
      );
      if (doc.quality.reviewRequired) {
        ctx.log(
          "script.review_required",
          "the draft needs an editor: a fact or quotation rule failed, or narration was removed",
          {
            dropped: doc.quality.droppedSentences,
            issues: doc.quality.issues
              .filter((issue) => issue.severity === "hard")
              .map((issue) => `${issue.code}: ${issue.message}`),
          },
        );
      }

      return {
        output: {
          topic: doc.topic,
          scriptId: persisted.script.id,
          docHash: persisted.hash,
          workingTitle: doc.workingTitle,
          logline: doc.logline,
          sections: doc.sections.map((section) => ({
            id: section.id,
            role: section.role,
            title: section.title,
            sentences: section.sentences.length,
          })),
          claims: doc.claims.map((claim) => ({
            claimId: claim.claimId,
            usage: claim.usage,
            sentenceIds: claim.sentenceIds,
            mayStateAsFact: claim.mayStateAsFact,
          })),
          counts: {
            claims: doc.claims.length,
            sentences: doc.stats.sentences,
            words: doc.stats.words,
          },
          stats: doc.stats,
          quality: {
            reviewRequired: doc.quality.reviewRequired,
            repairRounds: doc.quality.repairRounds,
            issues: doc.quality.issues.length,
            hardIssues: doc.quality.issues.filter((issue) => issue.severity === "hard").length,
            droppedSentences: doc.quality.droppedSentences.length,
          },
          warnings: doc.warnings,
        },
        artifacts: [scriptArtifactRef(persisted)],
      };
    },

    /**
     * Reuse guard: an identical episode re-run adopts the previous stage output
     * only if the script artifact still parses in the CAS — its claim ledger is
     * what downstream stages rely on.
     */
    validateReuse(_ctx, run) {
      const ref = run.artifacts.find((artifact) => artifact.kind === "script");
      if (ref === undefined) throw new PermanentError("script step has no script artifact");
      const doc = loadScriptDoc(deps.storage, ref.hash);
      if (doc.claims.length === 0) {
        throw new PermanentError("script artifact has no claim ledger; re-writing is safer");
      }
    },
  };
}

/** The research package this job produced, or one named explicitly in params. */
function researchPackageHashFrom(ctx: TaskContext): string | undefined {
  const upstream = ctx.upstream as Record<string, unknown>;
  for (const stageKey of ["fact_check", "research"]) {
    const output = upstream[stageKey];
    if (typeof output !== "object" || output === null) continue;
    const hash = (output as { packageHash?: unknown }).packageHash;
    if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params === "object" && params !== null) {
    const named = (params as { researchPackageHash?: unknown }).researchPackageHash;
    if (typeof named === "string" && /^[0-9a-f]{64}$/.test(named)) return named;
  }
  return undefined;
}

function directionFrom(ctx: TaskContext): string {
  const job = ctx.inputs.job as { params?: unknown } | undefined;
  const params = job?.params;
  if (typeof params !== "object" || params === null) return "";
  const direction = (params as { direction?: unknown }).direction;
  return typeof direction === "string" ? normalizeWhitespace(direction) : "";
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
