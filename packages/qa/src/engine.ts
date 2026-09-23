import { checkAudio } from "./audio.js";
import { checkContent } from "./content.js";
import type { Checker, QADeps, QAEvidence } from "./evidence.js";
import { checkPipeline } from "./pipeline.js";
import {
  QA_ENGINE,
  QA_REPORT_VERSION,
  compareFindings,
  type QACheckReport,
  type QACounts,
  type QAFinding,
  type QAReport,
  type QASubject,
} from "./schema.js";
import { resolveQASettings, settingsHash } from "./settings.js";
import { checkVideo } from "./video.js";
import { checkVisual } from "./visual.js";
import { QABlockedError } from "./errors.js";

/**
 * The QA engine: five checks, in the order the pipeline produces things, one
 * report.
 *
 * The engine is deliberately small. It does not fetch anything, retry anything or
 * decide anything fuzzy: it runs the checkers, orders their findings, counts them
 * and answers one question — **may this episode be published?**
 *
 * The answer is `report.publishable`. Every check that could not run is visible in
 * `checks[]` with a reason, so "no findings" always has a scope attached to it.
 */

/** The checks, in report order. Each one is a pure function of its evidence. */
export const QA_CHECKS: readonly { readonly id: string; readonly run: Checker }[] = [
  { id: "content.script", run: checkContent },
  { id: "visual.frames", run: checkVisual },
  { id: "audio.track", run: checkAudio },
  { id: "video.output", run: checkVideo },
  { id: "pipeline.state", run: checkPipeline },
];

export interface RunQAOptions {
  readonly episodeId?: string;
  readonly jobId?: string;
}

/**
 * Run every check and assemble the report.
 *
 * Deterministic: the findings are sorted, the settings are hashed, and the only
 * thing that varies run to run is `generatedAt` (overridable through
 * `deps.now`), which is what keeps fixtures reproducible.
 */
export function runQA(evidence: QAEvidence, deps: QADeps, options: RunQAOptions = {}): QAReport {
  const settings = resolveQASettings(deps.settings ?? {});
  const checks: QACheckReport[] = [];
  const findings: QAFinding[] = [];
  const notes: string[] = [];

  for (const check of QA_CHECKS) {
    const result = check.run(evidence, deps, settings);
    checks.push(result.report);
    findings.push(...result.findings);
  }

  const ordered = [...findings].sort(compareFindings);
  const counts: QACounts = {
    findings: ordered.length,
    errors: ordered.filter((entry) => entry.severity === "error").length,
    warnings: ordered.filter((entry) => entry.severity === "warning").length,
    infos: ordered.filter((entry) => entry.severity === "info").length,
    checks: checks.length,
    skipped: checks.filter((entry) => entry.status === "skipped").length,
  };
  const blocking = [
    ...new Set(ordered.filter((entry) => entry.severity === "error").map((entry) => entry.code)),
  ];
  const publishable = counts.errors === 0;

  const skipped = checks.filter((entry) => entry.status === "skipped");
  if (skipped.length > 0) {
    notes.push(
      `${skipped.length} check(s) could not run: ${skipped.map((entry) => `${entry.id} (${entry.note})`).join("; ")}`,
    );
  }
  if (evidence.script === undefined) notes.push("the content checks ran without a script document");
  if (evidence.research === undefined)
    notes.push("the content checks ran without a research package");
  if (evidence.audio === undefined) notes.push("the audio checks ran without a narration track");
  if (evidence.video === undefined) notes.push("the video checks ran without an output file");

  return {
    version: QA_REPORT_VERSION,
    generatedAt: deps.now ?? new Date().toISOString(),
    engine: { name: QA_ENGINE.name, version: QA_ENGINE.version },
    episodeId: options.episodeId ?? evidence.episodeId,
    jobId: options.jobId ?? evidence.jobId,
    subject: subjectOf(evidence),
    settings,
    settingsHash: settingsHash(settings),
    verdict: counts.errors > 0 ? "fail" : counts.warnings > 0 ? "pass_with_warnings" : "pass",
    publishable,
    blocked: !publishable,
    blocking,
    counts,
    checks,
    findings: ordered,
    notes,
  };
}

/** The hashes the report is *about* — what makes a verdict apply to something. */
export function subjectOf(evidence: QAEvidence): QASubject {
  return {
    manifestHash: evidence.manifestHash,
    scriptHash: evidence.script?.hash ?? "",
    researchPackageHash: evidence.research?.hash ?? "",
    audioTrackHash: evidence.audio?.hash ?? "",
    captionTrackHash: evidence.captions?.hash ?? "",
    renderMetadataHash: evidence.render?.hash ?? "",
    videoHash: evidence.video?.hash ?? "",
  };
}

/**
 * The guard a publisher calls. Throwing is the point: a caller that forgets to
 * check `publishable` still cannot publish a blocked report, because the only way
 * to get past this function is to have a report that says it may ship.
 */
export function assertPublishable(report: QAReport): void {
  if (report.publishable) return;
  throw new QABlockedError(report);
}

/** One line saying why, for a log or a stage error. */
export function describeReport(report: QAReport): string {
  return (
    `QA ${report.verdict}: ${report.counts.errors} error(s), ${report.counts.warnings} warning(s) ` +
    `over ${report.counts.checks - report.counts.skipped}/${report.counts.checks} checks`
  );
}
