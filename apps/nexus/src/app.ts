import type { AppConfig } from "@nexus/config";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

/** Kept in sync with apps/nexus/package.json version by hand for now (0.0.0 = foundation phase). */
export const SERVICE_VERSION = "0.0.0";

export interface BuildAppOptions {
  /** Fastify logger options; disabled by default so tests stay quiet. */
  readonly logger?: FastifyServerOptions["logger"];
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "nexus";
  readonly role: "app";
  readonly env: AppConfig["env"];
  readonly version: string;
}

/**
 * Build the Fastify application (routes only — no listening).
 *
 * Foundation phase scope (docs/plans/000-architecture-discovery.md §20,
 * Phase 0/1): a health endpoint and a service info endpoint. The dashboard,
 * orchestrator API, and pipeline routes arrive in later phases.
 */
export async function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/healthz", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      service: "nexus",
      role: "app",
      env: config.env,
      version: SERVICE_VERSION,
    };
  });

  app.get("/", async () => {
    return {
      name: "Nexus Forge",
      phase: "foundation",
      role: "app",
      endpoints: ["/healthz"],
      docs: "docs/plans/000-architecture-discovery.md",
    };
  });

  return app;
}
