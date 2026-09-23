import { vi, describe, expect, it } from "vitest";

// The first fixture build renders a real (scripted-FFmpeg) file, which costs a
// few seconds — and more on a loaded machine. The 5 s defaults are for unit tests,
// not for the tests that wait on a render.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { assertPublishable, runQA, subjectOf } from "./engine.js";
import { QABlockedError, isQAError } from "./errors.js";
import { passingSnapshot, qaFixture } from "./fixtures.js";
import { persistQAReport, loadQAReport, qaSummaryMarkdown, qaArtifactOf } from "./persist.js";
import { QA_CODES, compareFindings, parseQAReport, severityOf, type QAReport } from "./schema.js";
import { resolveQASettings, settingsHash } from "./settings.js";

/**
 * The engine and the report: one verdict, assembled from five checks.
 *
 * These tests are about the *report* rather than the rules: that a clean episode
 * earns a `pass`, that a single error turns the report into a refusal a publisher
 * cannot ignore, that findings are ordered and deduplicated, and that a check which
 * could not run says so instead of leaving a silent hole in the coverage.
 */

/**
 * One rendered fixture, shared by the tests that need a complete episode.
 *
 * The render is about the *plan* (the same five sections with the same narration
 * every time), so a test may replace a document — the script, a clip, a caption —
 * and still use this video: the verdict changes because the document did, which is
 * exactly what these tests are asserting.
 */
let shared:
  | Promise<{
      fixture: Awaited<ReturnType<typeof qaFixture>>;
      rendered: ReturnType<Awaited<ReturnType<typeof qaFixture>>["render"]>;
    }>
  | undefined;

function sharedFixture() {
  shared ??= (async () => {
    const fixture = await qaFixture();
    // A proxy size: the video checks read the container's integrity, and the plan
    // itself (which the visual checks measure) is at its own design resolution.
    return { fixture, rendered: fixture.render({ width: 192, height: 108 }) };
  })();
  return shared;
}

async function clean(): Promise<QAReport> {
  const { fixture, rendered } = await sharedFixture();
  return runQA(
    {
      ...fixture.evidence,
      pipeline: passingSnapshot(),
      video: { hash: rendered.videoHash },
      render: { doc: rendered.metadata, hash: rendered.metadataHash },
    },
    fixture.deps,
  );
}

/** Evidence for the shared plan: the video, its metadata and a finished job. */
async function cleanEvidence(patch: Record<string, unknown> = {}) {
  const { fixture, rendered } = await sharedFixture();
  return {
    fixture,
    evidence: {
      ...fixture.evidence,
      pipeline: passingSnapshot(),
      video: { hash: rendered.videoHash },
      render: { doc: rendered.metadata, hash: rendered.metadataHash },
      ...patch,
    },
  };
}

describe("runQA", () => {
  it("passes an episode that earns it", async () => {
    const report = await clean();
    expect(report.verdict).toBe("pass");
    expect(report.publishable).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.blocking).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({
      findings: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      checks: 5,
      skipped: 0,
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      "content.script",
      "visual.frames",
      "audio.track",
      "video.output",
      "pipeline.state",
    ]);
    expect(report.checks.every((check) => check.status === "ok")).toBe(true);
    expect(() => assertPublishable(report)).not.toThrow();
  });

  it("refuses an episode whose script overstates the evidence", async () => {
    const fixture = await qaFixture();
    const broken = fixture.with({
      script: {
        doc: {
          ...fixture.script.doc,
          claims: [{ ...fixture.script.doc.claims[0]!, mayStateAsFact: false, usage: "fact" }],
        },
        hash: fixture.script.hash,
      },
    });
    const report = runQA(broken, fixture.deps);
    expect(report.verdict).toBe("fail");
    expect(report.publishable).toBe(false);
    expect(report.blocked).toBe(true);
    expect(report.blocking).toContain("content_claim_unsupported");
    // One code, one entry, however many findings carry it.
    expect(report.blocking.filter((code) => code === "content_claim_unsupported")).toHaveLength(1);
    expect(() => assertPublishable(report)).toThrow(QABlockedError);
    try {
      assertPublishable(report);
    } catch (error) {
      expect(isQAError(error, "qa_blocked")).toBe(true);
      expect((error as QABlockedError).report.settingsHash).toBe(report.settingsHash);
    }
  });

  it("passes with warnings when nothing blocks", async () => {
    const { fixture, evidence } = await cleanEvidence();
    // A writing-quality issue the script engine recorded and nobody fixed: worth
    // telling a human, not worth refusing to publish.
    const issue = {
      code: "filler" as const,
      severity: "soft" as const,
      sectionId: fixture.script.doc.sections[0]!.id,
      sentenceId: fixture.script.doc.sections[0]!.sentences[0]!.id,
      message: "filler phrase: it is worth noting",
      detail: "it is worth noting",
      resolvedByRepair: false,
    };
    const report = runQA(
      {
        ...evidence,
        script: {
          doc: {
            ...fixture.script.doc,
            quality: { ...fixture.script.doc.quality, issues: [issue] },
          },
          hash: fixture.script.hash,
        },
      },
      fixture.deps,
    );
    expect(report.verdict).toBe("pass_with_warnings");
    expect(report.publishable).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBeGreaterThan(0);
    expect(() => assertPublishable(report)).not.toThrow();
  });

  it("says which checks could not run", async () => {
    const { fixture, evidence } = await cleanEvidence();
    const report = runQA({ ...evidence, script: undefined, research: undefined }, fixture.deps);
    const content = report.checks.find((check) => check.id === "content.script");
    expect(content?.status).toBe("skipped");
    expect(content?.note).toContain("no script document");
    expect(report.counts.skipped).toBe(1);
    expect(report.notes.join(" ")).toContain("could not run");
    // Still publishable: a warning about missing evidence is not a defect in the video.
    expect(report.publishable).toBe(true);
  });

  it("orders findings by category, code and subject", async () => {
    const fixture = await qaFixture();
    const manifest = {
      ...fixture.manifest,
      totalDurationSec: fixture.manifest.totalDurationSec + 4,
      assets: fixture.manifest.assets.map((asset) => ({
        ...asset,
        status: "planned" as const,
        uri: "",
      })),
    } as typeof fixture.manifest;
    const report = runQA(
      fixture.with({
        manifest,
        script: {
          doc: {
            ...fixture.script.doc,
            claims: [{ ...fixture.script.doc.claims[0]!, evidence: [] }],
          },
          hash: fixture.script.hash,
        },
      }),
      fixture.deps,
    );
    const categories = report.findings.map((finding) => finding.category);
    const rank = ["content", "visual", "audio", "video", "pipeline"];
    const ranks = categories.map((category) => rank.indexOf(category));
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect([...report.findings].sort(compareFindings)).toEqual(report.findings);
    expect(report.counts.findings).toBe(report.findings.length);
  });

  it("records the rules it ran with, and hashes them", async () => {
    const fixture = await qaFixture();
    const strict = runQA(fixture.evidence, fixture.depsWith({ minFontPx: 140, tightFontPx: 150 }));
    const relaxed = runQA(fixture.evidence, fixture.deps);
    expect(strict.settings.minFontPx).toBe(140);
    expect(strict.settingsHash).not.toBe(relaxed.settingsHash);
    expect(relaxed.settingsHash).toBe(settingsHash(resolveQASettings()));
    expect(strict.findings.some((finding) => finding.code === "visual_text_unreadable")).toBe(true);
    expect(relaxed.findings.some((finding) => finding.code === "visual_text_unreadable")).toBe(
      false,
    );
  });

  it("names the documents the verdict is about", async () => {
    const fixture = await qaFixture();
    const report = runQA(fixture.evidence, fixture.deps, {
      episodeId: "ep_other",
      jobId: "job_other",
    });
    expect(report.episodeId).toBe("ep_other");
    expect(report.jobId).toBe("job_other");
    expect(report.subject.manifestHash).toBe(fixture.manifestHash);
    expect(report.subject.scriptHash).toBe(fixture.script.hash);
    expect(report.subject.audioTrackHash).toBe(fixture.audio.hash);
    expect(report.subject.captionTrackHash).toBe(fixture.captions.hash);
    expect(report.subject.videoHash).toBe("");
    expect(subjectOf(fixture.evidence).researchPackageHash).toBe(fixture.research.hash);
  });

  it("only lets `error` codes block", async () => {
    const report = await clean();
    for (const code of report.blocking) expect(severityOf(code)).toBe("error");
    expect(QA_CODES.audio_unmeasurable.severity).toBe("warning");
    expect(QA_CODES.content_claim_unsupported.severity).toBe("error");
  });

  it("is reproducible for the same inputs", async () => {
    const fixture = await qaFixture();
    const first = runQA(fixture.evidence, fixture.deps);
    const second = runQA(fixture.evidence, fixture.deps);
    expect(second).toEqual(first);
    expect(first.generatedAt).toBe(fixture.deps.now);
  });
});

describe("the report as an artifact", () => {
  it("stores the report and a summary, and reads them back", async () => {
    const { fixture, evidence } = await cleanEvidence();
    const report = runQA(evidence, fixture.deps);
    const persisted = persistQAReport({ storage: fixture.storage, repo: fixture.repo }, report);

    expect(fixture.repo.getArtifact(persisted.hash)?.kind).toBe("qa_report");
    expect(fixture.storage.has(persisted.hash)).toBe(true);
    expect(loadQAReport(fixture.storage, persisted.hash)).toEqual(report);
    expect(
      parseQAReport(JSON.parse(new TextDecoder().decode(fixture.storage.read(persisted.hash)))),
    ).toEqual(report);

    const summary = new TextDecoder().decode(fixture.storage.read(persisted.summaryHash));
    expect(summary).toContain("# QA report");
    expect(summary).toContain("pass");
    expect(qaSummaryMarkdown(report)).toBe(summary);
    expect(fixture.repo.getArtifact(persisted.summaryHash)?.kind).toBe("document");

    const refs = [
      { hash: persisted.hash, kind: "qa_report" as const, role: "qa_report" },
      { hash: persisted.summaryHash, kind: "document" as const, role: "qa_summary" },
    ];
    expect(qaArtifactOf(refs)?.hash).toBe(persisted.hash);
    expect(qaArtifactOf([refs[1]!])).toBeUndefined();
  });

  it("lists what blocks, in the summary", async () => {
    const fixture = await qaFixture();
    const research = { ...fixture.research.doc, claims: [] };
    const report = runQA(
      fixture.with({ research: { doc: research, hash: fixture.research.hash } }),
      fixture.deps,
    );
    const summary = qaSummaryMarkdown(report);
    expect(summary).toContain("What blocks publication");
    expect(summary).toContain("content_claim_unsupported");
    expect(summary).toContain(`\`${report.verdict}\``);
  });
});
