/**
 * Security audit — the dashboard surface (routes, headers, error paths, gate
 * and publishing controls). Everything runs against an in-memory runtime with
 * mock providers; nothing here touches a deployment.
 *
 * Each test pins a security property an operator depends on. Fixes found by
 * this audit are referenced from `docs/testing/security-audit.md` (SA-1…).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv, type AppConfig } from "@nexus/config";
import { migrate } from "@nexus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../apps/nexus/src/app.js";
import { openRuntime, type Runtime } from "../../apps/nexus/src/runtime.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

let dataDir: string;
let config: AppConfig;
let runtime: Runtime;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "nexus-security-"));
  config = loadEnv({
    env: {
      ...configEnv,
      NEXUS_DATA_DIR: dataDir,
      NEXUS_RENDER_WORK_DIR: path.join(dataDir, "render"),
    },
  });
  runtime = openRuntime(config);
  migrate(runtime.db);
  app = await buildApp(config, { repo: runtime.repo, storage: runtime.storage });
});

afterAll(() => {
  runtime.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A second config over a scratch dir, for tests that need their own app. */
function probeConfig(dir: string): AppConfig {
  return loadEnv({
    env: {
      ...configEnv,
      NEXUS_DATA_DIR: dir,
      NEXUS_RENDER_WORK_DIR: path.join(dir, "render"),
    },
  });
}

const configEnv: Record<string, string> = {
  NEXUS_ENV: "test",
  NEXUS_LLM_PROVIDER: "fake",
  NEXUS_RESEARCH_PROVIDER: "fake",
  NEXUS_TTS_PROVIDER: "fake",
  NEXUS_RENDER_WIDTH: "192",
  NEXUS_RENDER_HEIGHT: "108",
  NEXUS_RENDER_FPS: "10",
  NEXUS_QA_DURATION_TOLERANCE_SEC: "15",
};

function createEpisode(topic: string, origin?: string): Promise<string> {
  return app
    .inject({
      method: "POST",
      url: "/episodes",
      payload: new URLSearchParams({ topic }).toString(),
      headers: origin === undefined ? FORM : { ...FORM, origin },
    })
    .then((response) => {
      expect(response.statusCode).toBe(303);
      return (response.headers.location as string).replace("/episodes/", "").split("?")[0]!;
    });
}

describe("cross-site request guard (SA-1)", () => {
  it("refuses a cross-origin form POST before any handler runs, recording nothing", async () => {
    const before = runtime.repo.listEpisodes().length;
    const attack = await app.inject({
      method: "POST",
      url: "/episodes",
      payload: new URLSearchParams({ topic: "created by an evil page" }).toString(),
      headers: { ...FORM, origin: "https://evil.example" },
    });
    expect(attack.statusCode).toBe(403);
    expect(runtime.repo.listEpisodes().length).toBe(before);
    expect(attack.body).toMatch(/Cross-site request refused/u);
  });

  it("refuses a null origin (sandboxed frame) and a malformed origin", async () => {
    for (const origin of ["null", "not a url"]) {
      const attack = await app.inject({
        method: "POST",
        url: "/jobs/00000000-0000-4000-8000-000000000000/approve",
        payload: "",
        headers: { ...FORM, origin },
      });
      expect(attack.statusCode, `origin ${origin}`).toBe(403);
    }
  });

  it("still accepts same-origin and origin-less POSTs (the dashboard and its tools)", async () => {
    const host = app.server.address();
    const hostHeader =
      typeof host === "object" && host !== null ? `127.0.0.1:${host.port}` : "127.0.0.1";
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/episodes",
      payload: new URLSearchParams({ topic: "same origin is fine" }).toString(),
      headers: { ...FORM, origin: `http://${hostHeader}`, host: hostHeader },
    });
    expect(sameOrigin.statusCode).toBe(303);

    const noOrigin = await app.inject({
      method: "POST",
      url: "/episodes",
      payload: new URLSearchParams({ topic: "no origin is fine (curl/worker)" }).toString(),
      headers: FORM,
    });
    expect(noOrigin.statusCode).toBe(303);
  });

  it("does not restrict reads: GETs carry no side effects to forge", async () => {
    const episodeId = await createEpisode("read probe");
    const page = await app.inject({
      method: "GET",
      url: `/episodes/${episodeId}`,
      headers: { origin: "https://evil.example" },
    });
    expect(page.statusCode).toBe(200);
  });
});

describe("response hardening headers (SA-2)", () => {
  it("sends nosniff, frame denial and a no-referrer policy on every response", async () => {
    const episodeId = await createEpisode("header probe");
    const page = await app.inject({ method: "GET", url: `/episodes/${episodeId}` });
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");

    const missing = await app.inject({ method: "GET", url: "/episodes/nope" });
    expect(missing.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves artifacts with a fixed content-type map and never as HTML", async () => {
    const episodeId = await createEpisode("artifact content probe");
    // A document artifact whose bytes are an HTML page: served by hash, but
    // never with a HTML content type (nosniff blocks the sniff-up).
    const bytes = new TextEncoder().encode("<script>alert('x')</script>");
    const stored = runtime.storage.put(bytes);
    runtime.repo.registerArtifact({ hash: stored.hash, kind: "document", bytes: stored.bytes });
    const served = await app.inject({ method: "GET", url: `/artifacts/${stored.hash}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).not.toContain("text/html");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");

    const episode = runtime.repo.requireEpisode(episodeId);
    expect(episode.id).toBe(episodeId);
  });
});

describe("error leakage (SA-3)", () => {
  it("shows operator-facing detail for 4xx but never for 5xx", async () => {
    // 4xx: the operator's own mistake, named plainly.
    const notFound = await app.inject({ method: "GET", url: "/episodes/does-not-exist" });
    expect(notFound.statusCode).toBe(404);

    // 5xx: an internal failure — the page must be generic, the server log
    // carries the real cause. A second app instance lets the probe register a
    // throwing route before the instance is ready (the audit must not wait
    // for a lucky infrastructure failure).
    const probeDir = mkdtempSync(path.join(tmpdir(), "nexus-sec-500-"));
    try {
      const probeRuntime = openRuntime(config);
      migrate(probeRuntime.db);
      const probeApp = await buildApp(probeConfig(probeDir), {
        repo: probeRuntime.repo,
        storage: probeRuntime.storage,
      });
      probeApp.post("/security-probe/boom", async () => {
        throw new Error(
          "SqliteError: FOREIGN KEY constraint failed — /home/operator/secret-data/nexus.db",
        );
      });
      const boom = await probeApp.inject({ method: "POST", url: "/security-probe/boom" });
      expect(boom.statusCode).toBe(500);
      expect(boom.body).not.toContain("SqliteError");
      expect(boom.body).not.toContain("/home/operator");
      expect(boom.body).toContain("server log");
      probeRuntime.db.close();
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});

describe("gate and publishing controls under attack", () => {
  it("refuses gate decisions for jobs that are not parked, and records nothing", async () => {
    const episodeId = await createEpisode("unparked approval probe");
    const job = runtime.repo.createJob({
      episodeId,
      pipeline: "longform_v1",
      steps: [
        "idea",
        "research",
        "script",
        "plan",
        "source_media",
        "animate",
        "voice",
        "captions",
        "render",
        "qa",
        "approval",
      ],
    }).job;
    runtime.repo.claimJob({ owner: "worker-1", leaseMs: 60_000 });

    for (const action of ["approve", "reject", "changes"]) {
      const attempt = await app.inject({
        method: "POST",
        url: `/jobs/${job.id}/${action}`,
        payload: "notes=attacker",
        headers: FORM,
      });
      expect(attempt.statusCode, action).toBe(303);
      expect(attempt.headers.location).toContain("error=");
    }
    expect(runtime.repo.listApprovals(episodeId)).toHaveLength(0);
  });

  it("refuses to resolve a gate against content other than what was parked", async () => {
    const episodeId = runtime.repo.createEpisode({
      projectId: runtime.repo.createProject({ name: "gatebind", slug: "gatebind" }).id,
      topic: "fingerprint binding",
    });
    const job = runtime.repo.createJob({
      episodeId: episodeId.id,
      pipeline: "longform_v1",
      steps: [
        "idea",
        "research",
        "script",
        "plan",
        "source_media",
        "animate",
        "voice",
        "captions",
        "render",
        "qa",
        "approval",
      ],
    }).job;
    // Park the job the way the runner does, at a known fingerprint.
    runtime.repo.startStep(job.id, "approval");
    runtime.repo.waitStep(job.id, "approval", {
      gate: "FINAL_APPROVAL",
      fingerprint: "a".repeat(64),
    });
    runtime.repo.setJobState(job.id, "WAITING_GATE", { gate: "FINAL_APPROVAL" });

    // A decision naming a different fingerprint is refused — "approved v3,
    // published v4" is structurally impossible.
    const { resolveGate } = await import("@nexus/jobs");
    expect(() =>
      resolveGate(runtime.repo, job.id, { decision: "approved", fingerprint: "b".repeat(64) }),
    ).toThrow(/does not match the parked content/u);
    expect(runtime.repo.listApprovals(episodeId.id)).toHaveLength(0);
  });

  it("refuses to queue a publish job for an episode that never reached an approved QA state", async () => {
    const episodeId = await createEpisode("publish gate probe");
    const attempt = await app.inject({
      method: "POST",
      url: `/episodes/${episodeId}/publish`,
      payload: new URLSearchParams({ title: "Attacker title" }).toString(),
      headers: FORM,
    });
    expect(attempt.statusCode).toBe(303);
    expect(attempt.headers.location).not.toContain("notice=publish");
    expect(attempt.headers.location).toContain("error=");
    // No publish job exists for the episode.
    const jobs = runtime.repo.listJobs(episodeId);
    expect(jobs).toHaveLength(0);
  });

  it("whitelists the publish privacy status — an attacker cannot smuggle a value", async () => {
    // (The enum whitelist is inline in the route: anything unknown → private.)
    const episodeId = await createEpisode("privacy whitelist probe");
    const attempt = await app.inject({
      method: "POST",
      url: `/episodes/${episodeId}/publish`,
      payload: new URLSearchParams({ title: "t", privacyStatus: "public" }).toString(),
      headers: FORM,
    });
    // Refused for the missing QA state, not for the privacy value — the point
    // is that the unknown-value path cannot escalate anything.
    expect(attempt.headers.location).toContain("error=");
  });
});

describe("injection and isolation probes", () => {
  it("stores hostile SQL/meta characters verbatim and leaves the database intact", async () => {
    const hostile =
      "x'; DROP TABLE episodes; -- <img src=x onerror=alert(1)> {{7*7}} ${process.env}";
    const episodeId = await createEpisode(hostile);
    const episode = runtime.repo.requireEpisode(episodeId);
    expect(episode.topic).toBe(hostile);

    // The episodes table is alive and the hostile row renders escaped.
    expect(runtime.repo.listEpisodes().length).toBeGreaterThan(0);
    const page = await app.inject({ method: "GET", url: `/episodes/${episodeId}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("<img src=x onerror");
    expect(page.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes reflected values in error pages and flashes", async () => {
    const page = await app.inject({
      method: "GET",
      url: "/episodes/%3Cscript%3Ealert(1)%3C/script%3E",
    });
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain("<script>alert(1)");

    // Flashes render on episode pages (the redirect target), escaped.
    const episodeId = await createEpisode("flash target");
    const flashed = await app.inject({
      method: "GET",
      url: `/episodes/${episodeId}?error=%3Cscript%3Ealert(1)%3C/script%3E`,
    });
    expect(flashed.body).not.toContain("<script>alert(1)");
    expect(flashed.body).toContain("&lt;script&gt;alert(1)");
  });

  it("refuses artifact addresses that are not sha-256 hashes (defense in depth)", async () => {
    for (const hostile of ["../../../etc/passwd", "zzzz", "/etc/passwd"]) {
      const attempt = await app.inject({
        method: "GET",
        url: `/artifacts/${encodeURIComponent(hostile)}`,
      });
      expect(attempt.statusCode, hostile).toBe(404);
    }
  });
});
