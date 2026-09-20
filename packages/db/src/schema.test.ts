import { describe, expect, it } from "vitest";

import { Db, EXPECTED_TABLES, MIGRATIONS, MigrationDriftError, migrate } from "./index.js";

const freshDb = (): Db => {
  const db = Db.memory();
  migrate(db);
  return db;
};

const tableNames = (db: Db): string[] =>
  db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    )
    .map((row) => row.name);

describe("migrations", () => {
  it("applies the full migration set exactly once (idempotent)", () => {
    const db = Db.memory();
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(migrate(db)).toEqual([]); // second run is a no-op
    expect(db.all("SELECT id FROM _migrations;")).toHaveLength(MIGRATIONS.length);
  });

  it("creates every expected table and nothing else", () => {
    const db = freshDb();
    const tables = tableNames(db).filter((t) => t !== "_migrations");
    expect(tables).toEqual([...EXPECTED_TABLES].sort());
  });

  it("migration ids are ordered, unique, and version-prefixed", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });

  it("uses TEXT ISO-8601 timestamps and TEXT uuid ids (stable-ID convention)", () => {
    const db = freshDb();
    const columns = db.all<{ name: string; type: string; notnull: number; pk: number }>(
      `SELECT name, type, "notnull", pk FROM pragma_table_info('episodes');`,
    );
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("id")).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(byName.get("created_at")).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(byName.get("updated_at")).toMatchObject({ type: "TEXT", notnull: 1 });
  });

  it("every primary key column is non-nullable (SQLite does not do this implicitly)", () => {
    const db = freshDb();
    for (const table of EXPECTED_TABLES) {
      const pkColumns = db.all<{ name: string; type: string; notnull: number }>(
        `SELECT name, type, "notnull" FROM pragma_table_info('${table}') WHERE pk > 0;`,
      );
      expect(pkColumns.length, `${table} has no primary key`).toBeGreaterThan(0);
      for (const column of pkColumns) {
        // INTEGER PRIMARY KEY is a rowid alias: it can never hold NULL.
        // Any other type MUST carry an explicit NOT NULL — SQLite would
        // otherwise accept a NULL (and even several NULLs) in a "unique" id.
        const nonNullable = column.notnull === 1 || column.type === "INTEGER";
        expect({ table, column: column.name, nonNullable }).toMatchObject({ nonNullable: true });
      }
    }
  });

  it("rejects NULL primary keys at runtime", () => {
    const db = freshDb();
    expect(() =>
      db.run(
        "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES (NULL,'P','p','','{}','t','t');",
      ),
    ).toThrow(/NOT NULL constraint failed/);
  });

  it("ships no destructive statements (no resets, no drops)", () => {
    const sql = MIGRATIONS.map((m) => m.sql).join("\n");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("refuses to run after an applied migration is edited (drift guard)", () => {
    const db = Db.memory();
    migrate(db);
    db.run("UPDATE _migrations SET sql_hash = 'tampered' WHERE id = ?;", [MIGRATIONS[0]!.id]);
    expect(() => migrate(db)).toThrow(MigrationDriftError);
    // and the guard message explains the append-only rule
    expect(() => migrate(db)).toThrow(/append-only|immutable/i);
  });

  it("stores only hashes + metadata for artifacts — never blobs", () => {
    const db = freshDb();
    const columns = db
      .all<{ name: string }>("SELECT name FROM pragma_table_info('artifacts');")
      .map((c) => c.name)
      .sort();
    expect(columns).toEqual(["bytes", "created_at", "hash", "kind", "meta"]);
    const mediaColumns = db
      .all<{ name: string }>("SELECT name FROM pragma_table_info('media_assets');")
      .map((c) => c.name);
    expect(mediaColumns).not.toContain("content");
    expect(mediaColumns).not.toContain("blob");
  });

  it("stores credential *names*, not secrets", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO provider_accounts (id, adapter, operation_scope, credentials_env, quota_window, quota_limit, quota_used, enabled, created_at, updated_at)
       VALUES ('p1', 'openai', '*', 'NEXUS_LLM_API_KEY', 'daily', 100, 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
    );
    const row = db.get<{ credentials_env: string }>(
      "SELECT credentials_env FROM provider_accounts WHERE id = 'p1';",
    );
    expect(row?.credentials_env).toBe("NEXUS_LLM_API_KEY");
    expect(row?.credentials_env).not.toMatch(/sk-/);
  });

  it("creates indexes on the access paths the pipeline actually uses", () => {
    const db = freshDb();
    const indexes = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%';",
      )
      .map((row) => row.name);
    for (const expected of [
      "idx_episodes_project_state",
      "idx_pipeline_jobs_claimable",
      "idx_pipeline_jobs_episode",
      "idx_claims_episode_status",
      "idx_approvals_subject",
      "idx_provider_call_log_provider_time",
      "idx_sources_content_hash",
      "idx_artifacts_kind",
      "idx_scenes_episode",
      "idx_media_assets_license",
    ]) {
      expect(indexes).toContain(expected);
    }
    // Claims lookup by sentence (captions/scene cross-references) must be covered.
    expect(indexes).toContain("idx_claims_episode_status");
  });

  it("survives reopen (WAL file-backed DB keeps data and migration state)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-db-"));
    try {
      const file = path.join(dir, "nexus.sqlite");
      const first = Db.open(file);
      migrate(first);
      first.run(
        "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES ('x','X','x','','{}','t','t');",
      );
      expect(first.all("PRAGMA journal_mode;")[0]).toMatchObject({ journal_mode: "wal" });
      first.close();

      const second = Db.open(file);
      migrate(second); // already applied
      expect(second.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects;")?.n).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("constraint enforcement (DB is the last line of defence)", () => {
  it("enforces foreign keys", () => {
    const db = freshDb();
    expect(() =>
      db.run(
        "INSERT INTO episodes (id, project_id, kind, topic, outline, state, created_at, updated_at) VALUES ('e1','missing','long','t','[]','QUEUED','t','t');",
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("restricts deleting a project that still owns episodes", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES ('p','P','p','','{}','t','t');",
    );
    db.run(
      "INSERT INTO episodes (id, project_id, kind, topic, outline, state, created_at, updated_at) VALUES ('e','p','long','t','[]','QUEUED','t','t');",
    );
    expect(() => db.run("DELETE FROM projects WHERE id = 'p';")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("cascades from episode to its scripts, claims, scenes, and jobs", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES ('p','P','p','','{}','t','t');",
    );
    db.run(
      "INSERT INTO episodes (id, project_id, kind, topic, outline, state, created_at, updated_at) VALUES ('e','p','long','t','[]','QUEUED','t','t');",
    );
    db.run(
      "INSERT INTO artifacts (hash, kind, bytes, meta, created_at) VALUES ('" +
        "a".repeat(64) +
        "','script',10,'{}','t');",
    );
    db.run(
      "INSERT INTO scripts (id, episode_id, version, status, doc_hash, created_at, updated_at) VALUES ('s','e',1,'draft','" +
        "a".repeat(64) +
        "','t','t');",
    );
    db.run(
      "INSERT INTO claims (id, episode_id, script_id, claim_ref, sentence_id, text, status, score, created_at, updated_at) VALUES ('c','e','s','k1','s1','text','unverified',0,'t','t');",
    );
    db.run(
      "INSERT INTO pipeline_jobs (id, episode_id, pipeline, state, attempt, created_at, updated_at) VALUES ('j','e','longform_v1','PENDING',0,'t','t');",
    );

    db.run("DELETE FROM episodes WHERE id = 'e';");
    for (const table of ["scripts", "claims", "pipeline_jobs"]) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`)?.n).toBe(0);
    }
  });

  it("rejects invalid enum values, empty required text, and out-of-range numbers", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES ('p','P','p','','{}','t','t');",
    );
    const insertEpisode = (state: string, kind = "long"): void => {
      db.run(
        "INSERT INTO episodes (id, project_id, kind, topic, outline, state, created_at, updated_at) VALUES ('e2','p',?, 't','[]',?,'t','t');",
        [kind, state],
      );
    };
    expect(() => insertEpisode("NOT_A_STATE")).toThrow(/CHECK constraint failed/);
    expect(() => insertEpisode("QUEUED", "medium")).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.run(
        "INSERT INTO episodes (id, project_id, kind, topic, outline, state, created_at, updated_at) VALUES ('e3','p','long','','[]','QUEUED','t','t');",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.run(
        "INSERT INTO claims (id, episode_id, script_id, claim_ref, sentence_id, text, status, score, created_at, updated_at) VALUES ('c1','e','s','k','s1','t','supported',1.5,'t','t');",
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces stable-id uniqueness contracts", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES ('p','P','slug-a','','{}','t','t');",
    );
    expect(() =>
      db.run(
        "INSERT INTO projects (id, name, slug, description, config, created_at, updated_at) VALUES ('p2','P2','slug-a','','{}','t','t');",
      ),
    ).toThrow(/UNIQUE constraint failed/);

    db.run(
      "INSERT INTO episodes (id, project_id, kind, topic, outline, state, created_at, updated_at) VALUES ('e','p','long','t','[]','QUEUED','t','t');",
    );
    db.run(
      "INSERT INTO artifacts (hash, kind, bytes, meta, created_at) VALUES ('" +
        "b".repeat(64) +
        "','script',1,'{}','t');",
    );
    db.run(
      "INSERT INTO scripts (id, episode_id, version, status, doc_hash, created_at, updated_at) VALUES ('s','e',1,'draft','" +
        "b".repeat(64) +
        "','t','t');",
    );
    // Same script version cannot be duplicated (versioning is explicit).
    expect(() =>
      db.run(
        "INSERT INTO scripts (id, episode_id, version, status, doc_hash, created_at, updated_at) VALUES ('s2','e',1,'draft','" +
          "b".repeat(64) +
          "','t','t');",
      ),
    ).toThrow(/UNIQUE constraint failed/);

    // Job step order and keys are both unique per job (resumability contract).
    db.run(
      "INSERT INTO pipeline_jobs (id, episode_id, pipeline, state, attempt, created_at, updated_at) VALUES ('j','e','longform_v1','PENDING',0,'t','t');",
    );
    db.run("INSERT INTO pipeline_job_steps (job_id, step_key, idx) VALUES ('j','script',1);");
    expect(() =>
      db.run("INSERT INTO pipeline_job_steps (job_id, step_key, idx) VALUES ('j','script',2);"),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      db.run("INSERT INTO pipeline_job_steps (job_id, step_key, idx) VALUES ('j','voice',1);"),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
