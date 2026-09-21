import { describe, expect, it } from "vitest";

import { DEFAULT_RESEARCH_TUNING, evaluateClaims } from "./pipeline.js";
import type { ClaimLink, Conflict, ResearchClaim, Stance } from "./types.js";

/**
 * The verification table, tested directly: this is the code path that decides
 * whether a sentence may be stated as fact. Nothing here consults a model — a
 * model only supplies a link's `strength`, and no strength can promote a claim
 * past a contradiction, a disagreement or a missing second source.
 */

function claim(links: readonly ClaimLink[], contested = false): ResearchClaim {
  return {
    id: "cl_00000001",
    statement: "The dam was completed in 1968.",
    variants: [],
    questionIds: [],
    links: [...links],
    status: "unverified",
    certainty: "uncertain",
    confidence: 0,
    corroboration: {
      supportingSources: [],
      contradictingSources: [],
      mentioningSources: [],
      independentSources: 0,
    },
    contested,
    mayStateAsFact: false,
    provenance: { extractedBy: [] },
  };
}

const link = (sourceId: string, stance: Stance, strength: number, index = 0): ClaimLink => ({
  sourceId,
  evidenceId: `ev_${sourceId.slice(-8)}${index}`,
  stance,
  strength,
  rationale: "",
});

const conflict = (claimId: string): Conflict => ({
  id: "cf_00000001",
  kind: "direct_contradiction",
  explanation: "they cannot both be true",
  detectedBy: "model",
  sides: [
    { kind: "claim", id: claimId, statement: "…", claimId, sourceIds: [] },
    { kind: "claim", id: "cl_00000002", statement: "…", claimId: "cl_00000002", sourceIds: [] },
  ],
  preserved: true,
});

describe("claim verification", () => {
  it("promotes a claim only when independent sources corroborate it", () => {
    const single = evaluateClaims([claim([link("src_a", "supports", 1)])], []);
    expect(single.claims[0]).toMatchObject({
      status: "supported",
      certainty: "likely",
      confidence: 0.5,
      mayStateAsFact: false,
      corroboration: { independentSources: 1 },
    });

    const double = evaluateClaims(
      [claim([link("src_a", "supports", 1), link("src_b", "supports", 1, 1)])],
      [],
    );
    expect(double.claims[0]).toMatchObject({
      status: "supported",
      certainty: "established",
      confidence: 0.75,
      mayStateAsFact: true,
    });

    const triple = evaluateClaims(
      [
        claim([
          link("src_a", "supports", 0.8),
          link("src_b", "supports", 0.8, 1),
          link("src_c", "supports", 0.8, 2),
        ]),
      ],
      [],
    );
    expect(triple.claims[0]!.confidence).toBeCloseTo(0.828, 3);
    expect(triple.claims[0]!.mayStateAsFact).toBe(true);
  });

  it("never lets a disagreement be stated as fact, whoever reported it", () => {
    // (a) A verified refutation: the source itself disputes the claim.
    const contradicted = evaluateClaims(
      [claim([link("src_a", "supports", 1), link("src_b", "contradicts", 1, 1)])],
      [],
    );
    expect(contradicted.claims[0]).toMatchObject({
      status: "contradicted",
      certainty: "disputed",
      mayStateAsFact: false,
    });
    expect(contradicted.claims[0]!.confidence).toBeLessThanOrEqual(0.25);

    // (b) An unresolved conflict between two claims: both sides stay disputed.
    const contested = evaluateClaims(
      [claim([link("src_a", "supports", 1), link("src_b", "supports", 1, 1)], true)],
      [conflict("cl_00000001")],
    );
    expect(contested.claims[0]).toMatchObject({
      status: "supported", // its own evidence does support it…
      certainty: "disputed", // …and it still must not be asserted
      mayStateAsFact: false,
    });
    expect(contested.claims[0]!.confidence).toBeLessThanOrEqual(0.4);

    // Two corroborating sources are not enough while the conflict stands: the
    // same links are "established" only once nothing is contested.
    const settled = evaluateClaims(
      [claim([link("src_a", "supports", 1), link("src_b", "supports", 1, 1)])],
      [],
    );
    expect(settled.claims[0]!.mayStateAsFact).toBe(true);
  });

  it("separates 'nothing supports this' from 'nothing was found'", () => {
    const mentioned = evaluateClaims([claim([link("src_a", "mentions", 0.4)])], []);
    expect(mentioned.claims[0]).toMatchObject({
      status: "unsupportable",
      certainty: "unsupported",
      confidence: 0,
      mayStateAsFact: false,
    });
    expect(mentioned.claims[0]!.corroboration.mentioningSources).toEqual(["src_a"]);

    const orphan = evaluateClaims([claim([])], []);
    expect(orphan.claims[0]).toMatchObject({
      status: "unverified",
      certainty: "uncertain",
      confidence: 0,
      mayStateAsFact: false,
    });
  });

  it("reports the review gate from the claims it evaluated", () => {
    const mixed = evaluateClaims(
      [
        { ...claim([link("src_a", "supports", 1), link("src_b", "supports", 1, 1)]), id: "cl_ok" },
        { ...claim([link("src_a", "mentions", 0.2)]), id: "cl_weak" },
      ],
      [],
    );
    expect(mixed.verification).toEqual({
      claims: 2,
      byStatus: { supported: 1, contradicted: 0, unverified: 0, unsupportable: 1 },
      established: 1,
      contested: 0,
      conflicts: 0,
      reviewRequired: true,
      blockingClaimIds: ["cl_weak"],
    });

    // An empty package can never look like a passed gate.
    const nothing = evaluateClaims([], []);
    expect(nothing.verification.reviewRequired).toBe(true);
    expect(nothing.verification.blockingClaimIds).toEqual([]);
  });

  it("respects tuning, so a policy change is a one-line change", () => {
    const strict = evaluateClaims([claim([link("src_a", "supports", 0.9)])], []);
    const relaxed = evaluateClaims([claim([link("src_a", "supports", 0.9)])], [], {
      ...DEFAULT_RESEARCH_TUNING,
      establishedMinSources: 1,
      establishedMinConfidence: 0.4,
    });
    expect(strict.claims[0]!.mayStateAsFact).toBe(false);
    expect(relaxed.claims[0]!.mayStateAsFact).toBe(true);
  });

  it("ignores a model-reported strength of zero or below", () => {
    const weak = evaluateClaims([claim([link("src_a", "supports", 0)])], []);
    expect(weak.claims[0]!.confidence).toBeCloseTo(0.3, 3); // 0.5 × (0.6 + 0)
    expect(weak.claims[0]!.mayStateAsFact).toBe(false);
  });
});
