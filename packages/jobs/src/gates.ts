import type { ApprovalRow, Repo } from "@nexus/db";

import { ConfigurationError } from "./errors.js";
import { assertJobTransition } from "./machines.js";
import { requirePipeline } from "./stages.js";

/**
 * Gate resolution — the operator side of a paused job (AD-08).
 *
 * A gate is satisfied only by an approval carrying the fingerprint of the
 * content that was actually parked. Resuming recomputes that fingerprint from
 * current content, so if anything upstream changed while the operator was
 * looking away, the old approval no longer matches and the job parks again.
 * That is the structural fix for "approved v3, published v4".
 */

export type GateDecision = "approved" | "rejected" | "needs_changes";

export interface ResolveGateInput {
  readonly decision: GateDecision;
  /** Optional: refuse to record the decision if the parked content changed. */
  readonly fingerprint?: string;
  readonly notes?: string;
  readonly reviewedBy?: string;
  /**
   * For `needs_changes`: the stage to rewind to. That stage and every stage
   * after it is invalidated, then the job resumes from there — so a re-take of
   * one sentence does not re-render the whole pipeline.
   */
  readonly targetStage?: string;
}

export interface ResolveGateResult {
  readonly jobId: string;
  readonly gate: string;
  readonly decision: GateDecision;
  readonly fingerprint: string;
  readonly approval: ApprovalRow;
  /** Stages reset to PENDING by a `needs_changes` decision. */
  readonly invalidatedStages: readonly string[];
}

export function resolveGate(repo: Repo, jobId: string, input: ResolveGateInput): ResolveGateResult {
  const job = repo.requireJob(jobId);
  if (job.state !== "WAITING_GATE" || !job.waiting_gate) {
    throw new ConfigurationError(
      `Job ${jobId} is ${job.state}, not waiting at a gate — nothing to resolve.`,
    );
  }
  const gate = job.waiting_gate;
  const pipeline = requirePipeline(job.pipeline);

  const waitingStep = repo.listJobSteps(jobId).find((step) => step.state === "WAITING");
  if (!waitingStep) {
    throw new ConfigurationError(`Job ${jobId} is WAITING_GATE (${gate}) but no stage is WAITING.`);
  }
  const parkedFingerprint = waitingStep.input_hash;
  if (!parkedFingerprint) {
    throw new ConfigurationError(
      `Stage ${waitingStep.step_key} of job ${jobId} is WAITING without a fingerprint; ` +
        "an approval cannot be bound to unknown content.",
    );
  }
  if (input.fingerprint !== undefined && input.fingerprint !== parkedFingerprint) {
    throw new ConfigurationError(
      `Refusing to resolve ${gate}: supplied fingerprint does not match the parked content ` +
        `(${input.fingerprint} ≠ ${parkedFingerprint}). The episode changed since the gate was shown.`,
    );
  }

  const approval = repo.recordApproval({
    subjectType: "episode",
    subjectId: job.episode_id,
    gate,
    decision: input.decision,
    fingerprint: parkedFingerprint,
    notes: input.notes,
    reviewedBy: input.reviewedBy,
  });

  if (input.decision === "rejected") {
    repo.failStep(jobId, waitingStep.step_key, `gate ${gate} rejected by operator`);
    assertJobTransition(job.state, "CANCELED");
    repo.cancelJob(jobId, `Gate ${gate} rejected: ${input.notes ?? "(no notes)"}`);
    repo.setEpisodeState(job.episode_id, "NEEDS_CHANGES", `Gate ${gate} rejected`);
    repo.logJob({
      jobId,
      stepKey: waitingStep.step_key,
      level: "warn",
      event: "gate.rejected",
      message: input.notes ?? `rejected at ${gate}`,
      data: { gate, decision: input.decision },
    });
    return {
      jobId,
      gate,
      decision: input.decision,
      fingerprint: parkedFingerprint,
      approval,
      invalidatedStages: [],
    };
  }

  let invalidated: string[] = [];
  if (input.decision === "needs_changes") {
    const target = input.targetStage?.trim();
    if (!target) {
      throw new ConfigurationError(
        "A needs_changes decision must name the stage to rewind to (targetStage).",
      );
    }
    if (!pipeline.stages.some((stage) => stage.key === target)) {
      throw new ConfigurationError(
        `Pipeline '${pipeline.id}' has no stage '${target}'. Known stages: ` +
          `${pipeline.stages.map((s) => s.key).join(", ")}.`,
      );
    }
    repo.invalidateFromStep(jobId, target);
    invalidated = repo
      .listJobSteps(jobId)
      .filter((step) => step.state === "PENDING")
      .map((step) => step.step_key);
    repo.logJob({
      jobId,
      stepKey: waitingStep.step_key,
      level: "warn",
      event: "gate.needs_changes",
      message: `rewinding to ${target}: ${input.notes ?? "(no notes)"}`,
      data: { gate, targetStage: target, invalidated: invalidated.join(",") },
    });
  } else {
    repo.logJob({
      jobId,
      stepKey: waitingStep.step_key,
      event: "gate.approved",
      message: `${gate} approved by ${approval.reviewed_by}`,
      data: { gate, fingerprint: parkedFingerprint },
    });
  }

  assertJobTransition(repo.requireJob(jobId).state, "PENDING");
  // The operator's decision must be claimable immediately: a stale backoff
  // window from the failed attempts would silently delay the rewind.
  repo.setJobState(jobId, "PENDING", { resetRetry: true });
  return {
    jobId,
    gate,
    decision: input.decision,
    fingerprint: parkedFingerprint,
    approval,
    invalidatedStages: invalidated,
  };
}

/** Operator retry for a FAILED job: clears the failure and re-enters the pipeline. */
export function retryFailedJob(repo: Repo, jobId: string): void {
  const job = repo.requireJob(jobId);
  if (job.state !== "FAILED") {
    throw new ConfigurationError(`Job ${jobId} is ${job.state}; only FAILED jobs can be retried.`);
  }
  assertJobTransition(job.state, "PENDING");
  // The operator's decision must be claimable immediately: a stale backoff
  // window from the failed attempts would silently delay (or, for the worker
  // loop, appear to ignore) the retry.
  repo.setJobState(jobId, "PENDING", { resetRetry: true });
  const episode = repo.requireEpisode(job.episode_id);
  if (episode.state === "FAILED") {
    // FAILED → the failed stage's own state is legal; the runner re-enters it.
    repo.setEpisodeState(episode.id, "NEEDS_CHANGES", null);
  }
  repo.logJob({
    jobId,
    event: "job.retry_requested",
    message: `operator retry after failure at ${job.failure_step ?? "unknown stage"}`,
    data: { failureStep: job.failure_step },
  });
}
