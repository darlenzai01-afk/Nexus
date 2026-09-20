import { loadEnv } from "@nexus/config";
import { createWorker, type WorkerLogger } from "@nexus/app";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for the worker entrypoint's lifecycle: start → heartbeats
 * → stop, using fake timers. Proves the second entrypoint of the
 * two-entrypoint deployment shape (AD-01) is real and controllable.
 */
describe("nexus worker (integration)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts, emits heartbeats on schedule, and stops cleanly", () => {
    vi.useFakeTimers();

    const messages: string[] = [];
    const logger: WorkerLogger = (message) => messages.push(message);
    const config = loadEnv({ env: { NEXUS_ENV: "test", NEXUS_WORKER_HEARTBEAT_MS: "1000" } });
    const worker = createWorker(config, { logger });

    expect(worker.running).toBe(false);

    worker.start();
    expect(worker.running).toBe(true);
    expect(messages).toEqual(["worker started"]);

    vi.advanceTimersByTime(3000);
    expect(messages.filter((m) => m === "worker heartbeat")).toHaveLength(3);

    worker.stop();
    expect(worker.running).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(messages.filter((m) => m === "worker heartbeat")).toHaveLength(3);
    expect(messages.at(-1)).toBe("worker stopped");

    // Idempotent lifecycle guards.
    worker.stop();
    expect(messages.filter((m) => m === "worker stopped")).toHaveLength(1);
  });
});
