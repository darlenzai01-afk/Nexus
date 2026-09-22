import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnv } from "@nexus/config";
import { migrate } from "@nexus/db";
import { buildApp, SERVICE_VERSION, openRuntime } from "@nexus/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type App = Awaited<ReturnType<typeof buildApp>>;

/**
 * Integration test: the @nexus/app package wiring works from outside the app
 * directory — a validated config opens a runtime (SQLite + CAS) and the real
 * dashboard routes answer over it (Fastify inject, no port binding). The full
 * pipeline walk lives in apps/nexus/src/app.test.ts; this file proves the
 * workspace-level composition: config package → app package → consumer.
 */
describe("nexus app (integration)", () => {
  let app: App;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "nexus-integration-"));
    const config = loadEnv({
      env: { NEXUS_ENV: "test", NEXUS_DATA_DIR: dataDir, NEXUS_LOG_LEVEL: "silent" },
    });
    const runtime = openRuntime(config);
    migrate(runtime.db);
    app = await buildApp(config, { repo: runtime.repo, storage: runtime.storage });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("GET /healthz reports a healthy dashboard with its environment and version", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", service: "nexus", env: "test" });
    expect(body.version).toBe(SERVICE_VERSION);
  });

  it("GET / serves the dashboard home (an empty studio, honestly)", async () => {
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Nexus Forge");
    expect(response.body).toContain("No episodes yet");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });
});
