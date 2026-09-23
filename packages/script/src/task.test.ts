import { Db, Repo, migrate, type EpisodeRow, type PipelineJobRow } from "@nexus/db";
import { PermanentError, createTaskRegistry, runJob, type RunnerDeps } from "@nexus/jobs";
import {
  BudgetGuard,
  DEFAULT_PROVIDER_POLICY,
  FakeLLMProvider,
  FixedClock,
  MANUAL_INPUT_GATE,
  ManualRequiredError,
  MemoryBlobStore,
  MemoryProviderCache,
  createRuntime,
  invoke,
  silentProviderLogger,
  unlimitedRateLimiter,
  type FakeLLMResponder,
  type InvokeRuntime,
  type ProviderPolicy,
} from "@nexus/providers";
import { researchPackageBytes, type ResearchPackage } from "@nexus/research";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ORPHAN_CLAIM_ID,
  CLEAR_CLAIM_ID,
  THIN_CLAIM_ID,
  goodDraft,
  researchPackageFixture,
} from "./fixtures.js";
import { loadScriptDoc, persistScript } from "./persist.js";
import { createScriptTask, type ScriptTaskDeps } from "./task.js";
import type { ScriptDraft } from "./prompts.js";

/**
 * The `script` stage inside the real job runner: real SQLite, real repository,
 * real lease/step machinery — the mocks are only the AI provider and the clock.
 * This is what proves the engine is wired into the system rather than merely
 * importable, and that the claim → evidence chain survives into SQL.
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

/** Answers every write with the same draft; revision answers with `revised`. */
function responder(draft: ScriptDraft, revised?: ScriptDraft): FakeLLMResponder {
  return (request) => (request.task === "script.revise" && revised !== undefined ? revised : draft);
}

interface Harness {
  readonly repo: Repo;
  readonly storage: MemoryBlobStore;
  readonly deps: RunnerDeps;
  readonly episode: EpisodeRow;
  readonly job: PipelineJobRow;
  readonly task: ReturnType<typeof createScriptTask>;
  /** The research package hash this job was pointed at, if any. */
  readonly packageHash: string;
  run(): Promise<Awaited<ReturnType<typeof runJob>>>;
}

describe("script stage task", () => {
  let repo: Repo;
  let storage: MemoryBlobStore;

  beforeEach(() => {
    const db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    storage = new MemoryBlobStore();
  });

  function harness(options: {
    readonly package?: ResearchPackage;
    readonly respond?: FakeLLMResponder;
    readonly failLlm?: Error;
    readonly params?: Record<string, unknown>;
    /** Point the job at a hash that is not in the CAS. */
    readonly missingPackage?: boolean;
  }): Harness {
    const pkg = options.package ?? researchPackageFixture();
    const packageHash = options.missingPackage
      ? "f".repeat(64)
      : storage.put(researchPackageBytes(pkg)).hash;

    const llm = new FakeLLMProvider(runtimeFor("stub-llm", storage), {
      id: "stub-llm",
      respond: options.respond ?? responder(goodDraft()),
      ...(options.failLlm !== undefined
        ? { failFirst: 100, failWith: () => options.failLlm! }
        : {}),
    });
    const taskDeps: ScriptTaskDeps = {
      llm,
      storage,
      repo,
      clock: new FixedClock(CLOCK_ISO),
    };
    const task = createScriptTask(taskDeps);
    const params = options.params ?? { researchPackageHash: packageHash };
    const deps: RunnerDeps = {
      repo,
      tasks: createTaskRegistry([task]),
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
      outline: ["intro", "traffic"],
    });
    // The stage that actually writes a script runs after research + fact_check,
    // so the episode starts where that hand-off leaves it.
    repo.setEpisodeState(episode.id, "FACT_CHECKING", null);
    const job = repo.createJob({
      episodeId: episode.id,
      pipeline: "longform_v1",
      steps: ["script"],
    }).job;
    return {
      repo,
      storage,
      deps,
      episode,
      job,
      task,
      packageHash,
      async run() {
        repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });
        return runJob(deps, job.id);
      },
    };
  }

  it("writes the script, stores it and keeps every claim linked to its evidence", async () => {
    const h = harness({});
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed", jobId: h.job.id });
    expect(repo.requireEpisode(h.episode.id).state).toBe("SCENE_PLANNING");

    // The artifact: kind + role the stage declares it produces, with provenance.
    const step = repo.getJobStep(h.job.id, "script")!;
    expect(step.state).toBe("DONE");
    const refs = JSON.parse(step.artifacts) as { hash: string; kind: string; role: string }[];
    expect(refs).toEqual([
      { hash: expect.stringMatching(/^[0-9a-f]{64}$/), kind: "script", role: "script_doc" },
    ]);
    const artifact = repo.getArtifact(refs[0]!.hash)!;
    expect(artifact.kind).toBe("script");
    expect(JSON.parse(artifact.meta)).toMatchObject({
      generatedBy: { provider: "stub-llm", templateVersion: "script.write@1" },
    });

    // The document reads back out of the CAS in the shape the stages downstream read.
    const doc = loadScriptDoc(storage, refs[0]!.hash);
    expect(doc.workingTitle).toBe("Forty Thousand Crossings a Day");
    expect(doc.sections.map((section) => section.role)).toEqual([
      "hook",
      "introduction",
      "narrative",
      "narrative",
      "conclusion",
    ]);
    // A sentence the writer left without a visual hint gets the empty default,
    // never an invented search string.
    expect(doc.sections[2]!.sentences[0]!.visual).toMatchObject({ kind: "broll", searchHint: "" });
    expect(doc.quality.reviewRequired).toBe(false);
    expect(doc.quality.droppedSentences).toEqual([]);
    // The document says which research package it was written from.
    expect(doc.provenance.researchPackageHash).toBe(h.packageHash);

    // The scripts row and the claim/evidence rows.
    const script = repo.latestScript(h.episode.id)!;
    expect(script.version).toBe(1);
    expect(script.status).toBe("draft");
    expect(script.doc_hash).toBe(refs[0]!.hash);

    const claims = repo.listClaims(script.id);
    expect(claims.map((row) => row.claim_ref).sort()).toEqual([CLEAR_CLAIM_ID, THIN_CLAIM_ID]);
    expect(claims.map((row) => row.status).every((status) => status === "supported")).toBe(true);
    const clear = claims.find((row) => row.claim_ref === CLEAR_CLAIM_ID)!;
    // Bound to the sentence that states it, in the document's own numbering.
    expect(clear.sentence_id).toBe("s1_1");
    expect(clear.text).toBe(
      doc.claims.find((entry) => entry.claimId === CLEAR_CLAIM_ID)!.statement,
    );

    const evidence = repo.listClaimEvidence(clear.id);
    expect(evidence.map((row) => row.url).sort()).toEqual([
      "https://data.example.org/kira",
      "https://news.example.com/bridge",
    ]);
    const dataEvidence = evidence.find((row) => row.url === "https://data.example.org/kira")!;
    expect(dataEvidence.excerpt).toBe(
      "Traffic counts show 40,000 vehicles a day crossing the Kira bridge.",
    );
    // Locator = the verbatim span in the source: resolvable back to the text.
    const [start, end] = dataEvidence.locator.split(":").map(Number);
    const source = repo.listSources().find((row) => row.id === dataEvidence.source_id)!;
    expect(source.content.slice(start, end)).toBe(dataEvidence.excerpt);

    // The package's sources are in the DB (the `research` stage owns the
    // episode link; this stage only guarantees the rows its evidence needs).
    const sources = repo.listSources();
    expect(sources.map((row) => row.url).sort()).toEqual([
      "https://data.example.org/kira",
      "https://forum.example.net/kira",
      "https://news.example.com/bridge",
    ]);
    expect(sources.every((row) => row.added_by === "provider")).toBe(true);

    // The step output is the summary downstream stages (and the UI) read.
    const output = JSON.parse(step.output!) as {
      scriptId: string;
      docHash: string;
      workingTitle: string;
      counts: Record<string, number>;
      stats: { words: number; estimatedDurationSec: number };
      quality: { reviewRequired: boolean; hardIssues: number };
      sections: { role: string; sentences: number }[];
      claims: { claimId: string; usage: string }[];
    };
    expect(output.scriptId).toBe(script.id);
    expect(output.docHash).toBe(refs[0]!.hash);
    expect(output.workingTitle).toBe("Forty Thousand Crossings a Day");
    expect(output.counts).toMatchObject({ claims: 2, sentences: 8 });
    expect(output.stats.words).toBeGreaterThan(50);
    expect(output.stats.estimatedDurationSec).toBeGreaterThan(0);
    expect(output.quality).toMatchObject({ reviewRequired: false, hardIssues: 0 });
    expect(output.sections[0]).toEqual({ id: "sec1", role: "hook", title: "Hook", sentences: 1 });
    expect(output.claims.map((claim) => claim.usage).sort()).toEqual(["attributed", "fact"]);

    const events = repo.listJobLogs(h.job.id).map((row) => row.event);
    expect(events).toContain("script.started");
    expect(events).toContain("script.completed");
    // A clean draft is not sent to an editor.
    expect(events).not.toContain("script.review_required");
    // OD-15: the claims are not invented here — the orphan claim from research
    // never reaches the writer or the database.
    expect(claims.some((row) => row.claim_ref === ORPHAN_CLAIM_ID)).toBe(false);
  });

  it("parks the job instead of writing when research cleared nothing", async () => {
    const base = researchPackageFixture();
    const unverified = researchPackageFixture({
      claims: base.claims.map((claim) => ({
        ...claim,
        links: [],
        status: "unverified" as const,
        certainty: "uncertain" as const,
        confidence: 0,
        mayStateAsFact: false,
      })),
    });
    const h = harness({ package: unverified });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "waiting", gate: MANUAL_INPUT_GATE });
    const step = repo.getJobStep(h.job.id, "script")!;
    expect(step.state).toBe("WAITING");
    expect(JSON.parse(step.artifacts)).toEqual([]);
    const gate = repo.listJobLogs(h.job.id).find((row) => row.event === "gate.waiting")!;
    expect(gate.message).toContain("no claim that can be written about");
    expect(gate.message).toContain("no verified evidence");
    expect(gate.message).toContain("operatorSources");
    expect(repo.listScripts(h.episode.id)).toEqual([]);
    expect(repo.listSources()).toEqual([]);
  });

  it("parks the job when the AI capability has degraded to manual", async () => {
    const h = harness({
      failLlm: new ManualRequiredError({
        capability: "llm",
        operation: "llm.chat",
        summary: "connect a model provider to write the narration",
        instructions: ["Set NEXUS_LLM_PROVIDER to a real adapter", "Or write the script by hand"],
      }),
    });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "waiting", gate: MANUAL_INPUT_GATE });
    const gate = repo.listJobLogs(h.job.id).find((row) => row.event === "gate.waiting")!;
    expect(gate.message).toContain("connect a model provider");
    expect(gate.message).toContain("NEXUS_LLM_PROVIDER");
    expect(repo.getJobStep(h.job.id, "script")!.state).toBe("WAITING");
    expect(repo.listScripts(h.episode.id)).toEqual([]);
  });

  it("fails permanently when nothing points at a research package", async () => {
    const h = harness({ params: {} });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("has no research package");
  });

  it("fails permanently when the named package is not in the CAS", async () => {
    const h = harness({ missingPackage: true });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "failed", errorKind: "permanent" });
    expect(repo.requireJob(h.job.id).error).toContain("cannot read research package");
  });

  it("sends a draft that had to drop narration to an editor, and still stores it", async () => {
    const fabricated = goodDraft();
    fabricated.sections[2]!.sentences[0] = {
      narration: 'The engineer told me "it will never hold" back in 1973.',
      assertion: "context",
      claimRefs: [],
      sourceRefs: [],
    };
    // The writer cannot fix it, so the same draft comes back for the repair round.
    const h = harness({ respond: responder(fabricated) });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ status: "completed" });
    const events = repo.listJobLogs(h.job.id).map((row) => row.event);
    expect(events).toContain("script.review_required");

    const doc = loadScriptDoc(h.storage, repo.latestScript(h.episode.id)!.doc_hash);
    expect(doc.quality.reviewRequired).toBe(true);
    expect(doc.quality.droppedSentences).toEqual([
      'The engineer told me "it will never hold" back in 1973.',
    ]);
    // The invented quote is gone from the document that ships downstream.
    expect(
      doc.sections.flatMap((s) => s.sentences).some((s) => s.narration.includes("never hold")),
    ).toBe(false);
    // …and it is still a complete, parseable script: the section that lost a
    // sentence keeps its remaining one, and the ledger stays consistent.
    expect(doc.sections.map((section) => section.role)).toContain("narrative");
    expect(doc.claims.map((claim) => claim.claimId).sort()).toEqual([
      CLEAR_CLAIM_ID,
      THIN_CLAIM_ID,
    ]);
  });

  it("adopts a reused script artifact only when its claim ledger is intact", async () => {
    const h = harness({});
    await h.run();
    const refs = JSON.parse(repo.getJobStep(h.job.id, "script")!.artifacts) as {
      hash: string;
      kind: "script";
      role: string;
    }[];
    const run = {
      jobId: h.job.id,
      stepKey: "script",
      output: null,
      artifacts: refs,
      finishedAt: null,
    };

    // A stored script with claims is adopted…
    expect(() => h.task.validateReuse!({} as never, run)).not.toThrow();

    // …a step that produced no script artifact is not…
    expect(() => h.task.validateReuse!({} as never, { ...run, artifacts: [] })).toThrow(
      PermanentError,
    );

    // …and neither is one whose document lost its claim ledger: without it the
    // downstream stages would have nothing to check their scenes against.
    const doc = loadScriptDoc(storage, refs[0]!.hash);
    const stripped = storage.put(
      new TextEncoder().encode(JSON.stringify({ ...doc, claims: [] }, null, 2) + "\n"),
    );
    expect(() =>
      h.task.validateReuse!({} as never, {
        ...run,
        artifacts: [{ ...refs[0]!, hash: stripped.hash }],
      }),
    ).toThrow(/no claim ledger/);
  });

  it("re-persisting a script attaches to the same source rows instead of duplicating them", async () => {
    const h = harness({});
    await h.run();
    const pkg = researchPackageFixture();
    const doc = loadScriptDoc(storage, repo.latestScript(h.episode.id)!.doc_hash);

    const second = persistScript({ storage, repo }, doc, pkg, { episodeId: h.episode.id });

    // Identical bytes → identical hash: the CAS write is a no-op, not a copy.
    expect(second.created).toBe(false);
    expect(repo.listSources()).toHaveLength(3);
    expect(
      repo
        .listScripts(h.episode.id)
        .map((row) => row.version)
        .sort(),
    ).toEqual([1, 2]);
    expect(repo.listClaims(second.script.id)).toHaveLength(2);
    expect(second.unresolvedEvidence).toEqual([]);
  });
});
