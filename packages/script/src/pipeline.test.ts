import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeLLMProvider,
  FixedClock,
  ManualRequiredError,
  MemoryBlobStore,
  MemoryProviderCache,
  ProviderContentError,
  ProviderTimeoutError,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type FakeLLMResponder,
  type InvokeRuntime,
  type ProviderPolicy,
} from "@nexus/providers";
import { describe, expect, it } from "vitest";

import {
  NoUsableClaimsError,
  generateScript,
  type ScriptDeps,
  type ScriptInput,
} from "./pipeline.js";
import {
  CLEAR_CLAIM_ID,
  PACKAGE_HASH,
  THIN_CLAIM_ID,
  goodDraft,
  researchPackageFixture,
} from "./fixtures.js";
import type { ScriptDraft } from "./prompts.js";
import { parseScriptDoc, scriptDocBytes } from "@nexus/db";
import { researchPackageBytes } from "@nexus/research";

/**
 * The script engine, exercised with a mock AI provider only — no network, no
 * API key, no paid call. What matters here is that the *rules* hold: what may be
 * asserted, what must be attributed, what is quoted verbatim, and what happens
 * when a draft breaks them.
 */

const CLOCK_ISO = "2024-05-01T00:00:00.000Z";
const POLICY: ProviderPolicy = {
  ...DEFAULT_PROVIDER_POLICY,
  maxAttempts: 1,
  baseDelayMs: 0,
  jitter: 0,
  rateLimitPerMinute: 0,
};

function runtimeFor(id: string, storage: MemoryBlobStore): InvokeRuntime {
  const clock = new FixedClock(CLOCK_ISO);
  const budget = new BudgetGuard({ clock });
  const cache = new MemoryProviderCache();
  return createRuntime({
    adapterId: id,
    kind: "llm",
    storage,
    clock,
    logger: silentProviderLogger,
    env: {},
    policy: POLICY,
    budget,
    limiter: unlimitedRateLimiter,
    credentialsEnv: "NEXUS_LLM_API_KEY",
    transport: (): Promise<never> => Promise.reject(new Error("the mocks never touch the network")),
    cache,
    invoke: (spec) =>
      invoke(
        {
          adapterId: id,
          kind: "llm",
          policy: POLICY,
          budget,
          cache,
          logger: silentProviderLogger,
          clock,
          sleep: async (): Promise<void> => undefined,
        },
        spec,
      ),
  });
}

interface MockWriter {
  readonly deps: ScriptDeps;
  /** Every request the writer received, in order. */
  readonly requests: {
    readonly task?: string;
    readonly messages: readonly { readonly content: string }[];
  }[];
}

/** A mock writer: `answers` are returned in order (one per call). */
function mockWriter(answers: readonly (ScriptDraft | Error)[]): MockWriter {
  const storage = new MemoryBlobStore();
  const requests: MockWriter["requests"] = [];
  let call = 0;
  const respond: FakeLLMResponder = (request) => {
    requests.push({ task: request.task, messages: request.messages });
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    deps: {
      llm: new FakeLLMProvider(runtimeFor("stub-llm", storage), { respond, id: "stub-llm" }),
      clock: new FixedClock(CLOCK_ISO),
    },
    requests,
  };
}

const input = (overrides: Partial<ScriptInput> = {}): ScriptInput => ({
  topic: "The Kira bridge",
  outline: ["intro", "traffic", "what drivers say"],
  research: researchPackageFixture(),
  packageHash: PACKAGE_HASH,
  episodeId: "ep_1",
  ...overrides,
});

describe("script engine", () => {
  it("writes a structured script from a verified research package", async () => {
    const writer = mockWriter([goodDraft()]);
    const doc = await generateScript(input(), writer.deps);

    // Working title + logline + the required structure, in order.
    expect(doc.workingTitle).toBe("Forty Thousand Crossings a Day");
    expect(doc.logline).toContain("busiest crossing");
    expect(doc.sections.map((section) => section.role)).toEqual([
      "hook",
      "introduction",
      "narrative",
      "narrative",
      "conclusion",
    ]);
    expect(doc.sections.map((section) => section.id)).toEqual([
      "sec1",
      "sec2",
      "sec3",
      "sec4",
      "sec5",
    ]);
    expect(doc.sections[1]!.transition).toContain("hard to picture");
    expect(doc.sections[0]!.transition).toBe("");

    // Narration plus visual cues, on stable ids scenes/captions can reference.
    const hook = doc.sections[0]!.sentences[0]!;
    expect(hook.id).toBe("s1_1");
    expect(hook.narration).toContain("Forty thousand vehicles");
    expect(hook.visual).toEqual({
      kind: "broll",
      description: "Wide shot of traffic streaming across the bridge",
      searchHint: "bridge traffic aerial",
    });
    expect(doc.sections[3]!.sentences[1]!.visual?.kind).toBe("none");

    // Stats are computed, not requested.
    expect(doc.stats.sections).toBe(5);
    expect(doc.stats.sentences).toBe(8);
    expect(doc.stats.words).toBeGreaterThan(60);
    expect(doc.stats.estimatedDurationSec).toBeGreaterThan(20);

    // The claim/evidence chain survives into the artifact.
    expect(doc.claims.map((entry) => entry.claimId)).toEqual([CLEAR_CLAIM_ID, THIN_CLAIM_ID]);
    const clear = doc.claims[0]!;
    expect(clear.usage).toBe("fact");
    expect(clear.mayStateAsFact).toBe(true);
    expect(clear.sentenceIds).toEqual(["s1_1", "s2_1", "s2_2", "s3_2", "s5_1"]);
    expect(clear.evidence).toHaveLength(2);
    expect(clear.evidence.map((ref) => ref.excerpt)).toEqual([
      "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
      "Traffic counts show 40,000 vehicles a day crossing the Kira bridge.",
    ]);
    expect(doc.claims[1]!).toMatchObject({
      claimId: THIN_CLAIM_ID,
      usage: "attributed",
      mayStateAsFact: false,
      sentenceIds: ["s4_1"],
    });

    // Quality: a clean draft needs no repair and no review.
    expect(doc.quality).toEqual({
      issues: [],
      repairRounds: 0,
      reviewRequired: false,
      droppedSentences: [],
    });

    // Provenance: which steps used AI, which were code, which package.
    expect(doc.provenance.researchPackageHash).toBe(PACKAGE_HASH);
    expect(doc.provenance.providers).toEqual({ llm: "stub-llm" });
    expect(doc.provenance.steps.map((step) => step.step)).toEqual([
      "select",
      "write",
      "validate",
      "finalize",
    ]);
    expect(doc.provenance.aiSteps).toEqual(["write"]);
    expect(doc.provenance.deterministicSteps).toEqual(["select", "validate", "finalize"]);
    expect(doc.provenance.repairRounds).toBe(0);
    expect(doc.warnings.join(" ")).toContain("claim cl_orphan excluded");
  });

  it("gives the writer only what research cleared, and the evidence to quote", async () => {
    const writer = mockWriter([goodDraft()]);
    await generateScript(input(), writer.deps);

    const prompt = writer.requests[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("TOPIC: The Kira bridge");
    expect(prompt).toContain("Outline beats");
    expect(prompt).toContain(`- ${CLEAR_CLAIM_ID}: The Kira bridge opened in 1973`);
    expect(prompt).toContain(`- ${THIN_CLAIM_ID}: Crossing the Kira bridge takes fifteen minutes`);
    expect(prompt).toContain("only one source backs it");
    // The unverified claim is never exposed to the writer.
    expect(prompt).not.toContain("most expensive in the region");
    expect(prompt).toContain("src_forum: forum.example.net");
    expect(prompt).toContain("EVIDENCE you may quote verbatim");
    expect(prompt).toContain("The Kira bridge opened in 1973 and carries 40,000 vehicles a day.");
  });

  it("is byte-for-byte reproducible for the same clock and answers", async () => {
    const first = mockWriter([goodDraft()]);
    const second = mockWriter([goodDraft()]);
    const a = await generateScript(input(), first.deps);
    const b = await generateScript(input(), second.deps);
    expect(`${JSON.stringify(a, null, 2)}\n`).toBe(`${JSON.stringify(b, null, 2)}\n`);
    void researchPackageBytes;
  });

  it("refuses to write when nothing was verified", async () => {
    const orphanOnly = researchPackageFixture({
      claims: researchPackageFixture().claims.filter(
        (claim) => claim.id !== CLEAR_CLAIM_ID && claim.id !== THIN_CLAIM_ID,
      ),
    });
    const writer = mockWriter([goodDraft()]);
    await expect(generateScript(input({ research: orphanOnly }), writer.deps)).rejects.toThrow(
      NoUsableClaimsError,
    );
    expect(writer.requests).toHaveLength(0); // the model is never even asked
  });

  it("attributes everything when nothing is cleared, after one corrective round", async () => {
    const base = researchPackageFixture();
    const unattested = researchPackageFixture({
      claims: base.claims.map((claim) =>
        claim.id === CLEAR_CLAIM_ID
          ? { ...claim, mayStateAsFact: false, certainty: "likely" as const }
          : claim,
      ),
    });

    /** What the writer should produce once it is told nothing is cleared. */
    const attributedDraft = (): ScriptDraft => {
      const draft = goodDraft();
      draft.sections[0]!.sentences[0] = {
        narration: "News.example.com reports 40,000 vehicles a day on the Kira bridge.",
        assertion: "attributed",
        claimRefs: [CLEAR_CLAIM_ID],
        sourceRefs: ["src_news"],
      };
      draft.sections[1]!.sentences[0] = {
        narration: "According to data.example.org, the bridge carries 40,000 vehicles a day.",
        assertion: "attributed",
        claimRefs: [CLEAR_CLAIM_ID],
        sourceRefs: ["src_data"],
      };
      draft.sections[1]!.sentences[1] = {
        narration: "News.example.com dates its opening to 1973.",
        assertion: "attributed",
        claimRefs: [CLEAR_CLAIM_ID],
        sourceRefs: ["src_news"],
      };
      draft.sections[2]!.sentences[1] = {
        narration: "Data.example.org counts 40,000 vehicles a day on the deck.",
        assertion: "attributed",
        claimRefs: [CLEAR_CLAIM_ID],
        sourceRefs: ["src_data"],
      };
      draft.sections[4]!.sentences[0] = {
        narration: "Forty thousand crossings a day is what the design now carries.",
        assertion: "context",
        claimRefs: [],
        sourceRefs: [],
      };
      return draft;
    };

    const writer = mockWriter([goodDraft(), attributedDraft()]);
    const doc = await generateScript(input({ research: unattested }), writer.deps);

    expect(writer.requests.map((request) => request.task)).toEqual([
      "script.write",
      "script.revise",
    ]);
    expect(writer.requests[1]!.messages.at(-1)!.content).toContain("did not clear it");
    expect(writer.requests[1]!.messages.at(-1)!.content).toContain("ISSUES TO FIX");
    expect(doc.quality.repairRounds).toBe(1);
    expect(doc.quality.reviewRequired).toBe(false);
    expect(doc.quality.droppedSentences).toEqual([]);
    // Everything is reported, nothing is asserted.
    const clear = doc.claims.find((entry) => entry.claimId === CLEAR_CLAIM_ID)!;
    expect(clear.usage).toBe("attributed");
    expect(clear.mayStateAsFact).toBe(false);
    expect(doc.warnings.join(" ")).toContain("every factual sentence is attributed");
    expect(doc.sections[0]!.sentences[0]!.narration).toContain("News.example.com reports");
  });

  it("repairs a draft that breaks the writing rules, then keeps the fix", async () => {
    const sloppy = goodDraft();
    sloppy.sections[0]!.sentences[0]!.narration = "In this video, we look at the Kira bridge.";
    const fixed = goodDraft();
    const writer = mockWriter([sloppy, fixed]);

    const doc = await generateScript(input(), writer.deps);
    // Filler alone is a soft issue: no revision round is spent on it, but it is
    // recorded so the operator sees it.
    expect(writer.requests).toHaveLength(1);
    expect(doc.quality.issues.map((issue) => issue.code)).toContain("filler");
    expect(doc.quality.repairRounds).toBe(0);
  });

  it("spends one corrective round on a hard violation and reports what it fixed", async () => {
    const lying = goodDraft();
    lying.sections[0]!.sentences[0] = {
      narration: "The bridge was the most expensive in the region.",
      assertion: "fact",
      // A claim id that is not in the package at all — the ledger cannot honour it.
      claimRefs: ["cl_invented"],
      sourceRefs: [],
    };
    const writer = mockWriter([lying, goodDraft()]);

    const doc = await generateScript(input(), writer.deps);
    expect(writer.requests.map((request) => request.task)).toEqual([
      "script.write",
      "script.revise",
    ]);
    expect(doc.quality.repairRounds).toBe(1);
    expect(doc.provenance.repairRounds).toBe(1);
    expect(doc.quality.reviewRequired).toBe(false);
    // The violation is recorded as resolved by the round that fixed it.
    const resolved = doc.quality.issues.filter((issue) => issue.resolvedByRepair);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.some((issue) => issue.code === "unknown_claim")).toBe(true);
    expect(doc.quality.issues.some((issue) => !issue.resolvedByRepair)).toBe(false);
    expect(doc.sections[0]!.sentences[0]!.narration).toContain("Forty thousand vehicles");
  });

  it("drops narration that still breaks a hard rule instead of shipping it", async () => {
    const fabricated = goodDraft();
    fabricated.sections[2]!.sentences[1] = {
      narration: 'The engineer said "we never thought it would last" in 1973.',
      assertion: "context",
      claimRefs: [],
      sourceRefs: [],
    };
    // The writer cannot fix it, so the same bad draft comes back twice.
    const writer = mockWriter([fabricated, fabricated]);

    const doc = await generateScript(input(), writer.deps);
    expect(doc.quality.repairRounds).toBe(1);
    expect(doc.quality.reviewRequired).toBe(true);
    // The invented quotation is gone from the narration…
    expect(JSON.stringify(doc.sections)).not.toContain("never thought it would last");
    expect(doc.quality.droppedSentences.join(" ")).toContain("never thought it would last");
    expect(doc.quality.issues.some((issue) => issue.code === "unverified_quote")).toBe(true);
    expect(doc.warnings.join(" ")).toContain(
      "removed because they broke a hard fact or quotation rule",
    );
    // …and ids stay canonical after the drop.
    expect(doc.sections.map((section) => section.id)).toEqual([
      "sec1",
      "sec2",
      "sec3",
      "sec4",
      "sec5",
    ]);
    expect(doc.sections[2]!.sentences.map((sentence) => sentence.id)).toEqual(["s3_1"]);
  });

  it("blocks a sentence that states an uncleared claim as a fact, even after revision", async () => {
    const assertion = goodDraft();
    assertion.sections[3]!.sentences[0] = {
      narration: "Crossing the bridge takes fifteen minutes at peak.",
      assertion: "fact",
      claimRefs: [THIN_CLAIM_ID],
      sourceRefs: [],
    };
    const writer = mockWriter([assertion, assertion]);

    const doc = await generateScript(input(), writer.deps);
    expect(doc.quality.reviewRequired).toBe(true);
    expect(doc.quality.issues.map((issue) => issue.code)).toContain("unsupported_assertion");
    expect(doc.quality.droppedSentences.join(" ")).toContain("fifteen minutes at peak");
    expect(doc.sections[3]!.sentences.map((sentence) => sentence.narration)).not.toContain(
      "Crossing the bridge takes fifteen minutes at peak.",
    );
    // The thin claim is no longer part of the ledger: nothing states or reports it.
    expect(doc.claims.map((entry) => entry.claimId)).toEqual([CLEAR_CLAIM_ID]);
  });

  it("still stores a script that lost its hook, and flags the structure for an editor", async () => {
    // The hook is a single sentence citing a domain nobody researched: after the
    // failed repair the sentence must go, and with it the whole hook section.
    const headless = goodDraft();
    headless.sections[0]!.sentences = [
      {
        narration: "According to thedailywire.example, the bridge is the busiest in the country.",
        assertion: "context",
        claimRefs: [],
        sourceRefs: [],
      },
    ];
    const writer = mockWriter([headless, headless]);

    const doc = await generateScript(input(), writer.deps);

    // The document survives — the CAS round trip parses, ledger and stats stay
    // consistent (a structure rule is a finding, never an unreadable artifact).
    const bytes = scriptDocBytes(doc);
    expect(parseScriptDoc(JSON.parse(new TextDecoder().decode(bytes)) as unknown)).toEqual(doc);
    expect(doc.sections.map((section) => section.role)).toEqual([
      "introduction",
      "narrative",
      "narrative",
      "conclusion",
    ]);
    expect(doc.stats.sections).toBe(4);
    expect(doc.claims.map((entry) => entry.claimId)).toEqual([CLEAR_CLAIM_ID, THIN_CLAIM_ID]);

    // …but the missing structure is a hard finding, not a crash: an editor sees
    // exactly what is wrong and the stage reports reviewRequired.
    expect(doc.quality.reviewRequired).toBe(true);
    const structural = doc.quality.issues.filter((issue) => issue.code === "missing_section");
    expect(structural.some((issue) => issue.message.includes("exactly one hook"))).toBe(true);
    expect(
      structural.some((issue) => issue.message.includes("first section must be the hook")),
    ).toBe(true);
    expect(doc.warnings.join(" ")).toContain("no longer has the required section structure");
    expect(doc.quality.droppedSentences[0]).toContain("thedailywire.example");
  });

  it("validates the model's structured output (and fails loudly when it cannot be parsed)", async () => {
    const writer = mockWriter([
      new ProviderContentError("schema mismatch", { provider: "stub-llm" }),
    ]);
    await expect(generateScript(input(), writer.deps)).rejects.toThrow(ProviderContentError);
  });

  it("propagates a provider timeout so the job runner can retry it", async () => {
    const writer = mockWriter([
      new ProviderTimeoutError("deadline exceeded", { provider: "stub-llm" }),
    ]);
    await expect(generateScript(input(), writer.deps)).rejects.toThrow(ProviderTimeoutError);
  });

  it("propagates a manual hand-off untouched, so the stage can park", async () => {
    const manual = new ManualRequiredError({
      capability: "llm",
      operation: "llm.chat",
      summary: "write this script by hand",
      instructions: ["Draft the narration", "Save it as a script artifact"],
    });
    const writer = mockWriter([manual]);
    await expect(generateScript(input(), writer.deps)).rejects.toBe(manual);
  });

  it("honours the tuning: target length, section plan and no repair rounds", async () => {
    const writer = mockWriter([goodDraft()]);
    await generateScript(input(), writer.deps, {
      targetDurationSec: 600,
      wordsPerSecond: 2,
      narrativeSections: 5,
      maxRepairRounds: 0,
    });
    const prompt = writer.requests[0]!.messages[0]!.content;
    expect(prompt).toContain("1200 words");
    expect(prompt).toContain("5 narrative sections");

    const lying = goodDraft();
    lying.sections[0]!.sentences[0] = {
      narration: "The bridge was the most expensive in the region.",
      assertion: "fact",
      claimRefs: [],
      sourceRefs: [],
    };
    const noRepair = mockWriter([lying]);
    const doc = await generateScript(input(), noRepair.deps, { maxRepairRounds: 0 });
    expect(noRepair.requests).toHaveLength(1);
    expect(doc.quality.repairRounds).toBe(0);
    expect(doc.quality.reviewRequired).toBe(true);
    expect(doc.quality.droppedSentences).toHaveLength(1);
  });

  it("deduplicates repeated citations instead of treating them as new evidence", async () => {
    const greedy = goodDraft();
    greedy.sections[0]!.sentences[0]!.claimRefs = [CLEAR_CLAIM_ID, CLEAR_CLAIM_ID];
    greedy.sections[3]!.sentences[0]!.sourceRefs = ["src_forum", "src_forum"];
    const writer = mockWriter([greedy]);
    const doc = await generateScript(input(), writer.deps);
    expect(doc.sections[0]!.sentences[0]!.claimRefs).toEqual([CLEAR_CLAIM_ID]);
    expect(doc.sections[3]!.sentences[0]!.sourceRefs).toEqual(["src_forum"]);
    expect(doc.quality.issues).toEqual([]);
  });
});
