import { z } from "zod";

/**
 * The audio document schemas (Phase 10).
 *
 * Two documents live here:
 *
 * - **`VoiceCasting`** — *configuration*: which voice speaks for which cast
 *   member. It is deliberately small and separable from the scene manifest, so a
 *   video can be re-voiced without touching its scenes (and a test can cast two
 *   fake voices over one manifest).
 * - **`AudioTrack`** — the *artifact*: one synthesis segment per scene (the text
 *   that was spoken, the voice, the container, the bytes in the CAS, the measured
 *   duration), and the timing document derived from those durations
 *   (`sentences[]`, `scenes[]`, `totals`) that the caption, mux and QA stages
 *   read instead of re-guessing what the voice did.
 *
 * Everything is strict: an unknown field is a parse error, so a typo in a cache
 * index or a hand-written casting is caught where it is written, not later in a
 * frame that shows the wrong person talking.
 */

/** Ids follow the scene manifest's rule: an id can be copied between documents. */
export const AudioIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u, "must be 1–64 characters of [A-Za-z0-9_.:-]");

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "must be a sha256 hex digest");

/** An ISO-8601 timestamp with a UTC offset. */
export const TimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u,
    "must be an ISO-8601 UTC timestamp",
  );

export const AudioFormatSchema = z.enum(["wav", "mp3"]);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export const VoiceGenderSchema = z.enum(["feminine", "masculine", "neutral"]);
export type VoiceGender = z.infer<typeof VoiceGenderSchema>;

/**
 * A configured voice id, or `""` for "whatever the adapter lists first".
 *
 * The empty form exists so an installation is valid before it has a voice
 * account: nothing has to be guessed, and the resolved id is written into every
 * segment of the track, so the ambiguity never reaches an artifact.
 */
export const OptionalVoiceIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$|^$/u,
    'must be "" or 1–64 characters of [A-Za-z0-9_.:-]',
  );

/** Everything a synthesis call is made with, resolved (never ambiguous). */
export const VoiceSettingsSchema = z.strictObject({
  voiceId: AudioIdSchema,
  label: z.string().min(1).max(80),
  language: z.string().min(2).max(16),
  gender: VoiceGenderSchema.optional(),
  /** Playback rate multiplier, 1 = the provider's own pace. */
  rate: z.number().min(0.5).max(2),
  style: z.string().min(1).max(40).optional(),
  format: AudioFormatSchema,
  sampleRate: z.number().int().min(8_000).max(48_000),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/** One cast member's voice, overriding the casting's defaults. */
export const CastVoiceSchema = z.strictObject({
  characterId: AudioIdSchema,
  voiceId: OptionalVoiceIdSchema,
  label: z.string().min(1).max(80).optional(),
  language: z.string().min(2).max(16).optional(),
  gender: VoiceGenderSchema.optional(),
  rate: z.number().min(0.5).max(2).optional(),
  style: z.string().min(1).max(40).optional(),
});
export type CastVoice = z.infer<typeof CastVoiceSchema>;

const NarratorVoiceSchema = z.strictObject({
  voiceId: OptionalVoiceIdSchema,
  label: z.string().min(1).max(80).optional(),
  language: z.string().min(2).max(16).optional(),
  gender: VoiceGenderSchema.optional(),
  rate: z.number().min(0.5).max(2).optional(),
  style: z.string().min(1).max(40).optional(),
});

export const VoiceCastingSchema = z
  .strictObject({
    version: z.literal(1),
    language: z.string().min(2).max(16),
    format: AudioFormatSchema,
    sampleRate: z.number().int().min(8_000).max(48_000),
    rate: z.number().min(0.5).max(2),
    /** The voice for scenes that show nobody (or nothing) on screen. */
    narrator: NarratorVoiceSchema,
    cast: z.array(CastVoiceSchema).max(12),
  })
  .superRefine((casting, ctx) => {
    const seen = new Set<string>();
    for (const [index, member] of casting.cast.entries()) {
      if (seen.has(member.characterId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cast", index, "characterId"],
          message: `casting has two voices for "${member.characterId}"`,
          params: { code: "duplicate_voice" },
        });
      }
      seen.add(member.characterId);
    }
  });
export type VoiceCasting = z.infer<typeof VoiceCastingSchema>;

// ── Issues ────────────────────────────────────────────────────────────────

export const AUDIO_ISSUE_CODES = [
  /** The provider failed for a segment, after every attempt. */
  "provider_failed",
  /** The capability degraded to its manual fallback: a human has to supply audio. */
  "manual_required",
  /** The provider returned no bytes. */
  "empty_audio",
  /** The provider returned more bytes than the stage will accept. */
  "bytes_too_large",
  /** Nothing measured the duration, so it was estimated from the words. */
  "duration_missing",
  /** The provider's duration disagrees with the bytes it returned. */
  "duration_mismatch",
  /** An operator-supplied clip for a segment is not in the CAS. */
  "operator_audio_missing",
  /** An operator-supplied clip is in the CAS but unusable. */
  "operator_audio_invalid",
  /** A cached clip is referenced by the index but missing from the CAS. */
  "cache_stale",
  /** The configured voice is not one the adapter offers. */
  "voice_unavailable",
  /** The adapter does not produce the container the casting asks for. */
  "unsupported_format",
  /** A scene has no narration text, so it has no audio. */
  "silent_scene",
  /** The narration's sentence ids and the text's sentence count disagree. */
  "timing_mismatch",
  /** A scene's speech needs more time than the plan gave it. */
  "spoken_overflow",
] as const;
export type AudioIssueCode = (typeof AUDIO_ISSUE_CODES)[number];

/**
 * Which codes make a track unfit for downstream stages. Everything else is a
 * note: a caption pass can run on an estimated duration, but not on a segment
 * that has no bytes.
 */
export const HARD_AUDIO_ISSUE_CODES: readonly AudioIssueCode[] = [
  "provider_failed",
  "manual_required",
  "empty_audio",
  "bytes_too_large",
  "operator_audio_missing",
  "operator_audio_invalid",
  "voice_unavailable",
  "unsupported_format",
];

export const AudioIssueSchema = z.strictObject({
  code: z.enum(AUDIO_ISSUE_CODES),
  severity: z.enum(["error", "warning"]),
  /** `""` when the issue is about the run rather than one scene. */
  sceneId: z.string().default(""),
  segmentId: z.string().default(""),
  message: z.string().min(1),
});
export type AudioIssue = z.infer<typeof AudioIssueSchema>;

export function isHardAudioIssue(code: AudioIssueCode): boolean {
  return HARD_AUDIO_ISSUE_CODES.includes(code);
}

// ── Segments ──────────────────────────────────────────────────────────────

/** How a segment's duration was established. */
export const DurationMethodSchema = z.enum([
  /** The provider reported it and the bytes agreed (or there was nothing to probe). */
  "provider",
  /** The bytes were parsed (a WAV header, an MP3 frame header). */
  "probed",
  /** Nothing measured it: words ÷ words-per-second. */
  "estimated",
]);
export type DurationMethod = z.infer<typeof DurationMethodSchema>;

export const WordTimingSchema = z.strictObject({
  word: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const SegmentAudioRefSchema = z.strictObject({
  hash: Sha256Schema,
  bytes: z.number().int().positive(),
  mime: z.string().min(3).max(80),
  format: AudioFormatSchema,
  sampleRate: z.number().int().min(8_000).max(48_000),
  durationMs: z.number().int().positive(),
});
export type SegmentAudioRef = z.infer<typeof SegmentAudioRefSchema>;

export const AudioSegmentSchema = z.strictObject({
  id: AudioIdSchema,
  sceneId: AudioIdSchema,
  index: z.number().int().min(0),
  sceneType: z.string().min(1).max(20),
  /** Where the segment sits in the *spoken* timeline (which the plan may not match). */
  startSec: z.number().min(0),
  durationSec: z.number().positive(),
  /** Where the plan put the scene, for the drift report. */
  plannedStartSec: z.number().min(0),
  plannedDurationSec: z.number().positive(),
  text: z.string().min(1),
  sentenceIds: z.array(AudioIdSchema),
  words: z.number().int().positive(),
  characters: z.number().int().positive(),
  voice: VoiceSettingsSchema,
  /** Adapter id that produced the clip (`"operator"` for a human's clip). */
  provider: z.string().min(1).max(60),
  /** Attempts this segment took, including the first. */
  attempts: z.number().int().min(0),
  /** True when the clip came from the segment cache instead of the provider. */
  cached: z.boolean(),
  durationMethod: DurationMethodSchema,
  audio: SegmentAudioRefSchema,
  wordTimings: z.array(WordTimingSchema).optional(),
});
export type AudioSegment = z.infer<typeof AudioSegmentSchema>;

// ── Timing ────────────────────────────────────────────────────────────────

export const SentenceTimingSchema = z.strictObject({
  sentenceId: z.string().default(""),
  sceneId: AudioIdSchema,
  segmentId: AudioIdSchema,
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  durationSec: z.number().min(0),
  words: z.number().int().min(0),
  characters: z.number().int().min(0),
  /** How the sentence's window was placed inside its segment. */
  method: z.enum(["word_timings", "proportional"]),
});
export type SentenceTiming = z.infer<typeof SentenceTimingSchema>;

export const SceneTimingSchema = z.strictObject({
  sceneId: AudioIdSchema,
  index: z.number().int().min(0),
  type: z.string().min(1).max(20),
  segmentId: z.string().default(""),
  plannedStartSec: z.number().min(0),
  plannedDurationSec: z.number().min(0),
  spokenStartSec: z.number().min(0),
  spokenDurationSec: z.number().min(0),
  /** Spoken minus planned: positive means the scene speaks longer than planned. */
  driftSec: z.number(),
  verdict: z.enum(["fits", "over", "short", "silent"]),
});
export type SceneTiming = z.infer<typeof SceneTimingSchema>;

export const AudioTotalsSchema = z.strictObject({
  scenes: z.number().int().min(0),
  segments: z.number().int().min(0),
  words: z.number().int().min(0),
  characters: z.number().int().min(0),
  /** Words per second actually spoken, across every segment with audio. */
  wordsPerSecond: z.number().min(0),
  plannedDurationSec: z.number().min(0),
  spokenDurationSec: z.number().min(0),
  driftSec: z.number(),
  cachedSegments: z.number().int().min(0),
  operatorSegments: z.number().int().min(0),
  estimatedSegments: z.number().int().min(0),
  failedSegments: z.number().int().min(0),
});
export type AudioTotals = z.infer<typeof AudioTotalsSchema>;

export const ProvenanceSchema = z.strictObject({
  name: z.string().min(1).max(60),
  version: z.string().min(1).max(20),
  steps: z.array(z.string().min(1).max(80)),
  /** Steps whose *audio* came from a model: the voice itself. */
  aiSteps: z.array(z.string().min(1).max(80)),
  deterministicSteps: z.array(z.string().min(1).max(80)),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CastingSummarySchema = z.strictObject({
  narrator: z.strictObject({
    voiceId: z.string().default(""),
    label: z.string().min(1).max(80),
    language: z.string().min(2).max(16),
    rate: z.number().min(0.5).max(2),
  }),
  cast: z.array(
    z.strictObject({
      characterId: AudioIdSchema,
      voiceId: z.string().default(""),
    }),
  ),
  format: AudioFormatSchema,
  sampleRate: z.number().int().min(8_000).max(48_000),
});

// ── The artifact ──────────────────────────────────────────────────────────

export const AudioTrackSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: TimestampSchema,
  language: z.string().min(2).max(16),
  scriptHash: z.union([Sha256Schema, z.literal("")]),
  manifestHash: Sha256Schema,
  casting: CastingSummarySchema,
  segments: z.array(AudioSegmentSchema),
  sentences: z.array(SentenceTimingSchema),
  scenes: z.array(SceneTimingSchema),
  totals: AudioTotalsSchema,
  issues: z.array(AudioIssueSchema),
  warnings: z.array(z.string().min(1)),
  provenance: ProvenanceSchema,
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export function parseAudioTrack(input: unknown): AudioTrack {
  return AudioTrackSchema.parse(input);
}

/** Canonical bytes for the CAS: the parsed document, indented, one trailing newline. */
export function audioTrackBytes(track: AudioTrack): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(AudioTrackSchema.parse(track), null, 2)}\n`);
}

/** True when the track is safe for downstream stages (no hard issues). */
export function isComplete(track: AudioTrack): boolean {
  return !track.issues.some((issue) => isHardAudioIssue(issue.code));
}

// ── Operator-supplied audio (the manual fallback) ─────────────────────────

/**
 * A clip a human supplied for one scene: the bytes are already in the CAS (an
 * upload is a `storage.put`, never a path in the database — AD-09), and the stage
 * adopts it in place of a synthesis call.
 */
export const OperatorAudioSchema = z.strictObject({
  sceneId: AudioIdSchema,
  hash: Sha256Schema,
  mime: z.string().min(3).max(80).optional(),
  durationMs: z.number().int().positive().optional(),
});
export type OperatorAudio = z.infer<typeof OperatorAudioSchema>;

export const OperatorAudioListSchema = z.array(OperatorAudioSchema).max(64);

// ── What a probe found in the bytes ───────────────────────────────────────

export const AudioProbeSchema = z.strictObject({
  format: z.enum(["wav", "mp3", "unknown"]),
  mime: z.string().min(1).max(80),
  durationMs: z.number().int().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitsPerSample: z.number().int().positive().optional(),
  /** `true` when the duration came from a header the codec always writes. */
  exact: z.boolean(),
});
export type AudioProbe = z.infer<typeof AudioProbeSchema>;
