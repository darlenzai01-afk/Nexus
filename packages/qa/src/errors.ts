import { blockingFindings, type QAReport } from "./schema.js";

/**
 * QA's errors.
 *
 * There is exactly one that matters: `QABlockedError`, thrown when something asks
 * whether an episode may be published and the report says no. It carries the
 * report, so the caller can log the artifact hash and the blocking codes without
 * re-reading anything.
 */

export type QAErrorCode = "qa_blocked" | "qa_report_invalid";

export class QAError extends Error {
  readonly code: QAErrorCode;

  constructor(message: string, options: { readonly code: QAErrorCode }) {
    super(message);
    this.name = "QAError";
    this.code = options.code;
  }
}

/** Publication refused: the report found something an operator must fix. */
export class QABlockedError extends QAError {
  readonly report: QAReport;

  constructor(report: QAReport) {
    super(`QA refused publication: ${describe(report)}`, { code: "qa_blocked" });
    this.name = "QABlockedError";
    this.report = report;
  }
}

export function isQAError(error: unknown, code?: QAErrorCode): error is QAError {
  return error instanceof QAError && (code === undefined || error.code === code);
}

function describe(report: QAReport): string {
  const blocking = blockingFindings(report);
  const shown = blocking
    .slice(0, 4)
    .map((finding) =>
      finding.subject === "" ? finding.code : `${finding.code} (${finding.subject})`,
    );
  const rest = blocking.length - shown.length;
  return `${blocking.length} blocking finding(s): ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}
