import type { ArtifactKind, EpisodeState, JobState, StepState } from "@nexus/db";

import { ConfigurationError } from "./errors.js";

/**
 * The stage graph — the canonical pipeline definitions, versioned in code
 * (AD-05: "pipelines are versioned DAGs of idempotent steps"). The pipeline
 * id embeds its version (`longform_v1`), so shipping `longform_v2` later is a
 * deploy, not a migration.
 *
 * Every stage declares:
 * - `key` — persisted as `pipeline_job_steps.step_key`;
 * - `runningLabel` / `completeLabel` — the operator vocabulary for the stage
 *   while it runs and once it has produced its artifacts. This is where the
 *   requested `RESEARCHING` / `RESEARCH_COMPLETE` pairs live (docs table:
 *   docs/architecture/job-orchestration.md);
 * - `episodeStateOnStart` / `episodeStateOnComplete` — how the coarse episode
 *   lifecycle moves while the stage runs;
 * - `produces` — artifact KINDS the stage is expected to yield (declarative:
 *   used by status views and by the Phase 4 pipeline engine);
 * - `reusable` — whether a finished identical output may be adopted instead of
 *   re-executing (see runner.ts);
 * - `gate` (optional) — the stage parks the job until an operator decides.
 */

export interface StageDef {
  readonly key: string;
  readonly label: string;
  readonly runningLabel: string;
  readonly completeLabel: string;
  readonly failedLabel?: string;
  readonly waitingLabel?: string;
  readonly episodeStateOnStart: EpisodeState;
  readonly episodeStateOnComplete: EpisodeState;
  readonly produces: readonly ArtifactKind[];
  /** Adopt an existing identical artifact instead of re-running (default true). */
  readonly reusable?: boolean;
  /** Park the job at this gate until an approval is recorded for it. */
  readonly gate?: string;
  /** Retry ceiling for this stage (fallback: the job's max_attempts). */
  readonly maxAttempts?: number;
}

export interface PipelineDef {
  readonly id: string;
  readonly label: string;
  readonly episodeKind: "long" | "short";
  readonly stages: readonly StageDef[];
}

const stage = (def: StageDef): StageDef => ({ reusable: true, ...def });

export const LONG_FORM_PIPELINE: PipelineDef = {
  id: "longform_v1",
  label: "Long-form episode",
  episodeKind: "long",
  stages: [
    stage({
      key: "idea",
      label: "Idea",
      runningLabel: "IDEA",
      completeLabel: "IDEA_COMPLETE",
      episodeStateOnStart: "QUEUED",
      episodeStateOnComplete: "RESEARCHING",
      produces: [],
    }),
    stage({
      key: "research",
      label: "Research",
      runningLabel: "RESEARCHING",
      completeLabel: "RESEARCH_COMPLETE",
      episodeStateOnStart: "RESEARCHING",
      episodeStateOnComplete: "FACT_CHECKING",
      produces: ["document"],
    }),
    stage({
      key: "fact_check",
      label: "Fact check",
      runningLabel: "FACT_CHECKING",
      completeLabel: "FACT_CHECK_COMPLETE",
      episodeStateOnStart: "FACT_CHECKING",
      // A stage may park the job at an extra gate (e.g. FACT_REVIEW) when it
      // finds unsupported claims — see TaskResult.waiting.
      episodeStateOnComplete: "SCRIPTING",
      produces: ["document"],
    }),
    stage({
      key: "script",
      label: "Script",
      runningLabel: "SCRIPTING",
      completeLabel: "SCRIPT_COMPLETE",
      episodeStateOnStart: "SCRIPTING",
      episodeStateOnComplete: "SCENE_PLANNING",
      produces: ["script"],
    }),
    stage({
      key: "plan",
      label: "Plan",
      runningLabel: "PLANNING",
      completeLabel: "PLAN_COMPLETE",
      episodeStateOnStart: "SCENE_PLANNING",
      episodeStateOnComplete: "MEDIA_GATHERING",
      produces: ["scene_graph"],
    }),
    stage({
      key: "source_media",
      label: "Source media",
      runningLabel: "SOURCING_MEDIA",
      completeLabel: "MEDIA_COMPLETE",
      episodeStateOnStart: "MEDIA_GATHERING",
      episodeStateOnComplete: "VOICE_SYNTHESIS",
      // The resolution report is the stage's declared deliverable; the
      // media-resolved manifest it publishes is already declared by `plan`
      // (kind `scene_graph`). Placeholder *plates* are drawn procedurally by
      // the renderer, so no image bytes exist to register, and sourced
      // image/video assets arrive with the real media engine (plan-Phase 3) —
      // declaring them now would make every episode fail QA for artifacts
      // nothing can produce yet.
      produces: ["document"],
    }),
    stage({
      key: "voice",
      label: "Voice",
      runningLabel: "GENERATING_VOICE",
      completeLabel: "VOICE_COMPLETE",
      episodeStateOnStart: "VOICE_SYNTHESIS",
      episodeStateOnComplete: "CAPTIONING",
      produces: ["audio"],
    }),
    stage({
      key: "captions",
      label: "Captions",
      runningLabel: "CAPTIONING",
      completeLabel: "CAPTIONS_COMPLETE",
      episodeStateOnStart: "CAPTIONING",
      episodeStateOnComplete: "COMPOSITING",
      produces: ["captions"],
    }),
    stage({
      key: "animate",
      label: "Animation",
      runningLabel: "BUILDING_ANIMATION",
      completeLabel: "ANIMATION_COMPLETE",
      episodeStateOnStart: "COMPOSITING",
      episodeStateOnComplete: "RENDERING",
      // The animation timeline is not a separate artifact in the shipped
      // architecture: the render pipeline folds the manifest's events
      // deterministically (Phase 9 fold inside `renderVideo`), so this stage
      // hands the media-resolved manifest forward. It produces no images.
      produces: ["scene_graph"],
    }),
    stage({
      key: "render",
      label: "Render",
      runningLabel: "RENDERING",
      completeLabel: "RENDER_COMPLETE",
      episodeStateOnStart: "RENDERING",
      episodeStateOnComplete: "QA",
      produces: ["video", "thumbnail"],
    }),
    stage({
      key: "qa",
      label: "QA",
      runningLabel: "QA",
      completeLabel: "QA_COMPLETE",
      episodeStateOnStart: "QA",
      episodeStateOnComplete: "APPROVAL",
      produces: ["qa_report"],
    }),
    stage({
      key: "approval",
      label: "Approval",
      runningLabel: "APPROVAL",
      waitingLabel: "AWAITING_APPROVAL",
      completeLabel: "APPROVED",
      episodeStateOnStart: "APPROVAL",
      episodeStateOnComplete: "READY",
      produces: [],
      gate: "FINAL_APPROVAL",
    }),
    stage({
      key: "publish",
      label: "Publish",
      runningLabel: "PUBLISHING",
      completeLabel: "PUBLISHED",
      episodeStateOnStart: "PUBLISHING",
      episodeStateOnComplete: "PUBLISHED",
      produces: ["metadata", "document"],
    }),
  ],
};

export const SHORTS_PIPELINE: PipelineDef = {
  id: "shorts_v1",
  label: "Short (vertical clip)",
  episodeKind: "short",
  stages: [
    stage({
      key: "short_analyze",
      label: "Analyze",
      runningLabel: "SHORT_ANALYZING",
      completeLabel: "CANDIDATES_FOUND",
      episodeStateOnStart: "QUEUED",
      episodeStateOnComplete: "SCENE_PLANNING",
      produces: ["document"],
    }),
    stage({
      key: "short_select",
      label: "Select",
      runningLabel: "SELECTING",
      completeLabel: "SELECTION_COMPLETE",
      episodeStateOnStart: "SCENE_PLANNING",
      episodeStateOnComplete: "SCRIPTING",
      produces: ["metadata"],
    }),
    stage({
      key: "short_rewrite",
      label: "Rewrite",
      runningLabel: "REWRITING",
      completeLabel: "REWRITE_COMPLETE",
      episodeStateOnStart: "SCRIPTING",
      episodeStateOnComplete: "COMPOSITING",
      produces: ["script"],
    }),
    stage({
      key: "short_layout",
      label: "Vertical layout",
      runningLabel: "VERTICAL_LAYOUT",
      completeLabel: "LAYOUT_COMPLETE",
      episodeStateOnStart: "COMPOSITING",
      episodeStateOnComplete: "RENDERING",
      produces: ["scene_graph"],
    }),
    stage({
      key: "short_render",
      label: "Render",
      runningLabel: "RENDERING",
      completeLabel: "RENDER_COMPLETE",
      episodeStateOnStart: "RENDERING",
      episodeStateOnComplete: "QA",
      produces: ["video", "thumbnail"],
    }),
    stage({
      key: "short_qa",
      label: "QA",
      runningLabel: "QA",
      completeLabel: "QA_COMPLETE",
      episodeStateOnStart: "QA",
      episodeStateOnComplete: "APPROVAL",
      produces: ["qa_report"],
    }),
    stage({
      key: "short_approval",
      label: "Approval",
      runningLabel: "APPROVAL",
      waitingLabel: "AWAITING_APPROVAL",
      completeLabel: "SHORT_APPROVED",
      episodeStateOnStart: "APPROVAL",
      episodeStateOnComplete: "READY",
      produces: [],
      gate: "SHORT_APPROVAL",
    }),
    stage({
      key: "short_publish",
      label: "Publish",
      runningLabel: "PUBLISHING",
      completeLabel: "PUBLISHED",
      episodeStateOnStart: "PUBLISHING",
      episodeStateOnComplete: "PUBLISHED",
      produces: ["metadata", "document"],
    }),
  ],
};

export const PIPELINES: readonly PipelineDef[] = [LONG_FORM_PIPELINE, SHORTS_PIPELINE];

export function findPipeline(pipelineId: string): PipelineDef | undefined {
  return PIPELINES.find((pipeline) => pipeline.id === pipelineId);
}

export function requirePipeline(pipelineId: string): PipelineDef {
  const pipeline = findPipeline(pipelineId);
  if (!pipeline) {
    throw new ConfigurationError(
      `Unknown pipeline '${pipelineId}'. Known pipelines: ${PIPELINES.map((p) => p.id).join(", ")}. ` +
        "Pipeline definitions are versioned in code (packages/jobs/src/stages.ts).",
    );
  }
  return pipeline;
}

export function requireStage(pipelineId: string, stageKey: string): StageDef {
  const pipeline = requirePipeline(pipelineId);
  const found = pipeline.stages.find((s) => s.key === stageKey);
  if (!found) {
    throw new ConfigurationError(
      `Pipeline '${pipelineId}' has no stage '${stageKey}'. Declared stages: ` +
        `${pipeline.stages.map((s) => s.key).join(", ")}.`,
    );
  }
  return found;
}

export const stageKeys = (pipeline: PipelineDef): string[] => pipeline.stages.map((s) => s.key);

/** True when the stage's own artifacts may be adopted from a previous run. */
export const isReusable = (stage: StageDef): boolean => stage.reusable !== false;

/**
 * How far a stage got, which is what the operator vocabulary actually
 * describes. "In flight" is derived, never stored: a step is running when its
 * job is RUNNING and the step has been started (`started_at`) but not finished.
 */
export interface StageProgress {
  readonly state: StepState;
  readonly started: boolean;
  readonly jobState: JobState;
}

export const isStageInFlight = (progress: StageProgress): boolean =>
  progress.state === "PENDING" && progress.started && progress.jobState === "RUNNING";

/**
 * The operator-facing label for a stage: `RESEARCHING` while it runs,
 * `RESEARCH_COMPLETE` once its artifacts exist, `AWAITING_APPROVAL` at a gate,
 * `RENDERING_INTERRUPTED` when a crash left it mid-flight.
 */
export function stageStateLabel(stage: StageDef, progress: StageProgress): string {
  switch (progress.state) {
    case "DONE":
      return stage.completeLabel;
    case "WAITING":
      return stage.waitingLabel ?? "WAITING";
    case "FAILED":
      return stage.failedLabel ?? `${stage.runningLabel}_FAILED`;
    case "PENDING":
      if (isStageInFlight(progress)) return stage.runningLabel;
      if (progress.started) return `${stage.runningLabel}_INTERRUPTED`;
      return `${stage.runningLabel}_PENDING`;
  }
}
