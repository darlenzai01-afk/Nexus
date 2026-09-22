import { CharacterLibrary } from "@nexus/characters";
import type { AppConfig } from "@nexus/config";
import { Repo } from "@nexus/db";
import {
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  findFont,
  loadFontFile,
  type FFmpegRunner,
  type FontSet,
} from "@nexus/video";
import { createCaptionsTask, createVoiceTask } from "@nexus/audio";
import {
  consoleLogger,
  createTaskRegistry,
  Worker as JobWorker,
  type Logger,
  type TaskRegistry,
} from "@nexus/jobs";
import { createQATask, resolveQASettings } from "@nexus/qa";
import { createResearchTask } from "@nexus/research";
import { createScenePlanTask } from "@nexus/scenes";
import { createScriptTask } from "@nexus/script";
import type { CasStore } from "@nexus/storage";
import { createRenderTask } from "@nexus/video";
import { existsSync } from "node:fs";

import {
  DASHBOARD_PIPELINE,
  createAnimateTask,
  createApprovalTask,
  createFactCheckTask,
  createIdeaTask,
  createPublishTask,
  createSourceMediaTask,
  fingerprintParams,
} from "./pipeline.js";
import { openRuntime, type Runtime } from "./runtime.js";

/**
 * The pipeline worker: every stage task of the dashboard pipeline, registered
 * and fail-fast.
 *
 * This is the wiring GAP-9 deferred until real tasks existed: the entrypoint
 * opens the runtime (SQLite + CAS + providers), builds the task registry from
 * the domain engines plus this app's glue tasks, refuses to start unless the
 * registry covers every stage a dashboard job can declare, and then runs the
 * orchestrator's claim loop. A worker that cannot execute a stage stops here,
 * at startup — never mid-job.
 */
export interface PipelineWorkerOptions {
  /** A pre-opened runtime (tests); defaults to `openRuntime(config)`. */
  readonly runtime?: Runtime;
  /** Idle poll interval; short so the dashboard feels live. */
  readonly pollIntervalMs?: number;
  /** Lease length; long stages are heartbeated at a third of it. */
  readonly leaseMs?: number;
  readonly logger?: Logger;
  /**
   * An FFmpeg runner for the render stage; production locates the configured
   * binary, tests inject the scripted one. Same seam as `RenderTaskDeps.ffmpeg`.
   */
  readonly ffmpeg?: FFmpegRunner;
}

export interface PipelineWorker {
  readonly worker: JobWorker;
  readonly registry: TaskRegistry;
  readonly runtime: Runtime;
  start(): void;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export function createPipelineWorker(
  config: AppConfig,
  options: PipelineWorkerOptions = {},
): PipelineWorker {
  const runtime = options.runtime ?? openRuntime(config);
  const { repo, storage, providers } = runtime;

  const llm = providers.llm();
  const research = providers.research();
  const tts = providers.tts();
  const characters = CharacterLibrary.load();
  const fonts = qaFontSet();

  const registry = createTaskRegistry([
    createIdeaTask(),
    createResearchTask({ llm, research, storage, repo }),
    createFactCheckTask({ storage }),
    createScriptTask({ llm, storage, repo }),
    createScenePlanTask({
      storage,
      repo,
      options: {
        fps: config.render.fps,
        cast: characters,
      },
    }),
    createSourceMediaTask({ storage, repo }),
    createAnimateTask(),
    createVoiceTask({
      tts,
      storage,
      repo,
      defaults: {
        ...(config.audio.voice !== "" ? { voiceId: config.audio.voice } : {}),
        format: config.audio.format,
        sampleRate: config.audio.sampleRate,
        rate: config.audio.rate,
      },
    }),
    createCaptionsTask({ storage, repo }),
    createRenderTask({
      storage,
      repo,
      config: config.render,
      ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
    }),
    createQATask({
      storage,
      repo,
      characters,
      ...(fonts !== undefined ? { fonts } : {}),
      settings: resolveQASettings(config.qa),
    }),
    createApprovalTask(),
    // Publishing is a real stage of longform_v1/shorts_v1 — an operator starts
    // it explicitly from the episode page after a run completes. The task
    // itself re-checks the QA verdict and the approval decision before any
    // bytes move (see createPublishTask).
    createPublishTask({ storage, repo, publisher: providers.publishing() }),
    createPublishTask({
      storage,
      repo,
      publisher: providers.publishing(),
      stageKey: "short_publish",
    }),
  ]);
  // A dashboard job declares exactly this step list; anything the registry
  // cannot execute must fail here, not after a job is claimed.
  registry.assertCovers(DASHBOARD_PIPELINE);

  const worker = new JobWorker({
    repo,
    tasks: registry,
    artifactExists: (hash) => storage.has(hash),
    params: fingerprintParams(config),
    leaseMs: options.leaseMs ?? 5 * 60_000,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    logger: options.logger ?? consoleLogger,
  });

  return {
    worker,
    registry,
    runtime,
    start: () => worker.start(),
    stop: (stopOptions) => worker.stop(stopOptions),
  };
}

/**
 * The faces the QA readability rules measure with — the same candidates the
 * render pipeline draws with. Without any installed face the visual checks
 * report readability as unchecked rather than guessing.
 */
export function qaFontSet(): FontSet | undefined {
  const regular = findFont(DEFAULT_FONT_CANDIDATES);
  if (regular === undefined || !existsSync(regular)) return undefined;
  const bold = findFont(DEFAULT_BOLD_FONT_CANDIDATES);
  try {
    return bold !== undefined && existsSync(bold)
      ? { regular: loadFontFile(regular), bold: loadFontFile(bold) }
      : { regular: loadFontFile(regular) };
  } catch {
    return undefined;
  }
}

/** Re-exported so the entrypoints share one idea of the repo/runtime types. */
export type { Repo, CasStore };
