import {
  type ArtifactRef,
  type CompletedStageRun,
  type EpisodeRow,
  type EpisodeState,
  type JobStepRow,
  type PipelineJobRow,
  type Repo,
} from "@nexus/db";

import { ConfigurationError, PermanentError, classifyError, errorMessage } from "./errors.js";
import { hashInputs, stageFingerprint } from "./fingerprint.js";
import { assertEpisodeTransition, assertJobTransition, assertStepTransition } from "./machines.js";
import { decideRetry, resolveRetryPolicy } from "./retry.js";
import { isReusable, requirePipeline, type PipelineDef, type StageDef } from "./stages.js";
import type { RunJobOutcome, RunnerDeps, TaskContext } from "./types.js";

/**
 * The execution engine. It owns everything a task must not: claim/lease state,
 * stage ordering, fingerprints, artifact reuse, retries, gates, logs and
 * episode state transitions.
 *
 * Contract in one sentence: **a stage runs at most once per fingerprint**, and
 * every run is checkpointed, so a crash, a retry or a fresh job resumes from
 * the last completed stage instead of redoing work.
 */
export async function runJob(deps: RunnerDeps, jobId: string): Promise<RunJobOutcome> {
  const { repo } = deps;
  const job = repo.requireJob(jobId);
  const log = (event: string, data?: Record<string, unknown>): void => {
    const failed = event.endsWith(".failed") || event.endsWith(".rejected");
    deps.logger?.({ level: failed ? "warn" : "info", event, jobId: job.id, ...data });
  };

  // A finished job is never re-executed — the bluntest form of
  // duplicate-execution prevention (a re-submitted idempotency key lands here).
  if (job.state === "DONE" || job.state === "CANCELED") {
    return { status: "skipped", jobId: job.id, reason: `job is ${job.state}` };
  }

  // A FAILED job is a *decision*, not a resume point: the operator retries it
  // (which moves it back to PENDING) or starts a new run that adopts its
  // completed stages. Executing one in place would bypass the attempt
  // bookkeeping and die on the FAILED → DONE transition mid-run.
  if (job.state === "FAILED") {
    return {
      status: "skipped",
      jobId: job.id,
      reason: "job is FAILED — retry it or start a new run",
    };
  }

  // Attempts are counted per claim: a job that comes back after its ceiling was
  // already reached (requeued, then the process died) fails here rather than
  // burning another attempt.
  if (job.attempt > job.max_attempts) {
    const error = `Retry ceiling reached (${job.max_attempts} attempts)`;
    repo.failJob(job.id, {
      error,
      errorKind: "exhausted",
      failureStep: job.failure_step ?? undefined,
    });
    repo.logJob({
      jobId: job.id,
      level: "error",
      event: "job.failed",
      message: error,
      data: { errorKind: "exhausted" },
    });
    log("job.failed", { errorKind: "exhausted", attempts: job.attempt });
    return {
      status: "failed",
      jobId: job.id,
      error,
      errorKind: "exhausted",
      stepKey: job.failure_step ?? "",
    };
  }

  const pipeline = requirePipeline(job.pipeline);
  const declared = repo.listJobSteps(job.id);
  const unknown = declared.filter((step) => !pipeline.stages.some((s) => s.key === step.step_key));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `Job ${job.id} declares step(s) that pipeline '${job.pipeline}' does not define: ` +
        `${unknown.map((s) => s.step_key).join(", ")}`,
    );
  }
  // Execute in the pipeline's declared order, restricted to this job's steps.
  const stages = pipeline.stages.filter((stage) =>
    declared.some((step) => step.step_key === stage.key),
  );
  deps.tasks.assertCovers({ ...pipeline, stages });

  const episode = repo.requireEpisode(job.episode_id);
  const inputs = jobInputs(episode, job, deps.params);
  const inputFingerprint = hashInputs(inputs);
  if (job.input_fingerprint !== inputFingerprint) {
    repo.setJobInputFingerprint(job.id, inputFingerprint);
  }

  const upstream: Record<string, unknown> = {};

  for (const [index, stage] of stages.entries()) {
    // Graceful shutdown: stop *between* stages, never mid-checkpoint. The job
    // stays RUNNING with a live lease; when the lease expires another worker
    // reclaims it and resumes from the checkpoints already written.
    if (deps.signal?.aborted) {
      repo.logJob({
        jobId: job.id,
        stepKey: stage.key,
        level: "warn",
        event: "job.abandoned",
        message: "worker stopped mid-run; another worker will resume from the last checkpoint",
        data: { nextStage: stage.key },
      });
      log("job.abandoned", { stageKey: stage.key });
      return { status: "skipped", jobId: job.id, reason: "worker shutting down" };
    }

    const fingerprint = stageFingerprint({
      pipeline: pipeline.id,
      stageKey: stage.key,
      inputs: { job: inputs, upstream },
      config: deps.params ?? null,
    });
    const step = repo.requireStep(job.id, stage.key);

    // ── Resume: a completed stage with unchanged inputs is not re-executed ──
    if (step.state === "DONE" && step.input_hash === fingerprint) {
      upstream[stage.key] = parseOutput(step.output);
      repo.logJob({
        jobId: job.id,
        stepKey: stage.key,
        event: "stage.skipped.completed",
        message: `${stage.runningLabel} already completed for this fingerprint`,
        data: { fingerprint },
      });
      continue;
    }

    // ── Content changed upstream: this stage and its dependents are stale ───
    if (step.state === "DONE" && step.input_hash !== fingerprint) {
      assertStepTransition(step.state, "PENDING");
      repo.invalidateFromStep(job.id, stage.key);
      repo.logJob({
        jobId: job.id,
        stepKey: stage.key,
        level: "warn",
        event: "stage.invalidated",
        message: "upstream content changed; this stage and its dependents will re-run",
        data: { previousFingerprint: step.input_hash, fingerprint },
      });
    }

    const current = repo.requireStep(job.id, stage.key);

    // ── Human / external gate ───────────────────────────────────────────────
    if (stage.gate || current.state === "WAITING") {
      const gate = stage.gate ?? job.waiting_gate ?? "GATE";
      const approval = repo.latestValidApproval("episode", episode.id, fingerprint);
      if (!approval) {
        return parkForGate(deps, job, stage, fingerprint, gate, log);
      }
      assertStepTransition(current.state, "DONE");
      // One output object for BOTH the checkpoint and the in-memory upstream:
      // if the two ever diverge, the next pass recomputes a different
      // downstream fingerprint and re-runs stages that did not change.
      const output = {
        gate,
        decision: approval.decision,
        fingerprint,
        reviewedBy: approval.reviewed_by,
        notes: approval.notes,
      };
      repo.checkpointStep(job.id, stage.key, {
        inputHash: fingerprint,
        output,
        // Artifacts the task declared when it parked (e.g. the review document
        // a fact-check gates on) belong to the completed step, not to nobody.
        artifacts: parseStepArtifacts(current.artifacts),
      });
      repo.logJob({
        jobId: job.id,
        stepKey: stage.key,
        event: "gate.approved",
        message: `${gate} approved by ${approval.reviewed_by}`,
        data: { decision: approval.decision, fingerprint },
      });
      setEpisodeState(deps, job, episode, stage.episodeStateOnComplete, log);
      upstream[stage.key] = output;
      continue;
    }

    const task = deps.tasks.get(stage.key);
    if (!task) throw new ConfigurationError(`No task registered for stage '${stage.key}'`);

    // ── Artifact reuse: adopt an identical completed stage instead of running ──
    if (isReusable(stage)) {
      const adopted = await tryAdopt(deps, job, episode, pipeline, stage, fingerprint, current);
      if (adopted) {
        repo.logJob({
          jobId: job.id,
          stepKey: stage.key,
          event: "stage.reused",
          message: `reused ${adopted.artifacts.length} artifact(s) from job ${adopted.jobId} (no execution)`,
          data: {
            fromJobId: adopted.jobId,
            artifacts: adopted.artifacts.map((a) => a.hash),
            fingerprint,
          },
        });
        repo.appendAudit({
          action: "stage.reused",
          subjectType: "episode",
          subjectId: episode.id,
          detail: { stage: stage.key, fromJobId: adopted.jobId, fingerprint },
        });
        // An adopted stage moves the episode exactly like an executed one —
        // including the entry state, so a reused run walks the same path
        // (READY -> PUBLISHING -> PUBLISHED) instead of trying to jump it.
        setEpisodeState(deps, job, episode, stage.episodeStateOnStart, log);
        setEpisodeState(deps, job, episode, stage.episodeStateOnComplete, log);
        upstream[stage.key] = parseOutput(adopted.output);
        continue;
      }
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    setEpisodeState(deps, job, episode, stage.episodeStateOnStart, log);
    assertStepTransition(current.state, "PENDING"); // start (or restart) the stage
    const running = repo.startStep(job.id, stage.key);
    repo.logJob({
      jobId: job.id,
      stepKey: stage.key,
      event: "stage.started",
      message: `executing ${stage.runningLabel} (attempt ${running.attempt})`,
      data: { attempt: running.attempt, fingerprint, index, total: stages.length },
    });
    log("stage.started", { stageKey: stage.key, attempt: running.attempt });

    let result: Awaited<ReturnType<typeof task.execute>>;
    try {
      result = await withHeartbeat(deps, job.id, () =>
        task.execute(
          buildContext(deps, job, episode, pipeline, stage, fingerprint, inputs, upstream),
        ),
      );
    } catch (error) {
      return handleStageFailure(deps, repo.requireJob(job.id), episode, stage, running, error, log);
    }

    // A task may park itself at a gate (unsupported claims, exhausted quota).
    if (result && result.waiting) {
      return parkForGate(
        deps,
        repo.requireJob(job.id),
        stage,
        fingerprint,
        result.waiting,
        log,
        result.waitingReason,
        result.artifacts,
      );
    }

    const artifacts = result?.artifacts ?? [];
    assertArtifactsRegistered(repo, job.id, stage.key, artifacts);
    assertStepTransition("PENDING", "DONE");
    const finished = repo.checkpointStep(job.id, stage.key, {
      inputHash: fingerprint,
      output: result?.output ?? {},
      artifacts,
    });
    repo.logJob({
      jobId: job.id,
      stepKey: stage.key,
      event: "stage.completed",
      message: `${stage.completeLabel} (${artifacts.length} artifact(s))`,
      data: { fingerprint, artifacts: artifacts.map((a) => a.hash), attempts: finished.attempt },
    });
    log("stage.completed", { stageKey: stage.key, artifacts: artifacts.length });
    setEpisodeState(deps, job, episode, stage.episodeStateOnComplete, log);
    upstream[stage.key] = result?.output ?? {};
  }

  assertJobTransition(repo.requireJob(job.id).state, "DONE");
  repo.setJobState(job.id, "DONE");
  repo.logJob({ jobId: job.id, event: "job.completed", message: `${pipeline.label} finished` });
  log("job.completed", { pipeline: pipeline.id });
  return { status: "completed", jobId: job.id };
}

/** The step row stores artifacts as a JSON array string; parse it defensively. */
function parseStepArtifacts(json: string): readonly ArtifactRef[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as readonly ArtifactRef[]) : [];
}

// ── helpers ─────────────────────────────────────────────────────────────────

function buildContext(
  deps: RunnerDeps,
  job: PipelineJobRow,
  episode: EpisodeRow,
  pipeline: PipelineDef,
  stage: StageDef,
  fingerprint: string,
  inputs: Record<string, unknown>,
  upstream: Record<string, unknown>,
): TaskContext {
  return {
    job: deps.repo.requireJob(job.id),
    episode,
    stage,
    pipeline,
    inputs: { job: inputs, upstream },
    upstream,
    fingerprint,
    signal: deps.signal ?? new AbortController().signal,
    log: (event, message, data) =>
      void deps.repo.logJob({ jobId: job.id, stepKey: stage.key, event, message, data }),
  };
}

function jobInputs(
  episode: EpisodeRow,
  job: PipelineJobRow,
  params: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return {
    episodeKind: episode.kind,
    topic: episode.topic,
    outline: JSON.parse(episode.outline) as unknown,
    parentEpisodeId: episode.parent_episode_id,
    projectId: episode.project_id,
    pipeline: job.pipeline,
    // `params` is part of the fingerprint on purpose: changing a provider or a
    // template version must invalidate the stages that used it.
    params: params ?? {},
  };
}

function parseOutput(output: string | null): unknown {
  if (output === null) return {};
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return {};
  }
}

function assertArtifactsRegistered(
  repo: Repo,
  jobId: string,
  stageKey: string,
  artifacts: readonly ArtifactRef[],
): void {
  for (const artifact of artifacts) {
    if (!repo.getArtifact(artifact.hash)) {
      throw new ConfigurationError(
        `Stage ${stageKey} (job ${jobId}) returned artifact ${artifact.hash} which is not registered in ` +
          "the artifacts table. Register it (kind + bytes + meta) before returning it.",
      );
    }
  }
}

function artifactsUsable(
  deps: RunnerDeps,
  artifacts: readonly ArtifactRef[],
): { ok: true } | { ok: false; reason: string } {
  for (const artifact of artifacts) {
    if (!deps.repo.getArtifact(artifact.hash)) {
      return { ok: false, reason: `artifact ${artifact.hash} is not registered` };
    }
    if (deps.artifactExists && !deps.artifactExists(artifact.hash)) {
      return { ok: false, reason: `artifact ${artifact.hash} is missing from the store` };
    }
  }
  return { ok: true };
}

/**
 * Adopt a previously completed identical stage. Refuses (and logs why) when an
 * artifact cannot be accounted for, or when the task's own `validateReuse`
 * rejects the output — in both cases the stage simply executes normally.
 */
async function tryAdopt(
  deps: RunnerDeps,
  job: PipelineJobRow,
  episode: EpisodeRow,
  pipeline: PipelineDef,
  stage: StageDef,
  fingerprint: string,
  step: JobStepRow,
): Promise<CompletedStageRun | undefined> {
  const candidate = deps.repo.findCompletedStageRun(fingerprint, stage.key, job.id);
  if (!candidate) return undefined;

  const reject = (reason: string): undefined => {
    deps.repo.logJob({
      jobId: job.id,
      stepKey: stage.key,
      level: "warn",
      event: "stage.reuse.rejected",
      message: `not reusing ${stage.key} from job ${candidate.jobId}: ${reason}`,
      data: { fromJobId: candidate.jobId, fingerprint, reason },
    });
    return undefined;
  };

  const usable = artifactsUsable(deps, candidate.artifacts);
  if (!usable.ok) return reject(usable.reason);

  const task = deps.tasks.get(stage.key);
  if (task?.validateReuse) {
    try {
      await task.validateReuse(
        buildContext(deps, job, episode, pipeline, stage, fingerprint, {}, {}),
        candidate,
      );
    } catch (error) {
      return reject(`task refused the reusable output: ${errorMessage(error)}`);
    }
  }

  assertStepTransition(step.state, "DONE");
  deps.repo.checkpointStep(job.id, stage.key, {
    inputHash: fingerprint,
    output: parseOutput(candidate.output),
    artifacts: candidate.artifacts,
    reusedFrom: { jobId: candidate.jobId, stepKey: candidate.stepKey },
  });
  return candidate;
}

function parkForGate(
  deps: RunnerDeps,
  job: PipelineJobRow,
  stage: StageDef,
  fingerprint: string,
  gate: string,
  log: (event: string, data?: Record<string, unknown>) => void,
  reason?: string,
  artifacts?: readonly ArtifactRef[],
): RunJobOutcome {
  const step = deps.repo.requireStep(job.id, stage.key);
  assertStepTransition(step.state, "WAITING");
  deps.repo.waitStep(job.id, stage.key, { gate, fingerprint, ...(artifacts ? { artifacts } : {}) });
  assertJobTransition(job.state, "WAITING_GATE");
  deps.repo.setJobState(job.id, "WAITING_GATE", { gate });
  deps.repo.logJob({
    jobId: job.id,
    stepKey: stage.key,
    event: "gate.waiting",
    message: reason ?? `waiting for ${gate}`,
    data: { gate, fingerprint },
  });
  log("gate.waiting", { stageKey: stage.key, gate });
  return { status: "waiting", jobId: job.id, gate };
}

function handleStageFailure(
  deps: RunnerDeps,
  job: PipelineJobRow,
  episode: EpisodeRow,
  stage: StageDef,
  step: JobStepRow,
  error: unknown,
  log: (event: string, data?: Record<string, unknown>) => void,
): RunJobOutcome {
  const { repo } = deps;
  const message = errorMessage(error);
  const kind = classifyError(error);
  const policy = resolveRetryPolicy(
    stage.maxAttempts !== undefined ? { maxAttempts: stage.maxAttempts } : undefined,
    job.max_attempts,
  );
  const decision = decideRetry({
    policy,
    attemptsUsed: step.attempt,
    kind,
    random: deps.random,
  });

  assertStepTransition(step.state, "FAILED");
  const declared = error instanceof PermanentError ? error.artifacts : undefined;
  repo.failStep(job.id, stage.key, message, declared);
  repo.logJob({
    jobId: job.id,
    stepKey: stage.key,
    level: "error",
    event: "stage.failed",
    message,
    data: { errorKind: kind, attempt: step.attempt, maxAttempts: policy.maxAttempts },
  });
  log("stage.failed", {
    stageKey: stage.key,
    errorKind: kind,
    attempt: step.attempt,
    error: message,
  });

  if (decision.retry) {
    repo.requeueJob(job.id, { delayMs: decision.delayMs, error: message, failureStep: stage.key });
    const next = repo.requireJob(job.id);
    repo.logJob({
      jobId: job.id,
      event: "job.retry_scheduled",
      message: `retry #${decision.nextAttempt} in ${decision.delayMs}ms`,
      data: {
        delayMs: decision.delayMs,
        nextAttempt: decision.nextAttempt,
        failureStep: stage.key,
      },
    });
    log("job.retry_scheduled", {
      stageKey: stage.key,
      delayMs: decision.delayMs,
      nextAttempt: decision.nextAttempt,
    });
    return {
      status: "retrying",
      jobId: job.id,
      stepKey: stage.key,
      attempt: next.attempt,
      nextAttemptAt: next.next_attempt_at ?? "",
    };
  }

  const errorKind: "permanent" | "exhausted" =
    decision.retry === false ? decision.reason : "exhausted";
  repo.failJob(job.id, { error: message, errorKind, failureStep: stage.key });
  repo.logJob({
    jobId: job.id,
    level: "error",
    event: "job.failed",
    message: `${stage.runningLabel} failed: ${message}`,
    data: { errorKind, failureStep: stage.key },
  });
  setEpisodeState(deps, job, episode, "FAILED", log, message);
  log("job.failed", { stageKey: stage.key, errorKind, error: message });
  return { status: "failed", jobId: job.id, error: message, errorKind, stepKey: stage.key };
}

/** Move the episode lifecycle forward; an illegal jump is logged, never forced. */
function setEpisodeState(
  deps: RunnerDeps,
  job: PipelineJobRow,
  episode: EpisodeRow,
  state: EpisodeState,
  log: (event: string, data?: Record<string, unknown>) => void,
  error: string | null = null,
): void {
  const current = deps.repo.requireEpisode(episode.id);
  if (current.state === state) return;
  try {
    assertEpisodeTransition(current.kind, current.state, state);
  } catch (transitionError) {
    // Legitimate case: a retry re-enters a stage whose episode state we already
    // advanced past. Record it on the job (operators read job logs, not stdout)
    // rather than forcing the episode backwards or forwards.
    const detail = {
      episodeId: episode.id,
      from: current.state,
      to: state,
      error: errorMessage(transitionError),
    };
    deps.repo.logJob({
      jobId: job.id,
      level: "warn",
      event: "episode.transition.rejected",
      message: `episode stays ${current.state}: ${current.state} → ${state} is not a legal transition`,
      data: detail,
    });
    log("episode.transition.rejected", detail);
    return;
  }
  deps.repo.setEpisodeState(episode.id, state, error);
}

/** Lease heartbeat: renew while a task runs so long stages are never stolen. */
async function withHeartbeat<T>(deps: RunnerDeps, jobId: string, fn: () => Promise<T>): Promise<T> {
  const interval = deps.heartbeatIntervalMs ?? Math.max(250, Math.floor(deps.leaseMs / 3));
  const timer = setInterval(() => {
    try {
      deps.repo.renewLease(jobId, deps.workerId, deps.leaseMs);
      deps.logger?.({ level: "debug", event: "lease.renewed", jobId });
    } catch (error) {
      // Losing the lease is not fatal: whatever we produce is checkpointed with
      // a fingerprint, so a second worker's identical work collapses onto the
      // same artifacts. Log and keep going.
      deps.logger?.({
        level: "warn",
        event: "lease.renew_failed",
        jobId,
        error: errorMessage(error),
      });
    }
  }, interval);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
