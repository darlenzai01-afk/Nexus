import { z } from "zod";

/**
 * The QA report — the one document the QA engine produces, and the only thing a
 * later stage is allowed to look at when it asks "may this be published?".
 *
 * Three properties matter more than the shape:
 *
 * 1. **A finding says where it came from.** Every finding carries the category,
 *    the code, the subject it is about (a scene, a cue, a step, the output), and
 *    an `evidence` bag with the numbers behind it. "Something is wrong" is not a
 *    finding; "scene scn_3 is 2.4 s longer than the plan" is.
 * 2. **A pass says what was checked.** `checks[]` records every check that ran,
 *    how many things it examined and whether it found anything — so an empty
 *    `findings[]` cannot be confused with a check that never executed. A check
 *    that could not run (no font installed, no research package) is `skipped`
 *    with the reason, never silently absent.
 * 3. **Blocking is a decision, not a feeling.** Severity and blocking come from a
 *    fixed registry below: an `error` blocks publication, a `warning` does not
 *    (it is recorded and needs a human), an `info` is context. Nothing in the
 *    engine invents severities at runtime.
 */

export const QA_REPORT_VERSION = 1;
export const QA_ENGINE = { name: "nexus-qa", version: "1.0.0" } as const;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "expected a sha256 hex digest");

export const QACategorySchema = z.enum(["content", "visual", "audio", "video", "pipeline"]);
export type QACategory = z.infer<typeof QACategorySchema>;

export const QASeveritySchema = z.enum(["error", "warning", "info"]);
export type QASeverity = z.infer<typeof QASeveritySchema>;

/**
 * Every code the engine can produce, with its category and severity.
 *
 * Keep this table readable: it *is* the QA contract. A code exists here because a
 * check can produce it, and a test proves it can.
 */
export const QA_CODES = {
  // ── Content: the script, the claims and the evidence behind them ──────────
  content_section_missing: { category: "content", severity: "error" },
  content_section_unplanned: { category: "content", severity: "warning" },
  content_claim_unsupported: { category: "content", severity: "error" },
  content_source_missing: { category: "content", severity: "error" },
  content_contradiction: { category: "content", severity: "error" },
  content_claim_unreferenced: { category: "content", severity: "warning" },
  content_quality_issue: { category: "content", severity: "warning" },
  // ── Visual: the plan's assets, scenes, text and layout ────────────────────
  visual_asset_missing: { category: "visual", severity: "error" },
  visual_asset_reference_broken: { category: "visual", severity: "error" },
  visual_scene_missing: { category: "visual", severity: "error" },
  visual_text_unreadable: { category: "visual", severity: "error" },
  visual_text_tight: { category: "visual", severity: "warning" },
  visual_text_undrawable: { category: "visual", severity: "warning" },
  visual_layout_invalid: { category: "visual", severity: "error" },
  /** Visible, but something of it falls outside the frame (often the camera). */
  visual_layout_clipped: { category: "visual", severity: "warning" },
  // ── Audio: the narration track and the clips behind it ────────────────────
  audio_missing: { category: "audio", severity: "error" },
  audio_segment_missing: { category: "audio", severity: "error" },
  audio_duration_mismatch: { category: "audio", severity: "error" },
  audio_drift: { category: "audio", severity: "warning" },
  audio_silence: { category: "audio", severity: "error" },
  audio_artifact_invalid: { category: "audio", severity: "error" },
  audio_unmeasurable: { category: "audio", severity: "warning" },
  // ── Video: the encoded deliverable ───────────────────────────────────────
  video_invalid_output: { category: "video", severity: "error" },
  video_resolution_mismatch: { category: "video", severity: "error" },
  video_duration_mismatch: { category: "video", severity: "error" },
  video_encoding_failure: { category: "video", severity: "error" },
  video_corrupted: { category: "video", severity: "error" },
  video_not_streamable: { category: "video", severity: "warning" },
  /** The episode has captions and the delivered file does not carry them. */
  video_captions_missing: { category: "video", severity: "error" },
  // ── Pipeline: the job, its steps and its artifacts ───────────────────────
  pipeline_invalid_state: { category: "pipeline", severity: "error" },
  pipeline_missing_artifacts: { category: "pipeline", severity: "error" },
  pipeline_incomplete_stages: { category: "pipeline", severity: "error" },
  pipeline_step_failed: { category: "pipeline", severity: "error" },
  // ── The report's own honesty ─────────────────────────────────────────────
  qa_evidence_missing: { category: "pipeline", severity: "warning" },
  qa_check_skipped: { category: "pipeline", severity: "info" },
} as const satisfies Record<string, { category: QACategory; severity: QASeverity }>;

export type QACode = keyof typeof QA_CODES;
export const QA_CODE_NAMES = Object.keys(QA_CODES) as readonly QACode[];
export const QACodeSchema = z.enum(QA_CODE_NAMES as unknown as [QACode, ...QACode[]]);

/** Codes whose severity is `error`: these are what block publication. */
export const HARD_QA_CODES: readonly QACode[] = QA_CODE_NAMES.filter(
  (code) => QA_CODES[code].severity === "error",
);

export function isHardQACode(code: QACode): boolean {
  return QA_CODES[code].severity === "error";
}

export function categoryOf(code: QACode): QACategory {
  return QA_CODES[code].category;
}

export function severityOf(code: QACode): QASeverity {
  return QA_CODES[code].severity;
}

export const QAFindingSchema = z.strictObject({
  code: QACodeSchema,
  category: QACategorySchema,
  severity: QASeveritySchema,
  /** What the finding is about: a scene, a cue, a step, the output, an artifact. */
  subject: z.string().max(200).default(""),
  message: z.string().min(1).max(600),
  /** The numbers behind the finding, so a reader can check the verdict. */
  evidence: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** What an operator could do about it — advisory, never executed. */
  fix: z.string().max(400).default(""),
});
export type QAFinding = z.infer<typeof QAFindingSchema>;

export const QACheckReportSchema = z.strictObject({
  /** Stable id, e.g. `content.claims`. */
  id: z.string().min(1).max(80),
  category: QACategorySchema,
  status: z.enum(["ok", "findings", "skipped"]),
  /** How many things the check looked at (0 with `skipped`). */
  examined: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  /** Why it was skipped, or any caveat on what it covered. */
  note: z.string().max(400).default(""),
});
export type QACheckReport = z.infer<typeof QACheckReportSchema>;

export const QACountsSchema = z.strictObject({
  findings: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  infos: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type QACounts = z.infer<typeof QACountsSchema>;

/** The inputs the report is about, by hash — what a verdict applies *to*. */
export const QASubjectSchema = z.strictObject({
  manifestHash: z.union([Sha256Schema, z.literal("")]).default(""),
  scriptHash: z.union([Sha256Schema, z.literal("")]).default(""),
  researchPackageHash: z.union([Sha256Schema, z.literal("")]).default(""),
  audioTrackHash: z.union([Sha256Schema, z.literal("")]).default(""),
  captionTrackHash: z.union([Sha256Schema, z.literal("")]).default(""),
  renderMetadataHash: z.union([Sha256Schema, z.literal("")]).default(""),
  videoHash: z.union([Sha256Schema, z.literal("")]).default(""),
});
export type QASubject = z.infer<typeof QASubjectSchema>;

/**
 * The thresholds the checks run with. They are part of the report (so a verdict
 * can be read years later) and are hashed into `settingsHash`, which means a
 * reused report says exactly which rules produced it.
 */
export const QASettingsSchema = z.strictObject({
  /** How far the finished audio may deviate from the plan before it is an error. */
  durationToleranceSec: z.number().min(0).max(30).default(0.5),
  /** Deviation that is worth a warning but not a block. */
  durationWarnSec: z.number().min(0).max(30).default(0.15),
  /** Scenes may drift this far from their planned window before it is reported. */
  sceneDriftToleranceSec: z.number().min(0).max(30).default(1),
  /** Smallest type size, in pixels of the *output* frame, that is still readable. */
  minFontPx: z.number().min(4).max(200).default(18),
  /** Below this, type is tight but not yet unreadable. */
  tightFontPx: z.number().min(4).max(200).default(24),
  /** Text may not come closer than this to the frame edge (fraction of the frame). */
  safeAreaRatio: z.number().min(0).max(0.25).default(0.04),
  /** RMS below this is silence (0…1, per channel). */
  silenceRms: z.number().min(0).max(1).default(0.006),
  /** A silent window this long, inside a spoken segment, is a defect. */
  silenceWindowSec: z.number().min(0.05).max(10).default(0.6),
  /** Audio level below this, over a whole clip, means the clip says nothing. */
  minClipRms: z.number().min(0).max(1).default(0.004),
  /** The video's own duration may deviate this far from the render metadata. */
  videoToleranceSec: z.number().min(0).max(5).default(0.25),
  /** A file smaller than this cannot be a real video. */
  minVideoBytes: z.number().int().min(1).default(1_024),
  /** Check the burned-in captions against the frame's safe area. */
  checkCaptionSafeArea: z.boolean().default(true),
});
export type QASettings = z.infer<typeof QASettingsSchema>;
export type QASettingsInput = z.input<typeof QASettingsSchema>;

export const QAReportSchema = z.strictObject({
  version: z.literal(QA_REPORT_VERSION),
  generatedAt: z.string().min(1),
  engine: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  episodeId: z.string().default(""),
  jobId: z.string().default(""),
  subject: QASubjectSchema,
  settings: QASettingsSchema,
  settingsHash: Sha256Schema,
  /** `pass` — nothing found; `pass_with_warnings` — only soft findings; `fail` — blocked. */
  verdict: z.enum(["pass", "pass_with_warnings", "fail"]),
  /** True exactly when no `error` finding exists. What a publisher must check. */
  publishable: z.boolean(),
  /** True when publication is refused by this report. */
  blocked: z.boolean(),
  /** Codes of the findings that block, deduplicated, in report order. */
  blocking: z.array(QACodeSchema),
  counts: QACountsSchema,
  checks: z.array(QACheckReportSchema),
  findings: z.array(QAFindingSchema),
  /** Anything a reader should know that is not a finding (e.g. what was not read). */
  notes: z.array(z.string().max(400)).default([]),
});
export type QAReport = z.infer<typeof QAReportSchema>;

export function qaReportBytes(report: QAReport): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(QAReportSchema.parse(report), null, 2)}\n`);
}

export function parseQAReport(input: unknown): QAReport {
  return QAReportSchema.parse(input);
}

/** True when this report refuses publication — the one predicate publishers call. */
export function blocksPublication(report: QAReport): boolean {
  return report.blocked;
}

/** The findings that make the report non-publishable, in report order. */
export function blockingFindings(report: QAReport): readonly QAFinding[] {
  return report.findings.filter((finding) => finding.severity === "error");
}

/** One line per blocking finding — what goes into a stage error message. */
export function describeBlocking(report: QAReport, limit = 4): string {
  const blocking = blockingFindings(report);
  const shown = blocking
    .slice(0, limit)
    .map((finding) =>
      finding.subject === "" ? finding.code : `${finding.code} (${finding.subject})`,
    );
  const rest = blocking.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

export const QA_ORDER: readonly QACategory[] = ["content", "visual", "audio", "video", "pipeline"];

/** The report order: category, then code, then subject, then message. */
export function compareFindings(left: QAFinding, right: QAFinding): number {
  const byCategory = QA_ORDER.indexOf(left.category) - QA_ORDER.indexOf(right.category);
  if (byCategory !== 0) return byCategory;
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1;
  return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
}
