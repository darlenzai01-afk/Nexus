import type { ArtifactRef, ArtifactRow, Repo } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import { QAReportSchema, qaReportBytes, type QAReport } from "./schema.js";

/**
 * Publishing the report.
 *
 * A QA verdict is only useful if it outlives the process that produced it, so the
 * report is an artifact like any other: content-addressed, registered, referenced
 * by the step that made it. Two artifacts, because they serve different readers:
 *
 * - `qa_report` (JSON) — the structured report, what the publisher and the
 *   pipeline read;
 * - `qa_summary` (Markdown, kind `document`) — the same report as a page a human
 *   can skim, because "why is this blocked?" should not require parsing JSON.
 */

export const QA_ARTIFACT_KIND = "qa_report" as const;
export const QA_ARTIFACT_ROLE = "qa_report" as const;
export const QA_SUMMARY_ARTIFACT_KIND = "document" as const;
export const QA_SUMMARY_ARTIFACT_ROLE = "qa_summary" as const;

export interface PersistQADeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
}

export interface PersistedQA {
  readonly report: QAReport;
  readonly hash: string;
  readonly bytes: number;
  readonly summaryHash: string;
  readonly summaryBytes: number;
}

/** Write the report (and its summary) into the CAS and register both. */
export function persistQAReport(deps: PersistQADeps, report: QAReport): PersistedQA {
  const parsed = QAReportSchema.parse(report);
  const bytes = qaReportBytes(parsed);
  const stored = deps.storage.put(bytes);
  deps.repo.registerArtifact({
    hash: stored.hash,
    kind: QA_ARTIFACT_KIND,
    bytes: stored.bytes,
    // `ArtifactMetaSchema` fields only: what a browse view needs, nothing more.
    meta: { generatedBy: { provider: `${parsed.engine.name} ${parsed.engine.version}` } },
  });

  const summary = new TextEncoder().encode(qaSummaryMarkdown(parsed));
  const summaryStored = deps.storage.put(summary);
  deps.repo.registerArtifact({
    hash: summaryStored.hash,
    kind: QA_SUMMARY_ARTIFACT_KIND,
    bytes: summaryStored.bytes,
    meta: { generatedBy: { provider: `${parsed.engine.name} ${parsed.engine.version}` } },
  });

  return {
    report: parsed,
    hash: stored.hash,
    bytes: stored.bytes,
    summaryHash: summaryStored.hash,
    summaryBytes: summaryStored.bytes,
  };
}

export function loadQAReport(storage: BlobStore, hash: string): QAReport {
  const bytes = storage.read(hash);
  return QAReportSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

export function qaArtifactRef(row: ArtifactRow): ArtifactRef {
  return { hash: row.hash, kind: row.kind, role: QA_ARTIFACT_ROLE };
}

/** The report a step recorded, when it has one. */
export function qaArtifactOf(refs: readonly ArtifactRef[]): ArtifactRef | undefined {
  return refs.find((ref) => ref.kind === QA_ARTIFACT_KIND && ref.role === QA_ARTIFACT_ROLE);
}

/** The same report, as a page: verdict, what was checked, what was found. */
export function qaSummaryMarkdown(report: QAReport): string {
  const lines: string[] = [
    `# QA report — ${report.verdict === "pass" ? "pass" : report.verdict === "fail" ? "blocked" : "pass with warnings"}`,
    "",
    `- **Verdict**: \`${report.verdict}\` — ${report.publishable ? "may be published" : "publication blocked"}`,
    `- **Episode / job**: \`${report.episodeId || "(none)"}\` / \`${report.jobId || "(none)"}\``,
    `- **Generated**: ${report.generatedAt} by ${report.engine.name} ${report.engine.version}`,
    `- **Findings**: ${report.counts.errors} error(s), ${report.counts.warnings} warning(s), ${report.counts.infos} info`,
    `- **Subject**: plan \`${short(report.subject.manifestHash)}\`, script \`${short(report.subject.scriptHash)}\`, ` +
      `audio \`${short(report.subject.audioTrackHash)}\`, video \`${short(report.subject.videoHash)}\``,
    "",
    "## Checks",
    "",
    "| Check | Status | Examined | Findings | Note |",
    "| ----- | ------ | -------- | -------- | ---- |",
  ];
  for (const check of report.checks) {
    lines.push(
      `| \`${check.id}\` | ${check.status} | ${check.examined} | ${check.findings} | ${escape(check.note)} |`,
    );
  }

  lines.push("", "## Findings", "");
  if (report.findings.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(
      "| Severity | Code | Subject | Message |",
      "| -------- | ---- | ------- | ------- |",
    );
    for (const finding of report.findings) {
      lines.push(
        `| ${finding.severity} | \`${finding.code}\` | ${escape(finding.subject)} | ${escape(finding.message)} |`,
      );
    }
  }

  if (report.blocking.length > 0) {
    lines.push(
      "",
      "## What blocks publication",
      "",
      ...report.blocking.map((code) => `- \`${code}\``),
      "",
      "An operator fixes these, then the `qa` stage is re-run against the same episode.",
    );
  }

  if (report.notes.length > 0) {
    lines.push("", "## Notes", "", ...report.notes.map((note) => `- ${escape(note)}`));
  }

  return `${lines.join("\n")}\n`;
}

function short(hash: string): string {
  return hash === "" ? "(none)" : hash.slice(0, 12);
}

function escape(text: string): string {
  return text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}
