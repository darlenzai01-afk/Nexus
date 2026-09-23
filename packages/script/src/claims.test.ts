import { describe, expect, it } from "vitest";

import { buildClaimBrief, buildClaimLedger, verifyScriptClaims } from "./claims.js";
import {
  CLEAR_CLAIM_ID,
  ORPHAN_CLAIM_ID,
  THIN_CLAIM_ID,
  researchPackageFixture,
} from "./fixtures.js";
import type { ScriptDoc } from "@nexus/db";

/**
 * The claim brief and the claim/evidence chain: what the writer is allowed to
 * say, and the deterministic proof that it stayed inside that.
 */
describe("script claim brief", () => {
  const brief = buildClaimBrief(researchPackageFixture());

  it("splits claims into assertable, attributable and blocked", () => {
    expect(brief.facts.map((fact) => fact.claimId)).toEqual([CLEAR_CLAIM_ID]);
    expect(brief.facts[0]!.sourceDomains).toEqual(["data.example.org", "news.example.com"]);
    expect(brief.attributed.map((item) => item.claimId)).toEqual([THIN_CLAIM_ID]);
    expect(brief.attributed[0]).toMatchObject({
      reason: "only one source backs it",
      sourceIds: ["src_forum"],
    });
    // Nothing verified the orphan claim, so the writer never sees it.
    expect(brief.blocked.map((item) => item.claimId)).toEqual([ORPHAN_CLAIM_ID]);
    expect(brief.blocked[0]!.reason).toContain("no verified evidence");
  });

  it("carries the verbatim evidence with its locator", () => {
    expect(brief.evidence.get("ev_news")).toEqual({
      excerpt: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
      locator: "0:65",
    });
  });

  const docWith = (sentences: ScriptDoc["sections"][number]["sentences"]): ScriptDoc =>
    ({
      version: 2,
      topic: "The Kira bridge",
      workingTitle: "T",
      logline: "",
      sections: [
        { id: "sec1", role: "hook", title: "Hook", transition: "", sentences },
        { id: "sec2", role: "introduction", title: "Intro", transition: "", sentences: [] },
        { id: "sec3", role: "narrative", title: "A", transition: "", sentences: [] },
        { id: "sec4", role: "narrative", title: "B", transition: "", sentences: [] },
        { id: "sec5", role: "conclusion", title: "End", transition: "", sentences: [] },
      ],
      claims: [],
      quality: { issues: [], repairRounds: 0, reviewRequired: false, droppedSentences: [] },
      stats: { sections: 5, sentences: 1, words: 1, estimatedDurationSec: 0.4 },
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
    }) as unknown as ScriptDoc;

  const sentence = (
    overrides: Partial<ScriptDoc["sections"][number]["sentences"][number]>,
  ): ScriptDoc["sections"][number]["sentences"][number] => ({
    id: "s1_1",
    narration: "Narration.",
    assertion: "context",
    claimRefs: [],
    sourceRefs: [],
    ...overrides,
  });

  it("accepts a fact that research cleared", () => {
    const doc = docWith([
      sentence({
        narration: "The bridge carries 40,000 vehicles a day.",
        assertion: "fact",
        claimRefs: [CLEAR_CLAIM_ID],
      }),
    ]);
    expect(verifyScriptClaims(doc, brief)).toEqual([]);
  });

  it("rejects stating an uncleared claim as fact", () => {
    const doc = docWith([
      sentence({
        narration: "Crossing takes fifteen minutes at peak.",
        assertion: "fact",
        claimRefs: [THIN_CLAIM_ID],
      }),
    ]);
    const violations = verifyScriptClaims(doc, brief);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ code: "unsupported_assertion", sentenceId: "s1_1" });
    expect(violations[0]!.detail).toContain("likely");
  });

  it("rejects a factual assertion with no claim behind it", () => {
    const doc = docWith([
      sentence({ narration: "The bridge is the busiest in the country.", assertion: "fact" }),
    ]);
    expect(verifyScriptClaims(doc, brief).map((violation) => violation.code)).toEqual([
      "unsupported_assertion",
    ]);
  });

  it("requires the citation to exist", () => {
    const doc = docWith([
      sentence({
        narration: "Something.",
        assertion: "fact",
        claimRefs: ["cl_missing"],
      }),
    ]);
    expect(verifyScriptClaims(doc, brief)[0]).toMatchObject({ code: "unknown_claim" });
  });

  it("accepts an attributed sentence that names its source and says so", () => {
    const doc = docWith([
      sentence({
        narration: "According to a drivers' forum, the crossing takes fifteen minutes at peak.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
        sourceRefs: ["src_forum"],
      }),
    ]);
    expect(verifyScriptClaims(doc, brief)).toEqual([]);
  });

  it("rejects attribution that names no source, or forgets to say it is reporting", () => {
    const unnamed = docWith([
      sentence({
        narration: "The crossing takes fifteen minutes at peak.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
      }),
    ]);
    expect(verifyScriptClaims(unnamed, brief).map((violation) => violation.code)).toEqual([
      "missing_attribution",
    ]);

    const silent = docWith([
      sentence({
        narration: "The crossing takes fifteen minutes at peak.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
        sourceRefs: ["src_forum"],
      }),
    ]);
    const violations = verifyScriptClaims(silent, brief);
    expect(violations.map((violation) => violation.code)).toEqual(["missing_attribution"]);
    expect(violations[0]!.message).toContain("without telling the listener");
  });

  it("rejects sources the research package does not contain, and unlinked ones", () => {
    const unknown = docWith([
      sentence({
        narration: "According to example.com, it takes fifteen minutes.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
        sourceRefs: ["src_nowhere"],
      }),
    ]);
    expect(verifyScriptClaims(unknown, brief).map((violation) => violation.code)).toContain(
      "unknown_source",
    );

    const unlinked = docWith([
      sentence({
        narration: "According to news.example.com, it takes fifteen minutes.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
        sourceRefs: ["src_news"],
      }),
    ]);
    expect(verifyScriptClaims(unlinked, brief).map((violation) => violation.code)).toContain(
      "unlinked_source",
    );
  });

  it("builds a ledger that keeps claim → sentence → verbatim evidence", () => {
    const doc = docWith([
      sentence({
        id: "s1_1",
        narration: "The bridge carries 40,000 vehicles a day.",
        assertion: "fact",
        claimRefs: [CLEAR_CLAIM_ID],
      }),
      sentence({
        id: "s1_2",
        narration: "According to a drivers' forum, the crossing takes fifteen minutes.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
        sourceRefs: ["src_forum"],
      }),
      sentence({ id: "s1_3", narration: "Nothing factual here.", assertion: "context" }),
    ]);

    const ledger = buildClaimLedger(doc, brief);
    expect(ledger.map((entry) => entry.claimId)).toEqual([CLEAR_CLAIM_ID, THIN_CLAIM_ID]);
    const clear = ledger[0]!;
    expect(clear).toMatchObject({
      usage: "fact",
      mayStateAsFact: true,
      sentenceIds: ["s1_1"],
      status: "supported",
      certainty: "established",
    });
    expect(clear.evidence.map((ref) => ref.sourceId)).toEqual(["src_news", "src_data"]);
    expect(clear.evidence[0]).toEqual({
      sourceId: "src_news",
      url: "https://news.example.com/bridge",
      excerpt: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
      locator: "0:65",
    });
    const thin = ledger[1]!;
    expect(thin).toMatchObject({
      usage: "attributed",
      mayStateAsFact: false,
      sentenceIds: ["s1_2"],
    });
  });

  it("records a claim as asserted when it is both asserted and reported", () => {
    const doc = docWith([
      sentence({
        id: "s1_1",
        narration: "Crossing takes fifteen minutes, according to a drivers' forum.",
        assertion: "attributed",
        claimRefs: [THIN_CLAIM_ID],
        sourceRefs: ["src_forum"],
      }),
      sentence({
        id: "s1_2",
        narration: "Fifteen minutes at peak, and the bridge carries 40,000 vehicles a day.",
        assertion: "fact",
        claimRefs: [CLEAR_CLAIM_ID, THIN_CLAIM_ID],
      }),
    ]);
    const ledger = buildClaimLedger(doc, brief);
    const thin = ledger.find((entry) => entry.claimId === THIN_CLAIM_ID)!;
    expect(thin.usage).toBe("fact");
    expect(thin.sentenceIds).toEqual(["s1_1", "s1_2"]);
  });
});
