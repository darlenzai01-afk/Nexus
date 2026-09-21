/**
 * `@nexus/audio` — the audio architecture (Phase 10).
 *
 * Pipeline position: a validated **scene manifest** (Phase 7) plus a **voice
 * casting** go in; **clips in the CAS** and one **audio track** document come out,
 * carrying the timing the rest of the pipeline reads. The pieces, in the order a
 * run uses them:
 *
 * 1. `castingFor` / `validateCasting` — voice configuration (`voices.ts`).
 * 2. `segmentPlansFrom` — one segment per scene, with the speaker and the voice
 *    plan (`requests.ts`).
 * 3. `synthesizeNarration` — the TTS capability behind retries, a segment cache,
 *    duration verification and coded failure handling (`pipeline.ts`).
 * 4. `probeAudio` — duration metadata read from the bytes themselves (`probe.ts`).
 * 5. `persistAudioTrack` / `loadAudioTrack` — the `audio` artifacts (`persist.ts`).
 * 6. `createVoiceTask` — the `voice` stage the orchestrator runs (`task.ts`).
 * 7. `buildCaptionTrack` — the cues, derived from the narration and the measured
 *    timing rather than authored per scene (`captions.ts`), and `createCaptionsTask`,
 *    the `captions` stage that publishes them (`captions-task.ts`).
 *
 * Nothing here reaches the network on its own: the adapter does that, through the
 * provider layer's shared `invoke` pipeline (budget, cache, rate limit, retry,
 * metering). Tests run the whole thing against the deterministic fake TTS.
 */

export {
  AUDIO_ISSUE_CODES,
  HARD_AUDIO_ISSUE_CODES,
  AudioIssueSchema,
  AudioFormatSchema,
  AudioIdSchema,
  AudioProbeSchema,
  AudioSegmentSchema,
  AudioTotalsSchema,
  AudioTrackSchema,
  CastVoiceSchema,
  CastingSummarySchema,
  DurationMethodSchema,
  OperatorAudioListSchema,
  OperatorAudioSchema,
  ProvenanceSchema,
  SceneTimingSchema,
  SegmentAudioRefSchema,
  SentenceTimingSchema,
  Sha256Schema,
  TimestampSchema,
  VoiceCastingSchema,
  VoiceGenderSchema,
  VoiceSettingsSchema,
  WordTimingSchema,
  audioTrackBytes,
  isComplete,
  isHardAudioIssue,
  parseAudioTrack,
  type AudioFormat,
  type AudioIssue,
  type AudioIssueCode,
  type AudioProbe,
  type AudioSegment,
  type AudioTotals,
  type AudioTrack,
  type CastVoice,
  type DurationMethod,
  type OperatorAudio,
  type Provenance,
  type SceneTiming,
  type SegmentAudioRef,
  type SentenceTiming,
  type VoiceCasting,
  type VoiceGender,
  type VoiceSettings,
  type WordTiming,
} from "./schema.js";

export {
  DEFAULT_CASTING_DEFAULTS,
  DEFAULT_LANGUAGE,
  DEFAULT_RATE,
  DEFAULT_SAMPLE_RATE,
  SPEAKING_STATES,
  castingFor,
  isResolvedVoiceSettings,
  resolveVoicePlan,
  speakerForScene,
  validateCasting,
  voicePlanFor,
  type CastingIssue,
  type CastingReport,
  type VoiceDefaults,
  type VoicePlan,
  type VoiceProfileLike,
} from "./voices.js";

export {
  DEFAULT_WORDS_PER_SECOND,
  estimateDurationMs,
  segmentIdForScene,
  segmentPlansFrom,
  synthesisRequestFor,
  type SegmentPlan,
  type SegmentPlans,
} from "./requests.js";

export { probeAudio } from "./probe.js";

export {
  CachedAudioSchema,
  FileSegmentCache,
  MemorySegmentCache,
  NullSegmentCache,
  segmentCacheFor,
  segmentCacheKey,
  type AudioCacheKeyParts,
  type CachedAudio,
  type SegmentAudioCache,
} from "./cache.js";

export {
  AUDIO_ENGINE_NAME,
  AUDIO_ENGINE_VERSION,
  DEFAULT_AUDIO_TUNING,
  backoffMs,
  synthesizeNarration,
  type AudioPipelineDeps,
  type AudioPipelineInput,
  type AudioRunReport,
  type AudioTuning,
} from "./pipeline.js";

export { AudioError, isAudioError, messageOf, type AudioErrorCode } from "./errors.js";

export {
  AUDIO_ARTIFACT_KIND,
  AUDIO_SEGMENT_ARTIFACT_ROLE,
  AUDIO_TRACK_ARTIFACT_ROLE,
  audioSegmentArtifactRefs,
  audioTrackArtifactRef,
  codecOf,
  loadAudioTrack,
  persistAudioTrack,
  readSegmentAudio,
  registerSegmentAudio,
  type PersistAudioDeps,
  type PersistedAudioTrack,
} from "./persist.js";

export { VOICE_STAGE_KEY, createVoiceTask, type VoiceTaskDeps } from "./task.js";

export {
  CAPTION_ENGINE_NAME,
  CAPTION_ENGINE_VERSION,
  CAPTION_ISSUE_CODES,
  CaptionCueSchema,
  CaptionIssueSchema,
  CaptionLineSchema,
  CaptionSettingsSchema,
  CaptionTotalsSchema,
  CaptionTrackSchema,
  DEFAULT_CAPTION_TUNING,
  HARD_CAPTION_ISSUE_CODES,
  buildCaptionTrack,
  captionLines,
  captionTextAt,
  captionTrackBytes,
  cueAt,
  cueText,
  isCaptionReady,
  isHardCaptionIssue,
  parseCaptionTrack,
  wrapTokens,
  type CaptionBuildOptions,
  type CaptionCue,
  type CaptionIssue,
  type CaptionIssueCode,
  type CaptionLine,
  type CaptionSettings,
  type CaptionTrack,
  type CaptionTuning,
} from "./captions.js";

export {
  CAPTIONS_STAGE_KEY,
  CAPTION_ARTIFACT_KIND,
  CAPTION_TRACK_ARTIFACT_ROLE,
  captionTrackArtifactRef,
  createCaptionsTask,
  loadCaptionTrack,
  persistCaptionTrack,
  type CaptionPersistDeps,
  type CaptionsTaskDeps,
  type PersistedCaptionTrack,
} from "./captions-task.js";
