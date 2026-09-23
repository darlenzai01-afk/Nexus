import type { EpisodeState } from "@nexus/db";
import { describe, expect, it } from "vitest";

import { InvalidTransitionError } from "./errors.js";
import {
  JOB_TRANSITIONS,
  LONG_EPISODE_TRANSITIONS,
  SHORT_EPISODE_TRANSITIONS,
  STEP_TRANSITIONS,
  assertEpisodeTransition,
  assertJobTransition,
  assertStepTransition,
  canTransitionEpisode,
  canTransitionJob,
  canTransitionStep,
} from "./machines.js";
import {
  LONG_FORM_PIPELINE,
  SHORTS_PIPELINE,
  isStageInFlight,
  stageStateLabel,
  type StageProgress,
} from "./stages.js";

const LONG_CHAIN: EpisodeState[] = [
  "QUEUED",
  "RESEARCHING",
  "FACT_CHECKING",
  "SCRIPTING",
  "SCENE_PLANNING",
  "MEDIA_GATHERING",
  "VOICE_SYNTHESIS",
  "CAPTIONING",
  "COMPOSITING",
  "RENDERING",
  "QA",
  "APPROVAL",
  "READY",
  "PUBLISHING",
  "PUBLISHED",
];

const SHORT_CHAIN: EpisodeState[] = [
  "QUEUED",
  "SCENE_PLANNING",
  "SCRIPTING",
  "COMPOSITING",
  "RENDERING",
  "QA",
  "APPROVAL",
  "READY",
  "PUBLISHING",
  "PUBLISHED",
];

describe("episode state machine", () => {
  it("accepts the full long-form happy path, one step at a time", () => {
    for (let i = 0; i < LONG_CHAIN.length - 1; i++) {
      const from = LONG_CHAIN[i]!;
      const to = LONG_CHAIN[i + 1]!;
      expect(canTransitionEpisode("long", from, to), `${from} → ${to}`).toBe(true);
      expect(() => assertEpisodeTransition("long", from, to)).not.toThrow();
    }
  });

  it("accepts the short-form happy path (skipping research and voice)", () => {
    for (let i = 0; i < SHORT_CHAIN.length - 1; i++) {
      const from = SHORT_CHAIN[i]!;
      const to = SHORT_CHAIN[i + 1]!;
      expect(canTransitionEpisode("short", from, to), `${from} → ${to}`).toBe(true);
    }
  });

  it("rejects illegal jumps with an actionable message", () => {
    const illegal: [EpisodeState, EpisodeState][] = [
      ["QUEUED", "READY"],
      ["PUBLISHED", "RESEARCHING"],
      ["RESEARCHING", "PUBLISHED"],
      ["APPROVAL", "PUBLISHED"], // publishing without READY
      ["PUBLISHED", "PUBLISHING"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransitionEpisode("long", from, to), `${from} → ${to}`).toBe(false);
      expect(() => assertEpisodeTransition("long", from, to)).toThrow(InvalidTransitionError);
      expect(() => assertEpisodeTransition("long", from, to)).toThrow(
        new RegExp(`${from} → ${to}`),
      );
    }
  });

  it("keeps long-form-only states unreachable for shorts", () => {
    expect(canTransitionEpisode("short", "QUEUED", "RESEARCHING")).toBe(false);
    expect(canTransitionEpisode("short", "QUEUED", "VOICE_SYNTHESIS")).toBe(false);
    // …and the short-form entry point is not a long-form entry point.
    expect(canTransitionEpisode("short", "QUEUED", "SCENE_PLANNING")).toBe(true);
    expect(LONG_EPISODE_TRANSITIONS.QUEUED).not.toContain("SCENE_PLANNING");
    expect(SHORT_EPISODE_TRANSITIONS.QUEUED).not.toContain("RESEARCHING");
  });

  it("treats PUBLISHED as terminal and keeps FAILED/CANCELED recoverable", () => {
    expect(LONG_EPISODE_TRANSITIONS.PUBLISHED).toEqual([]);
    expect(SHORT_EPISODE_TRANSITIONS.PUBLISHED).toEqual([]);
    expect(canTransitionEpisode("long", "FAILED", "SCRIPTING")).toBe(true);
    expect(canTransitionEpisode("long", "CANCELED", "QUEUED")).toBe(true);
    expect(canTransitionEpisode("long", "CANCELED", "PUBLISHING")).toBe(false);
  });

  it("round-trips NEEDS_CHANGES back to the responsible stage", () => {
    for (const target of ["SCRIPTING", "VOICE_SYNTHESIS", "RENDERING"] as const) {
      expect(canTransitionEpisode("long", "NEEDS_CHANGES", target)).toBe(true);
    }
  });

  it("allows a no-op transition (same state) for idempotent writes", () => {
    expect(canTransitionEpisode("long", "SCRIPTING", "SCRIPTING")).toBe(true);
    expect(canTransitionJob("RUNNING", "RUNNING")).toBe(true);
  });
});

describe("job state machine", () => {
  it("accepts claim, retry, gate and terminal paths", () => {
    expect(canTransitionJob("PENDING", "RUNNING")).toBe(true);
    expect(canTransitionJob("RUNNING", "PENDING")).toBe(true); // retry / requeue
    expect(canTransitionJob("RUNNING", "WAITING_GATE")).toBe(true);
    expect(canTransitionJob("WAITING_GATE", "PENDING")).toBe(true); // operator resolved
    expect(canTransitionJob("RUNNING", "DONE")).toBe(true);
    expect(canTransitionJob("RUNNING", "FAILED")).toBe(true);
    expect(canTransitionJob("FAILED", "PENDING")).toBe(true); // operator retry
    // Anything that is not finished can still be canceled; DONE is terminal.
    for (const state of ["PENDING", "RUNNING", "WAITING_GATE", "FAILED"] as const) {
      expect(() => assertJobTransition(state, "CANCELED")).not.toThrow();
    }
    expect(canTransitionJob("DONE", "CANCELED")).toBe(false);
  });

  it("rejects impossible job transitions", () => {
    const illegal = [
      ["PENDING", "DONE"],
      ["PENDING", "WAITING_GATE"],
      ["DONE", "RUNNING"],
      ["DONE", "PENDING"],
      ["CANCELED", "RUNNING"],
    ] as const;
    for (const [from, to] of illegal) {
      expect(canTransitionJob(from, to), `${from} → ${to}`).toBe(false);
      expect(() => assertJobTransition(from, to)).toThrow(InvalidTransitionError);
    }
    expect(JOB_TRANSITIONS.DONE).toEqual([]);
    expect(JOB_TRANSITIONS.CANCELED).toEqual([]);
  });
});

describe("stage state machine", () => {
  it("allows start, adopt, park, fail, retry and invalidation — nothing else", () => {
    expect(canTransitionStep("PENDING", "PENDING")).toBe(true); // start / crash reclaim
    expect(canTransitionStep("PENDING", "DONE")).toBe(true); // reused artifact
    expect(canTransitionStep("PENDING", "WAITING")).toBe(true); // gated stage
    expect(canTransitionStep("PENDING", "FAILED")).toBe(true);
    expect(canTransitionStep("WAITING", "DONE")).toBe(true); // gate approved
    expect(canTransitionStep("WAITING", "PENDING")).toBe(true); // gate rewound
    expect(canTransitionStep("FAILED", "PENDING")).toBe(true); // retry
    expect(canTransitionStep("FAILED", "DONE")).toBe(true); // adopt a good artifact
    expect(canTransitionStep("DONE", "PENDING")).toBe(true); // invalidation

    expect(canTransitionStep("DONE", "FAILED")).toBe(false);
    expect(canTransitionStep("DONE", "WAITING")).toBe(false);
    expect(() => assertStepTransition("DONE", "FAILED")).toThrow(InvalidTransitionError);
    expect(() => assertStepTransition("WAITING", "WAITING")).not.toThrow();
    expect(STEP_TRANSITIONS.DONE).toEqual(["PENDING"]);
  });

  it("models 'in flight' as derived state, not a stored one", () => {
    // A step is running exactly when its job runs and the step was started.
    const inFlight = { state: "PENDING", started: true, jobState: "RUNNING" } as const;
    const crashed = { state: "PENDING", started: true, jobState: "FAILED" } as const;
    const untouched = { state: "PENDING", started: false, jobState: "RUNNING" } as const;
    expect(isStageInFlight(inFlight)).toBe(true);
    expect(isStageInFlight(crashed)).toBe(false);
    expect(isStageInFlight(untouched)).toBe(false);
  });
});

describe("stage graph ⇄ state machine consistency", () => {
  it("every declared stage transition is legal in its episode machine", () => {
    for (const [pipeline, kind] of [
      [LONG_FORM_PIPELINE, "long"],
      [SHORTS_PIPELINE, "short"],
    ] as const) {
      for (const [index, stage] of pipeline.stages.entries()) {
        expect(
          canTransitionEpisode(kind, stage.episodeStateOnStart, stage.episodeStateOnComplete),
          `${pipeline.id}:${stage.key} ${stage.episodeStateOnStart} → ${stage.episodeStateOnComplete}`,
        ).toBe(true);

        const next = pipeline.stages[index + 1];
        if (next) {
          expect(
            canTransitionEpisode(kind, stage.episodeStateOnComplete, next.episodeStateOnStart),
            `${pipeline.id}: ${stage.key} → ${next.key} handoff ` +
              `(${stage.episodeStateOnComplete} → ${next.episodeStateOnStart})`,
          ).toBe(true);
        }
      }
    }
  });

  it("the long-form graph ends in PUBLISHED and the shorts graph in PUBLISHED", () => {
    expect(LONG_FORM_PIPELINE.stages.at(-1)?.episodeStateOnComplete).toBe("PUBLISHED");
    expect(SHORTS_PIPELINE.stages.at(-1)?.episodeStateOnComplete).toBe("PUBLISHED");
  });

  it("renders the operator vocabulary requested for each stage", () => {
    const label = (
      pipeline: typeof LONG_FORM_PIPELINE,
      key: string,
      state: "RUNNING" | "DONE" | "WAITING" | "FAILED",
    ): string => {
      const stage = pipeline.stages.find((s) => s.key === key)!;
      const progress: StageProgress = {
        state: state === "RUNNING" ? "PENDING" : state,
        started: state === "RUNNING",
        jobState: state === "RUNNING" ? "RUNNING" : "DONE",
      };
      return stageStateLabel(stage, progress);
    };
    expect(label(LONG_FORM_PIPELINE, "research", "RUNNING")).toBe("RESEARCHING");
    expect(label(LONG_FORM_PIPELINE, "research", "DONE")).toBe("RESEARCH_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "script", "RUNNING")).toBe("SCRIPTING");
    expect(label(LONG_FORM_PIPELINE, "script", "DONE")).toBe("SCRIPT_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "plan", "DONE")).toBe("PLAN_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "source_media", "RUNNING")).toBe("SOURCING_MEDIA");
    expect(label(LONG_FORM_PIPELINE, "source_media", "DONE")).toBe("MEDIA_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "voice", "RUNNING")).toBe("GENERATING_VOICE");
    expect(label(LONG_FORM_PIPELINE, "voice", "DONE")).toBe("VOICE_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "animate", "RUNNING")).toBe("BUILDING_ANIMATION");
    expect(label(LONG_FORM_PIPELINE, "animate", "DONE")).toBe("ANIMATION_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "render", "DONE")).toBe("RENDER_COMPLETE");
    expect(label(LONG_FORM_PIPELINE, "approval", "WAITING")).toBe("AWAITING_APPROVAL");
    expect(label(LONG_FORM_PIPELINE, "approval", "DONE")).toBe("APPROVED");
    expect(label(LONG_FORM_PIPELINE, "publish", "RUNNING")).toBe("PUBLISHING");
    expect(label(LONG_FORM_PIPELINE, "publish", "DONE")).toBe("PUBLISHED");
    expect(label(SHORTS_PIPELINE, "short_analyze", "RUNNING")).toBe("SHORT_ANALYZING");
    expect(label(SHORTS_PIPELINE, "short_analyze", "DONE")).toBe("CANDIDATES_FOUND");
    expect(label(SHORTS_PIPELINE, "short_select", "RUNNING")).toBe("SELECTING");
    expect(label(SHORTS_PIPELINE, "short_rewrite", "RUNNING")).toBe("REWRITING");
    expect(label(SHORTS_PIPELINE, "short_layout", "RUNNING")).toBe("VERTICAL_LAYOUT");
    expect(label(SHORTS_PIPELINE, "short_analyze", "FAILED")).toBe("SHORT_ANALYZING_FAILED");
  });

  it("declares a gate only where an operator decision is required", () => {
    expect(LONG_FORM_PIPELINE.stages.filter((s) => s.gate).map((s) => s.gate)).toEqual([
      "FINAL_APPROVAL",
    ]);
    expect(SHORTS_PIPELINE.stages.filter((s) => s.gate).map((s) => s.gate)).toEqual([
      "SHORT_APPROVAL",
    ]);
  });
});
