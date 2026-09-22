import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv } from "@nexus/config";
import { Db, migrate, Repo } from "@nexus/db";
import { PermanentError, type TaskContext, type TaskResult } from "@nexus/jobs";
import { loadDemoScene } from "@nexus/render";
import { ResearchPackageSchema } from "@nexus/research";
import { loadSceneManifest } from "@nexus/scenes";
import { CasStore } from "@nexus/storage";

import { afterAll, describe, expect, it } from "vitest";

import {
  DASHBOARD_PIPELINE,
  DASHBOARD_STEPS,
  createAnimateTask,
  createApprovalTask,
  createFactCheckTask,
  createIdeaTask,
  createSourceMediaTask,
  fingerprintParams,
} from "./pipeline.js";

/**
 * The app's glue stages, one broken-or-working document at a time.
 *
 * These tasks own no engines — they move documents between stages and apply
 * the app's own policy (what "source media" means before a media adapter
 * exists) — so the tests pin exactly those decisions.
 */

const root = mkdtempSync(path.join(tmpdir(), "nexus-pipeline-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const cas = new CasStore(path.join(root, "cas"));
const db = Db.memory();
migrate(db);
const repo = new Repo(db);

/** `execute` may return `void`; every glue task in this suite returns a result. */
function must(result: TaskResult | void): TaskResult {
  if (result === undefined || result === null) throw new Error("task returned no result");
  return result;
}

function contextOf(parts: Partial<TaskContext> = {}): TaskContext {
  return {
    job: { params: {} } as unknown as TaskContext["job"],
    episode: { topic: "the Kira bridge", outline: "[]" } as TaskContext["episode"],
    stage: DASHBOARD_PIPELINE.stages[0]!,
    pipeline: DASHBOARD_PIPELINE,
    inputs: { job: { topic: "the Kira bridge", outline: [] } },
    upstream: {},
    fingerprint: "f".repeat(64),
    signal: new AbortController().signal,
    log: () => {},
    ...parts,
  };
}

describe("the dashboard pipeline", () => {
  it("runs the long-form graph without publish", () => {
    expect(DASHBOARD_PIPELINE.id).toBe("longform_v1");
    expect(DASHBOARD_STEPS).not.toContain("publish");
    expect(DASHBOARD_STEPS.at(-1)).toBe("approval");
    // Every declared stage is executable (the worker asserts the same thing).
    expect(DASHBOARD_STEPS).toHaveLength(12);
  });

  it("keeps machine-specific paths out of the stage fingerprints", () => {
    const config = loadEnv({
      env: {
        NEXUS_FFMPEG_PATH: "/opt/ffmpeg/somewhere/ffmpeg",
        NEXUS_DATA_DIR: "/tmp/one",
        NEXUS_RENDER_WIDTH: "640",
      },
    });
    const params = fingerprintParams(config) as Record<string, unknown>;
    expect(JSON.stringify(params)).not.toContain("/opt/ffmpeg");
    expect(params).toMatchObject({ providers: { llm: "none" }, render: { width: 640 } });
  });
});

describe("the idea stage", () => {
  it("normalizes the operator's brief into the pipeline's first output", async () => {
    const result = must(
      await createIdeaTask().execute(
        contextOf({
          episode: {
            topic: "  Why bridges hum  ",
            outline: '["acoustics","history"]',
          } as TaskContext["episode"],
          inputs: { job: { topic: "  Why bridges hum  ", outline: ["acoustics", "history"] } },
        }),
      ),
    );
    expect(result.output).toMatchObject({
      topic: "Why bridges hum",
      outline: ["acoustics", "history"],
      words: 3,
    });
  });

  it("refuses an episode with no topic, before any provider is spent", async () => {
    await expect(
      createIdeaTask().execute(contextOf({ episode: { topic: "   " } as TaskContext["episode"] })),
    ).rejects.toThrow(PermanentError);
  });
});

describe("the fact_check stage", () => {
  const reviewPackage = ResearchPackageSchema.parse({
    version: 1,
    topic: "the Kira bridge",
    createdAt: "2026-01-01T00:00:00Z",
    questions: [{ id: "q1", question: "How busy is the bridge?" }],
    verification: {
      claims: 1,
      byStatus: { unverified: 1, supported: 0, contradicted: 0, unsupportable: 0 },
      established: 0,
      contested: 0,
      conflicts: 0,
      reviewRequired: true,
      blockingClaimIds: ["cl_kira"],
    },
    provenance: {
      engine: { name: "nexus-research", version: "1.0.0" },
      schemaVersion: 1,
      topic: "the Kira bridge",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      providers: {
        llm: "fake",
        research: "fake",
        tts: "fake",
        media: "none",
        storage: "local",
        publishing: "none",
      },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
    },
  });
  const clearPackage = {
    ...reviewPackage,
    verification: {
      ...reviewPackage.verification,
      reviewRequired: false,
      blockingClaimIds: [],
    },
  };

  it("parks the job at FACT_REVIEW when the package needs a human", async () => {
    const hash = cas.put(new TextEncoder().encode(JSON.stringify(reviewPackage))).hash;
    repo.registerArtifact({ hash, kind: "document", bytes: cas.read(hash).length });
    const result = must(
      await createFactCheckTask({ storage: cas }).execute(
        contextOf({ upstream: { research: { packageHash: hash } } }),
      ),
    );
    expect(result.waiting).toBe("FACT_REVIEW");
    expect(result.waitingReason).toContain("not established");
  });

  it("hands a cleared package to the script with its own review artifact", async () => {
    const hash = cas.put(new TextEncoder().encode(JSON.stringify(clearPackage))).hash;
    repo.registerArtifact({ hash, kind: "document", bytes: cas.read(hash).length });
    const result = must(
      await createFactCheckTask({ storage: cas }).execute(
        contextOf({ upstream: { research: { packageHash: hash } } }),
      ),
    );
    expect(result.waiting).toBeUndefined();
    expect(result.output).toMatchObject({ packageHash: hash, reviewRequired: false });
    expect(result.artifacts).toEqual([{ hash, kind: "document", role: "fact_check_review" }]);
  });

  it("refuses to run without a research package", async () => {
    await expect(createFactCheckTask({ storage: cas }).execute(contextOf())).rejects.toThrow(
      PermanentError,
    );
  });
});

describe("the source_media stage", () => {
  it("resolves planned assets to generated placeholder plates and republishes the manifest", async () => {
    // The demonstration scene ships with a planned asset — exactly what the
    // planner emits before the media stage runs.
    const planned = loadDemoScene();
    expect(planned.assets.some((asset) => asset.status === "planned")).toBe(true);
    const planHash = cas.put(
      new TextEncoder().encode(`${JSON.stringify(planned, null, 2)}\n`),
    ).hash;
    repo.registerArtifact({
      hash: planHash,
      kind: "scene_graph",
      bytes: cas.read(planHash).length,
    });

    const result = must(
      await createSourceMediaTask({ storage: cas, repo }).execute(
        contextOf({ upstream: { plan: { manifestHash: planHash } } }),
      ),
    );
    const output = result.output as { manifestHash: string; reportHash: string; resolved: number };
    expect(output.manifestHash).not.toBe(planHash);
    expect(output.resolved).toBeGreaterThan(0);

    const updated = loadSceneManifest(cas, output.manifestHash);
    for (const asset of updated.assets) {
      expect(asset.status).toBe("resolved");
      expect(asset.uri).toMatch(/^generated:\/\/plates\//u);
      expect(asset.licence).toBe("generated");
    }
    // The declared deliverable — the resolution report — is registered and readable.
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "document", role: "media_resolution_report" }),
      ]),
    );
    expect(repo.getArtifact(output.reportHash)).toBeDefined();
    expect(cas.has(output.reportHash)).toBe(true);
  });

  it("publishes the plan unchanged when nothing is planned", async () => {
    const manifest = {
      ...loadDemoScene(),
      assets: loadDemoScene().assets.map((asset) => ({
        ...asset,
        status: "resolved" as const,
        uri: "generated://already/plate.svg",
        licence: "generated" as const,
      })),
    };
    const planHash = cas.put(
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    ).hash;
    repo.registerArtifact({
      hash: planHash,
      kind: "scene_graph",
      bytes: cas.read(planHash).length,
    });

    const result = must(
      await createSourceMediaTask({ storage: cas, repo }).execute(
        contextOf({ upstream: { plan: { manifestHash: planHash } } }),
      ),
    );
    const output = result.output as { manifestHash: string; resolved: number };
    expect(output.manifestHash).toBe(planHash);
    expect(output.resolved).toBe(0);
  });
});

describe("the animate stage", () => {
  it("hands the manifest forward and references it as the timeline", async () => {
    const manifest = loadDemoScene();
    const hash = cas.put(new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)).hash;
    repo.registerArtifact({ hash, kind: "scene_graph", bytes: cas.read(hash).length });

    const result = must(
      await createAnimateTask().execute(
        contextOf({ upstream: { source_media: { manifestHash: hash } } }),
      ),
    );
    expect(result.output).toEqual({ manifestHash: hash });
    expect(result.artifacts).toEqual([{ hash, kind: "scene_graph", role: "animation_timeline" }]);
  });
});

describe("the approval stage task", () => {
  it("is a safety net that parks at the stage's own gate", async () => {
    const approvalStage = DASHBOARD_PIPELINE.stages.find((stage) => stage.key === "approval")!;
    const result = must(await createApprovalTask().execute(contextOf({ stage: approvalStage })));
    expect(result.waiting).toBe("FINAL_APPROVAL");
  });
});
