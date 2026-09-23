import type { ArtifactRef, EpisodeRow, JobStepRow, PipelineJobRow, Repo } from "@nexus/db";
import { LONG_FORM_PIPELINE, SHORTS_PIPELINE, type PipelineDef } from "@nexus/jobs";

/**
 * The pipeline, as QA sees it.
 *
 * The pipeline checks are about *state*, not documents: "the job says DONE but a
 * step never ran" is a defect that no amount of correct video will fix. The
 * snapshot is taken from the real repository (or handed over by a test), and it
 * carries the two things those checks need beyond the rows: the pipeline
 * definition the job claims to be running, and a way to ask whether an artifact's
 * bytes are actually in the store.
 */
export interface PipelineStepSnapshot {
  readonly key: string;
  readonly state: JobStepRow["state"];
  readonly attempt: number;
  readonly artifacts: readonly ArtifactRef[];
  /** The step's output document, as JSON — what later stages read. */
  readonly output: unknown;
  readonly error: string;
}

export interface PipelineSnapshot {
  readonly jobId: string;
  readonly jobState: PipelineJobRow["state"];
  readonly pipeline: string;
  readonly attempt: number;
  readonly failureStep: string;
  readonly error: string;
  /** True when the job holds a lease that has already expired. */
  readonly leaseExpired: boolean;
  readonly episode: { readonly id: string; readonly state: EpisodeRow["state"] };
  readonly steps: readonly PipelineStepSnapshot[];
  /** The definition the job claims to run, when it is a known pipeline. */
  readonly definition?: PipelineDef | undefined;
  /** Whether an artifact's bytes exist in the CAS. */
  readonly hasArtifact: (hash: string) => boolean;
}

export function pipelineFor(name: string): PipelineDef | undefined {
  if (name === LONG_FORM_PIPELINE.id) return LONG_FORM_PIPELINE;
  if (name === SHORTS_PIPELINE.id) return SHORTS_PIPELINE;
  return undefined;
}

function artifactsOf(step: JobStepRow): readonly ArtifactRef[] {
  try {
    const parsed: unknown = JSON.parse(step.artifacts === "" ? "[]" : step.artifacts);
    return Array.isArray(parsed) ? (parsed as ArtifactRef[]) : [];
  } catch {
    return [];
  }
}

function outputOf(step: JobStepRow): unknown {
  if (step.output === null || step.output === "") return undefined;
  try {
    return JSON.parse(step.output) as unknown;
  } catch {
    return step.output;
  }
}

export interface SnapshotDeps {
  readonly repo: Repo;
  /** Whether the CAS holds these bytes; defaults to asking the store. */
  readonly hasArtifact?: ((hash: string) => boolean) | undefined;
  /** `now`, for the lease check. */
  readonly now?: Date | undefined;
}

/**
 * Read one job's state out of the database. Everything here is a read: QA never
 * fixes the pipeline, it reports on it.
 */
export function collectPipelineSnapshot(deps: SnapshotDeps, jobId: string): PipelineSnapshot {
  const job = deps.repo.requireJob(jobId);
  const episode = deps.repo.requireEpisode(job.episode_id);
  const steps = deps.repo.listJobSteps(jobId).map((step) => ({
    key: step.step_key,
    state: step.state,
    attempt: step.attempt,
    artifacts: artifactsOf(step),
    output: outputOf(step),
    error: step.error ?? "",
  }));
  const now = (deps.now ?? new Date()).getTime();
  const leaseExpired =
    job.state === "RUNNING" &&
    job.lease_expires_at !== null &&
    job.lease_expires_at !== "" &&
    Date.parse(job.lease_expires_at) < now;

  return {
    jobId: job.id,
    jobState: job.state,
    pipeline: job.pipeline,
    attempt: job.attempt,
    failureStep: job.failure_step ?? "",
    error: job.error ?? "",
    leaseExpired,
    episode: { id: episode.id, state: episode.state },
    steps,
    definition: pipelineFor(job.pipeline),
    hasArtifact:
      deps.hasArtifact ??
      ((hash: string) => {
        try {
          return deps.repo.getArtifact(hash) !== undefined;
        } catch {
          return false;
        }
      }),
  };
}

/** The step with this key, or undefined. */
export function stepOf(snapshot: PipelineSnapshot, key: string): PipelineStepSnapshot | undefined {
  return snapshot.steps.find((step) => step.key === key);
}
