import { loadEnv } from "@nexus/config";
import { migrate } from "@nexus/db";

import { withDashboardDefaults } from "./env-defaults.js";
import { createPipelineWorker } from "./worker.js";

/**
 * Executable entrypoint for the "worker" role — the pipeline step executor
 * (AD-01/AD-05).
 *
 * Registers every stage task of the dashboard pipeline (the domain engines'
 * own tasks plus this app's glue stages) and runs the orchestrator's claim
 * loop against the same data directory the dashboard host reads. Refuses to
 * start when a stage has no task: a worker that cannot execute a stage must
 * stop here, not strand a claimed job.
 *
 * Dev:  pnpm dev:worker   (tsx, runs from source)
 * Prod: pnpm start:worker (node dist/worker-entry.js, after pnpm build)
 */
async function main(): Promise<void> {
  const config = loadEnv({ env: withDashboardDefaults(process.env) });
  const pipeline = createPipelineWorker(config, {
    logger: (entry) => console.log(JSON.stringify(entry)),
  });
  migrate(pipeline.runtime.db);

  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ level: "info", message: "shutting down", signal }));
    void pipeline.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  pipeline.start();
  console.log(
    JSON.stringify({
      level: "info",
      message: "pipeline worker ready",
      stages: pipeline.registry.stageKeys(),
      pipeline: "longform_v1 (minus publish — uploading arrives in a later phase)",
      dataDir: config.dataDir,
    }),
  );
}

void main();
