import { loadEnv } from "@nexus/config";
import { buildApp, SERVICE_VERSION } from "@nexus/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type App = Awaited<ReturnType<typeof buildApp>>;

/**
 * Integration test: boots the real app (in-memory via Fastify's inject, no
 * port binding) with a real validated config, proving the workspace wiring
 * (config package → app package → test harness) works end to end.
 */
describe("nexus app (integration)", () => {
  let app: App;

  beforeAll(async () => {
    const config = loadEnv({ env: { NEXUS_ENV: "test", NEXUS_LOG_LEVEL: "silent" } });
    app = await buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /healthz reports a healthy app with its environment and version", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "nexus",
      role: "app",
      env: "test",
      version: SERVICE_VERSION,
    });
  });

  it("GET / describes the service and current phase", async () => {
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; phase: string; endpoints: string[] };
    expect(body.name).toBe("Nexus Forge");
    expect(body.phase).toBe("foundation");
    expect(body.endpoints).toContain("/healthz");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });
});
