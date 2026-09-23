import {
  VoiceCastingSchema,
  type AudioFormat,
  type AudioIssue,
  type CastVoice,
  type VoiceCasting,
  type VoiceGender,
  type VoiceSettings,
} from "./schema.js";

import type { Scene, SceneCharacterState, SceneManifest } from "@nexus/scenes";

/**
 * Voice configuration (Phase 10).
 *
 * A scene manifest says *who is on screen*; it deliberately says nothing about
 * how anybody sounds (that is not a fact about the episode). The casting fills
 * that gap: one narrator voice, one voice per cast member, and the defaults every
 * segment inherits. It is a separate document so a video can be re-voiced —
 * another language, another host voice — without touching a single scene.
 *
 * Two rules make the configuration predictable:
 *
 * 1. **The speaker of a scene is decided by the scene.** The first cast member
 *    whose state is `talking`, `gesturing` or `pointing` speaks the narration
 *    (they are the ones on screen saying it); anything else — a listening guest, a
 *    b-roll scene, an evidence card — is read by the narrator.
 * 2. **Nothing is guessed twice.** A voice id of `""` means "the adapter's own
 *    first voice", and it is resolved *once* per run, against the adapter's real
 *    voice list, before anything is synthesized. The resolved id is written into
 *    every segment, so an artifact never contains an ambiguity.
 */

/**
 * The states in which a character is *speaking* the narration. `entering`,
 * `exiting` and `reacting` are deliberately absent: a character walking into frame
 * or reacting is not the one talking, and those states belong to staging.
 */
export const SPEAKING_STATES: readonly SceneCharacterState[] = ["talking", "gesturing", "pointing"];

export interface VoiceProfileLike {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly gender?: VoiceGender;
}

/** Voice defaults, as the operator configures them (`NEXUS_TTS_*`). */
export interface VoiceDefaults {
  readonly voiceId?: string;
  readonly label?: string;
  readonly language?: string;
  readonly gender?: VoiceGender;
  readonly rate?: number;
  readonly style?: string;
  readonly format?: AudioFormat;
  readonly sampleRate?: number;
}

export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_SAMPLE_RATE = 24_000;
export const DEFAULT_RATE = 1;
export const DEFAULT_CASTING_DEFAULTS: Required<
  Pick<VoiceDefaults, "voiceId" | "language" | "rate" | "format" | "sampleRate">
> = {
  voiceId: "",
  language: DEFAULT_LANGUAGE,
  rate: DEFAULT_RATE,
  format: "wav",
  sampleRate: DEFAULT_SAMPLE_RATE,
};

/** The voice a segment is synthesized with, before the adapter is consulted. */
export interface VoicePlan {
  readonly voiceId: string;
  readonly label: string;
  readonly language: string;
  readonly gender?: VoiceGender;
  readonly rate: number;
  readonly style?: string;
  readonly format: AudioFormat;
  readonly sampleRate: number;
}

export interface CastingIssue {
  /**
   * `unknown_cast_member` — a voice for somebody who is not in the cast.
   * `missing_voice` — a cast member the casting forgot (they would read as the narrator).
   * `language_mismatch` — a cast voice in another language than the document's.
   *
   * There is deliberately no "unused voice": a cast member who speaks no line of
   * *this* episode still needs a voice, because the next episode's casting is built
   * from the same document.
   */
  readonly code: "unknown_cast_member" | "missing_voice" | "language_mismatch";
  readonly characterId: string;
  readonly message: string;
}

export interface CastingReport {
  readonly ok: boolean;
  readonly issues: readonly CastingIssue[];
}

/** The character speaking a scene: the presenting one, or `""` for the narrator. */
export function speakerForScene(scene: Scene): string {
  const speaking = scene.characters.find((entry) => SPEAKING_STATES.includes(entry.state));
  return speaking?.characterId ?? "";
}

/**
 * Build a casting for a manifest: the narrator from the configured defaults, and
 * one entry per cast member, honouring explicit overrides.
 */
export function castingFor(
  manifest: SceneManifest,
  defaults: VoiceDefaults = {},
  overrides: readonly CastVoice[] = [],
): VoiceCasting {
  const language = defaults.language ?? DEFAULT_LANGUAGE;
  const format = defaults.format ?? DEFAULT_CASTING_DEFAULTS.format;
  const sampleRate = defaults.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const rate = defaults.rate ?? DEFAULT_RATE;
  const voiceId = defaults.voiceId ?? DEFAULT_CASTING_DEFAULTS.voiceId;

  const byCharacter = new Map(overrides.map((override) => [override.characterId, override]));
  const cast: CastVoice[] = manifest.cast.map((member) => {
    const override = byCharacter.get(member.id);
    return {
      characterId: member.id,
      voiceId: override?.voiceId ?? voiceId,
      // The configured label describes the *narrator's* voice. A cast member is
      // labelled by name unless an override names something else, because the
      // label travels into the artifact as "who is speaking this segment".
      label: override?.label ?? member.name,
      ...(override?.language !== undefined || defaults.language !== undefined
        ? { language: override?.language ?? language }
        : {}),
      ...(override?.gender !== undefined
        ? { gender: override.gender }
        : defaults.gender !== undefined
          ? { gender: defaults.gender }
          : {}),
      rate: override?.rate ?? rate,
      ...(override?.style !== undefined || defaults.style !== undefined
        ? { style: override?.style ?? defaults.style }
        : {}),
    };
  });

  return VoiceCastingSchema.parse({
    version: 1,
    language,
    format,
    sampleRate,
    rate,
    narrator: {
      voiceId,
      label: defaults.label ?? "Narrator",
      language,
      ...(defaults.gender !== undefined ? { gender: defaults.gender } : {}),
      rate,
      ...(defaults.style !== undefined ? { style: defaults.style } : {}),
    },
    cast,
  });
}

/** The plan for whoever speaks a scene: a cast voice, or the narrator's. */
export function voicePlanFor(casting: VoiceCasting, characterId = ""): VoicePlan {
  if (characterId === "") {
    return {
      voiceId: casting.narrator.voiceId,
      label: casting.narrator.label ?? "Narrator",
      language: casting.narrator.language ?? casting.language,
      ...(casting.narrator.gender !== undefined ? { gender: casting.narrator.gender } : {}),
      rate: casting.narrator.rate ?? casting.rate,
      ...(casting.narrator.style !== undefined ? { style: casting.narrator.style } : {}),
      format: casting.format,
      sampleRate: casting.sampleRate,
    };
  }

  const member = casting.cast.find((entry) => entry.characterId === characterId);
  return {
    voiceId: member?.voiceId ?? casting.narrator.voiceId,
    label: member?.label ?? casting.narrator.label ?? "Narrator",
    language: member?.language ?? casting.narrator.language ?? casting.language,
    ...(member?.gender !== undefined
      ? { gender: member.gender }
      : casting.narrator.gender !== undefined
        ? { gender: casting.narrator.gender }
        : {}),
    rate: member?.rate ?? casting.narrator.rate ?? casting.rate,
    ...(member?.style !== undefined || casting.narrator.style !== undefined
      ? { style: member?.style ?? casting.narrator.style }
      : {}),
    format: casting.format,
    sampleRate: casting.sampleRate,
  };
}

export function isResolvedVoiceSettings(value: unknown): value is VoiceSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { voiceId?: unknown }).voiceId === "string" &&
    (value as { voiceId: string }).voiceId !== ""
  );
}

/**
 * Resolve a plan against the adapter's real voice list.
 *
 * The only substitution that ever happens is `""` → the adapter's first voice;
 * a *named* voice that the adapter does not offer is never silently swapped for a
 * different one — that would ship the wrong voice in an artifact. It is reported
 * as `voice_unavailable` and the segment fails, which is what the operator needs
 * to see.
 */
export function resolveVoicePlan(
  plan: VoicePlan,
  available: readonly VoiceProfileLike[],
): { readonly settings: VoiceSettings } | { readonly issue: Omit<AudioIssue, "severity"> } {
  const offered = available.find((voice) => voice.id === plan.voiceId);
  const fallback = available[0];

  if (plan.voiceId !== "" && offered === undefined) {
    return {
      issue: {
        code: "voice_unavailable",
        sceneId: "",
        segmentId: "",
        message:
          `the configured voice "${plan.voiceId}" is not offered by the adapter ` +
          `(it offers: ${available.map((voice) => voice.id).join(", ") || "none"})`,
      },
    };
  }

  const chosen = offered ?? fallback;
  if (chosen === undefined) {
    return {
      issue: {
        code: "voice_unavailable",
        sceneId: "",
        segmentId: "",
        message: `the adapter offers no voices, so "${plan.label}" cannot be spoken`,
      },
    };
  }

  return {
    settings: {
      voiceId: chosen.id,
      label: plan.label === "" ? chosen.label : plan.label,
      language: plan.language,
      ...(plan.gender !== undefined
        ? { gender: plan.gender }
        : chosen.gender !== undefined
          ? { gender: chosen.gender }
          : {}),
      rate: plan.rate,
      ...(plan.style !== undefined ? { style: plan.style } : {}),
      format: plan.format,
      sampleRate: plan.sampleRate,
    },
  };
}

/**
 * Check a casting against the manifest it will voice: every cast member needs a
 * voice, no voice may name somebody who is not in the cast, and a language only
 * makes sense if it is the language of the document.
 */
export function validateCasting(casting: VoiceCasting, manifest: SceneManifest): CastingReport {
  const issues: CastingIssue[] = [];
  const castIds = new Set(manifest.cast.map((member) => member.id));
  const castEntries = new Set<string>();

  for (const member of casting.cast) {
    castEntries.add(member.characterId);
    if (!castIds.has(member.characterId)) {
      issues.push({
        code: "unknown_cast_member",
        characterId: member.characterId,
        message: `the casting gives a voice to "${member.characterId}", who is not in the cast`,
      });
    }
    if (member.language !== undefined && member.language !== casting.language) {
      issues.push({
        code: "language_mismatch",
        characterId: member.characterId,
        message: `"${member.characterId}" is cast in ${member.language}, but the casting is ${casting.language}`,
      });
    }
  }

  for (const member of manifest.cast) {
    if (!castEntries.has(member.id)) {
      issues.push({
        code: "missing_voice",
        characterId: member.id,
        message: `"${member.id}" is in the cast but has no voice (it would read as the narrator)`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}
