import { stepOf } from "./snapshot.js";
import type { QAEvidence, QADeps } from "./evidence.js";
import { checkResult, finding, skippedCheck, type CheckResult } from "./findings.js";
import type { QASettings } from "./schema.js";

/**
 * Pipeline QA: did the machinery actually do what the job says it did?
 *
 * A finished video with a failed step behind it is not a deliverable, and a job
 * that says `DONE` with a step still `PENDING` cannot be trusted to have run the
 * rest. These checks read the *database*, not documents:
 *
 * - **invalid job state** — a job that is running on an expired lease, a step
 *   after a failure, an episode state that disagrees with the last stage that
 *   completed, a step marked `DONE` with no output;
 * - **missing artifacts** — a stage that declares what it produces, and a step
 *   that has no such artifact, or whose artifact rows point at bytes the store
 *   does not have (a hash without bytes is worse than a missing row: it looks
 *   complete until someone tries to publish it);
 * - **incomplete stages** — steps the pipeline definition requires that the job
 *   never had, and steps that never finished.
 *
 * When QA runs outside a job (a library caller checking an old episode) there is
 * no snapshot, and that is reported rather than assumed to be fine.
 */

export function checkPipeline(
  evidence: QAEvidence,
  _deps: QADeps,
  _settings: QASettings,
): CheckResult {
  const snapshot = evidence.pipeline;
  const findings = [];
  let examined = 0;

  if (snapshot === undefined) {
    return skippedCheck(
      "pipeline.state",
      "pipeline",
      "no pipeline snapshot was supplied, so the job's own state was not checked",
      [
        finding(
          "qa_evidence_missing",
          "pipeline",
          "no pipeline snapshot was supplied, so the job's own state was not checked",
          {},
          "run QA from the qa stage, which reads the job it belongs to",
        ),
      ],
    );
  }

  examined += snapshot.steps.length;

  // ── The job and the episode ──────────────────────────────────────────────
  const doneSteps = snapshot.steps.filter((step) => step.state === "DONE");
  const failedSteps = snapshot.steps.filter((step) => step.state === "FAILED");
  const pendingSteps = snapshot.steps.filter(
    (step) => step.state === "PENDING" || step.state === "WAITING",
  );

  if (snapshot.leaseExpired) {
    examined += 1;
    findings.push(
      finding(
        "pipeline_invalid_state",
        snapshot.jobId,
        `job ${snapshot.jobId} is running on a lease that has already expired`,
        { jobId: snapshot.jobId, jobState: snapshot.jobState, attempt: snapshot.attempt },
        "let a worker reclaim it, or requeue it",
      ),
    );
  }

  if (failedSteps.length > 0) {
    for (const step of failedSteps) {
      examined += 1;
      findings.push(
        finding(
          "pipeline_step_failed",
          step.key,
          `step ${step.key} failed on attempt ${step.attempt}: ${step.error.slice(0, 200)}`,
          { stepKey: step.key, attempt: step.attempt, jobState: snapshot.jobState },
          "fix the cause and retry the step",
        ),
      );
    }
  }

  if (snapshot.jobState === "DONE" && pendingSteps.length > 0) {
    examined += 1;
    findings.push(
      finding(
        "pipeline_invalid_state",
        snapshot.jobId,
        `job ${snapshot.jobId} is DONE but ${pendingSteps.length} step(s) never finished ` +
          `(${pendingSteps.map((step) => step.key).join(", ")})`,
        { jobId: snapshot.jobId, steps: pendingSteps.map((step) => step.key).join(",") },
        "requeue the job so the remaining steps run",
      ),
    );
  }

  for (const step of snapshot.steps) {
    if (step.state === "DONE" && step.output === undefined && step.artifacts.length === 0) {
      examined += 1;
      findings.push(
        finding(
          "pipeline_invalid_state",
          step.key,
          `step ${step.key} is DONE but recorded neither output nor artifacts`,
          { stepKey: step.key },
          "re-run the step; nothing downstream can consume it",
        ),
      );
    }
    if (
      step.state === "DONE" &&
      step.key !== "approval" &&
      step.key !== "publish" &&
      step.output === undefined
    ) {
      // A gate (approval) legitimately completes with no output.
      examined += 1;
      findings.push(
        finding(
          "pipeline_invalid_state",
          step.key,
          `step ${step.key} is DONE with no output document, so the next stage has nothing to read`,
          { stepKey: step.key, artifacts: step.artifacts.length },
        ),
      );
    }
  }

  // The episode's state must be where the last completed stage left it. A stage
  // declares both ends, so this is a lookup, not an opinion.
  const definition = snapshot.definition;
  if (definition !== undefined) {
    const lastDone = [...snapshot.steps].reverse().find((step) => step.state === "DONE");
    const stage = definition.stages.find((entry) => entry.key === lastDone?.key);
    if (stage !== undefined) {
      examined += 1;
      const allowed = [stage.episodeStateOnComplete, stage.episodeStateOnStart];
      if (!allowed.includes(snapshot.episode.state)) {
        // A failure after this stage moves the episode on purpose, so only report
        // it when the job itself was not the thing that failed.
        if (snapshot.jobState !== "FAILED") {
          findings.push(
            finding(
              "pipeline_invalid_state",
              snapshot.episode.id,
              `the episode is ${snapshot.episode.state} while the last finished stage (${stage.key}) ` +
                `leaves it at ${stage.episodeStateOnComplete}`,
              {
                episodeState: snapshot.episode.state,
                lastStage: stage.key,
                expected: stage.episodeStateOnComplete,
                jobState: snapshot.jobState,
              },
              "re-run the job so the episode and its stages agree",
            ),
          );
        }
      }
    }
  } else {
    examined += 1;
    findings.push(
      finding(
        "pipeline_invalid_state",
        snapshot.pipeline,
        `job ${snapshot.jobId} runs pipeline "${snapshot.pipeline}", which this build does not know`,
        { pipeline: snapshot.pipeline },
        "check the job against the pipeline version that created it",
      ),
    );
  }

  // ── Stages the pipeline requires, and the artifacts they promise ─────────
  if (definition !== undefined) {
    // A job runs a *slice* of the definition — a resumed job runs a later slice, a
    // planning job an earlier one — so the check is about gaps: a stage the job
    // passed over between the first and the last stage it did run, which breaks the
    // chain of artifacts the later stages read.
    const jobSteps = new Set(snapshot.steps.map((step) => step.key));
    const orders = definition.stages
      .map((stage, index) => ({ key: stage.key, index }))
      .filter((entry) => jobSteps.has(entry.key))
      .map((entry) => entry.index);
    const firstStage = orders.length > 0 ? Math.min(...orders) : -1;
    const lastStage = orders.length > 0 ? Math.max(...orders) : -1;
    const gaps =
      firstStage < 0
        ? []
        : definition.stages
            .slice(firstStage, lastStage + 1)
            .filter((stage) => !jobSteps.has(stage.key));
    examined += definition.stages.length;
    if (gaps.length > 0) {
      findings.push(
        finding(
          "pipeline_incomplete_stages",
          snapshot.jobId,
          `the job ran past ${gaps.length} stage(s) of pipeline ${definition.id} with no step of its own: ` +
            `${gaps.map((stage) => stage.key).join(", ")}`,
          {
            pipeline: definition.id,
            missing: gaps.map((stage) => stage.key).join(","),
            from: definition.stages[firstStage]?.key ?? "",
            to: definition.stages[lastStage]?.key ?? "",
          },
          "re-run the job with every stage between the ones it needs",
        ),
      );
    }

    for (const stage of definition.stages) {
      const step = stepOf(snapshot, stage.key);
      if (step === undefined || step.state !== "DONE" || stage.produces.length === 0) continue;
      examined += stage.produces.length;
      const produced = new Set(step.artifacts.map((artifact) => artifact.kind));
      const missingKinds = stage.produces.filter((kind) => !produced.has(kind));
      if (missingKinds.length > 0) {
        findings.push(
          finding(
            "pipeline_missing_artifacts",
            stage.key,
            `stage ${stage.key} declares it produces ${stage.produces.join(", ")} but its artifacts are ` +
              `${step.artifacts.length === 0 ? "empty" : step.artifacts.map((artifact) => artifact.kind).join(", ")}`,
            {
              stepKey: stage.key,
              expected: stage.produces.join(","),
              actual: step.artifacts.map((a) => a.kind).join(","),
            },
            "re-run the stage; the artifact registry is the hand-off",
          ),
        );
      }
    }
  }

  // Every artifact a step points at must have bytes. A row without bytes passes
  // every other check and fails at the worst possible moment.
  for (const step of snapshot.steps) {
    for (const artifact of step.artifacts) {
      examined += 1;
      if (!snapshot.hasArtifact(artifact.hash)) {
        findings.push(
          finding(
            "pipeline_missing_artifacts",
            `${step.key}/${artifact.kind}`,
            `step ${step.key} registered a ${artifact.kind} artifact (${artifact.hash.slice(0, 12)}…) whose bytes are not in the store`,
            {
              stepKey: step.key,
              kind: artifact.kind,
              role: artifact.role ?? "",
              hash: artifact.hash.slice(0, 12),
            },
            "restore the artifact store, or re-run the step that wrote it",
          ),
        );
      }
    }
  }

  // ── The stages this report depends on ───────────────────────────────────
  const required = [
    { key: "render", why: "there is no video without it" },
    { key: "qa", why: "this report is its output" },
  ];
  for (const entry of required) {
    const step = stepOf(snapshot, entry.key);
    examined += 1;
    if (step === undefined) continue;
    if (step.state !== "DONE" && snapshot.jobState === "DONE") {
      findings.push(
        finding(
          "pipeline_incomplete_stages",
          entry.key,
          `step ${entry.key} is ${step.state} in a finished job — ${entry.why}`,
          { stepKey: entry.key, state: step.state },
        ),
      );
    }
  }

  const note = `${snapshot.jobState} job, ${doneSteps.length}/${snapshot.steps.length} step(s) done`;
  return checkResult("pipeline.state", "pipeline", examined, findings, note);
}

export type { PipelineSnapshot } from "./snapshot.js";
