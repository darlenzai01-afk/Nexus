import { ConfigurationError } from "./errors.js";
import type { PipelineDef } from "./stages.js";
import type { Task, TaskRegistry } from "./types.js";

class MapTaskRegistry implements TaskRegistry {
  readonly #tasks = new Map<string, Task>();

  register(task: Task): TaskRegistry {
    if (!task.stageKey?.trim()) throw new ConfigurationError("Task.stageKey is required");
    if (this.#tasks.has(task.stageKey)) {
      throw new ConfigurationError(`A task is already registered for stage '${task.stageKey}'`);
    }
    this.#tasks.set(task.stageKey, task);
    return this;
  }

  get(stageKey: string): Task | undefined {
    return this.#tasks.get(stageKey);
  }

  has(stageKey: string): boolean {
    return this.#tasks.has(stageKey);
  }

  stageKeys(): string[] {
    return [...this.#tasks.keys()].sort();
  }

  assertCovers(pipeline: PipelineDef): void {
    const missing = pipeline.stages
      .filter((stage) => !this.#tasks.has(stage.key))
      .map((s) => s.key);
    if (missing.length > 0) {
      throw new ConfigurationError(
        `No task registered for ${pipeline.id} stage(s): ${missing.join(", ")}. ` +
          "Register every stage before a worker claims jobs for this pipeline.",
      );
    }
  }
}

export function createTaskRegistry(tasks: readonly Task[] = []): TaskRegistry {
  const registry = new MapTaskRegistry();
  for (const task of tasks) registry.register(task);
  return registry;
}
