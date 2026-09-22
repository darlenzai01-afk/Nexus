import {
  QACheckReportSchema,
  categoryOf,
  severityOf,
  type QACategory,
  type QACheckReport,
  type QACode,
  type QAFinding,
} from "./schema.js";

/**
 * Building findings and check reports.
 *
 * Two small factories, both of which exist to make it impossible to produce a
 * finding whose category disagrees with its code, or a check report whose status
 * disagrees with its findings — the two ways a QA report starts lying.
 */

export type FindingEvidence = Readonly<Record<string, string | number | boolean | null>>;

/** One finding. Category and severity come from the code registry, never a caller. */
export function finding(
  code: QACode,
  subject: string,
  message: string,
  evidence: FindingEvidence = {},
  fix = "",
): QAFinding {
  return {
    code,
    category: categoryOf(code),
    severity: severityOf(code),
    subject,
    message,
    evidence,
    fix,
  };
}

export interface CheckResult {
  readonly report: QACheckReport;
  readonly findings: readonly QAFinding[];
}

/**
 * A finished check: what it looked at, what it found, and — when it could not
 * run — why not. `examined` is what makes a clean report meaningful.
 */
export function checkResult(
  id: string,
  category: QACategory,
  examined: number,
  findings: readonly QAFinding[],
  note = "",
): CheckResult {
  const status =
    findings.length > 0 ? "findings" : examined === 0 && note !== "" ? "skipped" : "ok";
  return {
    report: QACheckReportSchema.parse({
      id,
      category,
      status,
      examined,
      findings: findings.length,
      note,
    }),
    findings: [...findings],
  };
}

/** A check that could not run (no font, no research package) — reported, not hidden. */
export function skippedCheck(
  id: string,
  category: QACategory,
  note: string,
  findings: readonly QAFinding[] = [],
): CheckResult {
  return {
    report: QACheckReportSchema.parse({
      id,
      category,
      status: "skipped",
      examined: 0,
      findings: findings.length,
      note,
    }),
    findings: [...findings],
  };
}

/** Round money-free numbers for evidence bags: two decimals, no floats-as-noise. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `a`, `a and b`, `a, b and c` — for messages that read like sentences. */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
