import type { ResearchClaim, ResearchPackage } from "@nexus/research";
import type { ScriptDraft } from "./prompts.js";

/**
 * Shared test fixtures: a research package shaped exactly like the one the
 * Phase 5 engine produces, and draft scripts to feed the writer mock.
 *
 * Keeping them here (rather than inline per test file) means the claim-brief
 * tests, the engine tests and the stage tests all reason about the same
 * package, which is what makes the claim/evidence chain assertions meaningful.
 */

export const PACKAGE_HASH = "b".repeat(64);

const sources = [
  {
    id: "src_news",
    url: "https://news.example.com/bridge",
    originalUrl: "https://news.example.com/bridge",
    domain: "news.example.com",
    title: "Kira bridge opens",
    publisher: "brave",
    retrievedAt: "2024-05-01T00:00:00.000Z",
    provider: "brave",
    questionIds: ["q1"],
    content: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
    contentHash: "a".repeat(64),
    contentLength: 63,
    retrieval: "provider_snippet" as const,
  },
  {
    id: "src_data",
    url: "https://data.example.org/kira",
    originalUrl: "https://data.example.org/kira",
    domain: "data.example.org",
    title: "Kira bridge traffic counts",
    publisher: "brave",
    retrievedAt: "2024-05-01T00:00:00.000Z",
    provider: "brave",
    questionIds: ["q1"],
    content: "Traffic counts show 40,000 vehicles a day crossing the Kira bridge.",
    contentHash: "b".repeat(64),
    contentLength: 67,
    retrieval: "provider_snippet" as const,
  },
  {
    id: "src_forum",
    url: "https://forum.example.net/kira",
    originalUrl: "https://forum.example.net/kira",
    domain: "forum.example.net",
    title: "Kira bridge thread",
    publisher: "brave",
    retrievedAt: "2024-05-01T00:00:00.000Z",
    provider: "brave",
    questionIds: ["q1"],
    content: "Some drivers report the crossing takes fifteen minutes at peak.",
    contentHash: "c".repeat(64),
    contentLength: 65,
    retrieval: "provider_snippet" as const,
  },
];

const evidence = [
  {
    id: "ev_news",
    sourceId: "src_news",
    excerpt: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
    locator: { kind: "source_content" as const, start: 0, end: 65 },
    relevance: "opening year and traffic",
    questionIds: ["q1"],
    extractedBy: { provider: "stub-llm", templateVersion: "research.extract@1" },
  },
  {
    id: "ev_data",
    sourceId: "src_data",
    excerpt: "Traffic counts show 40,000 vehicles a day crossing the Kira bridge.",
    locator: { kind: "source_content" as const, start: 0, end: 67 },
    relevance: "independent traffic count",
    questionIds: ["q1"],
    extractedBy: { provider: "stub-llm", templateVersion: "research.extract@1" },
  },
  {
    id: "ev_forum",
    sourceId: "src_forum",
    excerpt: "Some drivers report the crossing takes fifteen minutes at peak.",
    locator: { kind: "source_content" as const, start: 0, end: 63 },
    relevance: "single-source claim about congestion",
    questionIds: ["q1"],
    extractedBy: { provider: "stub-llm", templateVersion: "research.extract@1" },
  },
];

const claim = (
  id: string,
  statement: string,
  overrides: Partial<ResearchClaim> = {},
): ResearchClaim => ({
  id,
  statement,
  variants: [],
  questionId: "q1",
  questionIds: ["q1"],
  links: [],
  status: "supported",
  certainty: "likely",
  confidence: 0.5,
  corroboration: {
    supportingSources: [],
    contradictingSources: [],
    mentioningSources: [],
    independentSources: 0,
  },
  contested: false,
  mayStateAsFact: false,
  provenance: { extractedBy: [] },
  ...overrides,
});

/**
 * Three claims covering the interesting cases:
 * - `cl_clear` — corroborated by two sources: may be stated as fact.
 * - `cl_thin` — a single source reports it: attribution only.
 * - `cl_orphan` — nothing verified it: blocked entirely.
 */
export const CLEAR_CLAIM_ID = "cl_clear";
export const THIN_CLAIM_ID = "cl_thin";
export const ORPHAN_CLAIM_ID = "cl_orphan";

export function researchPackageFixture(overrides: Partial<ResearchPackage> = {}): ResearchPackage {
  return {
    version: 1,
    topic: "The Kira bridge",
    createdAt: "2024-05-01T00:00:00.000Z",
    questions: [
      {
        id: "q1",
        question: "How busy is the Kira bridge?",
        rationale: "the core of the topic",
        priority: "primary",
        queries: ["kira bridge traffic"],
      },
    ],
    sources,
    evidence,
    claims: [
      claim(CLEAR_CLAIM_ID, "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.", {
        links: [
          {
            sourceId: "src_news",
            evidenceId: "ev_news",
            stance: "supports",
            strength: 0.9,
            rationale: "states it",
          },
          {
            sourceId: "src_data",
            evidenceId: "ev_data",
            stance: "supports",
            strength: 0.8,
            rationale: "counts agree",
          },
        ],
        status: "supported",
        certainty: "established",
        confidence: 0.75,
        corroboration: {
          supportingSources: ["src_data", "src_news"],
          contradictingSources: [],
          mentioningSources: [],
          independentSources: 2,
        },
        mayStateAsFact: true,
      }),
      claim(THIN_CLAIM_ID, "Crossing the Kira bridge takes fifteen minutes at peak.", {
        links: [
          {
            sourceId: "src_forum",
            evidenceId: "ev_forum",
            stance: "supports",
            strength: 0.6,
            rationale: "driver reports",
          },
        ],
        status: "supported",
        certainty: "likely",
        confidence: 0.6,
        corroboration: {
          supportingSources: ["src_forum"],
          contradictingSources: [],
          mentioningSources: [],
          independentSources: 1,
        },
        mayStateAsFact: false,
      }),
      claim(ORPHAN_CLAIM_ID, "The bridge was the most expensive in the region.", {
        links: [],
        status: "unverified",
        certainty: "uncertain",
        confidence: 0,
        mayStateAsFact: false,
      }),
    ],
    conflicts: [],
    verification: {
      claims: 3,
      byStatus: { supported: 2, contradicted: 0, unverified: 1, unsupportable: 0 },
      established: 1,
      contested: 0,
      conflicts: 0,
      reviewRequired: true,
      blockingClaimIds: [ORPHAN_CLAIM_ID, THIN_CLAIM_ID],
    },
    provenance: {
      engine: { name: "nexus-research", version: "1.0.0" },
      schemaVersion: 1,
      topic: "The Kira bridge",
      episodeId: "ep_1",
      startedAt: "2024-05-01T00:00:00.000Z",
      finishedAt: "2024-05-01T00:00:00.000Z",
      durationMs: 0,
      providers: { llm: "stub-llm", research: "stub-research" },
      steps: [],
      aiSteps: ["plan", "extract"],
      deterministicSteps: ["discover", "evaluate"],
    },
    dropped: [],
    warnings: [],
    partial: false,
    ...overrides,
  };
}

/**
 * A clean draft: hook, introduction, three narrative sections, conclusion;
 * facts cited from the cleared claim, the thin claim attributed by name.
 */
export function goodDraft(): ScriptDraft {
  return {
    workingTitle: "Forty Thousand Crossings a Day",
    logline: "How one 1973 bridge became the busiest crossing in the city.",
    sections: [
      {
        role: "hook",
        title: "Hook",
        transition: "",
        sentences: [
          {
            narration: "Forty thousand vehicles cross the Kira bridge every single day.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "broll",
              description: "Wide shot of traffic streaming across the bridge",
              searchHint: "bridge traffic aerial",
            },
          },
        ],
      },
      {
        role: "introduction",
        title: "Introduction",
        transition: "That number is hard to picture, so here is the bridge itself.",
        sentences: [
          {
            narration: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "image",
              description: "The bridge in 1973, from the archive",
              searchHint: "kira bridge 1973",
            },
          },
          {
            narration: "Two independent counts agree on that figure.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: { kind: "chart", description: "Daily crossings, counted twice in 2023" },
          },
        ],
      },
      {
        role: "narrative",
        title: "Why the planners were wrong",
        transition: "The story starts with a forecast that missed by a wide margin.",
        sentences: [
          {
            narration: "The design assumed far fewer cars than the city now sends across it.",
            assertion: "context",
            claimRefs: [],
            sourceRefs: [],
            visual: {
              kind: "broll",
              description: "Archive footage of the bridge under construction",
            },
          },
          {
            narration: "Data.example.org counts 40,000 vehicles a day on the deck.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: { kind: "text", description: "The daily count on screen" },
          },
        ],
      },
      {
        role: "narrative",
        title: "What drivers say",
        transition: "Numbers are only half of the story.",
        sentences: [
          {
            narration:
              "According to a drivers' forum, crossing the bridge takes fifteen minutes at peak.",
            assertion: "attributed",
            claimRefs: [THIN_CLAIM_ID],
            sourceRefs: ["src_forum"],
            visual: { kind: "broll", description: "Queued traffic at the toll plaza" },
          },
          {
            narration:
              "That single source has not been corroborated, so it stays a reported figure.",
            assertion: "context",
            claimRefs: [],
            sourceRefs: [],
            visual: {
              kind: "none",
              description: "No visual needed; keep the focus on the narration",
            },
          },
        ],
      },
      {
        role: "conclusion",
        title: "Payoff",
        transition: "Which brings us back to that number.",
        sentences: [
          {
            narration: "Forty thousand crossings a day is what a 1973 design now has to carry.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "broll",
              description: "Sunset over the bridge with traffic in both directions",
            },
          },
        ],
      },
    ],
  };
}
