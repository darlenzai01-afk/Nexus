import {
  SCENE_TYPE_SPECS,
  SceneManifestSchema,
  type Scene,
  type SceneCamera,
  type SceneManifest,
  type SceneTextPosition,
} from "@nexus/scenes";
import { AudioTrackSchema, type AudioTrack } from "@nexus/audio";

import {
  SHORTS_ENGINE,
  VERTICAL_CANVAS,
  VERTICAL_LAYOUT_VERSION,
  VerticalLayoutSchema,
  type ShortsCandidate,
  type VerticalLayout,
  type VerticalSceneLayout,
} from "./schema.js";
/** Rounded to 1e-3, so documents compare equal across machines. */
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * The vertical reflow: one candidate in, a 9:16 plan out.
 *
 * The output is **not** a crop of the long-form video. The long-form frames
 * are never decoded at all — the engine re-composes the short from the same
 * scene documents the long-form was rendered from, so every element is laid
 * out natively for the tall frame:
 *
 * - **camera** — a wide two-shot becomes a presenter-centric medium close-up;
 *   the recorded `window` is the framing's 16:9 *equivalent* (focus-following,
 *   computed from who presents and where the text/media sit), never a blanket
 *   centre crop;
 * - **characters** — the presenter carries the vertical frame (the blocking
 *   layer centres them; a listening second character stays in frame behind);
 * - **text** — corner text (which hugs the wide frame's edge) moves to the
 *   lower third; every text box gains a line because the frame is narrower;
 * - **evidence/diagrams** — diagrams re-stack top-to-bottom in the tall frame;
 * - **media** — side-by-side `split_screen` compositions become stacked
 *   `overlay` compositions;
 * - **captions** — the layout document places the caption band above the
 *   platform UI and sizes the type for the vertical canvas.
 *
 * The re-timed plan keeps each scene's **spoken** duration (from the narration
 * timestamps), declares the measured speaking pace, and the narration track is
 * re-based onto the vertical timeline **reusing the same audio artifacts** —
 * the short speaks the episode's own voice.
 */

type MediaTreatment = NonNullable<Scene["media"]>["treatment"];
type CameraShot = SceneCamera["shot"];

const SOURCE_ASPECT = "16:9";

/** Vertical safe margins: platform chrome at the top, captions + UI at the bottom. */
const SAFE_AREA = { top: 0.08, bottom: 0.18, left: 0.05, right: 0.05 } as const;

/** The caption band: above the bottom safe margin, comfortably tall. */
const CAPTION_BAND = { x: 0.06, y: 0.8, width: 0.88, height: 0.1 } as const;

/** Caption type that reads on a 1080-wide phone frame. */
const CAPTION_STYLE = { fontPx: 58, marginPx: 210 } as const;

/** Shot changes for the tall frame: a wide horizontal composition empties out. */
const SHOT_REFLOW: Partial<Record<CameraShot, CameraShot>> = {
  wide: "medium",
  insert: "insert",
};

/** Text position changes: the wide frame's corner has no vertical equivalent. */
const TEXT_POSITION_REFLOW: Partial<Record<SceneTextPosition, SceneTextPosition>> = {
  corner: "lower_third",
};

/** Media treatment changes: side-by-side becomes stacked. */
const MEDIA_TREATMENT_REFLOW: Partial<Record<MediaTreatment, MediaTreatment>> = {
  split_screen: "overlay",
  picture_in_picture: "overlay",
};

/** How much of the 16:9 frame the vertical framing corresponds to, per shot. */
const WINDOW_WIDTH: Record<CameraShot, number> = {
  wide: 0.9,
  medium: 0.78,
  medium_close: 0.68,
  close_up: 0.56,
  extreme_close_up: 0.45,
  over_shoulder: 0.66,
  pov: 0.72,
  insert: 0.8,
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Where the scene's attention lives on the source frame, from the scene's own
 * visual metadata: the presenting character's slot, else the text's centre,
 * else the media treatment's bias, else the middle.
 */
export function focusOf(scene: Scene): { x: number; y: number; reason: string } {
  const presenting = scene.characters.find((entry) =>
    ["talking", "gesturing", "pointing", "entering"].includes(entry.state),
  );
  if (presenting !== undefined) {
    const slot = presenterSlot(scene.characters, presenting.characterId);
    return {
      x: slot,
      y: 0.55,
      reason: `presenter "${presenting.characterId}" stands at x=${round1(slot)}`,
    };
  }
  if (scene.text !== undefined) {
    const centres: Record<SceneTextPosition, number> = {
      lower_third: 0.5,
      center: 0.5,
      upper_third: 0.5,
      corner: 0.69,
      full_screen: 0.5,
    };
    return {
      x: centres[scene.text.position],
      y: scene.text.position === "upper_third" ? 0.2 : scene.text.position === "center" ? 0.5 : 0.8,
      reason: `no cast — aiming at the "${scene.text.position}" text`,
    };
  }
  if (scene.media !== undefined) {
    const biases: Record<MediaTreatment, number> = {
      full_frame: 0.5,
      overlay: 0.5,
      split_screen: 0.32,
      background: 0.5,
      picture_in_picture: 0.81,
    };
    return {
      x: biases[scene.media.treatment],
      y: 0.5,
      reason: `media "${scene.media.treatment}" bias`,
    };
  }
  return { x: 0.5, y: 0.5, reason: "nothing to aim at — centre" };
}

/** The presenter's slot centre (the compositor's own `SLOT_CENTRES` rule). */
function presenterSlot(cast: Scene["characters"], presenterId: string): number {
  const slotCentres: Record<number, readonly number[]> = {
    1: [0.5],
    2: [0.34, 0.66],
    3: [0.22, 0.5, 0.78],
  };
  const row = slotCentres[cast.length] ?? [0.5];
  const index = Math.max(
    0,
    cast.findIndex((entry) => entry.characterId === presenterId),
  );
  return row[index] ?? 0.5;
}

export interface ReflowInput {
  readonly manifest: SceneManifest;
  readonly track: AudioTrack;
  readonly candidate: ShortsCandidate;
}

export interface ReflowOptions {
  /** The vertical canvas; the default is the platform's 1080×1920. */
  readonly canvas?: { readonly width: number; readonly height: number };
  /** The hash the re-based track should record (the persisted vertical manifest's). */
  readonly manifestHash?: string;
  /**
   * The SHORT's own script (a scoped condensation of the parent's), so QA's
   * plan↔script cross-reference binds to the document the short was built
   * from. Defaults to the source manifest's script hash.
   */
  readonly scriptHash?: string;
  readonly now?: string;
}

export interface ReflowResult {
  /** A validated 9:16 manifest covering exactly the candidate's scenes. */
  readonly manifest: SceneManifest;
  /** The framing/reflow decisions, as reviewable data. */
  readonly layout: VerticalLayout;
  /** The narration track re-based onto the vertical timeline, same audio bytes. */
  readonly track: AudioTrack;
  readonly warnings: readonly string[];
}

export function verticalReflow(input: ReflowInput, options: ReflowOptions = {}): ReflowResult {
  const canvas = options.canvas ?? VERTICAL_CANVAS;
  const now = options.now ?? "1970-01-01T00:00:00.000Z";
  const warnings: string[] = [];

  const source = input.manifest;
  const first = source.scenes[input.candidate.startIndex];
  const last = source.scenes[input.candidate.endIndex];
  if (first === undefined || last === undefined) {
    throw new Error(
      `candidate ${input.candidate.id} spans scenes ${input.candidate.startIndex}..${input.candidate.endIndex}, ` +
        `but the manifest has ${source.scenes.length}`,
    );
  }

  // ── The spoken timeline of the candidate, from the narration track ──
  const segmentsByScene = new Map(
    input.track.segments.map((segment) => [segment.sceneId, segment]),
  );
  const spanScenes = source.scenes.slice(input.candidate.startIndex, input.candidate.endIndex + 1);

  // ── Re-time each scene to its speech, and re-compose it for 9:16 ──
  const sceneLayouts: VerticalSceneLayout[] = [];
  const verticalScenes: SceneManifest["scenes"] = [];
  let cursor = 0;
  for (const scene of spanScenes) {
    const segment = segmentsByScene.get(scene.id);
    const spoken = segment !== undefined ? round1(segment.durationSec) : scene.durationSec;
    // The speech sets the pace, but a scene type still needs its minimum hold
    // (a DIAGRAM never flashes by in 2s) — the validator enforces the same floor.
    const durationSec = Math.max(0.4, spoken, SCENE_TYPE_SPECS[scene.type].minDurationSec);

    // Camera reflow.
    const focus = focusOf(scene);
    const targetShot = SHOT_REFLOW[scene.camera.shot] ?? scene.camera.shot;
    const width = WINDOW_WIDTH[targetShot] ?? WINDOW_WIDTH[scene.camera.shot] ?? 0.75;
    const windowX = Math.min(1 - width, Math.max(0, focus.x - width / 2));
    const shotMoved = targetShot !== scene.camera.shot;
    sceneLayouts.push({
      sceneId: scene.id,
      camera: {
        mode: "reflow",
        sourceAspect: SOURCE_ASPECT,
        focusX: round3(focus.x),
        focusY: round3(focus.y),
        window: { x: round3(windowX), width: round3(width) },
        reason:
          (shotMoved ? `"${scene.camera.shot}" re-frames as "${targetShot}" in 9:16; ` : "") +
          focus.reason,
      },
      notes: [],
    });

    // Text, media, diagram reflow — expressed on the scene the renderer reads.
    // The compositor derives type size from the frame's HEIGHT; in 9:16 that
    // makes 16:9-sized text far too wide for the narrow frame, so the reflow
    // scales it by the width ratio over the height ratio (never enlarging),
    // which preserves the long form's fit while staying readable.
    const sizeScale = Math.min(
      1,
      round3((canvas.width * source.resolution.height) / (canvas.height * source.resolution.width)),
    );
    const text = scene.text;
    const verticalText = text
      ? {
          ...text,
          position: TEXT_POSITION_REFLOW[text.position] ?? text.position,
          maxLines: Math.min(6, text.maxLines + 1),
          sizeScale,
        }
      : undefined;
    const verticalMedia = scene.media
      ? {
          ...scene.media,
          treatment: MEDIA_TREATMENT_REFLOW[scene.media.treatment] ?? scene.media.treatment,
        }
      : undefined;

    const textMoved = verticalText !== undefined && verticalText.position !== text?.position;
    const sceneLayout = sceneLayouts[sceneLayouts.length - 1];
    if (sceneLayout !== undefined) {
      if (text !== undefined) {
        sceneLayout.text = {
          position: verticalText!.position,
          ...(textMoved ? { previousPosition: text.position } : {}),
          reason:
            (textMoved
              ? `"${text.position}" hugs the wide frame's edge — it moves to "${verticalText!.position}"; the narrow frame gains a line`
              : `"${text.position}" reads the same in a tall frame; the box gains a line`) +
            (sizeScale < 0.99 ? `; type scaled ×${sizeScale} to the frame's width` : ""),
        };
      }
      if (scene.media !== undefined && verticalMedia !== undefined) {
        const moved = verticalMedia.treatment !== scene.media.treatment;
        sceneLayout.media = {
          treatment: verticalMedia.treatment,
          ...(moved ? { previousTreatment: scene.media.treatment } : {}),
          reason: moved
            ? `"${scene.media.treatment}" is a side-by-side layout — it stacks as "${verticalMedia.treatment}"`
            : `"${scene.media.treatment}" fills the tall frame unchanged`,
        };
      }
      if (scene.diagram !== undefined) {
        sceneLayout.diagram = {
          flow: "vertical",
          reason: `"${scene.diagram.kind}" re-stacks top-to-bottom in the tall frame`,
        };
      }
    }

    // The speech re-times the scene, so the animation events are re-timed
    // with it: the same events, uniformly scaled into the new length, still
    // ordered and still ending inside the scene (the validator enforces both).
    const animationScale = scene.durationSec > 0 ? durationSec / scene.durationSec : 1;
    const animation = scene.animation.map((event) => {
      const atSec = round3(event.atSec * animationScale);
      const eventDuration = round3(
        Math.min(event.durationSec * animationScale, Math.max(0.1, durationSec - atSec)),
      );
      return { ...event, atSec, durationSec: eventDuration };
    });
    if (animationScale < 0.99 || animationScale > 1.01) {
      sceneLayouts[sceneLayouts.length - 1]?.notes.push(
        `animation re-timed ×${round3(animationScale)} to the spoken length`,
      );
    }

    verticalScenes.push({
      ...scene,
      index: verticalScenes.length,
      startSec: round1(cursor),
      durationSec,
      animation,
      camera: { ...scene.camera, shot: targetShot },
      text: verticalText,
      media: verticalMedia,
      transition:
        scene.transition.kind === "cut"
          ? { ...scene.transition, toSceneId: "" }
          : { kind: "cut", durationSec: 0, toSceneId: "", audio: scene.transition.audio },
    });
    cursor = round1(cursor + durationSec);
  }

  // Wire the handover chain (the manifest schema insists every scene hands over).
  const wired = verticalScenes.map((scene, position) => ({
    ...scene,
    transition: { ...scene.transition, toSceneId: verticalScenes[position + 1]?.id ?? "" },
  }));

  const totalDurationSec = round1(wired.reduce((sum, scene) => sum + scene.durationSec, 0));
  const spokenWords = wired.reduce((sum, scene) => sum + scene.narration.words, 0);
  // The vertical plan declares a pace every scene honestly spoke at: at least
  // the fastest scene's rate plus headroom inside the validator's ±0.2s
  // estimate tolerance, so each scene's estimate can agree with both its words
  // and its (type-floored) hold.
  const fastest = Math.max(
    0,
    ...wired.map((scene) => scene.narration.words / (scene.durationSec + 0.35)),
  );
  const measuredWps =
    spokenWords > 0 && fastest > 0 ? Math.min(10, Math.max(0.5, fastest)) : source.wordsPerSecond;
  const wordsPerSecond = Math.round(measuredWps * 100) / 100;

  const verticalManifestInput = {
    ...source,
    ...(options.scriptHash !== undefined ? { scriptHash: options.scriptHash } : {}),
    generatedAt: now,
    aspect: "9:16" as const,
    resolution: { ...canvas },
    wordsPerSecond,
    totalDurationSec,
    scenes: wired.map((scene) => ({
      ...scene,
      narration: {
        ...scene.narration,
        estimatedDurationSec: Math.max(
          0.1,
          round1(Math.min(scene.narration.words / wordsPerSecond, scene.durationSec + 0.2)),
        ),
      },
    })),
    provenance: {
      ...source.provenance,
      engine: SHORTS_ENGINE,
      // deterministicSteps is the scenes engine's fixed vocabulary, so the
      // reflow records itself as a step note instead.
      steps: [
        ...source.provenance.steps,
        {
          step: "validate",
          engine: "none",
          notes: ["shorts.vertical_reflow: re-timed to spoken durations, re-composed for 9:16"],
        },
      ],
    },
  };

  const manifest = SceneManifestSchema.parse(verticalManifestInput);

  // ── The narration track, re-based and byte-identical ──
  const spanIds = new Set(spanScenes.map((scene) => scene.id));
  const rebased = input.track.segments
    .filter((segment) => spanIds.has(segment.sceneId))
    .map((segment) => {
      const scene = wired.find((entry) => entry.id === segment.sceneId)!;
      // The segment keeps its offset *within* its scene (drift included) and
      // lands on the scene's new vertical start.
      const sourceScene = segmentsByScene.get(segment.sceneId)!;
      return {
        ...segment,
        index: wired.findIndex((entry) => entry.id === segment.sceneId),
        startSec: round3(scene.startSec + (segment.startSec - sourceScene.startSec)),
        plannedStartSec: scene.startSec,
        plannedDurationSec: scene.durationSec,
      };
    })
    .sort((left, right) => left.startSec - right.startSec);

  const sentenceTimings = input.track.sentences
    .filter((timing) => spanScenes.some((scene) => scene.id === timing.sceneId))
    .map((timing) => {
      const segment = rebased.find((entry) => entry.sceneId === timing.sceneId);
      const sourceSegment = segmentsByScene.get(timing.sceneId);
      if (segment === undefined || sourceSegment === undefined) return timing;
      const into = timing.startSec - sourceSegment.startSec;
      return {
        ...timing,
        segmentId: segment.id,
        startSec: round3(segment.startSec + into),
        endSec: round3(segment.startSec + into + timing.durationSec),
      };
    })
    .sort((left, right) => left.startSec - right.startSec);

  const spokenSec = round3(rebased.reduce((sum, segment) => sum + segment.durationSec, 0));
  const words = rebased.reduce((sum, segment) => sum + segment.words, 0);
  const charactersCount = rebased.reduce((sum, segment) => sum + segment.characters, 0);

  const track: AudioTrack = AudioTrackSchema.parse({
    ...input.track,
    generatedAt: now,
    // Until the caller persists the vertical manifest and stamps its hash
    // (withManifestHash), the track keeps the source manifest's hash.
    manifestHash: options.manifestHash ?? input.track.manifestHash,
    scenes: wired.map((scene) => {
      const segment = rebased.find((entry) => entry.sceneId === scene.id);
      const spoken = segment !== undefined ? segment.durationSec : 0;
      return {
        sceneId: scene.id,
        index: scene.index,
        type: scene.type,
        segmentId: segment?.id ?? "",
        plannedStartSec: scene.startSec,
        plannedDurationSec: scene.durationSec,
        spokenStartSec: segment?.startSec ?? scene.startSec,
        spokenDurationSec: spoken,
        driftSec: round3(spoken - scene.durationSec),
        verdict: segment === undefined ? ("silent" as const) : ("fits" as const),
      };
    }),
    segments: rebased,
    sentences: sentenceTimings,
    totals: {
      ...input.track.totals,
      scenes: wired.length,
      segments: rebased.length,
      words,
      characters: charactersCount,
      wordsPerSecond: spokenSec > 0 ? round3(words / spokenSec) : 0,
      plannedDurationSec: totalDurationSec,
      spokenDurationSec: spokenSec,
      driftSec: round3(totalDurationSec - spokenSec),
      cachedSegments: input.track.totals.cachedSegments,
      operatorSegments: input.track.totals.operatorSegments,
      estimatedSegments: input.track.totals.estimatedSegments,
      failedSegments: input.track.totals.failedSegments,
    },
    warnings: [...input.track.warnings, `rebased for short ${input.candidate.id} (9:16 reflow)`],
    provenance: {
      ...input.track.provenance,
      deterministicSteps: [
        ...new Set([...input.track.provenance.deterministicSteps, "shorts.track_rebase"]),
      ],
    },
  });

  const layout: VerticalLayout = VerticalLayoutSchema.parse({
    version: VERTICAL_LAYOUT_VERSION,
    candidateId: input.candidate.id,
    canvas: { ...canvas },
    aspect: "9:16",
    safeArea: SAFE_AREA,
    captionBand: CAPTION_BAND,
    captionStyle: CAPTION_STYLE,
    scenes: sceneLayouts,
    warnings,
  });

  return { manifest, layout, track, warnings };
}

/** Re-stamp a re-based track with the vertical manifest's persisted hash. */
export function withManifestHash(track: AudioTrack, manifestHash: string): AudioTrack {
  return AudioTrackSchema.parse({ ...track, manifestHash });
}
