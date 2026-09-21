import { Sha256Schema } from "@nexus/db";
import { systemClock, type Clock } from "@nexus/providers";
import {
  normalizeWhitespace,
  quotedSpans,
  wordCount,
  type ScriptClaimEntry,
  type ScriptDoc,
  type ScriptSentence,
} from "@nexus/script";

import {
  SCENE_ENGINE,
  SceneManifestSchema,
  type Scene,
  type SceneAnimationEvent,
  type SceneAspect,
  type SceneAsset,
  type SceneCamera,
  type SceneCastMember,
  type SceneClaimRef,
  type SceneDiagram,
  type SceneManifest,
  type SceneMedia,
  type ScenePlanningStep,
  type SceneResolution,
  type SceneStepTrace,
  type SceneText,
  type SceneType,
} from "./schema.js";
import { CAMERA_MOVEMENT_CYCLE, PRESENTER_SHOT_CYCLE, SCENE_TYPE_SPECS } from "./scene-types.js";
import {
  DEFAULT_WORDS_PER_SECOND,
  fromDeciseconds,
  narrationDurationSec,
  sceneDurationDs,
} from "./timing.js";
import { validateSceneManifest } from "./validate.js";

/**
 * The scene planner (Phase 7): a validated script becomes a **scene manifest** —
 * an ordered list of scenes a concrete downstream system can act on: the media
 * stage sources its assets, the voice stage reads its narration, the renderer
 * executes its camera, animation and transitions, and the fact-check path can
 * still follow every factual scene back to the claim and the evidence behind it.
 *
 * The planner is *deterministic*. The script already decided what each sentence
 * shows (its visual cue) and who says it; mapping that onto a shot is a rule, not
 * a reasoning problem, and a model in this loop would make the same script
 * produce a different video twice (AD-07). Every mapping is a documented table —
 * `scene-types.ts`, and the two rules below — so a reviewer can predict the
 * output of the plan for any script.
 */

export interface ScenePlanOptions {
  /** CAS hash of the script artifact this manifest is planned from. */
  readonly scriptHash: string;
  readonly scriptId?: string;
  /**
   * Who may appear. Defaults to one presenter: the script never invents a person,
   * so the cast is input. An empty cast is only allowed when nothing needs a body.
   */
  readonly cast?: readonly SceneCastMember[];
  /** Narration pace; must match the script engine's tuning. */
  readonly wordsPerSecond?: number;
  readonly fps?: number;
  readonly aspect?: SceneAspect;
  readonly resolution?: SceneResolution;
  /** Length of the visual seam between scenes that are not hard-cut (seconds). */
  readonly transitionDurationSec?: number;
  readonly clock?: Clock;
}

export class ScenePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenePlanError";
  }
}

/** The channel presenter, as a role rather than a person. */
export const DEFAULT_CAST: readonly SceneCastMember[] = [
  {
    id: "presenter",
    name: "Presenter",
    role: "host",
    description: "The channel's on-screen presenter. The voice stage assigns the voice.",
  },
];

export const DEFAULT_RESOLUTION: SceneResolution = { width: 1920, height: 1080 };
export const DEFAULT_TRANSITION_DURATION_SEC = 0.45;

// ── Type, camera and motion rules (the whole vocabulary, in one place) ───

/**
 * Which scene a sentence becomes, in priority order:
 *
 * | The writer asked for  | The sentence             | Scene         |
 * | --------------------- | ------------------------ | ------------- |
 * | a spoken transition   | —                        | `TRANSITION`  |
 * | nothing / `none`      | —                        | `CHARACTER`   |
 * | `quote`               | —                        | `EVIDENCE`    |
 * | `text`                | citing claims            | `EVIDENCE`    |
 * | `text`                | no claims (a label)      | `HYBRID`      |
 * | `chart`               | —                        | `DIAGRAM`     |
 * | `image` / `broll`     | asserting a cleared fact | `HYBRID`      |
 * | `image` / `broll`     | otherwise                | `ENVIRONMENT` |
 */
export function sceneTypeFor(sentence: ScriptSentence): SceneType {
  const kind = sentence.visual?.kind;
  if (kind === undefined || kind === "none") return "CHARACTER";
  if (kind === "quote") return "EVIDENCE";
  if (kind === "chart") return "DIAGRAM";
  if (kind === "text") return sentence.claimRefs.length > 0 ? "EVIDENCE" : "HYBRID";
  // image / broll
  const assertsClearedFact = sentence.assertion === "fact" && sentence.claimRefs.length > 0;
  return assertsClearedFact ? "HYBRID" : "ENVIRONMENT";
}

/**
 * Shot and movement variation, so a 20-scene episode is not one camera angle.
 * `variation` is how many scenes of this type the plan has already produced, so
 * two scenes of the same type never open on the same setup (while different types
 * keep their own base look, which is what makes a scene readable at a glance).
 */
function cameraFor(type: SceneType, variation: number): SceneCamera {
  const base = SCENE_TYPE_SPECS[type].camera;
  switch (type) {
    case "CHARACTER":
      return {
        ...base,
        shot: PRESENTER_SHOT_CYCLE[variation % PRESENTER_SHOT_CYCLE.length] ?? base.shot,
      };
    case "ENVIRONMENT":
      return {
        ...base,
        movement: CAMERA_MOVEMENT_CYCLE[variation % CAMERA_MOVEMENT_CYCLE.length] ?? base.movement,
      };
    case "DIAGRAM":
      return { ...base, movement: variation % 2 === 0 ? "static" : "pan_right" };
    case "EVIDENCE":
      return { ...base, movement: variation % 3 === 0 ? "zoom_in" : "static" };
    default:
      return base;
  }
}

interface MotionFlags {
  readonly hasText: boolean;
  readonly hasDiagram: boolean;
  readonly hasMedia: boolean;
  readonly countsUp: boolean;
}

/** The animation events a scene starts with: enter, the on-screen element, the exit. */
function animationFor(
  type: SceneType,
  sceneId: string,
  durationSec: number,
  flags: MotionFlags,
): SceneAnimationEvent[] {
  const round = (value: number): number => Math.round(value * 10) / 10;
  const events: Omit<SceneAnimationEvent, "id">[] = [];
  const push = (
    kind: SceneAnimationEvent["kind"],
    atSec: number,
    lengthSec: number,
    target: SceneAnimationEvent["target"],
  ): void => {
    // An event that would run past the end of its scene is dropped, not clamped:
    // a half-played animation is worse than none.
    if (atSec < 0 || atSec + lengthSec > durationSec + 0.05) return;
    events.push({
      atSec: round(atSec),
      durationSec: round(lengthSec),
      kind,
      target,
      targetId: "",
      params: {},
    });
  };

  push("fade_in", 0, 0.35, "scene");
  switch (type) {
    case "TRANSITION":
      push("wipe_in", 0.05, 0.35, "scene");
      break;
    case "EVIDENCE":
      if (flags.hasText) push("slide_in", 0.05, 0.45, "text");
      break;
    case "DIAGRAM":
      push("scale_in", 0.05, 0.5, "diagram");
      if (flags.countsUp) push("count_up", 0.6, 0.8, "diagram");
      break;
    case "HYBRID":
      if (flags.hasText) push("lower_third", 0.4, 0.5, "text");
      break;
    case "CHARACTER":
      if (flags.hasText) push("lower_third", 0.35, 0.45, "text");
      break;
    case "ENVIRONMENT":
      if (flags.hasMedia) push("push_in", 0.1, Math.min(1.2, durationSec / 3), "media");
      break;
  }
  push("fade_out", Math.max(0.05, durationSec - 0.4), 0.4, "scene");

  // Ids follow time order; the schema insists the list is ordered too.
  return events
    .sort((a, b) => a.atSec - b.atSec)
    .map((event, position) => ({ ...event, id: `${sceneId}.a${position + 1}` }));
}

// ── Text, diagrams, media, assets ────────────────────────────────────────

/** Cut on a word boundary: these strings are read on screen, not in a log. */
function truncateAtWord(text: string, max: number): string {
  const collapsed = normalizeWhitespace(text);
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

function hasNumber(text: string): boolean {
  return /\d/u.test(text);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

interface LedgerIndex {
  readonly claimById: ReadonlyMap<string, ScriptClaimEntry>;
  readonly domainBySourceId: ReadonlyMap<string, string>;
}

function indexLedger(script: ScriptDoc): LedgerIndex {
  const claimById = new Map<string, ScriptClaimEntry>();
  const domainBySourceId = new Map<string, string>();
  for (const claim of script.claims) {
    if (!claimById.has(claim.claimId)) claimById.set(claim.claimId, claim);
    for (const evidence of claim.evidence) {
      const domain = domainOf(evidence.url);
      if (domain !== "" && !domainBySourceId.has(evidence.sourceId)) {
        domainBySourceId.set(evidence.sourceId, domain);
      }
    }
  }
  return { claimById, domainBySourceId };
}

/** The certainty vocabulary the scene contract accepts (the research one). */
const CERTAINTIES = ["established", "likely", "disputed", "unsupported", "uncertain"] as const;
type Certainty = (typeof CERTAINTIES)[number];

function certaintyOf(value: string, claimId: string, warn: (message: string) => void): Certainty {
  const known = CERTAINTIES.find((candidate) => candidate === value);
  if (known !== undefined) return known;
  // Fail safe, and say so: an unreadable certainty must never become "established".
  warn(`claim ${claimId} carries an unknown certainty "${value}": treated as uncertain`);
  return "uncertain";
}

/** The claim/evidence chain for one sentence, copied from the script's ledger. */
function claimRefsFor(
  sentence: ScriptSentence,
  ledger: LedgerIndex,
  warn: (message: string) => void,
): SceneClaimRef[] {
  const refs: SceneClaimRef[] = [];
  for (const claimId of sentence.claimRefs) {
    const claim = ledger.claimById.get(claimId);
    if (claim === undefined) continue;
    refs.push({
      claimId: claim.claimId,
      statement: claim.statement,
      usage: claim.usage,
      status: claim.status,
      certainty: certaintyOf(claim.certainty, claim.claimId, warn),
      confidence: claim.confidence,
      evidence: claim.evidence.map((evidence) => ({
        sourceId: evidence.sourceId,
        url: evidence.url,
        excerpt: evidence.excerpt,
        locator: evidence.locator,
      })),
    });
  }
  return refs;
}

/** Source ids the scene shows: what the sentence named, plus what its claims rest on. */
function sourceIdsFor(
  sentence: ScriptSentence,
  claims: readonly SceneClaimRef[],
  knownSourceIds: ReadonlySet<string>,
  warn: (message: string) => void,
  sceneId: string,
): string[] {
  const ids = new Set<string>();
  const candidates = [
    ...sentence.sourceRefs,
    ...claims.flatMap((claim) => claim.evidence.map((evidence) => evidence.sourceId)),
  ];
  for (const ref of candidates) {
    if (knownSourceIds.has(ref)) ids.add(ref);
    else warn(`scene ${sceneId} cannot show source ${ref}: no claim in the ledger rests on it`);
  }
  return [...ids].sort();
}

/** Who the narration is quoting or reporting, as domains — never an invented name. */
function attributionFor(
  sentence: ScriptSentence,
  claims: readonly SceneClaimRef[],
  ledger: LedgerIndex,
): string {
  const named = sentence.sourceRefs
    .map((sourceId) => ledger.domainBySourceId.get(sourceId) ?? "")
    .filter((domain) => domain !== "");
  const domains =
    named.length > 0
      ? named
      : claims.flatMap((claim) => claim.evidence.map((evidence) => domainOf(evidence.url)));
  return [...new Set(domains.filter((domain) => domain !== ""))].slice(0, 3).join(", ");
}

/**
 * On-screen words for a scene. Everything here is verbatim from the script or its
 * ledger (a quotation, a claim's own wording, or the line being spoken) — the
 * planner never writes a caption of its own.
 */
function textFor(
  type: SceneType,
  sentence: ScriptSentence,
  claims: readonly SceneClaimRef[],
  ledger: LedgerIndex,
): SceneText | undefined {
  const attribution = attributionFor(sentence, claims, ledger);
  const first = claims[0];

  if (type === "EVIDENCE") {
    const quoted = quotedSpans(sentence.narration)[0];
    if (quoted !== undefined) {
      return {
        kind: "quote",
        value: truncateAtWord(quoted, 280),
        attribution,
        position: "center",
        maxLines: 4,
      };
    }
    if (first !== undefined) {
      return {
        kind: hasNumber(first.statement) ? "number" : "claim",
        value: truncateAtWord(first.statement, 240),
        attribution,
        position: "center",
        maxLines: 3,
      };
    }
    return {
      kind: "label",
      value: truncateAtWord(sentence.narration, 90),
      attribution,
      position: "center",
      maxLines: 2,
    };
  }

  if (type === "HYBRID") {
    if (first !== undefined && sentence.assertion !== "context") {
      return {
        kind: hasNumber(first.statement) ? "number" : "claim",
        value: truncateAtWord(first.statement, 160),
        attribution,
        position: "lower_third",
        maxLines: 2,
      };
    }
    return {
      kind: "label",
      value: truncateAtWord(sentence.narration, 90),
      attribution: "",
      position: "lower_third",
      maxLines: 1,
    };
  }

  return undefined;
}

function diagramFor(
  claims: readonly SceneClaimRef[],
  warn: (message: string) => void,
  sceneId: string,
): SceneDiagram {
  const statements = claims.map((claim) => claim.statement);
  const numeric = statements.some((statement) => hasNumber(statement));
  if (claims.length === 0) {
    warn(
      `scene ${sceneId} asks for a chart but cites no claim: planned as a schematic with no figures`,
    );
  }
  return {
    kind: claims.length === 0 ? "schematic" : numeric ? "number_highlight" : "flow",
    // A title taken from the research's own wording — never a figure the planner made up.
    title: statements[0] !== undefined ? truncateAtWord(statements[0], 140) : "",
    annotations: statements.slice(0, 3).map((statement) => truncateAtWord(statement, 200)),
    series: [],
    claimIds: claims.map((claim) => claim.claimId),
  };
}

interface MediaPlan {
  readonly media: SceneMedia;
  readonly asset: SceneAsset;
}

function mediaFor(
  sentence: ScriptSentence,
  sceneSeconds: number,
  orientation: SceneMedia["orientation"],
  treatment: SceneMedia["treatment"],
  sceneId: string,
): MediaPlan | undefined {
  const visual = sentence.visual;
  if (visual === undefined || (visual.kind !== "broll" && visual.kind !== "image"))
    return undefined;
  const kind = visual.kind === "broll" ? "video" : "image";
  const description = truncateAtWord(visual.description, 300);
  const searchHint = truncateAtWord(visual.searchHint, 160);
  const asset: SceneAsset = {
    id: `asset_${sceneId}`,
    sceneId,
    kind,
    purpose: kind === "video" ? "broll" : "still",
    description,
    searchHint,
    orientation,
    minDurationSec: kind === "video" ? sceneSeconds : 0,
    status: "planned",
    uri: "",
    licence: "unknown",
  };
  return {
    media: {
      kind,
      description,
      searchHint,
      orientation,
      treatment,
      assets: [asset.id],
    },
    asset,
  };
}

// ── The planner ──────────────────────────────────────────────────────────

interface PlanningState {
  readonly scenes: Scene[];
  readonly assets: SceneAsset[];
  readonly warnings: string[];
}

function requiredCast(cast: readonly SceneCastMember[], sceneId: string): SceneCastMember {
  const member = cast[0];
  if (member === undefined) {
    throw new ScenePlanError(
      `scene ${sceneId} needs someone on screen, but the plan was given an empty cast. ` +
        "Pass at least one cast member, or write the script so nothing needs a presenter.",
    );
  }
  return member;
}

export function buildSceneManifest(script: ScriptDoc, options: ScenePlanOptions): SceneManifest {
  const hashCheck = Sha256Schema.safeParse(options.scriptHash);
  if (!hashCheck.success) {
    throw new ScenePlanError(
      `scriptHash must be a 64-character sha256 hex, received "${options.scriptHash}"`,
    );
  }
  const wordsPerSecond = options.wordsPerSecond ?? DEFAULT_WORDS_PER_SECOND;
  if (!(wordsPerSecond > 0) || wordsPerSecond > 10) {
    throw new ScenePlanError(`wordsPerSecond must be in (0, 10], received ${wordsPerSecond}`);
  }
  const fps = options.fps ?? 30;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    throw new ScenePlanError(`fps must be an integer in [1, 120], received ${fps}`);
  }
  const transitionDurationSec = options.transitionDurationSec ?? DEFAULT_TRANSITION_DURATION_SEC;
  if (transitionDurationSec < 0 || transitionDurationSec > 2) {
    throw new ScenePlanError(
      `transitionDurationSec must be in [0, 2], received ${transitionDurationSec}`,
    );
  }

  const clock = options.clock ?? systemClock;
  const cast = options.cast ?? DEFAULT_CAST;
  const aspect = options.aspect ?? "16:9";
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const orientation: SceneMedia["orientation"] = aspect === "9:16" ? "portrait" : "landscape";
  const ledger = indexLedger(script);
  const knownSourceIds = new Set(ledger.domainBySourceId.keys());

  const state: PlanningState = { scenes: [], assets: [], warnings: [] };
  const warn = (message: string): void => {
    state.warnings.push(message);
  };

  const steps: SceneStepTrace[] = [];
  const trace = (step: ScenePlanningStep, notes: string[]): SceneStepTrace => {
    const entry: SceneStepTrace = { step, engine: "none", notes };
    steps.push(entry);
    return entry;
  };

  trace("cast", [
    cast.length === 0
      ? "no cast: every sentence has to be carried by material rather than a presenter"
      : `cast: ${cast.map((member) => `${member.id} (${member.role})`).join(", ")}`,
  ]);

  // ── plan and time, section by section, sentence by sentence ────────────
  let startDs = 0;
  let index = 0;
  let sentenceScenes = 0;
  let transitionScenes = 0;
  let totalWords = 0;
  const typeCounts = new Map<SceneType, number>();
  const cameraSignatures = new Set<string>();

  const pushScene = (scene: Scene): void => {
    state.scenes.push(scene);
    cameraSignatures.add(`${scene.type}:${JSON.stringify(scene.camera)}`);
    typeCounts.set(scene.type, (typeCounts.get(scene.type) ?? 0) + 1);
    startDs += Math.round(scene.durationSec * 10);
    index += 1;
  };

  for (const section of script.sections) {
    // The spoken bridge into this section is its own scene, before its sentences:
    // that is where the audience hears it.
    const transition = normalizeWhitespace(section.transition);
    if (transition !== "") {
      const id = `scn_${section.id}_t`;
      const words = wordCount(transition);
      const durationSec = fromDeciseconds(sceneDurationDs("TRANSITION", words, wordsPerSecond));
      pushScene({
        id,
        index,
        type: "TRANSITION",
        sectionId: section.id,
        role: section.role,
        startSec: fromDeciseconds(startDs),
        durationSec,
        narration: {
          kind: "transition",
          text: transition,
          sectionId: section.id,
          role: section.role,
          sentenceIds: [],
          words,
          estimatedDurationSec: narrationDurationSec(words, wordsPerSecond),
        },
        characters: [],
        camera: cameraFor("TRANSITION", typeCounts.get("TRANSITION") ?? 0),
        animation: animationFor("TRANSITION", id, durationSec, {
          hasText: false,
          hasDiagram: false,
          hasMedia: false,
          countsUp: false,
        }),
        transition: { kind: "cut", durationSec: 0, toSceneId: "", audio: "none" },
        sources: [],
        sourceIds: [],
        notes: [],
      });
      totalWords += words;
      transitionScenes += 1;
    }

    for (const [position, sentence] of section.sentences.entries()) {
      const id = `scn_${section.id}_${position + 1}`;
      const type = sceneTypeFor(sentence);
      const words = wordCount(sentence.narration);
      const durationSec = fromDeciseconds(sceneDurationDs(type, words, wordsPerSecond));
      const claims = claimRefsFor(sentence, ledger, warn);
      const text = textFor(type, sentence, claims, ledger);
      const diagram = type === "DIAGRAM" ? diagramFor(claims, warn, id) : undefined;
      const mediaPlan = mediaFor(
        sentence,
        durationSec,
        orientation,
        type === "HYBRID" ? "background" : "full_frame",
        id,
      );
      if (mediaPlan !== undefined && mediaPlan.asset.searchHint === "") {
        warn(
          `scene ${id} has no media search hint: the media stage will search its description instead`,
        );
      }

      const needsPresenter = type === "CHARACTER" || type === "HYBRID";
      const presenter = needsPresenter ? requiredCast(cast, id) : undefined;
      const pointsAtTheFact =
        text !== undefined && (text.kind === "claim" || text.kind === "number");
      const countsUp =
        diagram?.kind === "number_highlight" || (type === "HYBRID" && text?.kind === "number");

      pushScene({
        id,
        index,
        type,
        sectionId: section.id,
        role: section.role,
        startSec: fromDeciseconds(startDs),
        durationSec,
        narration: {
          kind: "sentence",
          text: normalizeWhitespace(sentence.narration),
          sectionId: section.id,
          role: section.role,
          sentenceIds: [sentence.id],
          words,
          estimatedDurationSec: narrationDurationSec(words, wordsPerSecond),
        },
        characters:
          presenter === undefined
            ? []
            : [
                {
                  characterId: presenter.id,
                  state: type === "HYBRID" && pointsAtTheFact ? "gesturing" : "talking",
                },
              ],
        ...(mediaPlan !== undefined ? { media: mediaPlan.media } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(diagram !== undefined ? { diagram } : {}),
        camera: cameraFor(type, typeCounts.get(type) ?? 0),
        animation: animationFor(type, id, durationSec, {
          hasText: text !== undefined,
          hasDiagram: diagram !== undefined,
          hasMedia: mediaPlan !== undefined,
          countsUp,
        }),
        transition: { kind: "cut", durationSec: 0, toSceneId: "", audio: "none" },
        sources: claims,
        sourceIds: sourceIdsFor(sentence, claims, knownSourceIds, warn, id),
        notes: [],
      });
      if (mediaPlan !== undefined) state.assets.push(mediaPlan.asset);
      totalWords += words;
      sentenceScenes += 1;
    }
  }

  trace("types", [
    `${sentenceScenes} sentence scene(s) and ${transitionScenes} spoken transition(s)`,
    [...typeCounts.entries()].map(([type, count]) => `${count} ${type}`).join(", "),
  ]);

  // ── seams: cut inside a run of one type, dissolve into a new one ───────
  for (const [position, scene] of state.scenes.entries()) {
    const next = state.scenes[position + 1];
    if (next === undefined) {
      scene.transition = { kind: "cut", durationSec: 0, toSceneId: "", audio: "none" };
      continue;
    }
    const soft = next.type === "TRANSITION" || next.type !== scene.type;
    scene.transition = soft
      ? {
          kind: next.type === "TRANSITION" ? "fade_to_black" : "dissolve",
          durationSec: transitionDurationSec,
          toSceneId: next.id,
          audio: "crossfade",
        }
      : { kind: "cut", durationSec: 0, toSceneId: next.id, audio: "none" };
  }

  const totalDs = state.scenes.reduce((sum, scene) => sum + Math.round(scene.durationSec * 10), 0);
  trace("timing", [
    `${totalWords} word(s) at ${wordsPerSecond} words/second`,
    `${fromDeciseconds(totalDs)}s across ${state.scenes.length} scene(s)`,
  ]);
  trace("camera", [`${cameraSignatures.size} distinct camera setup(s)`]);
  trace("animation", [
    `${state.scenes.reduce((sum, scene) => sum + scene.animation.length, 0)} animation event(s)`,
  ]);
  trace("assets", [
    state.assets.length === 0
      ? "no external assets needed"
      : `${state.assets.length} asset(s) planned: ${[...new Set(state.assets.map((asset) => asset.kind))].join(", ")}`,
  ]);

  const generatedAt = clock.nowIso();
  const manifest: SceneManifest = {
    version: 1,
    topic: script.topic,
    workingTitle: script.workingTitle,
    scriptId: options.scriptId ?? "",
    scriptHash: options.scriptHash,
    generatedAt,
    fps,
    aspect,
    resolution,
    wordsPerSecond,
    totalDurationSec: fromDeciseconds(totalDs),
    cast: [...cast],
    scenes: state.scenes,
    assets: state.assets,
    warnings: [...state.warnings],
    provenance: {
      engine: SCENE_ENGINE,
      // A live reference: the validate step is recorded below, before the parse.
      steps,
      aiSteps: [],
      deterministicSteps: [],
      generatedAt,
    },
  };

  // ── validate what we just built, against the script it came from ───────
  const report = validateSceneManifest(manifest, { script, wordsPerSecond });
  for (const entry of report.issues) {
    const message = `${entry.severity === "hard" ? "error" : "warning"}: ${entry.message}`;
    manifest.warnings.push(message);
    const scene =
      entry.sceneId === "" ? undefined : manifest.scenes.find((s) => s.id === entry.sceneId);
    if (scene !== undefined && scene.notes.length < 6) scene.notes.push(message);
  }
  trace("validate", [
    `${report.issues.filter((entry) => entry.severity === "hard").length} hard and ` +
      `${report.issues.filter((entry) => entry.severity === "soft").length} soft issue(s)`,
  ]);
  manifest.provenance.deterministicSteps = steps.map((entry) => entry.step);

  return SceneManifestSchema.parse(manifest);
}
