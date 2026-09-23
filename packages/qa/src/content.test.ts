import type { ResearchPackage } from "@nexus/research";
import type { ScriptDoc } from "@nexus/script";
import { describe, expect, it } from "vitest";

import { checkContent } from "./content.js";
import { QA_FIXTURE_CLAIM, QA_FIXTURE_SOURCE, qaFixture } from "./fixtures.js";
import { DEFAULT_QA_SETTINGS } from "./settings.js";
import type { QACode } from "./schema.js";

/**
 * Content QA, one broken document at a time.
 *
 * Every case here is the *pass* case from the fixture with one thing changed: a
 * claim the evidence does not clear, a claim with no evidence, a sentence that
 * asserts a fact on its own authority, a contested claim shown as settled. The
 * clean run is asserted first, because a rule that fires on everything is worse
 * than no rule.
 */

function codes(codes: readonly string[]): readonly QACode[] {
  return codes.filter((code) => code.startsWith("content_")) as readonly QACode[];
}

describe("content checks", () => {
  it("passes a script whose claims are supported and evidenced", async () => {
    const fixture = await qaFixture();
    const result = checkContent(fixture.evidence, fixture.deps, DEFAULT_QA_SETTINGS);
    expect(result.report.status).toBe("ok");
    expect(result.findings).toEqual([]);
    expect(result.report.examined).toBeGreaterThan(0);
  });

  it("reports a script that is missing its conclusion", async () => {
    const fixture = await qaFixture();
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      sections: fixture.script.doc.sections.filter((section) => section.role !== "conclusion"),
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const missing = result.findings.filter((finding) => finding.code === "content_section_missing");
    expect(missing.map((finding) => finding.message)).toContain(
      "a script needs exactly one conclusion section",
    );
    // The plan still has the scene that section would have been cut into, and the
    // check says which document is out of step rather than guessing.
    expect(missing.some((finding) => finding.message.includes("the script does not have"))).toBe(
      true,
    );
  });

  it("reports a plan that drops a section the script wrote", async () => {
    const fixture = await qaFixture();
    const manifest = {
      ...fixture.manifest,
      scenes: fixture.manifest.scenes.map((scene) => ({ ...scene, sectionId: "sec_other" })),
    };
    const result = checkContent(
      fixture.with({ manifest: manifest as never }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(codes(result.findings.map((finding) => finding.code))).toContain(
      "content_section_missing",
    );
    expect(
      result.findings.some((finding) => finding.message.includes("which the script does not have")),
    ).toBe(true);
  });

  it("reports a claim stated as fact that the evidence does not clear", async () => {
    const fixture = await qaFixture();
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      claims: [
        {
          ...fixture.script.doc.claims[0]!,
          status: "unverified",
          certainty: "uncertain",
          mayStateAsFact: false,
          usage: "fact",
        },
      ],
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "content_claim_unsupported");
    expect(finding).toBeDefined();
    expect(finding?.subject).toBe(QA_FIXTURE_CLAIM);
    expect(String(finding?.message)).toMatch(/stated as fact/u);
  });

  it("reports a sentence that asserts a fact with no claim behind it", async () => {
    const fixture = await qaFixture();
    const section = fixture.script.doc.sections[0]!;
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      sections: [
        {
          ...section,
          sentences: section.sentences.map((sentence, index) => ({
            ...sentence,
            assertion: index === 0 ? "fact" : sentence.assertion,
            claimRefs: index === 0 ? [] : sentence.claimRefs,
          })),
        },
      ],
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.some(
        (finding) =>
          finding.code === "content_claim_unsupported" &&
          finding.message.includes("no claim behind it"),
      ),
    ).toBe(true);
  });

  it("reports a claim with no source evidence", async () => {
    const fixture = await qaFixture();
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      claims: [{ ...fixture.script.doc.claims[0]!, evidence: [] }],
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "content_source_missing");
    expect(finding?.subject).toBe(QA_FIXTURE_CLAIM);
  });

  it("reports an attributed sentence that names no source", async () => {
    const fixture = await qaFixture();
    const section = fixture.script.doc.sections[0]!;
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      sections: [
        {
          ...section,
          sentences: section.sentences.map((sentence) => ({
            ...sentence,
            assertion: "attributed" as const,
            sourceRefs: [],
          })),
        },
      ],
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(result.findings.some((finding) => finding.code === "content_source_missing")).toBe(true);
  });

  it("reports a source the research package does not have", async () => {
    const fixture = await qaFixture();
    const section = fixture.script.doc.sections[0]!;
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      sections: [
        {
          ...section,
          sentences: section.sentences.map((sentence) => ({
            ...sentence,
            assertion: "attributed" as const,
            sourceRefs: ["src_ghost"],
          })),
        },
      ],
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(result.findings.some((finding) => finding.message.includes("src_ghost"))).toBe(true);
  });

  it("reports a contested claim shown as fact, and preserves the disagreement", async () => {
    const fixture = await qaFixture();
    const research: ResearchPackage = {
      ...fixture.research.doc,
      conflicts: [
        {
          id: "cfl_fixture",
          kind: "numeric_disagreement",
          explanation: "Two counts disagree.",
          detectedBy: "evidence_stance",
          sides: [
            {
              kind: "claim",
              id: QA_FIXTURE_CLAIM,
              statement: "forty thousand",
              claimId: QA_FIXTURE_CLAIM,
              sourceIds: [],
            },
            {
              kind: "source",
              id: QA_FIXTURE_SOURCE,
              statement: "fifty thousand",
              sourceIds: [QA_FIXTURE_SOURCE],
            },
          ],
          preserved: true,
        },
      ],
      claims: fixture.research.doc.claims.map((claim) => ({ ...claim, contested: true })),
    };
    const result = checkContent(
      fixture.with({ research: { doc: research, hash: fixture.research.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "content_contradiction");
    expect(finding).toBeDefined();
    expect(String(finding?.message)).toMatch(/contested/u);
  });

  it("reports a scene showing a claim with different wording than the script", async () => {
    const fixture = await qaFixture();
    const scenes = fixture.manifest.scenes.map((scene) =>
      scene.index === 0
        ? {
            ...scene,
            sources: scene.sources.map((claim) => ({
              ...claim,
              statement: "A different statement entirely.",
            })),
          }
        : scene,
    );
    const result = checkContent(
      fixture.with({ manifest: { ...fixture.manifest, scenes } as never }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.some(
        (finding) =>
          finding.code === "content_contradiction" && finding.message.includes("different wording"),
      ),
    ).toBe(true);
  });

  it("reports a claim the research package does not have", async () => {
    const fixture = await qaFixture();
    const research: ResearchPackage = { ...fixture.research.doc, claims: [] };
    const result = checkContent(
      fixture.with({ research: { doc: research, hash: fixture.research.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(
      result.findings.some((finding) => finding.message.includes("not in the research package")),
    ).toBe(true);
  });

  it("says so, rather than passing, when there is no script to check", async () => {
    const fixture = await qaFixture({ withoutContent: true });
    const result = checkContent(fixture.evidence, fixture.deps, DEFAULT_QA_SETTINGS);
    expect(result.findings.map((finding) => finding.code)).toEqual(["qa_evidence_missing"]);
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.report.examined).toBe(0);
    expect(result.report.status).toBe("skipped");
    expect(result.report.note).toContain("no script document was supplied");
  });
  it("warns about a section the plan has no scene for", async () => {
    const fixture = await qaFixture();
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      sections: fixture.script.doc.sections.map((section, index) => ({
        ...section,
        id: index === 0 ? "sec_written_but_unplanned" : section.id,
      })),
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const unplanned = result.findings.find(
      (finding) =>
        finding.code === "content_section_unplanned" &&
        finding.subject === "sec_written_but_unplanned",
    );
    expect(unplanned?.severity).toBe("warning");
    expect(unplanned?.message).toContain("has no scene in the plan");
  });

  it("warns about a claim nothing in the script asserts", async () => {
    const fixture = await qaFixture();
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      claims: fixture.script.doc.claims.map((claim) => ({ ...claim, sentenceIds: [] })),
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const unreferenced = result.findings.find(
      (finding) => finding.code === "content_claim_unreferenced",
    );
    expect(unreferenced?.severity).toBe("warning");
    expect(result.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("warns about a writing problem the script's own lint left unfixed", async () => {
    const fixture = await qaFixture();
    const section = fixture.script.doc.sections[0]!;
    const sentence = section.sentences[0]!;
    const doc: ScriptDoc = {
      ...fixture.script.doc,
      quality: {
        ...fixture.script.doc.quality,
        issues: [
          {
            code: "filler",
            severity: "soft",
            sectionId: section.id,
            sentenceId: sentence.id,
            message: "filler phrase: it is worth noting",
            detail: "it is worth noting",
            resolvedByRepair: false,
          },
        ],
      },
    };
    const result = checkContent(
      fixture.with({ script: { doc, hash: fixture.script.hash } }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const quality = result.findings.find((finding) => finding.code === "content_quality_issue");
    expect(quality?.severity).toBe("warning");
    expect(quality?.subject).toBe(sentence.id);

    // An issue the corrective round fixed is history, not a finding.
    const fixed = checkContent(
      fixture.with({
        script: {
          doc: {
            ...doc,
            quality: {
              ...doc.quality,
              issues: doc.quality.issues.map((issue) => ({ ...issue, resolvedByRepair: true })),
            },
          },
          hash: fixture.script.hash,
        },
      }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    expect(fixed.findings.map((finding) => finding.code)).not.toContain("content_quality_issue");
  });
});
