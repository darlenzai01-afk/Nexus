/**
 * Worker-side structured logging. This is *operational* logging (stdout), the
 * counterpart of the durable per-job log in `job_logs`: the job log answers
 * "what happened to this episode?", the process log answers "what is this
 * worker doing right now?".
 */
export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly [key: string]: unknown;
}

export type Logger = (entry: LogEntry) => void;

export const consoleLogger: Logger = (entry) => {
  const { level, event, ...rest } = entry;
  const line = JSON.stringify({ level, event, ...rest });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const silentLogger: Logger = () => {};

export const noopLogger: Logger = silentLogger;
