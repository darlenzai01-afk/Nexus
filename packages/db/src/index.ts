import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "./schema.js";

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * Thin synchronous SQLite wrapper (AD-04: SQLite is the system of record;
 * single writer, WAL mode, zero infrastructure). All persistence goes
 * through this class so a future driver swap touches one file.
 *
 * Note: node:sqlite is experimental in Node 22 — tracked as ENV-4 in
 * docs/plans/ISSUES.md.
 */
export class Db {
  private constructor(private readonly handle: DatabaseSync) {}

  static open(file: string): Db {
    if (file !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    const handle = new DatabaseSync(file);
    const db = new Db(handle);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
    return db;
  }

  static memory(): Db {
    return Db.open(":memory:");
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  run(sql: string, params: readonly SqlParam[] = []): RunResult {
    return this.handle.prepare(sql).run(...params) as RunResult;
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): T | undefined {
    return this.handle.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): T[] {
    return this.handle.prepare(sql).all(...params) as T[];
  }

  /** Run fn inside an immediate transaction; rethrows after rollback. */
  transaction<T>(fn: () => T): T {
    this.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.exec("ROLLBACK;");
      } catch {
        // Rollback can fail if the transaction already aborted; ignore.
      }
      throw error;
    }
  }

  close(): void {
    this.handle.close();
  }
}

/** Raised when an already-applied migration's SQL no longer matches its stored hash. */
export class MigrationDriftError extends Error {
  constructor(readonly migrationId: string) {
    super(
      `Migration '${migrationId}' was edited after being applied. ` +
        "Migrations are append-only and immutable — add a NEW migration instead. " +
        "(Refusing to run: this guard prevents silent destructive schema drift.)",
    );
    this.name = "MigrationDriftError";
  }
}

export function migrationHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Apply pending migrations in a transaction. Idempotent and non-destructive:
 * - applied migrations are verified against their stored sql_hash; any edit
 *   to an applied migration throws MigrationDriftError instead of running,
 * - existing data is never touched (no DROP/reset paths exist here).
 * Returns the ids of newly applied migrations.
 */
export function migrate(db: Db): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id         TEXT PRIMARY KEY,
       sql_hash   TEXT NOT NULL,
       applied_at TEXT NOT NULL
     );`,
  );

  const applied = new Map(
    db
      .all<{ id: string; sql_hash: string }>("SELECT id, sql_hash FROM _migrations;")
      .map((row) => [row.id, row.sql_hash]),
  );

  // Safety: detect edits to applied migrations BEFORE applying anything.
  for (const migration of MIGRATIONS) {
    const storedHash = applied.get(migration.id);
    if (storedHash !== undefined && storedHash !== migrationHash(migration.sql)) {
      throw new MigrationDriftError(migration.id);
    }
  }

  const now = new Date().toISOString();
  const newlyApplied: string[] = [];
  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      db.exec(migration.sql);
      db.run("INSERT INTO _migrations (id, sql_hash, applied_at) VALUES (?, ?, ?);", [
        migration.id,
        migrationHash(migration.sql),
        now,
      ]);
      newlyApplied.push(migration.id);
    }
  });
  return newlyApplied;
}

export { MIGRATIONS, EXPECTED_TABLES, type Migration } from "./schema.js";
export * from "./types.js";
export * from "./docs.js";
export * from "./repo.js";
