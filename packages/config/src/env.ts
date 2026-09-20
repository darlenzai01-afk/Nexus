import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

/**
 * Raw environment schema. Every variable is optional with a safe default so
 * the system boots with zero configuration; invalid values fail fast at
 * startup with an actionable message (never mid-pipeline).
 *
 * Secrets are intentionally NOT part of this schema yet: per AD-12,
 * provider credentials arrive with their adapters (later phases) and are
 * referenced by env-var *name* only — never stored in the DB or repo.
 */
export const envSchema = z.object({
  NEXUS_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXUS_HOST: z.string().min(1).default("127.0.0.1"),
  NEXUS_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  NEXUS_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NEXUS_DATA_DIR: z.string().min(1).default("data"),
  NEXUS_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100).default(30_000),
  // Provider selection (AD-06). "none" = fully offline; real adapter ids
  // (e.g. "fake", "manual", vendor ids) are registered in later phases.
  NEXUS_LLM_PROVIDER: z.string().min(1).default("none"),
  NEXUS_TTS_PROVIDER: z.string().min(1).default("none"),
});

/** The validated, normalized application configuration. */
export interface AppConfig {
  readonly env: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** Absolute path for persistent state (SQLite DB + artifact store, later phases). */
  readonly dataDir: string;
  readonly workerHeartbeatMs: number;
  readonly providers: {
    readonly llm: string;
    readonly tts: string;
  };
}

export interface LoadEnvOptions {
  /**
   * Explicit environment to validate. When omitted, `.env` is read from
   * `cwd` (if present) and merged under `process.env` — real environment
   * variables always win over file values.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directory to look for `.env` in and to resolve relative paths against. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** Thrown when environment validation fails; message lists every issue. */
export class EnvValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(issues: readonly z.ZodIssue[]) {
    const details = issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Load and validate configuration. Pure with respect to `options.env`
 * (no mutation of `process.env`), which keeps it trivially testable.
 */
export function loadEnv(options: LoadEnvOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();

  let raw: Readonly<Record<string, string | undefined>>;
  if (options.env !== undefined) {
    raw = options.env;
  } else {
    const envPath = path.join(cwd, ".env");
    const fromFile: Record<string, string> = existsSync(envPath)
      ? parseDotenv(readFileSync(envPath, "utf8"))
      : {};
    raw = { ...fromFile, ...process.env };
  }

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  const parsed = result.data;

  return {
    env: parsed.NEXUS_ENV,
    host: parsed.NEXUS_HOST,
    port: parsed.NEXUS_PORT,
    logLevel: parsed.NEXUS_LOG_LEVEL,
    dataDir: path.isAbsolute(parsed.NEXUS_DATA_DIR)
      ? parsed.NEXUS_DATA_DIR
      : path.resolve(cwd, parsed.NEXUS_DATA_DIR),
    workerHeartbeatMs: parsed.NEXUS_WORKER_HEARTBEAT_MS,
    providers: {
      llm: parsed.NEXUS_LLM_PROVIDER,
      tts: parsed.NEXUS_TTS_PROVIDER,
    },
  };
}
