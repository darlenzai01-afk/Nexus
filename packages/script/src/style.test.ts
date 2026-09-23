import type { ScriptDoc } from "@nexus/db";
import { describe, expect, it } from "vitest";

import { lintScript, structureFindings, type StyleContext } from "./style.js";

/**
 * The writing lint: the deterministic half of the brief's "avoid" list. It never
 * rewrites prose — it reports, and the pipeline hands the findings to the writer.
 */

const context: StyleContext = {
  knownDomains: ["news.example.com", "data.example.org"],
  evidenceExcerpts: ["Traffic counts show 40,000 vehicles a day crossing the bridge."],
};

function docOf(sections: ScriptDoc["sections"]): ScriptDoc {
  return {
    version: 2,
    topic: "The Kira bridge",
    workingTitle: "The bridge that carries a city",
    logline: "",
    sections,
    claims: [],
    quality: { issues: [], repairRounds: 0, reviewRequired: false, droppedSentences: [] },
    stats: { sections: sections.length, sentences: 0, words: 0, estimatedDurationSec: 0 },
    provenance: {
      engine: { name: "test", version: "0" },
      researchPackageHash: "0".repeat(64),
      providers: { llm: "stub" },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
      repairRounds: 0,
      generatedAt: "2024-05-01T00:00:00.000Z",
      durationMs: 0,
    },
    warnings: [],
  };
}

const section = (
  id: string,
  role: ScriptDoc["sections"][number]["role"],
  narrations: string[],
) => ({
  id,
  role,
  title: role,
  transition: "",
  sentences: narrations.map((narration, index) => ({
    id: `${id}_${index}`,
    narration,
    assertion: "context" as const,
    claimRefs: [],
    sourceRefs: [],
  })),
});

const goodStructure = [
  section("sec1", "hook", ["Forty thousand vehicles cross the Kira bridge every day."]),
  section("sec2", "introduction", ["The bridge opened in 1973 and immediately changed the city."]),
  section("sec3", "narrative", ["Traffic grew faster than the planners expected."]),
  section("sec4", "narrative", ["By the nineties the deck needed strengthening."]),
  section("sec5", "conclusion", ["That is what the numbers still show today."]),
];

describe("script writing lint", () => {
  it("passes a clean script", () => {
    expect(lintScript(docOf(goodStructure), context)).toEqual([]);
  });

  it("enforces the required structure", () => {
    const missing = lintScript(docOf(goodStructure.slice(1)), context);
    expect(missing.map((finding) => finding.code)).toContain("missing_section");
    expect(missing.every((finding) => finding.severity === "hard")).toBe(true);

    const unordered = docOf([
      goodStructure[1]!, // introduction first
      goodStructure[0]!, // hook second
      goodStructure[2]!,
      goodStructure[3]!,
      goodStructure[4]!,
    ]);
    const messages = structureFindings(unordered)
      .map((finding) => finding.message)
      .join(" ");
    expect(messages).toContain("first section must be the hook");
    expect(messages).toContain("sections are out of order");

    const thinNarrative = docOf([
      goodStructure[0]!,
      goodStructure[1]!,
      goodStructure[2]!,
      goodStructure[4]!,
    ]);
    expect(
      structureFindings(thinNarrative).some((finding) => finding.message.includes("two narrative")),
    ).toBe(true);
  });

  it("flags filler and manufactured suspense", () => {
    const findings = lintScript(
      docOf([
        section("sec1", "hook", ["In this video we look at the Kira bridge."]),
        section("sec2", "introduction", ["Stay tuned, because what happened next will shock you."]),
        section("sec3", "narrative", ["It's important to note that traffic grew."]),
        section("sec4", "narrative", ["Moreover, the deck needed work."]),
        section("sec5", "conclusion", [
          "At the end of the day, the bridge still carries the city.",
        ]),
      ]),
      context,
    );
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain("filler");
    expect(codes).toContain("fake_suspense");
    expect(findings.filter((finding) => finding.code === "filler")).toHaveLength(3);
    // Both manufactured-suspense phrases in that line are reported.
    const suspense = findings.filter((finding) => finding.code === "fake_suspense");
    expect(suspense.length).toBeGreaterThanOrEqual(1);
    expect(suspense.map((finding) => finding.message).join(" ")).toContain("stay tuned");
    expect(findings.every((finding) => finding.severity === "soft")).toBe(true);
  });

  it("flags repetitive phrasing across the script", () => {
    const findings = lintScript(
      docOf([
        section("sec1", "hook", ["The bridge carries traffic every day."]),
        section("sec2", "introduction", ["The bridge carries traffic into the city."]),
        section("sec3", "narrative", ["The bridge carries traffic over the river."]),
        section("sec4", "narrative", [
          "Moreover, the deck aged.",
          "Furthermore, the piers settled.",
        ]),
        section("sec5", "conclusion", ["Additionally, the city keeps growing."]),
      ]),
      context,
    );
    const repetition = findings.filter((finding) => finding.code === "repetition");
    expect(repetition.length).toBeGreaterThanOrEqual(2);
    expect(repetition.map((finding) => finding.message).join(" ")).toContain("same three words");
    expect(repetition.map((finding) => finding.message).join(" ")).toContain(
      "academic connectives",
    );
  });

  it("flags invented quotations and fabricated sources as hard issues", () => {
    const findings = lintScript(
      docOf([
        section("sec1", "hook", ['The mayor said "we never expected this," and traffic doubled.']),
        section("sec2", "introduction", [
          "According to the bridge-authority.com figures, it grew.",
        ]),
        section("sec3", "narrative", [
          "Traffic counts show 40,000 vehicles a day crossing the bridge.",
        ]),
        section("sec4", "narrative", ["Data.example.org reports the same number."]),
        section("sec5", "conclusion", ["That is the story the numbers tell."]),
      ]),
      context,
    );
    const quotes = findings.filter((finding) => finding.code === "unverified_quote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.severity).toBe("hard");
    const fabricated = findings.filter((finding) => finding.code === "fabricated_source");
    // The invented domain is caught; the evidence-backed narration is not.
    expect(fabricated.map((finding) => finding.detail).join(" ")).toContain("bridge-authority.com");
    expect(findings.some((finding) => finding.detail.includes("news.example.com"))).toBe(false);
  });

  it("accepts a quotation that is verbatim from the evidence", () => {
    const findings = lintScript(
      docOf([
        section("sec1", "hook", [
          'Consider what the counts say: "40,000 vehicles a day crossing the bridge".',
        ]),
        section("sec2", "introduction", ["That is a lot for four lanes."]),
        section("sec3", "narrative", ["The deck was strengthened in the nineties."]),
        section("sec4", "narrative", ["Traffic kept rising anyway."]),
        section("sec5", "conclusion", ["The number is still the city's problem to solve."]),
      ]),
      context,
    );
    expect(findings.filter((finding) => finding.code === "unverified_quote")).toEqual([]);
  });

  it("flags long sentences and markup: this is read aloud, not rendered", () => {
    const long = `${"word ".repeat(40).trim()}.`;
    const findings = lintScript(
      docOf([
        section("sec1", "hook", ["**The Kira bridge**, in numbers:"]),
        section("sec2", "introduction", [long]),
        section("sec3", "narrative", ["Traffic grew."]),
        section("sec4", "narrative", ["The deck aged."]),
        section("sec5", "conclusion", ["That is the story."]),
      ]),
      context,
    );
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain("long_sentence");
    expect(codes).toContain("markup");
    expect(findings.find((finding) => finding.code === "long_sentence")!.message).toContain(
      "40 words",
    );
  });
});
