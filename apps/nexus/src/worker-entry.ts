import { loadEnv } from "@nexus/config";

import { createWorker } from "./worker.js";

/**
 * Executable entrypoint for the "worker" role (pipeline step executor —
 * AD-01/AD-05). Foundation phase: starts the heartbeat lifecycle and waits;
 * job claiming/execution arrives with the orchestrator phase.
 *
 * Dev:  pnpm dev:worker   (tsx, runs from source)
 * Prod: pnpm start:worker (node dist/worker-entry.js, after pnpm build)
 */
async function main(): Promise<void> {
  const config = loadEnv();
  const worker = createWorker(config);

  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ level: "info", message: "shutting down", signal }));
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  worker.start();
  console.log(
    JSON.stringify({
      level: "info",
      message:
        "worker ready (job system not yet implemented — see docs/plans/000-decisions.md AD-05)",
    }),
  );
}

void main();
