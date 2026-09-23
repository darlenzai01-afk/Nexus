import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PublishProvider } from "@nexus/providers";
import {
  BudgetGuard,
  createRuntime,
  DEFAULT_PROVIDER_POLICY,
  FakePublishProvider,
  FixedClock,
  invoke,
  MemoryBlobStore,
} from "@nexus/providers";
import { QA_REPORT_VERSION, QAReportSchema } from "@nexus/qa";
import { Db, migrate, Repo, type EpisodeRow } from "@nexus/db";
import { CasStore } from "@nexus/storage";
import { PermanentError, LONG_FORM_PIPELINE, type TaskContext } from "@nexus/jobs";

import { afterAll, describe, expect, it } from "vitest";

import { createPublishTask, PUBLISH_RECORD_ROLE, type PublishRequest } from "./pipeline.js";

/**
 * The publish stage's hard rule, tested from every side: **an episode only
 * publishes from an approved QA state.** A failed report, a missing report, a
 * missing approval, or an episode that is not approved means no upload call
 * ever happens — and the refusal is permanent, so no retry can sneak past.
 * The happy path runs against the deterministic fake publisher (never a real
 * one, never a network).
 */

const root = mkdtempSync(path.join(tmpdir(), "nexus-publish-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const cas = new CasStore(path.join(root, "cas"));
const db = Db.memory();
migrate(db);
const repo = new Repo(db);

/** Real episode rows (jobs reference them), created once, states driven per test. */
const project = repo.createProject({ name: "publish tests", slug: "publish-tests" });
const epA = repo.createEpisode({
  projectId: project.id,
  topic: "Why the Kira bridge hums at dusk",
  kind: "long",
});
const epB = repo.createEpisode({
  projectId: project.id,
  topic: "The cable frequency, measured",
  kind: "long",
});
repo.setEpisodeState(epA.id, "READY", "approved");
repo.setEpisodeState(epB.id, "READY", "approved");
let EPISODE_ID = epA.id;

/** `execute` may return `void`; every publish result in this suite is used. */
function must<T>(value: T | void): T {
  if (value === undefined || value === null) throw new Error("task returned no result");
  return value as T;
}

/** A counting publisher — proves whether an upload call happened at all. */
function countingPublisher(): { provider: PublishProvider; uploads: () => number } {
  const fake = new FakePublishProvider(fakeRuntime());
  let calls = 0;
  const provider: PublishProvider = {
    ...fake,
    // Override upload only; the rest of the capability is the fake's.
    upload: async (
      videoHash: string,
      metadata: Parameters<PublishProvider["upload"]>[1],
      ctx: Parameters<PublishProvider["upload"]>[2],
    ) => {
      calls += 1;
      return fake.upload(videoHash, metadata, ctx);
    },
  } as PublishProvider;
  return { provider, uploads: () => calls };
}

/** The InvokeRuntime the fake publisher needs (its own invoke envelope). */
function fakeRuntime(): ReturnType<typeof createRuntime> {
  const clock = new FixedClock("2024-05-01T00:00:00.000Z");
  const policy = {
    ...DEFAULT_PROVIDER_POLICY,
    maxAttempts: 2,
    baseDelayMs: 1,
    factor: 1,
    maxDelayMs: 2,
  };
  return createRuntime({
    adapterId: "fake",
    kind: "publishing",
    storage: new MemoryBlobStore(),
    clock,
    logger: () => {},
    env: {},
    policy,
    transport: () => {
      throw new Error("no transport in tests");
    },
    budget: new BudgetGuard({ clock }),
    limiter: { tryAcquire: () => true, msUntilAvailable: () => 0 },
    credentialsEnv: "NEXUS_YOUTUBE_CLIENT_SECRET",
    invoke: (spec) =>
      invoke(
        {
          adapterId: "fake",
          kind: "publishing",
          policy,
          budget: new BudgetGuard({ clock }),
          clock,
          sleep: async () => {},
        },
        spec,
      ),
  });
}

function putBytes(bytes: Uint8Array, kind: "metadata" | "qa_report" = "metadata"): string {
  const stored = cas.put(bytes);
  repo.registerArtifact({ hash: stored.hash, kind, bytes: stored.bytes });
  return stored.hash;
}

/** A minimal QA report the gate can read: `pass` by default, `fail` on demand. */
function qaReport(verdict: "pass" | "fail"): string {
  const report = QAReportSchema.parse({
    version: QA_REPORT_VERSION,
    generatedAt: "2024-05-01T00:00:00.000Z",
    engine: { name: "nexus-qa", version: "1.0.0" },
    episodeId: EPISODE_ID,
    jobId: "job_qa",
    subject: {},
    settings: {},
    settingsHash: "4".repeat(64),
    verdict,
    publishable: verdict !== "fail",
    blocked: verdict === "fail",
    blocking: [],
    counts: {
      errors: verdict === "fail" ? 1 : 0,
      warnings: 0,
      infos: 0,
      findings: verdict === "fail" ? 1 : 0,
      checks: 5,
      skipped: 0,
    },
    checks: [],
    findings: [],
  });
  return putBytes(new TextEncoder().encode(JSON.stringify(report)), "qa_report");
}

function episode(episodeId: string, state: EpisodeRow["state"] = "READY"): EpisodeRow {
  return {
    id: episodeId,
    project_id: "proj_1",
    parent_episode_id: null,
    kind: "long",
    topic: "Why the Kira bridge hums at dusk",
    outline: "[]",
    state,
    error: null,
    created_at: "2024-05-01T00:00:00.000Z",
    updated_at: "2024-05-01T00:00:00.000Z",
  };
}

function contextOf(episodeId: string, parts: Partial<TaskContext> = {}): TaskContext {
  return {
    job: {
      id: `job_publish_${repo.listJobs(episodeId).length + 1}`,
      episode_id: episodeId,
      idempotency_key: null,
      pipeline: "longform_v1",
    } as unknown as TaskContext["job"],
    episode: episode(episodeId),
    stage: LONG_FORM_PIPELINE.stages.find((stage) => stage.key === "publish")!,
    pipeline: LONG_FORM_PIPELINE,
    inputs: { job: { params: {} } },
    upstream: {},
    fingerprint: "f".repeat(64),
    signal: new AbortController().signal,
    log: () => {},
    ...parts,
  };
}

function recordApproval(episodeId: string = EPISODE_ID): void {
  repo.recordApproval({
    subjectType: "episode",
    subjectId: episodeId,
    gate: "FINAL_APPROVAL",
    decision: "approved",
    fingerprint: "e".repeat(64),
    reviewedBy: "test",
  });
}

describe("the publish stage", () => {
  it("refuses — permanently, with no upload — when no QA report exists", async () => {
    const { provider, uploads } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    await expect(task.execute(contextOf(EPISODE_ID))).rejects.toBeInstanceOf(PermanentError);
    expect(uploads()).toBe(0);
  });

  it("refuses a FAILED QA report — a failed episode must not be publishable", async () => {
    const failedHash = qaReport("fail");
    const { provider, uploads } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    await expect(
      task.execute(contextOf(EPISODE_ID, { upstream: { qa: { reportHash: failedHash } } })),
    ).rejects.toThrow(/failed QA.*must not be published/su);
    expect(uploads()).toBe(0);
  });

  it("refuses when QA passed but the operator never approved", async () => {
    const passedHash = qaReport("pass");
    const { provider, uploads } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    await expect(
      task.execute(contextOf(EPISODE_ID, { upstream: { qa: { reportHash: passedHash } } })),
    ).rejects.toThrow(/requires the operator's approval/u);
    expect(uploads()).toBe(0);
  });

  it("refuses an episode that is not in an approved state", async () => {
    const passedHash = qaReport("pass");
    recordApproval();
    const { provider, uploads } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    await expect(
      task.execute(
        contextOf(EPISODE_ID, {
          episode: episode(EPISODE_ID, "NEEDS_CHANGES"),
          upstream: { qa: { reportHash: passedHash } },
        }),
      ),
    ).rejects.toThrow(/failed QA or was rejected must not be publishable/u);
    expect(uploads()).toBe(0);
  });

  it("publishes an approved, QA-clean episode and registers the record", async () => {
    const passedHash = qaReport("pass");
    const videoHash = putBytes(new TextEncoder().encode("pretend mp4"));
    recordApproval();
    const { provider, uploads } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    const result = must(
      await task.execute(
        contextOf(EPISODE_ID, {
          upstream: { qa: { reportHash: passedHash }, render: { videoHash } },
        }),
      ),
    );

    expect(uploads()).toBe(1);
    const output = result.output as {
      refId: string;
      url: string;
      status: string;
      recordHash: string;
    };
    expect(output.status).toBe("uploaded");
    expect(output.url).toContain("https://");
    const roles = (result.artifacts ?? []).map((artifact) => artifact.role);
    expect(roles).toContain(PUBLISH_RECORD_ROLE);
    expect(roles).toContain("publish_confirmation");
    // The record is real JSON in the CAS, carrying the QA hash it published under.
    const record = JSON.parse(new TextDecoder().decode(cas.read(output.recordHash))) as {
      qaReportHash: string;
      ref: { id: string };
    };
    expect(record.qaReportHash).toBe(passedHash);
    expect(record.ref.id).toBe(output.refId);
  });

  it("does not upload twice: a re-run returns the episode's recorded ref", async () => {
    const passedHash = qaReport("pass");
    const videoHash = putBytes(new TextEncoder().encode("pretend mp4"));
    recordApproval();
    const { provider, uploads } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    const context = contextOf(EPISODE_ID, {
      upstream: { qa: { reportHash: passedHash }, render: { videoHash } },
    });
    const first = must(await task.execute(context)).output as { refId: string; recordHash: string };

    // The first job's publish step is DONE and carries the record — as the
    // runner would have left it.
    const job = repo.createJob({
      episodeId: EPISODE_ID,
      pipeline: "longform_v1",
      steps: ["publish"],
      idempotencyKey: `publish:${EPISODE_ID}:${passedHash}`,
    });
    repo.checkpointStep(job.job.id, "publish", {
      output: first,
      artifacts: [{ hash: first.recordHash, kind: "metadata", role: PUBLISH_RECORD_ROLE }],
    });

    const second = must(
      await task.execute(
        contextOf(EPISODE_ID, {
          upstream: { qa: { reportHash: passedHash }, render: { videoHash } },
        }),
      ),
    ).output as { refId: string };
    expect(second.refId).toBe(first.refId);
    expect(uploads()).toBe(1);
  });

  it("carries the operator's request (title, privacy, schedule) from the idempotency key", async () => {
    const passedHash = qaReport("pass");
    const videoHash = putBytes(new TextEncoder().encode("pretend mp4"));
    recordApproval();
    EPISODE_ID = epB.id;
    recordApproval(epB.id);
    const request: PublishRequest = {
      version: 1,
      episodeId: epB.id,
      title: "The bridge that hums",
      description: "A scheduled premiere.",
      privacyStatus: "private",
      scheduledAt: "2024-06-01T15:00:00.000Z",
      requestedBy: "dashboard",
      requestedAt: "2024-05-01T00:00:00.000Z",
    };
    const requestHash = putBytes(new TextEncoder().encode(JSON.stringify(request)));
    const { provider } = countingPublisher();
    const task = createPublishTask({ storage: cas, repo, publisher: provider });
    const job = repo.createJob({
      episodeId: epB.id,
      pipeline: "longform_v1",
      steps: ["publish"],
      idempotencyKey: `publish:${epB.id}:${requestHash}`,
    });
    const result = must(
      await task.execute(
        contextOf(epB.id, {
          job: {
            id: job.job.id,
            episode_id: epB.id,
            idempotency_key: job.job.idempotency_key,
          } as unknown as TaskContext["job"],
          upstream: { qa: { reportHash: passedHash }, render: { videoHash } },
        }),
      ),
    );
    const output = result.output as { status: string };
    expect(output.status).toBe("scheduled");
  });
});
