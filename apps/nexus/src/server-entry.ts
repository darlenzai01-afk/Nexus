import { loadEnv } from "@nexus/config";

import { buildApp } from "./app.js";

/**
 * Executable entrypoint for the "app" role (dashboard/API host — AD-01).
 * Dev:  pnpm dev          (tsx, runs from source)
 * Prod: pnpm start        (node dist/server-entry.js, after pnpm build)
 */
async function main(): Promise<void> {
  const config = loadEnv();
  const app = await buildApp(config, { logger: { level: config.logLevel } });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ error }, "failed to start");
    process.exit(1);
  }
}

void main();
