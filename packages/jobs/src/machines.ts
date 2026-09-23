import type { EpisodeKind, EpisodeState, JobState, StepState } from "@nexus/db";

import { InvalidTransitionError } from "./errors.js";

/**
 * State machines. Three levels, three lifetimes:
 *
 * - **episode** (`episodes.state`) — the coarse lifecycle an operator thinks
 *   in: "this episode is being scripted". Enforced here, one machine per
 *   episode kind (shorts legitimately skip research and voice).
 * - **job** (`pipeline_jobs.state`) — one attempt-set of one pipeline run.
 * - **stage** (`pipeline_job_steps.state`) — the per-stage progress that makes
 *   the run resumable; this is where "…_COMPLETE" lives (see stages.ts).
 *
 * The tables are the specification, not an implementation detail: every
 * mutation in the orchestration layer goes through the `assert*` helpers, so
 * an illegal jump is a test failure rather than a corrupt row.
 */

const T = <K extends string>(from: K, to: readonly K[]): readonly K[] => to;

// ── Episode lifecycle ─────────────────────────────────────────────────────

export const LONG_EPISODE_TRANSITIONS: Readonly<Record<EpisodeState, readonly EpisodeState[]>> = {
  QUEUED: T("QUEUED", ["RESEARCHING", "FAILED", "CANCELED"]),
  RESEARCHING: T("RESEARCHING", ["FACT_CHECKING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  FACT_CHECKING: T("FACT_CHECKING", ["FACT_REVIEW", "SCRIPTING", "FAILED", "CANCELED"]),
  FACT_REVIEW: T("FACT_REVIEW", ["SCRIPTING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  SCRIPTING: T("SCRIPTING", ["SCENE_PLANNING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  SCENE_PLANNING: T("SCENE_PLANNING", ["MEDIA_GATHERING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  MEDIA_GATHERING: T("MEDIA_GATHERING", ["VOICE_SYNTHESIS", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  VOICE_SYNTHESIS: T("VOICE_SYNTHESIS", ["CAPTIONING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  CAPTIONING: T("CAPTIONING", ["COMPOSITING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  COMPOSITING: T("COMPOSITING", ["RENDERING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  RENDERING: T("RENDERING", ["QA", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  // QA can send work back to the renderer (glitch, wrong duration, bad audio).
  QA: T("QA", ["APPROVAL", "RENDERING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  APPROVAL: T("APPROVAL", ["READY", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  READY: T("READY", ["PUBLISHING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  PUBLISHING: T("PUBLISHING", ["PUBLISHED", "READY", "FAILED", "CANCELED"]),
  PUBLISHED: T("PUBLISHED", []),
  // NEEDS_CHANGES carries a target stage: re-entry is always *backwards*.
  NEEDS_CHANGES: T("NEEDS_CHANGES", [
    "RESEARCHING",
    "FACT_REVIEW",
    "SCRIPTING",
    "SCENE_PLANNING",
    "MEDIA_GATHERING",
    "VOICE_SYNTHESIS",
    "CAPTIONING",
    "COMPOSITING",
    "RENDERING",
    "QA",
    "APPROVAL",
    "FAILED",
    "CANCELED",
  ]),
  // FAILED is resumable (discovery §7.1): an operator fixes the cause and
  // re-enters the responsible stage.
  FAILED: T("FAILED", [
    "RESEARCHING",
    "FACT_CHECKING",
    "FACT_REVIEW",
    "SCRIPTING",
    "SCENE_PLANNING",
    "MEDIA_GATHERING",
    "VOICE_SYNTHESIS",
    "CAPTIONING",
    "COMPOSITING",
    "RENDERING",
    "QA",
    "APPROVAL",
    "READY",
    "PUBLISHING",
    "CANCELED",
  ]),
  CANCELED: T("CANCELED", ["QUEUED"]),
};

export const SHORT_EPISODE_TRANSITIONS: Readonly<Record<EpisodeState, readonly EpisodeState[]>> = {
  // Shorts skip research/voice: they analyze a finished long-form episode,
  // select a moment, rewrite it, re-lay it out vertically and re-render (AD-10).
  QUEUED: T("QUEUED", ["SCENE_PLANNING", "FAILED", "CANCELED"]),
  SCENE_PLANNING: T("SCENE_PLANNING", ["SCRIPTING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  SCRIPTING: T("SCRIPTING", ["COMPOSITING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  COMPOSITING: T("COMPOSITING", ["RENDERING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  RENDERING: T("RENDERING", ["QA", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  QA: T("QA", ["APPROVAL", "RENDERING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  APPROVAL: T("APPROVAL", ["READY", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  READY: T("READY", ["PUBLISHING", "NEEDS_CHANGES", "FAILED", "CANCELED"]),
  PUBLISHING: T("PUBLISHING", ["PUBLISHED", "READY", "FAILED", "CANCELED"]),
  PUBLISHED: T("PUBLISHED", []),
  NEEDS_CHANGES: T("NEEDS_CHANGES", [
    "SCENE_PLANNING",
    "SCRIPTING",
    "COMPOSITING",
    "RENDERING",
    "QA",
    "APPROVAL",
    "FAILED",
    "CANCELED",
  ]),
  FAILED: T("FAILED", [
    "SCENE_PLANNING",
    "SCRIPTING",
    "COMPOSITING",
    "RENDERING",
    "QA",
    "APPROVAL",
    "READY",
    "PUBLISHING",
    "CANCELED",
  ]),
  CANCELED: T("CANCELED", ["QUEUED"]),
  // States that only exist on the long-form path stay unreachable for shorts.
  RESEARCHING: T("RESEARCHING", ["FAILED", "CANCELED"]),
  FACT_CHECKING: T("FACT_CHECKING", ["FAILED", "CANCELED"]),
  FACT_REVIEW: T("FACT_REVIEW", ["FAILED", "CANCELED"]),
  MEDIA_GATHERING: T("MEDIA_GATHERING", ["FAILED", "CANCELED"]),
  VOICE_SYNTHESIS: T("VOICE_SYNTHESIS", ["FAILED", "CANCELED"]),
  CAPTIONING: T("CAPTIONING", ["FAILED", "CANCELED"]),
};

export const episodeTransitions = (
  kind: EpisodeKind,
): Readonly<Record<EpisodeState, readonly EpisodeState[]>> =>
  kind === "short" ? SHORT_EPISODE_TRANSITIONS : LONG_EPISODE_TRANSITIONS;

export const canTransitionEpisode = (
  kind: EpisodeKind,
  from: EpisodeState,
  to: EpisodeState,
): boolean => from === to || (episodeTransitions(kind)[from] ?? []).includes(to);

/**
 * The shortest legal episode path from `from` to `to`, walking only edges the
 * state machine itself declares (BFS over the transition table).
 *
 * Used by operator rewinds: a parked run's episode state must follow the job
 * backwards to the rewind target, and the direct jump is not always legal
 * (e.g. FACT_CHECKING must pass through FACT_REVIEW to reach NEEDS_CHANGES).
 * Throws when no path exists — the rewind is refused rather than the episode
 * being forced into an illegal state.
 */
export function episodePathTo(
  kind: EpisodeKind,
  from: EpisodeState,
  to: EpisodeState,
): readonly EpisodeState[] {
  if (from === to) return [];
  const table = episodeTransitions(kind);
  const visited = new Set<EpisodeState>([from]);
  let frontier: readonly (readonly EpisodeState[])[] = [[from]];
  while (frontier.length > 0) {
    const nextFrontier: (readonly EpisodeState[])[] = [];
    for (const path of frontier) {
      const last = path[path.length - 1]!;
      for (const next of table[last] ?? []) {
        if (next === to) return [...path, next];
        if (!visited.has(next)) {
          visited.add(next);
          nextFrontier.push([...path, next]);
        }
      }
    }
    frontier = nextFrontier;
  }
  throw new InvalidTransitionError(
    `episode (${kind}) — no legal path`,
    from,
    to,
    table[from] ?? [],
  );
}

export function assertEpisodeTransition(
  kind: EpisodeKind,
  from: EpisodeState,
  to: EpisodeState,
): void {
  if (canTransitionEpisode(kind, from, to)) return;
  throw new InvalidTransitionError(
    `episode (${kind})`,
    from,
    to,
    episodeTransitions(kind)[from] ?? [],
  );
}

// ── Job lifecycle ─────────────────────────────────────────────────────────

export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  PENDING: T("PENDING", ["RUNNING", "CANCELED"]),
  RUNNING: T("RUNNING", ["PENDING", "WAITING_GATE", "DONE", "FAILED", "CANCELED"]),
  WAITING_GATE: T("WAITING_GATE", ["PENDING", "FAILED", "CANCELED"]),
  DONE: T("DONE", []),
  FAILED: T("FAILED", ["PENDING", "CANCELED"]),
  CANCELED: T("CANCELED", []),
};

export const canTransitionJob = (from: JobState, to: JobState): boolean =>
  from === to || (JOB_TRANSITIONS[from] ?? []).includes(to);

export function assertJobTransition(from: JobState, to: JobState): void {
  if (canTransitionJob(from, to)) return;
  throw new InvalidTransitionError("job", from, to, JOB_TRANSITIONS[from] ?? []);
}

// ── Stage lifecycle ───────────────────────────────────────────────────────

export const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  // A stage may be adopted wholesale (DONE, artifact reuse), park at a gate
  // (WAITING), fail, or be started again. "Started" is not a stored state: a
  // step is in flight when its job is RUNNING and `started_at` is stamped, so
  // PENDING → PENDING covers both the first attempt and a crash reclaim
  // (`attempt` records how many times it was started).
  PENDING: T("PENDING", ["PENDING", "WAITING", "DONE", "FAILED"]),
  WAITING: T("WAITING", ["DONE", "PENDING", "FAILED"]),
  DONE: T("DONE", ["PENDING"]), // invalidation only (upstream content changed)
  FAILED: T("FAILED", ["PENDING", "DONE"]), // retry, or adopt a good artifact
};

export const canTransitionStep = (from: StepState, to: StepState): boolean =>
  from === to || (STEP_TRANSITIONS[from] ?? []).includes(to);

export function assertStepTransition(from: StepState, to: StepState): void {
  if (canTransitionStep(from, to)) return;
  throw new InvalidTransitionError("stage", from, to, STEP_TRANSITIONS[from] ?? []);
}
