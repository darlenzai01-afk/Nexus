/**
 * `@nexus/qa` — the automated QA engine (Phase 12).
 *
 * Pipeline position: after `render`, before `approval`. The engine reads what the
 * earlier phases produced — the research package, the script, the scene plan, the
 * character library, the narration and caption tracks, the encoded video and the
 * job's own state — and answers one question: **may this episode be published?**
 *
 * The pieces:
 *
 * 1. `runQA` — five checks (content, visual, audio, video, pipeline) over an
 *    evidence bundle, assembled into one `QAReport` (`engine.ts`).
 * 2. The checks themselves (`content.ts`, `visual.ts`, `audio.ts`, `video.ts`,
 *    `pipeline.ts`) — each one a pure function of the documents it is handed, so
 *    every rule has a failing test that hands it a broken document.
 * 3. `QA_CODES` (`schema.ts`) — the registry of every finding: its category, its
 *    severity, and therefore whether it blocks publication. An `error` blocks, a
 *    `warning` is recorded for a human, an `info` is context.
 * 4. `persistQAReport` / `qaSummaryMarkdown` (`persist.ts`) — the report as an
 *    artifact (`qa_report`) plus a readable summary (`qa_summary`).
 * 5. `createQATask` (`task.ts`) — the `qa` stage: assembles the evidence from the
 *    upstream stages' outputs, stores the report, and **fails the job when the
 *    report refuses publication**, which is what stops `approval` and `publish`.
 * 6. `assertPublishable` — the guard a publisher calls, so a caller that forgets to
 *    read the verdict still cannot ship a blocked episode.
 */

export {
  HARD_QA_CODES,
  QA_CODES,
  QA_CODE_NAMES,
  QA_ENGINE,
  QA_ORDER,
  QA_REPORT_VERSION,
  QACategorySchema,
  QACheckReportSchema,
  QACodeSchema,
  QACountsSchema,
  QAFindingSchema,
  QAReportSchema,
  QASeveritySchema,
  QASettingsSchema,
  QASubjectSchema,
  blockingFindings,
  blocksPublication,
  categoryOf,
  compareFindings,
  describeBlocking,
  isHardQACode,
  parseQAReport,
  qaReportBytes,
  severityOf,
  type QACategory,
  type QACheckReport,
  type QACode,
  type QACounts,
  type QAFinding,
  type QAReport,
  type QASeverity,
  type QASettings,
  type QASettingsInput,
  type QASubject,
} from "./schema.js";

export { DEFAULT_QA_SETTINGS, resolveQASettings, settingsHash } from "./settings.js";

export { QABlockedError, QAError, isQAError, type QAErrorCode } from "./errors.js";

export {
  QA_CHECKS,
  assertPublishable,
  describeReport,
  runQA,
  subjectOf,
  type RunQAOptions,
} from "./engine.js";

export { readBytes, type Checker, type Loaded, type QADeps, type QAEvidence } from "./evidence.js";

export { checkContent } from "./content.js";
export { checkVisual } from "./visual.js";
export { checkAudio, silentWindowsOf } from "./audio.js";
export { checkVideo } from "./video.js";
export { checkPipeline } from "./pipeline.js";

export {
  collectPipelineSnapshot,
  pipelineFor,
  stepOf,
  type PipelineSnapshot,
  type PipelineStepSnapshot,
  type SnapshotDeps,
} from "./snapshot.js";

export {
  QA_ARTIFACT_KIND,
  QA_ARTIFACT_ROLE,
  QA_SUMMARY_ARTIFACT_KIND,
  QA_SUMMARY_ARTIFACT_ROLE,
  loadQAReport,
  persistQAReport,
  qaArtifactOf,
  qaArtifactRef,
  qaSummaryMarkdown,
  type PersistQADeps,
  type PersistedQA,
} from "./persist.js";

export { QA_STAGE_KEY, createQATask, type QATaskDeps } from "./task.js";

export {
  QA_FIXTURE_CLAIM,
  QA_FIXTURE_CLOCK,
  QA_FIXTURE_EVIDENCE,
  QA_FIXTURE_SOURCE,
  QA_FIXTURE_STATEMENT,
  QA_FIXTURE_URL,
  QA_NARRATION,
  QA_SECTION_ROLES,
  artifact,
  cleanupQAFixtureTemp,
  fixtureFonts,
  completedSnapshot,
  passingSnapshot,
  step,
  qaFixture,
  planFixture,
  researchFixture,
  sceneClaim,
  scriptFixture,
  sourceContent,
  type QAFixture,
  type QAFixtureOptions,
  type RenderFixtureOptions,
  type RenderedFixture,
  type SnapshotOptions,
} from "./fixtures.js";
