import { Db, Repo, migrate, type EpisodeRow, type PipelineJobRow } from "@nexus/db";
import { PermanentError, createTaskRegistry, runJob, type RunnerDeps } from "@nexus/jobs";
import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeLLMProvider,
  MANUAL_INPUT_GATE,
  ManualRequiredError,
  MemoryBlobStore,
  MemoryProviderCache,
  FixedClock,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type FakeLLMResponder,
  type ImageSearchResult,
  type InvokeRuntime,
  type ProviderPolicy,
  type ProviderResult,
  type ResearchProvider,
  type SearchOptions,
  type WebSearchResult,
} from "@nexus/providers";
import { beforeEach, describe, expect, it } from "vitest";

import { loadResearchPackage } from "./persist.js";
import { createResearchTask, type ResearchTaskDeps } from "./task.js";
import type { ResearchPackage } from "./types.js";

/**
 * The research stage inside the real job runner: same DB, same repository, same
 * lease/step machinery the worker uses. This is what proves the engine is wired
 * into the system rather than merely importable.
 */

const CLOCK_ISO = "2024-05-01T00:00:00.000Z";
const SNIPPET = "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.";
const POLICY: ProviderPolicy = {
  ...DEFAULT_PROVIDER_POLICY,
  maxAttempts: 1,
  baseDelayMs: 0,
  jitter: 0,
};

interface StubOptions {
  readonly rows?: readonly unknown[];
  readonly fail?: () => Error | undefined;
}

function stubResearch(options: StubOptions = {}): ResearchProvider {
  const id = "stub-research";
  const envelope = <T>(value: T): ProviderResult<T> => ({
    value,
    provider: id,
    operation: "research.search",
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
      _query: string,
      _options?: SearchOptions,
    ): Promise<ProviderResult<readonly WebSearchResult[]>> {
      const failure = options.fail?.();
      if (failure) throw failure;
      const rows = (options.rows ?? [
        { title: "Kira bridge", url: "https://news.example.com/bridge", snippet: SNIPPET },
      ]) as readonly WebSearchResult[];
      return envelope(rows);
    },
    async images(): Promise<ProviderResult<readonly ImageSearchResult[]>> {
      return envelope([] as readonly ImageSearchResult[]);
    },
  };
}

/** Answers every research task from the engine's own prompt, quoting the source. */
function responder(quote: string, statement = "The Kira bridge opened in 1973."): FakeLLMResponder {
  return (request) => {
    if (request.task === "research.questions") {
      return {
        questions: [
          {
            question: "When did the Kira bridge open?",
            rationale: "",
            priority: "primary",
            queries: ["kira bridge"],
          },
        ],
      };
    }
    if (request.task === "research.extract") {
      return {
        evidence: [{ quote, relevance: "the opening date" }],
        claims: [{ statement, evidence: [0], stance: "supports", strength: 1 }],
      };
    }
    if (request.task === "research.reconcile") return { groups: [] };
    return { conflicts: [], refutations: [] };
  };
}

function runtimeFor(id: string, kind: "llm" | "research", storage: MemoryBlobStore): InvokeRuntime {
  const clock = new FixedClock(CLOCK_ISO);
  const budget = new BudgetGuard({ clock });
  const cache = new MemoryProviderCache();
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
    invoke: (spec) =>
      invoke(
        {
          adapterId: id,
          kind,
          policy: POLICY,
          budget,
          cache,
          logger: silentProviderLogger,
          clock,
          sleep: async () => undefined,
        },
        spec,
      ),
  });
}

interface Harness {
  readonly repo: Repo;
  readonly storage: MemoryBlobStore;
  readonly deps: RunnerDeps;
  readonly episode: EpisodeRow;
  readonly job: PipelineJobRow;
  readonly research: ResearchProvider;
  run(): Promise<Awaited<ReturnType<typeof runJob>>>;
}

describe("research stage task", () => {
  let repo: Repo;
  let storage: MemoryBlobStore;

  beforeEach(() => {
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    storage = new MemoryBlobStore();
  });

  function harness(
    research: ResearchProvider,
    respond: FakeLLMResponder,
    params: Record<string, unknown> = {},
  ): Harness {
    const taskDeps: ResearchTaskDeps = {
      llm: new FakeLLMProvider(runtimeFor("stub-llm", "llm", storage), { respond, id: "stub-llm" }),
      research,
      storage,
      repo,
      clock: new FixedClock(CLOCK_ISO),
    };
    const deps: RunnerDeps = {
      repo,
      tasks: createTaskRegistry([createResearchTask(taskDeps)]),
      workerId: "worker-1",
      leaseMs: 60_000,
      heartbeatIntervalMs: 5,
      params,
      random: () => 0.5,
      signal: new AbortController().signal,
    };
    const project = repo.createProject({
      name: "Channel",
      slug: `channel-${Math.random().toString(36).slice(2, 8)}`,
    });
    const episode = repo.createEpisode({
      projectId: project.id,
      topic: "The Kira bridge",
      outline: ["intro"],
    });
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: ["research"],
    }).job;
    return {
      repo,
      storage,
      deps,
      episode,
      job,
      research,
      async run() {
        repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
        return runJob(deps, job.id);
      },
    };
  }

  it("completes the stage, persists the package and links the sources", async () => {
    const h = harness(stubResearch(), responder(SNIPPET));
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed", jobId: h.job.id });
    expect(repo.requireEpisode(h.episode.id).state).toBe("FACT_CHECKING");

    // The package is a CAS artifact, registered as the document the stage declares.
    const step = repo.getJobStep(h.job.id, "research")!;
    expect(step.state).toBe("DONE");
    const refs = JSON.parse(step.artifacts) as { hash: string; kind: string; role: string }[];
    expect(refs).toEqual([
      { hash: expect.stringMatching(/^[0-9a-f]{64}$/), kind: "document", role: "research_package" },
    ]);
    const artifact = repo.getArtifact(refs[0]!.hash)!;
    expect(artifact.kind).toBe("document");
    expect(JSON.parse(artifact.meta)).toMatchObject({
      generatedBy: { provider: "stub-llm", templateVersion: "research.extract@1" },
    });

    const pkg: ResearchPackage = loadResearchPackage(storage, refs[0]!.hash);
    expect(pkg.topic).toBe("The Kira bridge");
    expect(pkg.sources).toHaveLength(1);
    expect(pkg.claims).toHaveLength(1);
    expect(pkg.provenance.episodeId).toBe(h.episode.id);

    // Sources land in the DB and are linked to the episode.
    const linked = repo.listEpisodeSources(h.episode.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.url).toBe("https://news.example.com/bridge");
    expect(linked[0]!.added_by).toBe("provider");
    expect(linked[0]!.publisher).toBe("stub-research");
    expect(linked[0]!.content).toBe(SNIPPET);

    // The step output is what downstream stages read.
    const output = JSON.parse(step.output!) as {
      packageHash: string;
      counts: Record<string, number>;
      verification: { blockingClaimIds: string[] };
    };
    expect(output.packageHash).toBe(refs[0]!.hash);
    expect(output.counts).toEqual({ sources: 1, evidence: 1, claims: 1, conflicts: 0 });
    expect(output.verification.blockingClaimIds).toHaveLength(1);

    const events = repo.listJobLogs(h.job.id).map((row) => row.event);
    expect(events).toContain("research.started");
    expect(events).toContain("research.completed");
  });

  it("parks the job when the capability degrades to manual", async () => {
    const h = harness(
      stubResearch({
        fail: () =>
          new ManualRequiredError({
            capability: "research",
            operation: "research.search",
            summary: "paste the sources the search provider cannot return",
            instructions: [
              "Run the search in a browser",
              "Paste url + text into params.operatorSources",
            ],
          }),
      }),
      responder(SNIPPET),
    );
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "waiting", gate: MANUAL_INPUT_GATE });
    const step = repo.getJobStep(h.job.id, "research")!;
    expect(step.state).toBe("WAITING");
    expect(JSON.parse(step.artifacts)).toEqual([]);
    const gate = repo.listJobLogs(h.job.id).find((row) => row.event === "gate.waiting")!;
    expect(gate.message).toContain("paste the sources");
    expect(repo.listSources()).toEqual([]);
  });

  it("parks instead of inventing sources when the search comes back empty", async () => {
    const h = harness(stubResearch({ rows: [] }), responder(SNIPPET));
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "waiting", gate: MANUAL_INPUT_GATE });
    const gate = repo.listJobLogs(h.job.id).find((row) => row.event === "gate.waiting")!;
    expect(gate.message).toContain("no usable sources");
    expect(gate.message).toContain("operatorSources");
    expect(repo.listSources()).toEqual([]);
    expect(repo.getJobStep(h.job.id, "research")!.state).toBe("WAITING");
  });

  it("uses operator-supplied sources from params and records them as operator-sourced", async () => {
    const h = harness(
      stubResearch({ rows: [] }),
      responder("Construction finished in 1968.", "The dam finished in 1968."),
      {
        operatorSources: [
          {
            url: "https://archive.example.org/dam",
            title: "Dam archive",
            content: "Construction finished in 1968.",
          },
        ],
      },
    );
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed" });
    const sources = repo.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.added_by).toBe("operator");
    expect(sources[0]!.url).toBe("https://archive.example.org/dam");
  });

  it("rejects malformed operator sources as a permanent configuration error", async () => {
    const h = harness(stubResearch(), responder(SNIPPET), { operatorSources: [{ url: 42 }] });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("params.operatorSources is invalid");
  });

  it("refuses to adopt a reused stage output whose package is unreadable", async () => {
    const h = harness(stubResearch(), responder(SNIPPET));
    const task = createResearchTask({
      llm: new FakeLLMProvider(runtimeFor("stub-llm", "llm", storage), {
        respond: responder(SNIPPET),
      }),
      research: h.research,
      storage,
      repo,
      clock: new FixedClock(CLOCK_ISO),
    });

    await h.run();
    const refs = JSON.parse(repo.getJobStep(h.job.id, "research")!.artifacts) as {
      hash: string;
      kind: "document";
      role: string;
    }[];
    const run = {
      jobId: h.job.id,
      stepKey: "research",
      output: null,
      artifacts: refs,
      finishedAt: null,
    };

    // A readable package is adopted…
    expect(() => task.validateReuse!({} as never, run)).not.toThrow();

    // …a package whose bytes are gone is not (the stage re-executes instead).
    expect(() =>
      task.validateReuse!({} as never, {
        ...run,
        artifacts: [{ ...refs[0]!, hash: "0".repeat(64) }],
      }),
    ).toThrow();

    // …and neither is a stage that claims to have produced no package at all.
    expect(() => task.validateReuse!({} as never, { ...run, artifacts: [] })).toThrow(
      PermanentError,
    );
  });
});
