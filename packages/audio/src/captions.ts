import { normalizeWhitespace, sentences as sentenceSplit } from "@nexus/script";
import { z } from "zod";

import {
  AudioIdSchema,
  Sha256Schema,
  TimestampSchema,
  type AudioTrack,
  type SentenceTiming,
} from "./schema.js";

/**
 * The caption/timing engine (Phase 10).
 *
 * **Captions are derived, never authored.** A scene manifest carries narration
 * text and nothing that resembles a subtitle: no per-scene caption string, no
 * manual line breaks, no hand-timed cue. Those would be a second copy of the
 * words that drifts from the first the moment anybody edits the script, and they
 * would make every later stage (dubbing, re-cut, re-pace) re-do work by hand.
 *
 * Instead a `CaptionTrack` is *computed* from the two documents that already
 * exist: the **audio track's timing** (where each sentence was actually spoken,
 * measured from the clip's own milliseconds) and the **narration text** in the
 * manifest's scenes (split with the same sentence splitter the script and scene
 * planner used). Everything in the output is a function of those two inputs, so
 * the whole engine is deterministic — there is no model in this file, and
 * `provenance.aiSteps` is empty on purpose (AD-12).
 *
 * Two properties the engine is built around:
 *
 * 1. **Safe line lengths.** A cue never shows more than `maxLinesPerCue` lines of
 *    at most `maxCharsPerLine` characters, broken at word boundaries, preferring a
 *    punctuation break ("…crossings a day, / and it is still growing") over an
 *    arbitrary one. A single unbreakable word longer than the budget is reported
 *    (`long_line`) rather than cut in half.
 * 2. **Readable timing.** Cues never overlap, they follow the sentence windows the
 *    voice stage measured, a cue that would flash by in less than `minCueMs` is
 *    *held* (into the following silence, not over the next line), a cue that would
 *    sit on screen longer than `maxCueMs` is split, and a cue whose reading speed
 *    exceeds `maxCharsPerSecond` is reported (`too_fast`) — fast captions are a
 *    defect you can only see in the numbers, not in a still frame.
 *
 * The invariant that ties the two together: **the concatenation of a sentence's
 * cues is exactly the sentence's text.** Nothing is reworded, nothing is dropped
 * for being too long, and nothing is duplicated when a sentence is split.
 */

export const CAPTION_ENGINE_NAME = "nexus-captions";
export const CAPTION_ENGINE_VERSION = "1.0.0";

export interface CaptionTuning {
  /** Hard wrap width of one caption line, in characters. */
  readonly maxCharsPerLine: number;
  /** Lines shown at once. Two is the broadcast convention; three is the ceiling. */
  readonly maxLinesPerCue: number;
  /** A cue shorter than this is held on screen longer. */
  readonly minCueMs: number;
  /** A cue that would sit longer than this is split into more cues. */
  readonly maxCueMs: number;
  /** Silence kept between two consecutive cues. */
  readonly gapMs: number;
  /** Above this reading speed a cue is reported as too fast. */
  readonly maxCharsPerSecond: number;
}

export const DEFAULT_CAPTION_TUNING: CaptionTuning = {
  maxCharsPerLine: 42,
  maxLinesPerCue: 2,
  minCueMs: 800,
  maxCueMs: 7_000,
  gapMs: 0,
  maxCharsPerSecond: 25,
};

export const CAPTION_ISSUE_CODES = [
  /** A word is longer than a caption line and had to be broken by hand. */
  "long_line",
  /** A cue still shows too briefly after being held. */
  "cue_too_short",
  /** A cue that cannot be split further sits on screen too long. */
  "cue_too_long",
  /** A cue reads faster than the readable ceiling. */
  "too_fast",
  /** A scene has no audio, so nothing can be captioned for it. */
  "silent_scene",
  /** The voice stage left no sentence window; the cue window was estimated. */
  "missing_window",
  /** Two cues would have overlapped; the later one was pushed (an invariant break). */
  "overlap",
] as const;
export type CaptionIssueCode = (typeof CAPTION_ISSUE_CODES)[number];

/** Codes that make a caption track unfit for burn-in. Everything else is a note. */
export const HARD_CAPTION_ISSUE_CODES: readonly CaptionIssueCode[] = ["overlap"];

export const CaptionIssueSchema = z.strictObject({
  code: z.enum(CAPTION_ISSUE_CODES),
  severity: z.enum(["error", "warning"]),
  cueId: z.string().default(""),
  sceneId: z.string().default(""),
  sentenceId: z.string().default(""),
  message: z.string().min(1),
});
export type CaptionIssue = z.infer<typeof CaptionIssueSchema>;

export function isHardCaptionIssue(code: CaptionIssueCode): boolean {
  return HARD_CAPTION_ISSUE_CODES.includes(code);
}

/**
 * Build an issue with the document's defaults filled in, so a call site only
 * names what it knows (a cue issue names its cue; a scene-level one does not).
 */
export function captionIssue(entry: {
  readonly code: CaptionIssueCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly cueId?: string;
  readonly sceneId?: string;
  readonly sentenceId?: string;
}): CaptionIssue {
  return {
    code: entry.code,
    severity: entry.severity,
    message: entry.message,
    cueId: entry.cueId ?? "",
    sceneId: entry.sceneId ?? "",
    sentenceId: entry.sentenceId ?? "",
  };
}

/** The tuning a track was built with, snapshotted so the document explains itself. */
export const CaptionSettingsSchema = z.strictObject({
  maxCharsPerLine: z.number().int().min(10).max(80),
  maxLinesPerCue: z.number().int().min(1).max(3),
  minCueMs: z.number().int().min(100).max(5_000),
  maxCueMs: z.number().int().min(1_000).max(15_000),
  gapMs: z.number().int().min(0).max(1_000),
  maxCharsPerSecond: z.number().min(5).max(60),
});
export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;

export const CaptionLineSchema = z.strictObject({
  text: z.string().min(1).max(120),
  words: z.number().int().min(1),
  characters: z.number().int().min(1),
});
export type CaptionLine = z.infer<typeof CaptionLineSchema>;

export const CaptionCueSchema = z.strictObject({
  /** `cue_0001` — stable across runs of the same document. */
  id: z.string().regex(/^cue_\d{4,}$/u),
  sceneId: AudioIdSchema,
  segmentId: AudioIdSchema,
  /** The script sentence this cue speaks; `""` when the timing had no id. */
  sentenceId: z.string().default(""),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  lines: z.array(CaptionLineSchema).min(1).max(3),
  words: z.number().int().min(1),
  characters: z.number().int().min(1),
  /**
   * How the cue's *window* was established: the sentence's own window, a share of
   * it after a split, or an estimate because the voice stage left no window.
   */
  method: z.enum(["sentence", "split", "estimated"]),
});
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const CaptionTotalsSchema = z.strictObject({
  cues: z.number().int().min(0),
  lines: z.number().int().min(0),
  words: z.number().int().min(0),
  characters: z.number().int().min(0),
  /** First cue's start — the caption track's offset (usually 0). */
  startMs: z.number().int().min(0),
  /** Last cue's end. */
  endMs: z.number().int().min(0),
  /** Total time captions are on screen (the sum of the cue durations). */
  captionDurationSec: z.number().min(0),
  /** Speaking time the audio track reports, for the coverage ratio. */
  spokenDurationSec: z.number().min(0),
  shortestCueMs: z.number().int().min(0),
  longestCueMs: z.number().int().min(0),
  /** The fastest cue's reading speed, characters per second. */
  maxCharactersPerSecond: z.number().min(0),
  /** Sentences whose window the voice stage did not report. */
  estimatedCues: z.number().int().min(0),
  /** Cues faster than the configured ceiling. */
  overBudgetCues: z.number().int().min(0),
  /** Scenes with no audio to caption. */
  silentScenes: z.number().int().min(0),
});

export const CaptionProvenanceSchema = z.strictObject({
  name: z.string().min(1).max(60),
  version: z.string().min(1).max(20),
  steps: z.array(z.string().min(1).max(80)),
  /** Empty by construction: captions are derived, never generated by a model. */
  aiSteps: z.array(z.string().min(1).max(80)),
  deterministicSteps: z.array(z.string().min(1).max(80)),
});

export const CaptionTrackSchema = z
  .strictObject({
    version: z.literal(1),
    generatedAt: TimestampSchema,
    language: z.string().min(2).max(16),
    scriptHash: z.union([Sha256Schema, z.literal("")]),
    /** The manifest whose narration these cues carry. */
    manifestHash: Sha256Schema,
    /** The audio track the windows came from (`""` when timing was estimated). */
    audioTrackHash: z.union([Sha256Schema, z.literal("")]),
    settings: CaptionSettingsSchema,
    cues: z.array(CaptionCueSchema),
    totals: CaptionTotalsSchema,
    issues: z.array(CaptionIssueSchema),
    warnings: z.array(z.string().min(1)),
    provenance: CaptionProvenanceSchema,
  })
  .superRefine((track, ctx) => {
    let previousEnd = -1;
    let previousId = "";
    for (const [index, cue] of track.cues.entries()) {
      if (cue.endMs < cue.startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", index, "endMs"],
          message: `cue ${cue.id} ends (${cue.endMs}ms) before it starts (${cue.startMs}ms)`,
          params: { code: "cue_order" },
        });
      }
      if (cue.startMs < previousEnd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", index, "startMs"],
          message: `cue ${cue.id} starts inside ${previousId}: cues may not overlap`,
          params: { code: "overlap" },
        });
      }
      if (cue.lines.length > track.settings.maxLinesPerCue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", index, "lines"],
          message: `cue ${cue.id} shows ${cue.lines.length} line(s), over the ${track.settings.maxLinesPerCue}-line limit`,
          params: { code: "too_many_lines" },
        });
      }
      previousEnd = cue.endMs;
      previousId = cue.id;
    }
  });
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;

export function parseCaptionTrack(input: unknown): CaptionTrack {
  return CaptionTrackSchema.parse(input);
}

/** Canonical bytes for the CAS: the parsed document, indented, one trailing newline. */
export function captionTrackBytes(track: CaptionTrack): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(CaptionTrackSchema.parse(track), null, 2)}\n`);
}

/** True when the track is fit to burn in (no hard issue). */
export function isCaptionReady(track: CaptionTrack): boolean {
  return !track.issues.some((issue) => isHardCaptionIssue(issue.code));
}

/** The cue on screen at `ms`, or the next one when nothing is showing. */
export function cueAt(track: CaptionTrack, ms: number): CaptionCue | undefined {
  return track.cues.find((cue) => cue.startMs <= ms && ms < cue.endMs);
}

/** The text shown at `ms` (`""` between cues). */
export function captionTextAt(track: CaptionTrack, ms: number): string {
  return cueText(cueAt(track, ms));
}

export function cueText(cue: CaptionCue | undefined): string {
  return cue === undefined ? "" : cue.lines.map((line) => line.text).join(" ");
}

// ── The engine ────────────────────────────────────────────────────────────

export interface CaptionBuildOptions {
  readonly now?: string;
  /** Hash of the audio track artifact, for traceability. */
  readonly audioTrackHash?: string;
  readonly tuning?: Partial<CaptionTuning>;
}

interface CaptionSentence {
  readonly text: string;
  readonly sentenceId: string;
  readonly sceneId: string;
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly estimated: boolean;
}

interface CueDraft {
  readonly id: string;
  readonly text: string;
  readonly sentenceId: string;
  readonly sceneId: string;
  readonly segmentId: string;
  readonly method: CaptionCue["method"];
  startMs: number;
  endMs: number;
}

/**
 * Build the caption track for an audio track.
 *
 * The cues follow the *spoken* timeline (the audio track's), not the plan's: when
 * a scene runs long, its captions move with the voice, which is the whole reason
 * the voice stage measured the clips instead of trusting the estimate.
 */
export function buildCaptionTrack(
  track: AudioTrack,
  options: CaptionBuildOptions = {},
): CaptionTrack {
  const settings: CaptionSettings = CaptionSettingsSchema.parse({
    ...DEFAULT_CAPTION_TUNING,
    ...options.tuning,
  });
  const issues: CaptionIssue[] = [];

  const { sentences, silentScenes } = captionSentencesFor(track, issues);

  const drafts: Omit<CueDraft, "id">[] = [];
  for (const sentence of sentences) {
    for (const draft of cueDraftsFor(sentence, settings, issues)) drafts.push(draft);
  }
  // Number the cues once the text is settled, so a cue that is later held, split
  // or reported can always be named.
  const numbered: CueDraft[] = drafts.map((draft, index) => ({ ...draft, id: cueIdFor(index) }));

  const held = holdShortCues(numbered, settings, issues);
  const cues = held.map((draft) => toCue(draft, settings));
  for (const cue of cues) issues.push(...readabilityIssues(cue, settings));

  const totals = totalsFor(cues, track, silentScenes, settings);
  const warnings: string[] = [];
  if (track.totals.estimatedSegments > 0 || cues.some((cue) => cue.method === "estimated")) {
    warnings.push(
      "some cue windows come from an estimated duration: the voice stage could not measure every clip, " +
        "so those cues may drift once the audio is muxed",
    );
  }
  if (totals.overBudgetCues > 0) {
    warnings.push(
      `${totals.overBudgetCues} cue(s) read faster than ${settings.maxCharsPerSecond} characters/second: ` +
        "consider tightening the narration rather than the captions",
    );
  }

  return CaptionTrackSchema.parse({
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    language: track.language,
    scriptHash: track.scriptHash,
    manifestHash: track.manifestHash,
    audioTrackHash: options.audioTrackHash ?? "",
    settings,
    cues,
    totals,
    issues,
    warnings,
    provenance: {
      name: CAPTION_ENGINE_NAME,
      version: CAPTION_ENGINE_VERSION,
      steps: ["caption.sentences", "caption.lines", "caption.timings"],
      // No model touches captions: they are a derivation of the narration and the
      // measured timing (AD-12).
      aiSteps: [],
      deterministicSteps: ["caption.sentences", "caption.lines", "caption.timings"],
    },
  });
}

/**
 * Pair every spoken sentence with its window.
 *
 * The text comes from the segment (the narration as it was spoken) and is split
 * with the *same* splitter the planner used, so the cue text and the script's
 * sentence ids stay in lock-step. The window comes from the audio track; when it
 * is missing the segment's own window is shared out by characters and the cue
 * says `estimated`.
 */
function captionSentencesFor(
  track: AudioTrack,
  issues: CaptionIssue[],
): { readonly sentences: readonly CaptionSentence[]; readonly silentScenes: number } {
  const windows = new Map<string, SentenceTiming[]>();
  for (const timing of track.sentences) {
    const list = windows.get(timing.segmentId);
    if (list === undefined) windows.set(timing.segmentId, [timing]);
    else list.push(timing);
  }

  const silentScenes = track.scenes.filter((scene) => scene.verdict === "silent").length;
  for (const scene of track.scenes) {
    if (scene.verdict !== "silent") continue;
    issues.push(
      captionIssue({
        code: "silent_scene",
        severity: "warning",
        sceneId: scene.sceneId,
        message:
          `scene ${scene.sceneId} has no audio, so it carries no caption: voice the scene (or supply a clip for it) ` +
          "before burning captions in",
      }),
    );
  }

  const sentences: CaptionSentence[] = [];
  for (const segment of track.segments) {
    const texts = sentenceSplit(normalizeWhitespace(segment.text)).filter(
      (text) => text.trim() !== "",
    );
    if (texts.length === 0) continue;
    const timings = windows.get(segment.id) ?? [];
    const startMs = Math.round(segment.startSec * 1_000);
    const endMs = Math.round((segment.startSec + segment.durationSec) * 1_000);

    if (timings.length === texts.length) {
      for (const [index, text] of texts.entries()) {
        const timing = timings[index];
        if (timing === undefined) continue;
        sentences.push({
          text,
          sentenceId: timing.sentenceId,
          sceneId: segment.sceneId,
          segmentId: segment.id,
          startMs: Math.round(timing.startSec * 1_000),
          endMs: Math.round(timing.endSec * 1_000),
          estimated: false,
        });
      }
      continue;
    }

    issues.push(
      captionIssue({
        code: "missing_window",
        severity: "warning",
        sceneId: segment.sceneId,
        message:
          timings.length === 0
            ? `segment ${segment.id} has no sentence windows in the audio track; its cues are estimated across the clip`
            : `segment ${segment.id} has ${timings.length} sentence window(s) for ${texts.length} sentence(s); ` +
              "its cues are estimated across the clip",
      }),
    );
    const estimated = distributeWindow(startMs, endMs, texts);
    for (const [index, text] of texts.entries()) {
      const share = estimated[index];
      if (share === undefined) continue;
      sentences.push({
        text,
        sentenceId: segment.sentenceIds[index] ?? "",
        sceneId: segment.sceneId,
        segmentId: segment.id,
        startMs: share.startMs,
        endMs: share.endMs,
        estimated: true,
      });
    }
  }

  return { sentences, silentScenes };
}

/** One sentence → one or more cues, each fitting the line budget. */
function cueDraftsFor(
  sentence: CaptionSentence,
  settings: CaptionSettings,
  issues: CaptionIssue[],
): Omit<CueDraft, "id">[] {
  const chunks = chunkText(sentence.text, settings);
  const drafts: Omit<CueDraft, "id">[] = [];
  const windows = distributeWindow(
    sentence.startMs,
    sentence.endMs,
    chunks.map((chunk) => chunk.text),
  );

  for (const [index, chunk] of chunks.entries()) {
    const window = windows[index];
    if (window === undefined) continue;
    for (const piece of splitForDuration(
      chunk.text,
      window.startMs,
      window.endMs,
      settings,
      issues,
      sentence,
    )) {
      drafts.push({
        text: piece.text,
        sentenceId: sentence.sentenceId,
        sceneId: sentence.sceneId,
        segmentId: sentence.segmentId,
        method: sentence.estimated
          ? "estimated"
          : chunks.length > 1 || piece.split
            ? "split"
            : "sentence",
        startMs: piece.startMs,
        endMs: piece.endMs,
      });
    }
  }

  return drafts;
}

interface Chunk {
  readonly text: string;
  readonly tokens: readonly string[];
}

/**
 * Split a sentence into cue-sized chunks.
 *
 * The greedy rule is "as much as fits in a cue", but a break *after punctuation*
 * wins whenever the chunk is already half full: readers get "…a day, / and it is
 * still growing" instead of an arbitrary cut, and the concatenation of the chunks
 * is still the sentence, word for word.
 */
function chunkText(text: string, settings: CaptionSettings): Chunk[] {
  const tokens = text.split(/\s+/u).filter((token) => token !== "");
  // What fits in a cue: every line full, minus the spaces that join them.
  const budget = settings.maxCharsPerLine * settings.maxLinesPerCue + (settings.maxLinesPerCue - 1);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let length = 0;

  const appended = (tokens: readonly string[], currentLength: number, token: string): number =>
    currentLength === 0 ? token.length : currentLength + 1 + token.length;

  const flush = (): void => {
    if (current.length === 0) return;
    const chunk: Chunk = { text: current.join(" "), tokens: current };
    for (const broken of verifyChunk(chunk, settings)) chunks.push(broken);
    current = [];
    length = 0;
  };

  for (const token of tokens) {
    if (current.length > 0 && appended(current, length, token) > budget) flush();
    length = appended(current, length, token);
    current.push(token);
    // A break after punctuation, once the cue is half full, reads better than
    // filling every character: the reader gets the clause, not the cut.
    if (isBreakAfter(token) && length >= budget / 2) flush();
  }
  flush();

  if (chunks.length === 0) return [{ text, tokens }];
  return chunks;
}

/** A chunk that does not fit its line budget is cut back at its last fitting word. */
function verifyChunk(chunk: Chunk, settings: CaptionSettings): Chunk[] {
  const lines = wrapTokens(chunk.tokens, settings.maxCharsPerLine);
  if (lines.length <= settings.maxLinesPerCue) return [chunk];

  const out: Chunk[] = [];
  let current: string[] = [];
  for (const token of chunk.tokens) {
    const candidate = [...current, token];
    if (
      wrapTokens(candidate, settings.maxCharsPerLine).length > settings.maxLinesPerCue &&
      current.length > 0
    ) {
      out.push({ text: current.join(" "), tokens: current });
      current = [token];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) out.push({ text: current.join(" "), tokens: current });
  return out;
}

function isBreakAfter(token: string): boolean {
  return /[,;:—)\]}]$/u.test(token) || /[.!?…]["'”’)]?$/u.test(token);
}

function longestToken(tokens: readonly string[]): string {
  return tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), "");
}

/** Wrap tokens into lines of at most `maxCharsPerLine`, breaking only at spaces. */
export function wrapTokens(tokens: readonly string[], maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current === "" ? token : `${current} ${token}`;
    if (candidate.length <= maxCharsPerLine || current === "") {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = token;
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** The lines one cue shows, from its text. */
export function captionLines(text: string, settings: Partial<CaptionTuning> = {}): string[] {
  const tuning = { ...DEFAULT_CAPTION_TUNING, ...settings };
  return wrapTokens(
    text.split(/\s+/u).filter((token) => token !== ""),
    tuning.maxCharsPerLine,
  );
}

interface Window {
  readonly startMs: number;
  readonly endMs: number;
}

/** Share a window out by text length: proportional, monotonic, exact at both ends. */
function distributeWindow(startMs: number, endMs: number, texts: readonly string[]): Window[] {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [{ startMs, endMs: Math.max(startMs, endMs) }];

  const total = texts.reduce((sum, text) => sum + Math.max(1, text.length), 0);
  const span = Math.max(0, endMs - startMs);
  const out: Window[] = [];
  let cursor = 0;
  let cumulative = 0;

  for (const [index, text] of texts.entries()) {
    cumulative += Math.max(1, text.length);
    const end =
      index === texts.length - 1
        ? startMs + span
        : startMs + Math.round((cumulative / total) * span);
    out.push({ startMs: startMs + cursor, endMs: Math.max(startMs + cursor, end) });
    cursor = end - startMs;
  }
  return out;
}

interface CuePiece {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly split: boolean;
}

/** Split a cue that would sit too long, halving it at a word boundary. */
function splitForDuration(
  text: string,
  startMs: number,
  endMs: number,
  settings: CaptionSettings,
  issues: CaptionIssue[],
  sentence: CaptionSentence,
  depth = 0,
): CuePiece[] {
  if (endMs - startMs <= settings.maxCueMs) return [{ text, startMs, endMs, split: depth > 0 }];

  const tokens = text.split(/\s+/u).filter((token) => token !== "");
  if (tokens.length < 2 || depth >= 3) {
    issues.push(
      captionIssue({
        code: "cue_too_long",
        severity: "warning",
        sceneId: sentence.sceneId,
        sentenceId: sentence.sentenceId,
        message:
          `"${text}" would sit on screen for ${Math.round((endMs - startMs) / 1_000)}s ` +
          `(over the ${settings.maxCueMs}ms limit) and cannot be split further`,
      }),
    );
    return [{ text, startMs, endMs, split: depth > 0 }];
  }

  const middle = Math.ceil(tokens.length / 2);
  const left = tokens.slice(0, middle).join(" ");
  const right = tokens.slice(middle).join(" ");
  const boundary =
    startMs + Math.round(((endMs - startMs) * left.length) / (left.length + right.length));

  return [
    ...splitForDuration(left, startMs, boundary, settings, issues, sentence, depth + 1),
    ...splitForDuration(right, boundary, endMs, settings, issues, sentence, depth + 1),
  ];
}

/**
 * Make the cue list monotonic and readable: no overlaps, and a cue that would
 * flash by is held — into the following silence, never over the next cue.
 */
function holdShortCues(
  drafts: CueDraft[],
  settings: CaptionSettings,
  issues: CaptionIssue[],
): CueDraft[] {
  const out: CueDraft[] = [];

  for (const [index, draft] of drafts.entries()) {
    const previous = out[index - 1];
    if (previous !== undefined && draft.startMs < previous.endMs + settings.gapMs) {
      const pushed = previous.endMs + settings.gapMs;
      issues.push(
        captionIssue({
          code: "overlap",
          severity: "error",
          cueId: draft.id,
          sceneId: draft.sceneId,
          sentenceId: draft.sentenceId,
          message:
            `"${draft.text}" was due at ${draft.startMs}ms, inside the previous cue (ends ${previous.endMs}ms): ` +
            `it is pushed to ${pushed}ms`,
        }),
      );
      draft.startMs = pushed;
      if (draft.endMs < draft.startMs) draft.endMs = draft.startMs + 1;
    }

    const next = drafts[index + 1];
    const duration = draft.endMs - draft.startMs;
    if (duration < settings.minCueMs) {
      const ceiling = next === undefined ? Number.POSITIVE_INFINITY : next.startMs - settings.gapMs;
      const held = Math.min(draft.startMs + settings.minCueMs, Math.max(draft.endMs, ceiling));
      draft.endMs = Math.max(draft.endMs, held);
      if (next !== undefined && next.startMs < draft.endMs + settings.gapMs) {
        next.startMs = draft.endMs + settings.gapMs;
        if (next.endMs < next.startMs) next.endMs = next.startMs + 1;
      }
      if (draft.endMs - draft.startMs < settings.minCueMs) {
        issues.push(
          captionIssue({
            code: "cue_too_short",
            severity: "warning",
            cueId: draft.id,
            sceneId: draft.sceneId,
            sentenceId: draft.sentenceId,
            message:
              `"${draft.text}" is on screen for ${draft.endMs - draft.startMs}ms, under the ${settings.minCueMs}ms ` +
              "minimum: there is no silence after it to hold it in",
          }),
        );
      }
    }

    out.push(draft);
  }

  return out;
}

function cueIdFor(index: number): string {
  return `cue_${String(index + 1).padStart(4, "0")}`;
}

function toCue(draft: CueDraft, settings: CaptionSettings): CaptionCue {
  const tokens = draft.text.split(/\s+/u).filter((token) => token !== "");
  const lines: CaptionLine[] = wrapTokens(tokens, settings.maxCharsPerLine).map((text) => ({
    text,
    words: text.split(/\s+/u).filter((token) => token !== "").length,
    characters: text.length,
  }));
  return CaptionCueSchema.parse({
    id: draft.id,
    sceneId: draft.sceneId,
    segmentId: draft.segmentId,
    sentenceId: draft.sentenceId,
    startMs: Math.round(draft.startMs),
    endMs: Math.round(draft.endMs),
    lines,
    words: lines.reduce((sum, line) => sum + line.words, 0),
    characters: draft.text.length,
    method: draft.method,
  });
}

function readabilityIssues(cue: CaptionCue, settings: CaptionSettings): CaptionIssue[] {
  const issues: CaptionIssue[] = [];
  const durationMs = Math.max(1, cue.endMs - cue.startMs);

  for (const line of cue.lines) {
    if (line.characters <= settings.maxCharsPerLine) continue;
    const longest = longestToken(line.text.split(/\s+/u));
    issues.push(
      captionIssue({
        code: "long_line",
        severity: "warning",
        cueId: cue.id,
        sceneId: cue.sceneId,
        sentenceId: cue.sentenceId,
        message:
          longest.length > settings.maxCharsPerLine
            ? `"${longest}" is ${longest.length} characters and cannot be wrapped to ` +
              `${settings.maxCharsPerLine}: it takes a line of its own, which readers of subtitles notice`
            : `line "${line.text}" is ${line.characters} characters, over the ${settings.maxCharsPerLine} one line may hold`,
      }),
    );
  }

  const rate = (cue.characters / durationMs) * 1_000;
  if (rate > settings.maxCharsPerSecond) {
    issues.push(
      captionIssue({
        code: "too_fast",
        severity: "warning",
        cueId: cue.id,
        sceneId: cue.sceneId,
        sentenceId: cue.sentenceId,
        message:
          `cue ${cue.id} reads at ${rate.toFixed(1)} characters/second (ceiling ${settings.maxCharsPerSecond}) ` +
          `over ${durationMs}ms`,
      }),
    );
  }

  if (durationMs > settings.maxCueMs) {
    issues.push(
      captionIssue({
        code: "cue_too_long",
        severity: "warning",
        cueId: cue.id,
        sceneId: cue.sceneId,
        sentenceId: cue.sentenceId,
        message: `cue ${cue.id} sits on screen for ${durationMs}ms, over the ${settings.maxCueMs}ms limit`,
      }),
    );
  }

  return issues;
}

function totalsFor(
  cues: readonly CaptionCue[],
  track: AudioTrack,
  silentScenes: number,
  settings: CaptionSettings,
) {
  const startMs = cues[0]?.startMs ?? 0;
  const endMs = cues[cues.length - 1]?.endMs ?? 0;
  const durations = cues.map((cue) => Math.max(1, cue.endMs - cue.startMs));
  const captionMs = durations.reduce((sum, duration) => sum + duration, 0);
  const rates = cues.map(
    (cue, index) => (cue.characters / Math.max(1, durations[index] ?? 1)) * 1_000,
  );

  return {
    cues: cues.length,
    lines: cues.reduce((sum, cue) => sum + cue.lines.length, 0),
    words: cues.reduce((sum, cue) => sum + cue.words, 0),
    characters: cues.reduce((sum, cue) => sum + cue.characters, 0),
    startMs,
    endMs,
    captionDurationSec: Math.round((captionMs / 1_000) * 1_000) / 1_000,
    spokenDurationSec: track.totals.spokenDurationSec,
    shortestCueMs: durations.length === 0 ? 0 : Math.min(...durations),
    longestCueMs: durations.length === 0 ? 0 : Math.max(...durations),
    maxCharactersPerSecond: rates.length === 0 ? 0 : Math.round(Math.max(...rates) * 10) / 10,
    estimatedCues: cues.filter((cue) => cue.method === "estimated").length,
    overBudgetCues: rates.filter((rate) => rate > settings.maxCharsPerSecond).length,
    silentScenes,
  };
}
