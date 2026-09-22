import { mkdirSync } from "node:fs";
import path from "node:path";

import type { AppConfig } from "@nexus/config";
import { Db, Repo } from "@nexus/db";
import { createProviders, type Providers } from "@nexus/providers";
import { offlineResponder } from "./offline-llm.js";
import { CasStore } from "@nexus/storage";

/**
 * The composition root: one process, one runtime.
 *
 * Both entrypoints (dashboard host and pipeline worker) open the same two
 * durable things — the SQLite database and the content-addressed store — under
 * `NEXUS_DATA_DIR`, and build the provider container from the validated
 * configuration. SQLite runs in WAL mode with a busy timeout and every write
 * is short, so a server that only reads and a worker that only executes share
 * the files safely; artifact *bytes* never enter the DB (AD-09).
 *
 * Tests call `openRuntime` with a config whose `dataDir` points at a temp
 * directory (or swap `db`/`storage` for in-memory doubles via the field
 * overrides each entrypoint accepts).
 */
export interface Runtime {
  readonly config: AppConfig;
  readonly db: Db;
  readonly repo: Repo;
  readonly storage: CasStore;
  readonly providers: Providers;
}

export function openRuntime(
  config: AppConfig,
  options: { readonly db?: Db; readonly storage?: CasStore } = {},
): Runtime {
  const db = options.db ?? openDatabase(config.dataDir);
  const storage = options.storage ?? new CasStore(path.join(config.dataDir, "cas"));
  const repo = new Repo(db);
  const providers = createProviders({
    config,
    storage,
    repo,
    // With the fake LLM selected, answer coherently so the offline demo walk
    // produces verifiable evidence and a writable script instead of parking.
    ...(config.providers.llm === "fake" ? { fakeLLMRespond: offlineResponder() } : {}),
  });
  return { config, db, repo, storage, providers };
}

function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  return Db.open(path.join(dataDir, "nexus.db"));
}
