import { loadCaptionTrack, loadAudioTrack } from "@nexus/audio";
import type { ArtifactRef, Repo } from "@nexus/db";
import type { CompletedStageRun } from "@nexus/db";
import { PermanentError, type Task, type TaskContext } from "@nexus/jobs";
import { loadResearchPackage } from "@nexus/research";
import { loadSceneManifest } from "@nexus/scenes";
import { loadScriptDoc } from "@nexus/script";
import type { BlobStore } from "@nexus/storage";
import { loadRenderMetadata } from "@nexus/video";
import type { CharacterLibrary } from "@nexus/characters";
import type { FontSet } from "@nexus/video";

import { runQA, describeReport } from "./engine.js";
import type { QAEvidence } from "./evidence.js";
import {
  persistQAReport,
  qaArtifactOf,
  QA_ARTIFACT_KIND,
  QA_ARTIFACT_ROLE,
  QA_SUMMARY_ARTIFACT_KIND,
  QA_SUMMARY_ARTIFACT_ROLE,
} from "./persist.js";
import { collectPipelineSnapshot } from "./snapshot.js";
import type { QASettings } from "./schema.js";

/**
 * The `qa` stage: the gate between "there is a render" and "somebody may publish
 * it".
 *
 * The stage reads what the earlier stages produced — from their *outputs*, never
 * from paths — assembles the evidence bundle, runs the engine, stores the report,
 * and then does the one thing that makes QA more than a linter: **when the report
 * is not publishable, the stage fails.** A failed step fails the job, the episode
 * moves to `FAILED`, and `approval`/`publish` never run. The report is stored
 * either way, so the operator can read exactly why.
 *
 * The inputs are read by hash wherever a hash is available, and everything that is
 * missing becomes a finding rather than an exception: QA's job is to report, and a
 * missing input is something to report.
 */

export const QA_STAGE_KEY = "qa";

export interface QATaskDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
  /** The character library, so the visual checks can verify layer files. */
  readonly characters?: CharacterLibrary | undefined;
  /** The faces text is measured with; without them readability is reported unchecked. */
  readonly fonts?: FontSet | undefined;
  readonly settings?: QASettings | undefined;
}

export function createQATask(deps: QATaskDeps): Task {
  return {
    stageKey: QA_STAGE_KEY,

    async execute(ctx: TaskContext): Promise<{ output: unknown; artifacts: ArtifactRef[] }> {
      const manifestHash =
        upstreamHash(ctx, "plan", "manifestHash") ?? namedParam(ctx, "manifestHash");
      if (manifestHash === undefined) {
        throw new PermanentError(
          "qa stage has no scene plan: run the plan stage first, or pass params.manifestHash",
        );
      }
      let manifest;
      try {
        manifest = loadSceneManifest(deps.storage, manifestHash);
      } catch (error) {
        throw new PermanentError(
          `qa stage cannot read the scene plan ${manifestHash.slice(0, 12)}…: ${messageOf(error)}`,
        );
      }

      // The script and the research package are reached through the hashes the
      // manifest and the script carry — no new wiring, and nothing is assumed to
      // exist: a missing document is a finding, not a crash.
      const script = optional(deps.storage, manifest.scriptHash, loadScriptDoc);
      const research = optional(
        deps.storage,
        script?.doc.provenance.researchPackageHash ?? "",
        loadResearchPackage,
      );
      const audioHash =
        upstreamHash(ctx, "render", "audioTrackHash") ??
        upstreamHash(ctx, "voice", "trackHash") ??
        "";
      const captionHash =
        upstreamHash(ctx, "render", "captionTrackHash") ??
        upstreamHash(ctx, "captions", "captionHash") ??
        upstreamHash(ctx, "captions", "trackHash") ??
        "";
      const metadataHash = upstreamHash(ctx, "render", "metadataHash") ?? "";
      const videoHash = upstreamHash(ctx, "render", "videoHash") ?? "";

      const evidence: QAEvidence = {
        episodeId: ctx.job.episode_id,
        jobId: ctx.job.id,
        manifest,
        manifestHash,
        script,
        research,
        audio: optional(deps.storage, audioHash, loadAudioTrack),
        captions: optional(deps.storage, captionHash, loadCaptionTrack),
        render: optional(deps.storage, metadataHash, loadRenderMetadata),
        video: videoHash === "" ? undefined : { hash: videoHash },
        pipeline: collectPipelineSnapshot(
          { repo: deps.repo, hasArtifact: (hash) => deps.storage.has(hash) },
          ctx.job.id,
        ),
      };

      const report = runQA(
        evidence,
        {
          storage: deps.storage,
          ...(deps.characters !== undefined ? { characters: deps.characters } : {}),
          ...(deps.fonts !== undefined ? { fonts: deps.fonts } : {}),
          ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
        },
        { episodeId: ctx.job.episode_id, jobId: ctx.job.id },
      );

      const persisted = persistQAReport({ storage: deps.storage, repo: deps.repo }, report);
      ctx.log(report.publishable ? "qa.passed" : "qa.blocked", describeReport(report), {
        verdict: report.verdict,
        errors: report.counts.errors,
        warnings: report.counts.warnings,
        skippedChecks: report.counts.skipped,
        reportHash: persisted.hash,
      });
      for (const finding of report.findings) {
        ctx.log(finding.severity === "error" ? "qa.finding" : "qa.warning", finding.message, {
          code: finding.code,
          subject: finding.subject,
        });
      }

      if (!report.publishable) {
        // The report is stored first: a blocked episode must leave its evidence.
        throw new PermanentError(
          `${describeReport(report)} — publication blocked by ` +
            `${report.blocking.join(", ") || "unpublished findings"} (report ${persisted.hash})`,
        );
      }

      return {
        output: {
          reportHash: persisted.hash,
          summaryHash: persisted.summaryHash,
          verdict: report.verdict,
          publishable: report.publishable,
          errors: report.counts.errors,
          warnings: report.counts.warnings,
          findings: report.counts.findings,
          checks: report.counts.checks,
          skipped: report.counts.skipped,
          blocking: report.blocking,
          settingsHash: report.settingsHash,
          manifestHash,
        },
        artifacts: [
          { hash: persisted.hash, kind: QA_ARTIFACT_KIND, role: QA_ARTIFACT_ROLE },
          {
            hash: persisted.summaryHash,
            kind: QA_SUMMARY_ARTIFACT_KIND,
            role: QA_SUMMARY_ARTIFACT_ROLE,
          },
        ],
      };
    },

    /**
     * Reuse guard: a previous report is adopted only when it is about the *same*
     * subject and it passed. A report that blocked, or that describes a different
     * render, must not be reused — that is exactly how a fixed episode would ship
     * with a stale verdict.
     */
    validateReuse(ctx: TaskContext, run: CompletedStageRun): void {
      const ref = qaArtifactOf(run.artifacts);
      if (ref === undefined) throw new PermanentError("the qa step has no report artifact");
      let report;
      try {
        report = JSON.parse(new TextDecoder().decode(deps.storage.read(ref.hash))) as {
          publishable?: boolean;
          subject?: { manifestHash?: string };
        };
      } catch (error) {
        throw new PermanentError(`the previous QA report cannot be read: ${messageOf(error)}`);
      }
      if (report.publishable !== true) {
        throw new PermanentError(
          "the previous QA report blocked publication, so it cannot be reused",
        );
      }
      const expected = upstreamHash(ctx, "plan", "manifestHash");
      if (expected !== undefined && report.subject?.manifestHash !== expected) {
        throw new PermanentError(
          `the previous QA report is about plan ${report.subject?.manifestHash?.slice(0, 12) ?? "(none)"}…, ` +
            `not ${expected.slice(0, 12)}…`,
        );
      }
    },
  };
}

/** Read a document from the CAS when the hash is real and present. */
function optional<T>(
  storage: BlobStore,
  hash: string,
  load: (storage: BlobStore, hash: string) => T,
): { doc: T; hash: string } | undefined {
  if (!/^[0-9a-f]{64}$/u.test(hash) || !storage.has(hash)) return undefined;
  try {
    return { doc: load(storage, hash), hash };
  } catch {
    return undefined;
  }
}

function upstreamHash(ctx: TaskContext, stage: string, key: string): string | undefined {
  const output = (ctx.upstream as Record<string, unknown>)[stage];
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
