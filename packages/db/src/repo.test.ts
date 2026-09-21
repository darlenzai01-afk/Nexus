import { beforeEach, describe, expect, it } from "vitest";

import { Db, type ScriptDoc } from "./index.js";
import { migrate } from "./index.js";
import { ConflictError, NotFoundError, Repo, ValidationError } from "./repo.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const scriptDoc: ScriptDoc = {
  version: 2,
  topic: "Why the sky is blue",
  workingTitle: "Why the sky is blue",
  logline: "Rayleigh scattering, explained simply.",
  sections: [
    {
      id: "sec1",
      role: "hook",
      title: "Hook",
      transition: "",
      sentences: [
        {
          id: "s1_1",
          narration: "Look up on a clear day.",
          assertion: "context",
          claimRefs: [],
          sourceRefs: [],
        },
      ],
    },
    {
      id: "sec2",
      role: "introduction",
      title: "Introduction",
      transition: "Here is what is actually happening.",
      sentences: [
        {
          id: "s2_1",
          narration: "Sunlight contains all visible wavelengths.",
          assertion: "fact",
          claimRefs: ["c1"],
          sourceRefs: [],
        },
      ],
    },
    {
      id: "sec3",
      role: "narrative",
      title: "Scattering",
      transition: "",
      sentences: [
        {
          id: "s3_1",
          narration: "Air scatters blue light more strongly.",
          assertion: "context",
          claimRefs: [],
          sourceRefs: [],
        },
      ],
    },
    {
      id: "sec4",
      role: "conclusion",
      title: "Conclusion",
      transition: "",
      sentences: [
        {
          id: "s4_1",
          narration: "That is why the sky looks blue.",
          assertion: "context",
          claimRefs: [],
          sourceRefs: [],
        },
      ],
    },
  ],
  claims: [
    {
      claimId: "c1",
      statement: "Sunlight contains all visible wavelengths.",
      status: "supported",
      certainty: "established",
      confidence: 0.8,
      mayStateAsFact: true,
      usage: "fact",
      sentenceIds: ["s2_1"],
      evidence: [
        {
          sourceId: "src_a",
          url: "https://example.com/a",
          excerpt: "Sunlight is white.",
          locator: "0:18",
        },
      ],
    },
  ],
  quality: { issues: [], repairRounds: 0, reviewRequired: false, droppedSentences: [] },
  stats: { sections: 4, sentences: 4, words: 30, estimatedDurationSec: 12 },
  provenance: {
    engine: { name: "nexus-script", version: "1.0.0" },
    researchPackageHash: SHA_A,
    providers: { llm: "fake" },
    steps: [],
    aiSteps: ["write"],
    deterministicSteps: ["select", "validate", "finalize"],
    repairRounds: 0,
    generatedAt: "2024-05-01T00:00:00.000Z",
    durationMs: 0,
  },
  warnings: [],
};

describe("Repo — projects & episodes", () => {
  let db: Db;
  let repo: Repo;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
  });

  const seedProject = (): string =>
    repo.createProject({ name: "Science Weekly", slug: "science-weekly" }).id;

  it("creates a project with validated defaults and ISO timestamps", () => {
    const project = repo.createProject({ name: "Science Weekly", slug: "science-weekly" });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.created_at).toMatch(ISO);
    expect(repo.projectConfig(project.id).aspects.horizontal).toEqual({
      width: 640,
      height: 360,
      fps: 12,
    });
    expect(repo.projectConfig(project.id).publishingDefaults.privacy).toBe("private");
    expect(repo.listProjects()).toHaveLength(1);
  });

  it("rejects invalid project data before it reaches SQL", () => {
    expect(() => repo.createProject({ name: "", slug: "ok" })).toThrow(ValidationError);
    expect(() => repo.createProject({ name: "X", slug: "Not A Slug" })).toThrow(ValidationError);
    expect(() =>
      repo.createProject({
        name: "X",
        slug: "ok",
        config: { aspects: { horizontal: { width: 10, height: 10, fps: 12 } } } as never,
      }),
    ).toThrow(ValidationError);
    repo.createProject({ name: "Science Weekly", slug: "science-weekly" });
    expect(() => repo.createProject({ name: "Dupe", slug: "science-weekly" })).toThrow(/UNIQUE/i);

    // Bad project id is a typed error, not a raw SQL failure.
    expect(() => repo.createEpisode({ projectId: "nope", topic: "t" })).toThrow(NotFoundError);
  });

  it("creates episodes with a valid state and enforces the short→parent rule", () => {
    const projectId = seedProject();
    const episode = repo.createEpisode({
      projectId,
      topic: "Rainbows",
      outline: ["intro", "physics"],
    });
    expect(episode.state).toBe("QUEUED");
    expect(episode.kind).toBe("long");
    expect(repo.episodeOutline(episode.id)).toEqual(["intro", "physics"]);

    expect(() => repo.createEpisode({ projectId, topic: "" })).toThrow(ValidationError);
    expect(() => repo.createEpisode({ projectId, topic: "t", outline: [""] })).toThrow(
      ValidationError,
    );
    expect(() => repo.createEpisode({ projectId, topic: "t", kind: "short" })).toThrow(
      /parentEpisodeId/,
    );
    expect(() =>
      repo.createEpisode({ projectId, topic: "t", kind: "short", parentEpisodeId: "missing" }),
    ).toThrow(NotFoundError);
    expect(() => repo.createEpisode({ projectId, topic: "t", kind: "nope" as never })).toThrow(
      ValidationError,
    );
  });

  it("moves an episode through validated states and records failures", () => {
    const episode = repo.createEpisode({ projectId: seedProject(), topic: "Rainbows" });
    const researching = repo.setEpisodeState(episode.id, "RESEARCHING");
    expect(researching.state).toBe("RESEARCHING");
    expect(researching.updated_at >= researching.created_at).toBe(true);

    const failed = repo.setEpisodeState(episode.id, "FAILED", "provider quota exhausted");
    expect(failed.state).toBe("FAILED");
    expect(failed.error).toBe("provider quota exhausted");
    expect(repo.setEpisodeState(episode.id, "FAILED").error).toBeNull();

    expect(() => repo.setEpisodeState(episode.id, "SOMETIMES" as never)).toThrow(ValidationError);
    expect(() => repo.setEpisodeState("missing", "READY")).toThrow(NotFoundError);
    // every documented state is accepted
    for (const state of [
      "QUEUED",
      "RESEARCHING",
      "FACT_CHECKING",
      "FACT_REVIEW",
      "SCRIPTING",
      "SCENE_PLANNING",
      "MEDIA_GATHERING",
      "VOICE_SYNTHESIS",
      "CAPTIONING",
      "COMPOSITING",
      "RENDERING",
      "QA",
      "APPROVAL",
      "READY",
      "PUBLISHING",
      "PUBLISHED",
      "NEEDS_CHANGES",
      "FAILED",
      "CANCELED",
    ] as const) {
      expect(repo.setEpisodeState(episode.id, state).state).toBe(state);
    }
  });
});

describe("Repo — sources, artifacts, scripts, scenes, claims, media", () => {
  let db: Db;
  let repo: Repo;
  let episodeId: string;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    episodeId = repo.createEpisode({
      projectId: repo.createProject({ name: "P", slug: "p" }).id,
      topic: "Sky",
    }).id;
  });

  it("deduplicates sources by URL/content hash and links them to episodes", () => {
    const first = repo.addSource({
      url: "https://example.com/sky",
      content: "Rayleigh scattering explains it.",
    });
    const sameUrl = repo.addSource({ url: "https://example.com/sky", content: "different body" });
    const sameContent = repo.addSource({
      url: "https://other.test/copy",
      content: "Rayleigh scattering explains it.",
    });
    expect(sameUrl.id).toBe(first.id);
    expect(sameContent.id).toBe(first.id);
    expect(first.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.added_by).toBe("operator");

    repo.linkEpisodeSource(episodeId, first.id);
    expect(repo.listEpisodeSources(episodeId).map((s) => s.id)).toEqual([first.id]);
    repo.linkEpisodeSource(episodeId, first.id); // idempotent
    expect(repo.listEpisodeSources(episodeId)).toHaveLength(1);

    expect(() => repo.addSource({ url: "", content: "x" })).toThrow(ValidationError);
    expect(() => repo.linkEpisodeSource(episodeId, "missing")).toThrow(NotFoundError);
  });

  it("registers artifacts by hash only, refusing inconsistent re-registration", () => {
    const artifact = repo.registerArtifact({
      hash: SHA_A,
      kind: "script",
      bytes: 512,
      meta: { durationSec: 0 },
    });
    expect(artifact.hash).toBe(SHA_A);
    expect(repo.registerArtifact({ hash: SHA_A, kind: "script", bytes: 512 }).hash).toBe(SHA_A); // idempotent
    expect(() => repo.registerArtifact({ hash: SHA_A, kind: "video", bytes: 512 })).toThrow(
      ConflictError,
    );
    expect(() => repo.registerArtifact({ hash: "zzz", kind: "script", bytes: 1 })).toThrow(
      ValidationError,
    );
    expect(() => repo.registerArtifact({ hash: SHA_B, kind: "script", bytes: -1 })).toThrow(
      ValidationError,
    );
    expect(() => repo.registerArtifact({ hash: SHA_B, kind: "nope" as never, bytes: 1 })).toThrow(
      ValidationError,
    );
  });

  it("versions scripts per episode and supersedes the previous approval", () => {
    repo.registerArtifact({ hash: SHA_A, kind: "script", bytes: 10 });
    repo.registerArtifact({ hash: SHA_B, kind: "script", bytes: 20 });

    const v1 = repo.createScript({ episodeId, doc: scriptDoc, docHash: SHA_A, status: "approved" });
    const v2 = repo.createScript({ episodeId, doc: scriptDoc, docHash: SHA_B });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1.status).toBe("approved");

    const v3 = repo.createScript({ episodeId, doc: scriptDoc, docHash: SHA_B, status: "approved" });
    expect(v3.version).toBe(3);
    expect(repo.getScript(v1.id)?.status).toBe("superseded");
    expect(repo.latestScript(episodeId)?.id).toBe(v3.id);

    // schema-invalid script document (no sections) is rejected before SQL
    expect(() =>
      repo.createScript({ episodeId, doc: { version: 1, sections: [] } as never, docHash: SHA_A }),
    ).toThrow(ValidationError);
    expect(() => repo.createScript({ episodeId, doc: scriptDoc, docHash: "not-a-hash" })).toThrow(
      ValidationError,
    );
    // docHash must exist in the CAS index: no dangling artifact references.
    expect(() => repo.createScript({ episodeId, doc: scriptDoc, docHash: "f".repeat(64) })).toThrow(
      /not registered/,
    );
    expect(() =>
      repo.createScript({ episodeId: "missing", doc: scriptDoc, docHash: SHA_A }),
    ).toThrow(NotFoundError);
  });

  it("stores a scene graph with validated payloads and stable ordering", () => {
    repo.registerArtifact({ hash: SHA_A, kind: "script", bytes: 10 });
    const script = repo.createScript({ episodeId, doc: scriptDoc, docHash: SHA_A });
    const scenes = repo.replaceScenes(script.id, [
      {
        kind: "title",
        sectionId: "sec1",
        sentenceId: "s1_1",
        durationSec: 1.5,
        data: { title: "Intro" },
      },
      {
        kind: "fact",
        sectionId: "sec1",
        sentenceId: "s2_1",
        startSec: 1.5,
        durationSec: 2,
        data: { body: "Blue." },
      },
    ]);
    expect(scenes.map((s) => [s.idx, s.kind, s.start_sec])).toEqual([
      [0, "title", 0],
      [1, "fact", 1.5],
    ]);
    expect(scenes[0]!.episode_id).toBe(episodeId);

    // re-planning replaces, never duplicates (idempotent step)
    const replanned = repo.replaceScenes(script.id, [
      {
        kind: "title",
        sectionId: "sec1",
        sentenceId: "s1_1",
        durationSec: 1.5,
        data: { title: "Intro" },
      },
    ]);
    expect(replanned).toHaveLength(1);
    expect(replanned[0]!.idx).toBe(0);
    expect(repo.listScenes(script.id)).toHaveLength(1);

    expect(() => repo.replaceScenes(script.id, [{ kind: "title", durationSec: 0 }])).toThrow(
      ValidationError,
    );
    expect(() =>
      repo.replaceScenes(script.id, [{ kind: "dance" as never, durationSec: 1 }]),
    ).toThrow(ValidationError);
    expect(() => repo.replaceScenes("missing", [])).toThrow(NotFoundError);
  });

  it("keeps claims first-class with mandatory evidence traceability", () => {
    repo.registerArtifact({ hash: SHA_A, kind: "script", bytes: 10 });
    const script = repo.createScript({ episodeId, doc: scriptDoc, docHash: SHA_A });
    const source = repo.addSource({
      url: "https://example.com/sky",
      content: "Sunlight contains all visible wavelengths.",
    });

    const claims = repo.replaceClaims(script.id, [
      {
        claimRef: "c1",
        sentenceId: "s2_1",
        text: "Sunlight contains all visible wavelengths.",
        status: "supported",
        score: 1,
        evidence: [
          {
            sourceId: source.id,
            excerpt: "Sunlight contains all visible wavelengths.",
            locator: "p1",
            score: 1,
          },
        ],
      },
    ]);
    expect(claims).toHaveLength(1);
    const evidence = repo.listClaimEvidence(claims[0]!.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source_id).toBe(source.id);

    expect(() =>
      repo.replaceClaims(script.id, [{ claimRef: "c2", sentenceId: "", text: "x" }]),
    ).toThrow(ValidationError);
    expect(() =>
      repo.replaceClaims(script.id, [{ claimRef: "c2", sentenceId: "s1_1", text: "x", score: 2 }]),
    ).toThrow(ValidationError);
    expect(() =>
      repo.replaceClaims(script.id, [
        { claimRef: "c2", sentenceId: "s1_1", text: "x", evidence: [{ sourceId: "missing" }] },
      ]),
    ).toThrow(NotFoundError);

    const updated = repo.setClaimStatus(claims[0]!.id, "overridden", 1);
    expect(updated.status).toBe("overridden");
    expect(() => repo.setClaimStatus(claims[0]!.id, "maybe" as never)).toThrow(ValidationError);
  });

  it("requires license provenance for media assets", () => {
    repo.registerArtifact({ hash: SHA_B, kind: "image", bytes: 2048 });
    const asset = repo.registerMediaAsset({
      hash: SHA_B,
      kind: "generated",
      license: "original",
      aiGenerated: true,
      attribution: "Nexus Forge",
    });
    expect(asset.ai_generated).toBe(1);
    expect(() => repo.registerMediaAsset({ hash: SHA_B, kind: "image", license: "  " })).toThrow(
      ValidationError,
    );
    expect(() =>
      repo.registerMediaAsset({ hash: "c".repeat(64), kind: "image", license: "CC0" }),
    ).toThrow(/not registered/);
  });
});

describe("Repo — resumable pipeline jobs", () => {
  let db: Db;
  let repo: Repo;
  let episodeId: string;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    episodeId = repo.createEpisode({
      projectId: repo.createProject({ name: "P", slug: "p" }).id,
      topic: "Sky",
    }).id;
  });

  const steps = ["research", "script", "fact_check", "voice", "render", "qa", "approval"] as const;

  it("creates a versioned job with ordered steps", () => {
    const { job, steps: rows } = repo.createJob({ episodeId, pipeline: "longform_v1", steps });
    expect(job.state).toBe("PENDING");
    expect(job.attempt).toBe(0);
    expect(rows.map((r) => r.step_key)).toEqual([...steps]);
    expect(rows.every((r) => r.state === "PENDING")).toBe(true);

    expect(() => repo.createJob({ episodeId, pipeline: "longform", steps })).toThrow(
      ValidationError,
    );
    expect(() => repo.createJob({ episodeId, pipeline: "longform_v1", steps: [] })).toThrow(
      ValidationError,
    );
    expect(() => repo.createJob({ episodeId, pipeline: "longform_v1", steps: ["a", "a"] })).toThrow(
      ValidationError,
    );
    expect(() => repo.createJob({ episodeId: "missing", pipeline: "longform_v1", steps })).toThrow(
      NotFoundError,
    );
  });

  it("claims exactly one job per worker and only the oldest runnable job", () => {
    const first = repo.createJob({ episodeId, pipeline: "longform_v1", steps }).job;
    const second = repo.createJob({
      episodeId,
      pipeline: "shorts_v1",
      steps: ["prep", "render"],
    }).job;

    const claimed = repo.claimJob({ owner: "worker-a", leaseMs: 60_000 });
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.state).toBe("RUNNING");
    expect(claimed?.lease_owner).toBe("worker-a");
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.lease_expires_at).toMatch(ISO);

    expect(repo.claimJob({ owner: "worker-a", leaseMs: 60_000 })?.id).toBe(second.id);
    expect(repo.claimJob({ owner: "worker-a", leaseMs: 60_000 })).toBeUndefined();
  });

  it("reclaims jobs whose worker died (expired lease)", () => {
    const job = repo.createJob({ episodeId, pipeline: "longform_v1", steps }).job;
    repo.claimJob({ owner: "worker-a", leaseMs: 60_000 });
    expect(repo.claimJob({ owner: "worker-b", leaseMs: 60_000 })).toBeUndefined(); // lease still live

    db.run("UPDATE pipeline_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?;", [
      job.id,
    ]);
    const reclaimed = repo.claimJob({ owner: "worker-b", leaseMs: 60_000 });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.lease_owner).toBe("worker-b");
    expect(reclaimed?.attempt).toBe(2);
  });

  it("does not let a worker renew someone else's lease", () => {
    const job = repo.createJob({ episodeId, pipeline: "longform_v1", steps }).job;
    repo.claimJob({ owner: "worker-a", leaseMs: 60_000 });
    expect(repo.renewLease(job.id, "worker-a", 120_000).lease_expires_at).toMatch(ISO);
    expect(() => repo.renewLease(job.id, "worker-b", 120_000)).toThrow(ConflictError);
  });

  it("records checkpoints and skips satisfied steps on resume", () => {
    const { job } = repo.createJob({ episodeId, pipeline: "longform_v1", steps });
    repo.claimJob({ owner: "worker-a", leaseMs: 60_000 });

    repo.startStep(job.id, "research");
    expect(repo.getJobStep(job.id, "research")?.attempt).toBe(1);
    repo.checkpointStep(job.id, "research", { inputHash: "h1", output: { sources: 3 } });

    expect(repo.isStepSatisfied(job.id, "research", "h1")).toBe(true);
    expect(repo.isStepSatisfied(job.id, "research", "h2")).toBe(false); // upstream changed
    expect(repo.isStepSatisfied(job.id, "script", "h1")).toBe(false); // not done yet

    const failed = repo.failStep(job.id, "script", "LLM returned invalid JSON");
    expect(failed.state).toBe("FAILED");
    expect(failed.error).toMatch(/invalid JSON/);
    expect(() => repo.failStep(job.id, "nope", "x")).toThrow(NotFoundError);

    // Crash + resume: re-claiming keeps finished step checkpoints intact.
    db.run("UPDATE pipeline_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?;", [
      job.id,
    ]);
    expect(repo.claimJob({ owner: "worker-b", leaseMs: 60_000 })?.id).toBe(job.id);
    expect(repo.getJobStep(job.id, "research")?.state).toBe("DONE");
    expect(repo.getJobStep(job.id, "research")?.output).toBe(JSON.stringify({ sources: 3 }));
  });

  it("invalidates a step and everything downstream when upstream content changes", () => {
    const { job } = repo.createJob({ episodeId, pipeline: "longform_v1", steps });
    for (const key of steps) repo.checkpointStep(job.id, key, { inputHash: "h", output: { key } });
    expect(repo.listJobSteps(job.id).every((s) => s.state === "DONE")).toBe(true);

    const afterInvalidate = repo.invalidateFromStep(job.id, "voice");
    const stateByKey = Object.fromEntries(afterInvalidate.map((s) => [s.step_key, s.state]));
    expect(stateByKey).toMatchObject({
      research: "DONE",
      script: "DONE",
      fact_check: "DONE",
      voice: "PENDING",
      render: "PENDING",
      qa: "PENDING",
      approval: "PENDING",
    });
    expect(afterInvalidate.find((s) => s.step_key === "voice")?.input_hash).toBeNull();
    expect(() => repo.invalidateFromStep(job.id, "missing")).toThrow(NotFoundError);
  });

  it("parks a job at a gate and clears its lease when it leaves RUNNING", () => {
    const { job } = repo.createJob({ episodeId, pipeline: "longform_v1", steps });
    repo.claimJob({ owner: "worker-a", leaseMs: 60_000 });
    const waiting = repo.setJobState(job.id, "WAITING_GATE", { gate: "FACT_REVIEW" });
    expect(waiting.state).toBe("WAITING_GATE");
    expect(waiting.waiting_gate).toBe("FACT_REVIEW");
    expect(waiting.lease_owner).toBeNull();
    expect(waiting.lease_expires_at).toBeNull();

    const done = repo.setJobState(job.id, "DONE");
    expect(done.state).toBe("DONE");
    expect(() => repo.setJobState(job.id, "MAYBE" as never)).toThrow(ValidationError);
    expect(() => repo.setJobState("missing", "DONE")).toThrow(NotFoundError);
  });
});

describe("Repo — approvals, audit, provider metering", () => {
  let db: Db;
  let repo: Repo;
  let episodeId: string;

  beforeEach(() => {
    db = Db.memory();
    migrate(db);
    repo = new Repo(db);
    episodeId = repo.createEpisode({
      projectId: repo.createProject({ name: "P", slug: "p" }).id,
      topic: "Sky",
    }).id;
  });

  it("binds approvals to a content fingerprint and audits the decision", () => {
    const approval = repo.recordApproval({
      subjectType: "episode",
      subjectId: episodeId,
      gate: "FINAL_REVIEW",
      decision: "approved",
      fingerprint: "fp-v3",
      notes: "looks good",
    });
    expect(approval.reviewed_by).toBe("operator");
    expect(repo.listApprovals(episodeId)).toHaveLength(1);

    // approved v3 must not validate against v4 content
    expect(repo.latestValidApproval("episode", episodeId, "fp-v3")?.id).toBe(approval.id);
    expect(repo.latestValidApproval("episode", episodeId, "fp-v4")).toBeUndefined();

    const rejected = repo.recordApproval({
      subjectType: "episode",
      subjectId: episodeId,
      gate: "FINAL_REVIEW",
      decision: "rejected",
      fingerprint: "fp-v4",
    });
    expect(repo.latestValidApproval("episode", episodeId, "fp-v4")).toBeUndefined();
    expect(rejected.decision).toBe("rejected");

    expect(() =>
      repo.recordApproval({
        subjectType: "episode",
        subjectId: "",
        gate: "g",
        decision: "approved",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      repo.recordApproval({
        subjectType: "video" as never,
        subjectId: episodeId,
        gate: "g",
        decision: "approved",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      repo.recordApproval({
        subjectType: "episode",
        subjectId: episodeId,
        gate: "g",
        decision: "maybe" as never,
      }),
    ).toThrow(ValidationError);
  });

  it("appends audit entries in order with structured detail", () => {
    repo.appendAudit({
      action: "provider.credential.changed",
      actor: "operator",
      detail: { adapter: "openai" },
    });
    repo.appendAudit({ action: "episode.created", subjectType: "episode", subjectId: episodeId });
    const entries = repo.listAudit();
    expect(entries.map((e) => e.action)).toEqual([
      "episode.created",
      "provider.credential.changed",
    ]);
    expect(entries[1]?.detail).toBe(JSON.stringify({ adapter: "openai" }));
    expect(() => repo.appendAudit({ action: "" })).toThrow(ValidationError);
  });

  it("meters provider calls per free-tier quota window and never stores secrets", () => {
    const account = repo.upsertProviderAccount({
      adapter: "openai",
      credentialsEnv: "NEXUS_LLM_API_KEY",
      quotaWindow: "daily",
      quotaLimit: 200_000,
    });
    expect(account.quota_used).toBe(0);
    const again = repo.upsertProviderAccount({
      adapter: "openai",
      credentialsEnv: "NEXUS_LLM_API_KEY",
      enabled: false,
    });
    expect(again.id).toBe(account.id);
    expect(again.enabled).toBe(0);

    expect(() =>
      repo.upsertProviderAccount({ adapter: "openai", credentialsEnv: "sk-live-abc123" }),
    ).toThrow(ValidationError);

    repo.logProviderCall({
      provider: "openai",
      operation: "script",
      units: 1200,
      durationMs: 900,
      accountId: account.id,
    });
    repo.logProviderCall({
      provider: "openai",
      operation: "metadata",
      units: 300,
      cacheKey: "topic:sky",
    });
    repo.logProviderCall({
      provider: "tts",
      operation: "voice",
      units: 400,
      status: "error",
      error: "429 quota",
    });

    const usage = repo.providerUsageSince("2000-01-01T00:00:00.000Z");
    expect(usage).toEqual([
      { provider: "openai", units: 1500, calls: 2 },
      { provider: "tts", units: 400, calls: 1 },
    ]);
    expect(repo.listProviderCalls()[0]?.status).toBe("error");
    expect(() => repo.logProviderCall({ provider: "", operation: "x" })).toThrow(ValidationError);
  });

  it("keeps raw() read-only", () => {
    expect(repo.raw("SELECT COUNT(*) AS n FROM projects;")).toHaveLength(1);
    expect(() => repo.raw("DELETE FROM projects;")).toThrow(ValidationError);
    expect(() => repo.raw("DROP TABLE projects;")).toThrow(ValidationError);
  });
});
