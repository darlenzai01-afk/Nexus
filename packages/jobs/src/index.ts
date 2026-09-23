export {
  ConfigurationError,
  InvalidTransitionError,
  PermanentError,
  RetryableError,
  classifyError,
  errorMessage,
} from "./errors.js";

export {
  JOB_TRANSITIONS,
  LONG_EPISODE_TRANSITIONS,
  SHORT_EPISODE_TRANSITIONS,
  STEP_TRANSITIONS,
  assertEpisodeTransition,
  assertJobTransition,
  assertStepTransition,
  canTransitionEpisode,
  canTransitionJob,
  canTransitionStep,
  episodeTransitions,
} from "./machines.js";

export {
  LONG_FORM_PIPELINE,
  PIPELINES,
  SHORTS_PIPELINE,
  findPipeline,
  isReusable,
  requirePipeline,
  requireStage,
  stageKeys,
  stageStateLabel,
  type PipelineDef,
  type StageDef,
} from "./stages.js";

export {
  canonicalize,
  hashInputs,
  sha256Hex,
  stageFingerprint,
  type StageFingerprintInput,
} from "./fingerprint.js";

export {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  decideRetry,
  resolveRetryPolicy,
  type RetryDecision,
  type RetryPolicy,
} from "./retry.js";

export { createTaskRegistry } from "./registry.js";

export { runJob } from "./runner.js";

export {
  deriveJobStatus,
  getJobStatus,
  type JobStatusView,
  type StageStatusView,
} from "./status.js";

export {
  resolveGate,
  retryFailedJob,
  type GateDecision,
  type ResolveGateInput,
  type ResolveGateResult,
} from "./gates.js";

export { Worker, createWorker, type DrainSummary, type WorkerOptions } from "./worker.js";

export { consoleLogger, silentLogger, type LogEntry, type Logger } from "./logger.js";

export type {
  RunJobOutcome,
  RunnerDeps,
  Task,
  TaskContext,
  TaskRegistry,
  TaskResult,
} from "./types.js";
