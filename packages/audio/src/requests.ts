import { normalizeWhitespace, sentences, words } from "@nexus/script";
import type { SynthesisRequest, VoiceProfile } from "@nexus/providers";
import type { SceneManifest } from "@nexus/scenes";

import type { AudioIssue, VoiceCasting, VoiceSettings } from "./schema.js";
import { speakerForScene, voicePlanFor, type VoicePlan } from "./voices.js";

/**
 * What actually gets spoken.
 *
 * **One segment per scene.** A scene's narration is a coherent stretch of speech —
 * the planner wrote it that way — so it is the natural unit for a synthesis call:
 * the seam between two segments then lands exactly where the video cuts, a retry
 * re-voices one scene rather than a whole episode, and the cache reuses the scenes
 * that did not change. Sentence-level audio (one call per sentence) would ship
 * more calls, more seams to hide and worse prosody; it is only worth it when a
 * later stage needs per-sentence editing (OD-27).
 *
 * Sentence *boundaries* inside the segment come from the narration text itself —
 * the same splitter the script engine used — and the ids come from the manifest,
 * so nothing has to be re-derived from an upstream artifact and the caption stage
 * can place a line without ever seeing the script.
 */

export const DEFAULT_WORDS_PER_SECOND = 2.5;

export interface SegmentPlan {
  readonly id: string;
  readonly sceneId: string;
  readonly index: number;
  readonly sceneType: string;
  /** The character speaking, or `""` for the narrator. */
  readonly speakerId: string;
  readonly text: string;
  /** The narration's sentences, in order, paired with `sentenceIds`. */
  readonly sentenceTexts: readonly string[];
  readonly sentenceIds: readonly string[];
  readonly words: number;
  readonly characters: number;
  readonly plan: VoicePlan;
  readonly plannedStartSec: number;
  readonly plannedDurationSec: number;
}

export interface SegmentPlans {
  readonly plans: readonly SegmentPlan[];
  readonly issues: readonly AudioIssue[];
}

export function segmentIdForScene(sceneId: string): string {
  return `seg_${sceneId}`;
}

/** One plan per scene that has narration to speak. */
export function segmentPlansFrom(manifest: SceneManifest, casting: VoiceCasting): SegmentPlans {
  const plans: SegmentPlan[] = [];
  const issues: AudioIssue[] = [];

  for (const [index, scene] of manifest.scenes.entries()) {
    const text = normalizeWhitespace(scene.narration.text);
    if (text === "") {
      // Defensive: the manifest schema refuses a scene whose narration has no
      // words (its word count would not match the text), so a *validated* manifest
      // cannot arrive here. It stays because this function is also fed documents
      // that were assembled in memory, and a scene with nothing to say must be
      // reported rather than silently skipped.
      issues.push({
        code: "silent_scene",
        severity: "warning",
        sceneId: scene.id,
        segmentId: segmentIdForScene(scene.id),
        message: `scene ${scene.id} has no narration text, so it has no audio`,
      });
      continue;
    }

    const speakerId = speakerForScene(scene);
    const plan = voicePlanFor(casting, speakerId);
    const sentenceTexts = sentences(text);
    const sentenceIds = scene.narration.sentenceIds;

    if (sentenceIds.length > 0 && sentenceIds.length !== sentenceTexts.length) {
      issues.push({
        code: "timing_mismatch",
        severity: "warning",
        sceneId: scene.id,
        segmentId: segmentIdForScene(scene.id),
        message:
          `scene ${scene.id} carries ${sentenceIds.length} sentence id(s) but its narration reads as ` +
          `${sentenceTexts.length} sentence(s); sentence timing falls back to even distribution`,
      });
    }

    plans.push({
      id: segmentIdForScene(scene.id),
      sceneId: scene.id,
      index,
      sceneType: scene.type,
      speakerId,
      text,
      sentenceTexts,
      sentenceIds,
      words: words(text).length,
      characters: text.length,
      plan,
      plannedStartSec: scene.startSec,
      plannedDurationSec: scene.durationSec,
    });
  }

  return { plans, issues };
}

/** The call the adapter receives. */
export function synthesisRequestFor(plan: SegmentPlan, settings: VoiceSettings): SynthesisRequest {
  const voice: VoiceProfile = {
    id: settings.voiceId,
    label: settings.label,
    language: settings.language,
    ...(settings.gender !== undefined ? { gender: settings.gender } : {}),
  };
  return {
    text: plan.text,
    voice,
    format: settings.format,
    sampleRate: settings.sampleRate,
    rate: settings.rate,
  };
}

/** The fallback duration, when neither the provider nor the bytes measured one. */
export function estimateDurationMs(
  text: string,
  wordsPerSecond = DEFAULT_WORDS_PER_SECOND,
): number {
  const count = words(text).length;
  if (count === 0) return 0;
  return Math.max(200, Math.round((count / wordsPerSecond) * 1_000));
}
