import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeLLMProvider,
  FakeResearchProvider,
  FixedClock,
  MemoryBlobStore,
  MemoryProviderCache,
  ProviderContentError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type CallContext,
  type FakeLLMResponder,
  type ImageSearchResult,
  type InvokeRuntime,
  type LLMProvider,
  type ProviderPolicy,
  type ProviderResult,
  type ResearchProvider,
  type SearchOptions,
  type WebSearchResult,
} from "@nexus/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { runResearch, type ResearchDeps } from "./pipeline.js";
import { canonicalUrl, shortId } from "./text.js";
import { researchPackageBytes, type ResearchPackage } from "./types.js";

/**
 * The research engine, exercised entirely with mock providers — no network, no
 * API key, no paid call. All eight scenarios the brief names are here:
 * successful research, empty result, malformed provider output, timeout, rate
 * limit, conflicting sources, duplicate sources and invalid URLs.
 */

const CLOCK_ISO = "2024-05-01T00:00:00.000Z";
const POLICY: ProviderPolicy = {
  ...DEFAULT_PROVIDER_POLICY,
  maxAttempts: 1,
  baseDelayMs: 0,
  jitter: 0,
  rateLimitPerMinute: 0,
};

// ── Mock providers ────────────────────────────────────────────────────────

interface StubResearchOptions {
  readonly id?: string;
  /** Simulate a failing call for one query (timeout, rate limit, …). */
  readonly fail?: (query: string) => Error | undefined;
}

/** A scripted search provider: rows per query, no network, deterministic. */
function stubResearch(
  rows: (query: string) => readonly unknown[],
  options: StubResearchOptions = {},
): ResearchProvider {
  const id = options.id ?? "stub-research";
  const envelope = <T>(value: T, operation: string): ProviderResult<T> => ({
    value,
    provider: id,
    operation,
    cached: false,
    attempts: 1,
    durationMs: 0,
    usage: { units: 1, unit: "requests" },
  });
  return {
    id,
    kind: "research",
    mode: "fake",
    label: "Stub research (test)",
    async search(
      query: string,
      searchOptions: SearchOptions = {},
      _ctx?: CallContext,
    ): Promise<ProviderResult<readonly WebSearchResult[]>> {
      const failure = options.fail?.(query);
      if (failure) throw failure;
      const limit = searchOptions.limit ?? 5;
      return envelope(rows(query).slice(0, limit) as readonly WebSearchResult[], "research.search");
    },
    async images(): Promise<ProviderResult<readonly ImageSearchResult[]>> {
      return envelope([] as readonly ImageSearchResult[], "research.images");
    },
  };
}

function webRow(
  url: string,
  snippet: string,
  overrides: Partial<WebSearchResult> = {},
): WebSearchResult {
  return {
    title: `Title for ${url}`,
    url,
    snippet,
    publishedAt: "2023-04-02",
    source: "stub-research",
    ...overrides,
  };
}

const sourceIdFor = (url: string): string => shortId("src", canonicalUrl(url)!);

/** Runtime plumbing so the fake LLM goes through the real `invoke` pipeline. */
function runtimeFor(kind: "llm" | "research", id: string, storage: MemoryBlobStore): InvokeRuntime {
  const clock = new FixedClock(CLOCK_ISO);
  const budget = new BudgetGuard({ clock });
  const cache = new MemoryProviderCache();
  const invokeDeps = {
    adapterId: id,
    kind,
    policy: POLICY,
    budget,
    cache,
    logger: silentProviderLogger,
    clock,
    sleep: async (): Promise<void> => undefined,
  };
  return createRuntime({
    adapterId: id,
    kind,
    storage,
    clock,
    logger: silentProviderLogger,
    env: {},
    policy: POLICY,
    budget,
    limiter: unlimitedRateLimiter,
    credentialsEnv: `NEXUS_${kind.toUpperCase()}_API_KEY`,
    transport: (): Promise<never> => Promise.reject(new Error("the mocks never touch the network")),
    cache,
    invoke: (spec) => invoke(invokeDeps, spec),
  });
}

function makeLlm(
  storage: MemoryBlobStore,
  respond: FakeLLMResponder,
  id = "stub-llm",
): LLMProvider {
  return new FakeLLMProvider(runtimeFor("llm", id, storage), { respond, id });
}

// ── Prompt readers (a fake model "reading" what the engine sent) ───────────

type Messages = readonly { readonly content: string }[];

const lastMessage = (messages: Messages): string => messages[messages.length - 1]?.content ?? "";

const between = (messages: Messages, open: string, close: string): string => {
  const text = lastMessage(messages);
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start + open.length, end) : "";
};

const sourceUrlOf = (messages: Messages): string =>
  /SOURCE: [\s\S]* — (\S+)/.exec(lastMessage(messages))?.[1] ?? "";

/** `cl_…`/`p…` ids listed at the start of a prompt line. */
const claimIdsOf = (messages: Messages): string[] => [
  ...new Set(
    [...lastMessage(messages).matchAll(/^(p\d+|cl_[0-9a-f]{8}):/gm)].map((match) => match[1]!),
  ),
];

const claimEntriesOf = (messages: Messages): { id: string; statement: string }[] =>
  [...lastMessage(messages).matchAll(/^(cl_[0-9a-f]{8}): (.+)$/gm)].map((match) => ({
    id: match[1]!,
    statement: match[2]!,
  }));

// ── Harness ───────────────────────────────────────────────────────────────

describe("research engine", () => {
  let storage: MemoryBlobStore;

  beforeEach(() => {
    storage = new MemoryBlobStore();
  });

  const deps = (
    research: ResearchProvider,
    respond: FakeLLMResponder,
    overrides: Partial<ResearchDeps> = {},
  ): ResearchDeps => ({
    llm: makeLlm(storage, respond),
    research,
    clock: new FixedClock(CLOCK_ISO),
    ...overrides,
  });

  const plannedQuestions = (question = "What is known about the Kira bridge?"): unknown => ({
    questions: [
      {
        question,
        rationale: "the core of the topic",
        priority: "primary",
        queries: ["kira bridge"],
      },
    ],
  });

  const twoQuestions = (): unknown => ({
    questions: [
      {
        question: "What is known about the dam?",
        rationale: "",
        priority: "primary",
        queries: ["dam history"],
      },
      {
        question: "How much power does it produce?",
        rationale: "",
        priority: "supporting",
        queries: ["dam power"],
      },
    ],
  });

  /** A model that quotes the first sentence of the source it was shown. */
  const extractFirstSentence =
    (statement: (url: string, text: string) => string): FakeLLMResponder =>
    (request) => {
      if (request.task === "research.questions") return plannedQuestions();
      if (request.task === "research.extract") {
        const text = between(request.messages, '"""', '"""');
        const url = sourceUrlOf(request.messages);
        const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
        return {
          evidence: [{ quote: firstSentence, relevance: "states it directly" }],
          claims: [
            {
              statement: statement(url, text),
              evidence: [0],
              stance: "supports",
              strength: 0.9,
              rationale: "the sentence asserts it",
            },
          ],
        };
      }
      if (request.task === "research.reconcile") return { groups: [] };
      return { conflicts: [], refutations: [] };
    };

  // ── 1. Successful research ──────────────────────────────────────────────

  it("produces a complete, verifiable package for a topic", async () => {
    const bridge = webRow(
      "https://news.example.com/bridge?utm_source=newsletter#top",
      "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
    );
    const data = webRow(
      "https://data.example.org/kira-bridge/",
      "Traffic counts show 40,000 vehicles a day crossing the Kira bridge.",
    );
    let reconcileIds: string[] = [];

    const pkg = await runResearch(
      {
        topic: "The Kira bridge",
        episodeId: "ep_1",
        projectId: "pr_1",
        outline: ["intro", "traffic"],
      },
      deps(
        stubResearch(() => [bridge, data]),
        (request) => {
          if (request.task === "research.questions") {
            expect(request.messages[0]!.content).toContain("fact-checked");
            expect(request.messages[1]!.content).toContain("The Kira bridge");
            expect(request.messages[1]!.content).toContain("- intro");
            return plannedQuestions();
          }
          if (request.task === "research.extract") {
            const url = sourceUrlOf(request.messages);
            const text = between(request.messages, '"""', '"""');
            return {
              evidence: [{ quote: text, relevance: "the traffic figure" }],
              claims: [
                {
                  statement: url.includes("news.example.com")
                    ? "The Kira bridge carries 40,000 vehicles a day."
                    : "Crossing the Kira bridge are 40,000 vehicles a day.",
                  evidence: [0],
                  stance: "supports",
                  strength: 0.9,
                  rationale: "explicit figure",
                },
              ],
            };
          }
          if (request.task === "research.reconcile") {
            reconcileIds = claimIdsOf(request.messages);
            // Both wordings assert the same fact: one corroborated claim.
            return { groups: [{ claims: reconcileIds }] };
          }
          return { conflicts: [], refutations: [] };
        },
      ),
    );

    // Questions
    expect(pkg.questions).toHaveLength(1);
    expect(pkg.questions[0]!.queries).toEqual(["kira bridge"]);

    // Sources: canonicalised, deduplicated, with metadata + content hash.
    expect(pkg.sources.map((source) => source.url)).toEqual([
      "https://news.example.com/bridge",
      "https://data.example.org/kira-bridge",
    ]);
    expect(pkg.sources[0]!.domain).toBe("news.example.com");
    expect(pkg.sources[0]!.publisher).toBe("stub-research");
    expect(pkg.sources[0]!.retrieval).toBe("provider_snippet");
    expect(pkg.sources[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.sources[0]!.contentLength).toBe(bridge.snippet.length);
    expect(pkg.sources[0]!.questionIds).toEqual(["q1"]);

    // Evidence is verbatim, with locators that slice back out of the source.
    expect(pkg.evidence).toHaveLength(2);
    for (const evidence of pkg.evidence) {
      const source = pkg.sources.find((candidate) => candidate.id === evidence.sourceId)!;
      expect(source.content.slice(evidence.locator.start, evidence.locator.end)).toBe(
        evidence.excerpt,
      );
      expect(evidence.extractedBy.provider).toBe("stub-llm");
      expect(evidence.extractedBy.templateVersion).toBe("research.extract@1");
    }

    // One claim, corroborated by two sources, safe to state as fact.
    expect(reconcileIds).toHaveLength(2);
    expect(pkg.claims).toHaveLength(1);
    const claim = pkg.claims[0]!;
    expect(claim.links).toHaveLength(2);
    expect(claim.corroboration.independentSources).toBe(2);
    expect(claim.status).toBe("supported");
    expect(claim.certainty).toBe("established");
    expect(claim.mayStateAsFact).toBe(true);
    expect(claim.confidence).toBeGreaterThanOrEqual(0.7);
    expect(claim.provenance.reconciledBy?.templateVersion).toBe("research.reconcile@1");
    expect(claim.questionIds).toEqual(["q1"]);

    // Verification summary + gate.
    expect(pkg.verification).toMatchObject({
      claims: 1,
      established: 1,
      contested: 0,
      conflicts: 0,
      reviewRequired: false,
      blockingClaimIds: [],
    });
    expect(pkg.verification.byStatus).toEqual({
      supported: 1,
      contradicted: 0,
      unverified: 0,
      unsupportable: 0,
    });

    // Provenance: which steps used AI, which were code, which adapters served.
    expect(pkg.provenance.providers).toEqual({ llm: "stub-llm", research: "stub-research" });
    expect(pkg.provenance.steps.map((step) => step.step)).toEqual([
      "plan",
      "discover",
      "extract",
      "reconcile",
      "conflicts",
      "evaluate",
    ]);
    expect(pkg.provenance.aiSteps).toEqual(["plan", "extract", "reconcile"]);
    expect(pkg.provenance.deterministicSteps).toEqual(["discover", "evaluate"]);
    expect(pkg.provenance.episodeId).toBe("ep_1");
    expect(pkg.provenance.durationMs).toBe(0); // FixedClock: reproducible bytes
    expect(pkg.provenance.steps.find((step) => step.step === "discover")?.units).toBe(1);
    expect(pkg.partial).toBe(false);
    expect(pkg.warnings).toEqual([]);
    expect(pkg.dropped).toEqual([]);
  });

  it("is byte-for-byte reproducible for the same clock and the same answers", async () => {
    const rows = [webRow("https://example.com/a", "The dam was completed in 1968.")];
    const build = (): Promise<ResearchPackage> =>
      runResearch(
        { topic: "The dam" },
        deps(
          stubResearch(() => rows),
          extractFirstSentence(() => "The dam was completed in 1968."),
        ),
      );

    const first = await build();
    const second = await build();
    expect(new TextDecoder().decode(researchPackageBytes(first))).toBe(
      new TextDecoder().decode(researchPackageBytes(second)),
    );
    // One source is not corroboration: the claim is real but not "established".
    expect(first.claims[0]!.status).toBe("supported");
    expect(first.claims[0]!.certainty).toBe("likely");
    expect(first.claims[0]!.mayStateAsFact).toBe(false);
  });

  it("keeps operator-supplied sources, marked as such", async () => {
    const pkg = await runResearch(
      {
        topic: "The dam",
        operatorSources: [
          {
            url: "https://archive.example.org/dam",
            title: "Dam archive",
            content: "Construction of the dam finished in 1968.",
            publisher: "operator",
          },
        ],
      },
      deps(
        stubResearch(() => []),
        extractFirstSentence(() => "The dam was finished in 1968."),
      ),
    );

    expect(pkg.sources).toHaveLength(1);
    expect(pkg.sources[0]!.retrieval).toBe("operator_text");
    expect(pkg.sources[0]!.provider).toBe("operator");
    expect(pkg.sources[0]!.publisher).toBe("operator");
    expect(pkg.claims).toHaveLength(1);
    expect(pkg.evidence[0]!.excerpt).toBe("Construction of the dam finished in 1968.");
  });

  // ── 2. Empty result ─────────────────────────────────────────────────────

  it("returns an explicitly empty package when the provider finds nothing", async () => {
    const pkg = await runResearch(
      { topic: "An obscure topic" },
      deps(
        stubResearch(() => []),
        extractFirstSentence(() => "never used"),
      ),
    );

    expect(pkg.sources).toEqual([]);
    expect(pkg.evidence).toEqual([]);
    expect(pkg.claims).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.partial).toBe(true);
    expect(pkg.verification.reviewRequired).toBe(true);
    expect(pkg.verification.claims).toBe(0);
    expect(pkg.warnings.join(" ")).toContain("no usable sources were found");
    expect(pkg.warnings.join(" ")).toContain("no factual claims could be extracted");
    // The replayable trace still exists: the run itself is documented.
    expect(pkg.provenance.steps.find((step) => step.step === "discover")?.outcome).toBe("partial");
    expect(pkg.provenance.steps.find((step) => step.step === "conflicts")?.outcome).toBe("skipped");
  });

  it("falls back to the topic when the planner returns no questions", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => []),
        (request) =>
          request.task === "research.questions" ? { questions: [] } : { evidence: [], claims: [] },
      ),
    );
    expect(pkg.questions).toHaveLength(1);
    expect(pkg.questions[0]!.question).toBe("The dam");
    expect(pkg.warnings.join(" ")).toContain("planner returned no usable research questions");
  });

  // ── 3. Malformed provider output ────────────────────────────────────────

  it("fails the run when the model cannot satisfy the schema", async () => {
    await expect(
      runResearch(
        { topic: "The dam" },
        deps(
          stubResearch(() => [webRow("https://example.com/a", "The dam finished in 1968.")]),
          () => ({ questions: "this is not the shape the schema asked for" }),
        ),
      ),
    ).rejects.toThrow(ProviderContentError);
  });

  it("rejects malformed search rows and keeps the well-formed ones", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [
          webRow("https://example.com/good", "The dam was completed in 1968."),
          { title: "no url at all" },
          { url: 42, snippet: "numeric url" },
          { url: "https://example.com/no-snippet", title: "no snippet at all" },
        ]),
        extractFirstSentence(() => "The dam was completed in 1968."),
      ),
    );

    expect(pkg.sources.map((source) => source.url)).toEqual([
      "https://example.com/good",
      "https://example.com/no-snippet",
    ]);
    expect(pkg.sources.map((source) => source.retrieval)).toEqual([
      "provider_snippet",
      "unavailable",
    ]);
    expect(pkg.dropped.filter((item) => item.reason === "malformed_result")).toHaveLength(2);
    // A row with no text can never become evidence.
    expect(pkg.dropped.some((item) => item.reason === "no_content")).toBe(true);
    expect(pkg.evidence).toHaveLength(1);
  });

  it("marks a claim whose quotation cannot be verified as unverified", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [webRow("https://example.com/a", "The dam was completed in 1968.")]),
        (request) => {
          if (request.task === "research.questions") return plannedQuestions();
          if (request.task === "research.extract") {
            return {
              evidence: [{ quote: "The dam was completed in 1968 and cost $40m." }],
              claims: [
                {
                  statement: "The dam cost $40m.",
                  evidence: [0],
                  stance: "supports",
                  strength: 0.9,
                },
              ],
            };
          }
          return { groups: [], conflicts: [], refutations: [] };
        },
      ),
    );

    expect(pkg.evidence).toEqual([]);
    expect(pkg.dropped.some((item) => item.reason === "quote_not_found")).toBe(true);
    const claim = pkg.claims[0]!;
    expect(claim.links).toEqual([]);
    expect(claim.status).toBe("unverified");
    expect(claim.certainty).toBe("uncertain");
    expect(claim.mayStateAsFact).toBe(false);
    expect(pkg.verification.blockingClaimIds).toEqual([claim.id]);
  });

  it("drops links that reference evidence which failed verification", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [webRow("https://example.com/a", "The dam was completed in 1968.")]),
        (request) => {
          if (request.task === "research.questions") return plannedQuestions();
          if (request.task === "research.extract") {
            return {
              evidence: [{ quote: "The dam was completed in 1968." }],
              claims: [{ statement: "It cost $40m.", evidence: [4], stance: "supports" }],
            };
          }
          return { groups: [], conflicts: [], refutations: [] };
        },
      ),
    );

    expect(pkg.dropped.some((item) => item.reason === "unknown_reference")).toBe(true);
    expect(pkg.claims[0]!.links).toEqual([]);
    expect(pkg.evidence).toHaveLength(1);
  });

  // ── 4. Timeout ──────────────────────────────────────────────────────────

  const extractionForDam = (request: {
    readonly task?: string;
    readonly messages: Messages;
  }): unknown => {
    if (request.task === "research.questions") return twoQuestions();
    if (request.task === "research.extract") {
      return {
        evidence: [{ quote: "The dam was completed in 1968." }],
        claims: [
          {
            statement: "The dam was completed in 1968.",
            evidence: [0],
            stance: "supports",
            strength: 1,
          },
        ],
      };
    }
    return { groups: [], conflicts: [], refutations: [] };
  };

  it("degrades to the calls that succeeded when one search times out", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [webRow("https://example.com/dam", "The dam was completed in 1968.")], {
          fail: (query) =>
            query === "dam power"
              ? new ProviderTimeoutError("deadline exceeded", { provider: "stub-research" })
              : undefined,
        }),
        extractionForDam,
      ),
    );

    expect(pkg.partial).toBe(true);
    expect(pkg.sources).toHaveLength(1);
    expect(pkg.warnings.join(" ")).toContain("search call(s) failed");
    const discover = pkg.provenance.steps.find((step) => step.step === "discover")!;
    expect(discover.outcome).toBe("partial");
    expect(discover.notes.join(" ")).toContain("search failed");
  });

  it("fails the run when every search times out", async () => {
    await expect(
      runResearch(
        { topic: "The dam" },
        deps(
          stubResearch(() => [], {
            fail: () =>
              new ProviderTimeoutError("deadline exceeded", { provider: "stub-research" }),
          }),
          extractFirstSentence(() => "unused"),
        ),
      ),
    ).rejects.toThrow(ProviderTimeoutError);
  });

  // ── 5. Rate limit ───────────────────────────────────────────────────────

  it("surfaces a rate limit as a retryable failure when nothing succeeded", async () => {
    await expect(
      runResearch(
        { topic: "The dam" },
        deps(
          stubResearch(() => [], {
            fail: () =>
              new ProviderRateLimitError("429 from the search API", {
                provider: "stub-research",
                retryAfterMs: 30_000,
              }),
          }),
          extractFirstSentence(() => "unused"),
        ),
      ),
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 30_000 });
  });

  it("continues past a rate-limited query and records it", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [webRow("https://example.com/dam", "The dam was completed in 1968.")], {
          fail: (query) =>
            query === "dam power"
              ? new ProviderRateLimitError("429", { provider: "stub-research" })
              : undefined,
        }),
        extractionForDam,
      ),
    );

    expect(pkg.partial).toBe(true);
    expect(pkg.sources).toHaveLength(1);
    expect(pkg.provenance.steps.find((step) => step.step === "discover")?.outcome).toBe("partial");
  });

  // ── 6. Conflicting sources ──────────────────────────────────────────────

  it("preserves disagreement between sources instead of resolving it", async () => {
    const alpha = webRow(
      "https://alpha.example.com/bridge",
      "The bridge carries 40,000 vehicles a day.",
    );
    const beta = webRow(
      "https://beta.example.com/bridge",
      "The bridge carries 55,000 vehicles a day.",
    );

    const pkg = await runResearch(
      { topic: "The bridge" },
      deps(
        stubResearch(() => [alpha, beta]),
        (request) => {
          if (request.task === "research.questions") {
            return plannedQuestions("How busy is the bridge?");
          }
          if (request.task === "research.extract") {
            const url = sourceUrlOf(request.messages);
            const text = between(request.messages, '"""', '"""');
            return {
              evidence: [{ quote: text }],
              claims: [
                {
                  statement: url.includes("alpha")
                    ? "The bridge carries 40,000 vehicles a day."
                    : "The bridge carries 55,000 vehicles a day.",
                  evidence: [0],
                  stance: "supports",
                  strength: 1,
                },
              ],
            };
          }
          if (request.task === "research.reconcile") return { groups: [] };
          // The conflict pass proposes the numeric disagreement, one refutation
          // that is genuinely quoted, and one that is fabricated.
          const entries = claimEntriesOf(request.messages);
          const forty = entries.find((entry) => entry.statement.includes("40,000"))!;
          const fiftyFive = entries.find((entry) => entry.statement.includes("55,000"))!;
          return {
            conflicts: [
              {
                claims: [forty.id, fiftyFive.id],
                kind: "numeric_disagreement",
                explanation: "the two counts differ",
              },
            ],
            refutations: [
              {
                claim: forty.id,
                source: sourceIdFor(beta.url),
                quote: "The bridge carries 55,000 vehicles a day.",
                explanation: "beta disputes alpha",
              },
              {
                claim: forty.id,
                source: sourceIdFor(alpha.url),
                quote: "a sentence the source never contained",
                explanation: "fabricated",
              },
            ],
          };
        },
      ),
    );

    // Both claims survive, worded exactly as their sources state them.
    expect(pkg.claims).toHaveLength(2);
    expect(pkg.claims.map((claim) => claim.contested)).toEqual([true, true]);
    for (const claim of pkg.claims) {
      expect(claim.certainty).toBe("disputed");
      expect(claim.mayStateAsFact).toBe(false);
      expect(claim.confidence).toBeLessThanOrEqual(0.4);
    }
    const statements = pkg.claims.map((claim) => claim.statement).join(" | ");
    expect(statements).toContain("40,000");
    expect(statements).toContain("55,000");

    // The model-proposed conflict has both sides and is never auto-resolved.
    const numeric = pkg.conflicts.find((conflict) => conflict.kind === "numeric_disagreement")!;
    expect(numeric.detectedBy).toBe("model");
    expect(numeric.preserved).toBe(true);
    expect(numeric.sides).toHaveLength(2);
    expect(numeric.sides.map((side) => side.claimId).sort()).toEqual(
      pkg.claims.map((claim) => claim.id).sort(),
    );

    // The verified refutation became a contradiction link + a source side…
    const verified = pkg.conflicts.find((conflict) => conflict.detectedBy === "evidence_stance")!;
    expect(verified.sides.find((side) => side.kind === "source")!.statement).toBe(
      "The bridge carries 55,000 vehicles a day.",
    );
    const contradicted = pkg.claims.find((claim) =>
      claim.links.some((link) => link.stance === "contradicts"),
    )!;
    expect(contradicted.status).toBe("contradicted");
    expect(
      pkg.evidence.some(
        (evidence) => evidence.excerpt === "The bridge carries 55,000 vehicles a day.",
      ),
    ).toBe(true);

    // …and the fabricated quote is dropped, never stored.
    expect(pkg.dropped.some((item) => item.reason === "quote_not_found")).toBe(true);
    expect(pkg.evidence.some((evidence) => evidence.excerpt.includes("never contained"))).toBe(
      false,
    );

    expect(pkg.verification.reviewRequired).toBe(true);
    expect(pkg.verification.contested).toBe(2);
    expect(pkg.verification.blockingClaimIds).toHaveLength(2);
  });

  it("drops conflict proposals that reference claims which do not exist", async () => {
    const pkg = await runResearch(
      { topic: "The bridge" },
      deps(
        stubResearch(() => [
          webRow("https://alpha.example.com/bridge", "Alpha reports 40,000 vehicles."),
          webRow("https://beta.example.com/bridge", "Beta reports 55,000 vehicles."),
        ]),
        (request) => {
          if (request.task === "research.questions")
            return plannedQuestions("How busy is the bridge?");
          if (request.task === "research.extract") {
            const url = sourceUrlOf(request.messages);
            const text = between(request.messages, '"""', '"""');
            return {
              evidence: [{ quote: text }],
              claims: [
                {
                  statement: url.includes("alpha")
                    ? "Alpha reports 40,000."
                    : "Beta reports 55,000.",
                  evidence: [0],
                  stance: "supports",
                  strength: 1,
                },
              ],
            };
          }
          if (request.task === "research.reconcile") return { groups: [] };
          const ids = claimIdsOf(request.messages);
          return {
            conflicts: [{ claims: [ids[0] ?? "cl_missing", "cl_does_not_exist"], kind: "scope" }],
            refutations: [{ claim: "cl_missing", source: "src_missing", quote: "whatever" }],
          };
        },
      ),
    );

    expect(pkg.conflicts).toEqual([]);
    expect(pkg.dropped.filter((item) => item.reason === "unknown_reference")).toHaveLength(2);
    expect(pkg.claims.every((claim) => !claim.contested)).toBe(true);
  });

  // ── 7. Duplicate sources ────────────────────────────────────────────────

  it("deduplicates by canonical URL and by identical content", async () => {
    const canonical = "https://example.com/story";
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [
          webRow(canonical, "The dam was completed in 1968."),
          webRow(`${canonical}?utm_source=twitter#section-2`, "The dam was completed in 1968."),
          webRow("https://mirror.example.net/copy", "The dam was completed in 1968."),
        ]),
        extractFirstSentence(() => "The dam was completed in 1968."),
      ),
    );

    expect(pkg.sources).toHaveLength(1);
    expect(pkg.sources[0]!.url).toBe(canonical);
    const reasons = pkg.dropped.map((item) => item.reason);
    expect(reasons).toContain("duplicate_url");
    expect(reasons).toContain("duplicate_content");
  });

  it("stops collecting once the source budget is spent and says so", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() =>
          Array.from({ length: 5 }, (_, index) =>
            webRow(`https://example.com/${index}`, `Statement number ${index} about the dam.`),
          ),
        ),
        extractFirstSentence((url) => `Statement about ${url}.`),
        { options: { maxSources: 2 } },
      ),
    );

    expect(pkg.sources).toHaveLength(2);
    expect(pkg.dropped.filter((item) => item.reason === "source_limit")).toHaveLength(3);
  });

  // ── 8. Invalid URLs ─────────────────────────────────────────────────────

  it("rejects invalid, local and non-HTTP URLs before anything is stored", async () => {
    const pkg = await runResearch(
      { topic: "The dam" },
      deps(
        stubResearch(() => [
          webRow("javascript:alert(1)", "script payload"),
          webRow("file:///etc/passwd", "file payload"),
          webRow("http://127.0.0.1/admin", "loopback payload"),
          webRow("http://192.168.0.5/router", "private payload"),
          webRow("http://[::ffff:10.0.0.1]/metadata", "mapped-address payload"),
          webRow("https://user:secret@example.com/a", "credentials payload"),
          webRow("https://example.com/ok", "The dam was completed in 1968."),
        ]),
        extractFirstSentence(() => "The dam was completed in 1968."),
        { options: { resultsPerQuery: 20 } },
      ),
    );

    expect(pkg.sources.map((source) => source.url)).toEqual(["https://example.com/ok"]);
    const invalid = pkg.dropped.filter((item) => item.reason === "invalid_url");
    expect(invalid).toHaveLength(6);
    // The rejection is recorded, and no rejected URL became a source.
    expect(invalid.map((item) => item.value).join(" ")).toContain("127.0.0.1");
    expect(pkg.sources.some((source) => source.url.includes("10.0.0.1"))).toBe(false);
    expect(pkg.evidence).toHaveLength(1);
  });

  it("validates operator-supplied URLs with the same rule", async () => {
    const pkg = await runResearch(
      {
        topic: "The dam",
        operatorSources: [{ url: "http://localhost:8080/x", content: "pasted text" }],
      },
      deps(
        stubResearch(() => []),
        extractFirstSentence(() => "unused"),
      ),
    );
    expect(pkg.sources).toEqual([]);
    expect(pkg.dropped.some((item) => item.reason === "invalid_url")).toBe(true);
  });

  // ── Wiring: the engine against a bundled fake adapter ──────────────────

  it("runs end to end on the bundled fake research adapter", async () => {
    const research = new FakeResearchProvider(runtimeFor("research", "fake", storage), {
      id: "fake",
    });

    const pkg = await runResearch(
      { topic: "Why the sky is blue" },
      {
        llm: makeLlm(
          storage,
          extractFirstSentence((url) => `A statement drawn from ${url}.`),
        ),
        research,
        clock: new FixedClock(CLOCK_ISO),
      },
      { maxQuestions: 1, maxQueriesPerQuestion: 1, maxSources: 3, resultsPerQuery: 2 },
    );

    expect(research).toBeInstanceOf(FakeResearchProvider);
    expect(pkg.sources).toHaveLength(2);
    expect(pkg.sources.every((source) => source.provider === "fake")).toBe(true);
    expect(pkg.provenance.providers.research).toBe("fake");
    expect(pkg.claims).toHaveLength(2);
    // Every excerpt is a slice of its own source: the core invariant.
    for (const evidence of pkg.evidence) {
      const source = pkg.sources.find((candidate) => candidate.id === evidence.sourceId)!;
      expect(source.content.slice(evidence.locator.start, evidence.locator.end)).toBe(
        evidence.excerpt,
      );
    }
  });
});
