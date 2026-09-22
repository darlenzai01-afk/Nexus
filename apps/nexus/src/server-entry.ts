import { loadEnv } from "@nexus/config";
import { migrate } from "@nexus/db";

import { buildApp } from "./app.js";
import { withDashboardDefaults } from "./env-defaults.js";
import { openRuntime } from "./runtime.js";

/**
 * Executable entrypoint for the "app" role — the dashboard/API host (AD-01).
 *
 * Opens the runtime (SQLite + CAS + provider container under NEXUS_DATA_DIR),
 * builds the dashboard routes and listens. The pipeline itself runs in the
 * worker process (`pnpm dev:worker` / `start:worker`); this process only
 * creates jobs and records gate decisions, so it stays responsive while the
 * worker renders.
 *
 * Dev:  pnpm dev          (tsx, runs from source)
 * Prod: pnpm start        (node dist/server-entry.js, after pnpm build)
 */
async function main(): Promise<void> {
  const config = loadEnv({ env: withDashboardDefaults(process.env) });
  const runtime = openRuntime(config);
  migrate(runtime.db);

  const app = await buildApp(
    config,
    { repo: runtime.repo, storage: runtime.storage },
    {
      logger: { level: config.logLevel === "silent" ? "silent" : config.logLevel },
    },
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      `dashboard ready on http://${config.host}:${config.port} (data: ${config.dataDir})`,
    );
  } catch (error) {
    app.log.error({ error }, "failed to start");
    process.exit(1);
  }
}

void main();
