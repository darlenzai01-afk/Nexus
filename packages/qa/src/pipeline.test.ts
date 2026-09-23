import { describe, expect, it } from "vitest";

import { artifact, completedSnapshot, passingSnapshot, qaFixture, step } from "./fixtures.js";
import { checkPipeline } from "./pipeline.js";
import { DEFAULT_QA_SETTINGS } from "./settings.js";
import type { PipelineSnapshot } from "./snapshot.js";

/**
 * Pipeline QA, one incoherent job at a time.
 *
 * These checks read state, not documents, so every case here starts from a
 * *correct* job (the fixture derives its steps from the real pipeline definition)
 * and changes one thing: a lease that expired, a step that failed, a stage the job
 * skipped, an artifact that has no bytes, an episode state nobody left it in.
 */

async function evidence(patch: Partial<PipelineSnapshot> = {}) {
  const fixture = await qaFixture();
  return fixture.with({
    pipeline: { ...passingSnapshot(), ...patch } as PipelineSnapshot,
  });
}

describe("pipeline checks", () => {
  it("passes a job that ran the stages through qa", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot();
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(result.findings).toEqual([]);
    expect(result.report.examined).toBeGreaterThan(snapshot.steps.length);
    expect(result.report.note).toContain("RUNNING");
  });

  it("passes a job that ran every stage", async () => {
    const fixture = await qaFixture();
    const result = checkPipeline(
      fixture.with({ pipeline: completedSnapshot() }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(result.findings).toEqual([]);
  });

  it("reports a job running on an expired lease", async () => {
    const withLease = await evidence({ leaseExpired: true });
    const fixture = await qaFixture();
    const result = checkPipeline(withLease, fixture.deps, DEFAULT_QA_SETTINGS);
    const finding = result.findings.find((entry) => entry.code === "pipeline_invalid_state");
    expect(finding?.message).toMatch(/expired/u);
  });

  it("reports a failed step, naming it", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({
      jobState: "FAILED",
      steps: [
        step("idea"),
        step("research", [artifact("document", "research", "research")], {
          state: "FAILED",
          error: "the search provider returned nothing",
        }),
      ],
    });
    const result = checkPipeline(
      fixture.with({ pipeline: { ...snapshot, failureStep: "research" } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "pipeline_step_failed");
    expect(finding?.subject).toBe("research");
    expect(finding?.message).toContain("the search provider returned nothing");
  });

  it("reports a finished job with a step that never finished", async () => {
    const fixture = await qaFixture();
    const snapshot = completedSnapshot({
      steps: completedSnapshot().steps.map((entry) =>
        entry.key === "render" ? { ...entry, state: "PENDING" as const } : entry,
      ),
    });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.some(
        (finding) =>
          finding.code === "pipeline_invalid_state" && finding.message.includes("never finished"),
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) => finding.code === "pipeline_incomplete_stages" && finding.subject === "render",
      ),
    ).toBe(true);
  });

  it("reports a stage the job skipped between the stages it ran", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({
      steps: passingSnapshot().steps.filter((entry) => entry.key !== "render"),
    });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "pipeline_incomplete_stages");
    expect(finding).toBeDefined();
    expect(String(finding?.evidence.missing)).toContain("render");
  });

  it("reports a stage that did not produce the artifact kind it declares", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({
      steps: passingSnapshot().steps.map((entry) =>
        entry.key === "render"
          ? { ...entry, artifacts: [artifact("video", "video_master", "render")] }
          : entry,
      ),
    });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "pipeline_missing_artifacts");
    expect(finding?.subject).toBe("render");
    expect(String(finding?.message)).toMatch(/thumbnail/u);
  });

  it("reports an artifact whose bytes are not in the store", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({ hasArtifact: false });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.filter((entry) => entry.code === "pipeline_missing_artifacts").length,
    ).toBe(snapshot.steps.reduce((sum, entry) => sum + entry.artifacts.length, 0));
  });

  it("reports a done step with no output document", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({
      steps: passingSnapshot().steps.map((entry) =>
        entry.key === "voice" ? { ...entry, output: undefined } : entry,
      ),
    });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.some(
        (finding) => finding.code === "pipeline_invalid_state" && finding.subject === "voice",
      ),
    ).toBe(true);
  });

  it("reports an episode whose state no stage left it in", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({ episodeState: "FACT_REVIEW" });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "pipeline_invalid_state");
    expect(String(finding?.message)).toMatch(/FACT_REVIEW/u);
    expect(finding?.evidence.lastStage).toBe("qa");
    expect(finding?.evidence.expected).toBe("APPROVAL");
  });

  it("reports a job running a pipeline this build does not know", async () => {
    const fixture = await qaFixture();
    const snapshot = passingSnapshot({ pipeline: "longform_v9" });
    const result = checkPipeline(
      fixture.with({ pipeline: snapshot }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.some((finding) => finding.message.includes("which this build does not know")),
    ).toBe(true);
  });

  it("says the job was not checked rather than passing silently", async () => {
    const fixture = await qaFixture();
    const result = checkPipeline(fixture.evidence, fixture.deps, DEFAULT_QA_SETTINGS);
    expect(result.findings.map((finding) => finding.code)).toEqual(["qa_evidence_missing"]);
    expect(result.findings[0]?.severity).toBe("warning");
  });
});
