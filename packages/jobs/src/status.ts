import type { ArtifactRef, JobLogRow, JobStatus, PipelineJobRow, Repo, StepState } from "@nexus/db";

import { requirePipeline, stageStateLabel, type StageDef } from "./stages.js";

/**
 * Read-only status projection for operators and the dashboard. It never
 * mutates: everything here is derived from the job row, its stage rows and the
 * log, which keeps "what is the system doing?" answerable without a second
 * source of truth.
 */

export interface StageStatusView {
  readonly key: string;
  readonly label: string;
  readonly index: number;
  readonly state: StepState;
  /** Operator vocabulary: `RESEARCHING`, `RESEARCH_COMPLETE`, `AWAITING_APPROVAL`, … */
  readonly stateLabel: string;
  readonly attempt: number;
  readonly fingerprint: string | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly reusedFrom: { readonly jobId: string; readonly stepKey: string } | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface JobStatusView {
  readonly id: string;
  readonly episodeId: string;
  readonly pipeline: string;
  /** Stored state (`PENDING`/`RUNNING`/…) — the machine's own vocabulary. */
  readonly state: PipelineJobRow["state"];
  /**
   * Operator-facing status: the stored state, plus `RETRYING` for a PENDING
   * job whose next attempt is scheduled in the future.
   */
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string | null;
  readonly waitingGate: string | null;
  readonly error: string | null;
  readonly errorKind: PipelineJobRow["error_kind"];
  readonly failureStep: string | null;
  readonly inputFingerprint: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The stage to look at: the running one, else the first unfinished one. */
  readonly currentStage: {
    readonly key: string;
    readonly label: string;
    readonly stateLabel: string;
  } | null;
  readonly steps: readonly StageStatusView[];
  readonly logs: readonly JobLogRow[];
}

export function deriveJobStatus(job: PipelineJobRow, now: Date = new Date()): JobStatus {
  if (
    job.state === "PENDING" &&
    job.next_attempt_at !== null &&
    job.next_attempt_at > now.toISOString()
  ) {
    return "RETRYING";
  }
  return job.state;
}

const parseArtifacts = (raw: string): ArtifactRef[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ArtifactRef[]) : [];
  } catch {
    return [];
  }
};

export function getJobStatus(
  repo: Repo,
  jobId: string,
  options: { now?: Date; logLimit?: number } = {},
): JobStatusView {
  const job = repo.requireJob(jobId);
  const pipeline = requirePipeline(job.pipeline);
  const stageByKey = new Map<string, StageDef>(pipeline.stages.map((stage) => [stage.key, stage]));

  const steps: StageStatusView[] = repo.listJobSteps(job.id).map((step) => {
    const stage = stageByKey.get(step.step_key);
    return {
      key: step.step_key,
      label: stage?.label ?? step.step_key,
      index: step.idx,
      state: step.state,
      stateLabel: stage
        ? stageStateLabel(stage, {
            state: step.state,
            started: step.started_at !== null,
            jobState: job.state,
          })
        : step.state,
      attempt: step.attempt,
      fingerprint: step.input_hash,
      artifacts: parseArtifacts(step.artifacts),
      reusedFrom:
        step.reused_from_job_id !== null
          ? { jobId: step.reused_from_job_id, stepKey: step.reused_from_step_key ?? "" }
          : null,
      startedAt: step.started_at,
      finishedAt: step.finished_at,
      error: step.error,
    };
  });

  // The stage to look at: the first unfinished one when it is in flight, else
  // the first blocked/failed/unfinished stage, else the last one touched.
  const firstUnfinished = steps.findIndex((step) => step.state !== "DONE");
  const candidate = firstUnfinished >= 0 ? steps[firstUnfinished] : undefined;
  const inFlight =
    candidate?.state === "PENDING" && candidate.startedAt !== null && job.state === "RUNNING"
      ? candidate
      : undefined;
  const current =
    inFlight ??
    steps.find((step) => step.state === "WAITING") ??
    steps.find((step) => step.state === "FAILED") ??
    steps.find((step) => step.state === "PENDING") ??
    steps.at(-1);

  return {
    id: job.id,
    episodeId: job.episode_id,
    pipeline: job.pipeline,
    state: job.state,
    status: deriveJobStatus(job, options.now),
    attempt: job.attempt,
    maxAttempts: job.max_attempts,
    nextAttemptAt: job.next_attempt_at,
    waitingGate: job.waiting_gate,
    error: job.error,
    errorKind: job.error_kind,
    failureStep: job.failure_step,
    inputFingerprint: job.input_fingerprint,
    leaseOwner: job.lease_owner,
    leaseExpiresAt: job.lease_expires_at,
    heartbeatAt: job.heartbeat_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    currentStage: current
      ? { key: current.key, label: current.label, stateLabel: current.stateLabel }
      : null,
    steps,
    logs: repo.listJobLogs(job.id, { limit: options.logLimit ?? 50 }),
  };
}
