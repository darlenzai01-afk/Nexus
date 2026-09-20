import type { AppConfig } from "@nexus/config";

export type WorkerLogger = (message: string, data?: Record<string, unknown>) => void;

export interface WorkerOptions {
  readonly logger?: WorkerLogger;
  /** Override the heartbeat interval (ms); defaults to config.workerHeartbeatMs. */
  readonly heartbeatMs?: number;
}

export interface Worker {
  readonly running: boolean;
  start(): void;
  stop(): void;
}

const defaultLogger: WorkerLogger = (message, data) => {
  // Minimal structured stdout logging until a real logger/job system lands (AD-05).
  console.log(JSON.stringify({ level: "info", message, ...data }));
};

/**
 * Create the pipeline worker.
 *
 * Foundation phase scope: a start/stop lifecycle with a heartbeat, proving
 * the "worker" entrypoint of the two-entrypoint deployment shape (AD-01).
 * The DB-backed job state machine (job claiming, leases, step execution)
 * is explicitly NOT implemented yet — it arrives with the orchestrator
 * phase, and this module is where it will plug in.
 */
export function createWorker(config: AppConfig, options: WorkerOptions = {}): Worker {
  const log = options.logger ?? defaultLogger;
  const heartbeatMs = options.heartbeatMs ?? config.workerHeartbeatMs;

  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      log("worker started", { env: config.env, heartbeatMs });
      timer = setInterval(() => {
        log("worker heartbeat", { pid: process.pid });
      }, heartbeatMs);
      // Do not keep the event loop alive solely for the heartbeat.
      timer.unref?.();
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      log("worker stopped");
    },
  };
}
