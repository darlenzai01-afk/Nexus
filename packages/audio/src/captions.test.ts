import { MemoryBlobStore } from "@nexus/providers";
import { words } from "@nexus/script";
import { describe, expect, it } from "vitest";

import {
  CaptionTrackSchema,
  DEFAULT_CAPTION_TUNING,
  buildCaptionTrack,
  captionLines,
  captionTextAt,
  captionTrackBytes,
  cueAt,
  cueText,
  parseCaptionTrack,
  type CaptionCue,
  type CaptionTrack,
} from "./captions.js";
import {
  FIXTURE_CLOCK,
  ScriptedTtsProvider,
  castingFixture,
  fakeTts,
  fixtureTrack,
  fixedClock,
  twoSceneManifest,
} from "./fixtures.js";
import { synthesizeNarration } from "./pipeline.js";
import {
  AudioTrackSchema,
  type AudioSegment,
  type AudioTrack,
  type SceneTiming,
  type SentenceTiming,
} from "./schema.js";

/**
 * Captions, derived from the narration and the measured timing.
 *
 * The unit-level tests build the audio track by hand so a cue's window is exactly
 * what the test says it is (that is the only way to pin the hold, the split and
 * the "too fast" rule); the last block runs the real voice pipeline and captions
 * what it actually produced, which is the property that matters: *nobody types a
 * caption*.
 */

// ── A track with windows a test chose ─────────────────────────────────────

interface SpokenSentence {
  readonly sentenceId: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface SpokenScene {
  readonly sceneId: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly sentences: readonly SpokenSentence[];
}

const sec = (ms: number): number => Math.round(ms) / 1_000;

function trackWith(scenes: readonly SpokenScene[]): AudioTrack {
  const base = fixtureTrack();
  const segments: AudioSegment[] = [];
  const sentences: SentenceTiming[] = [];
  const timings: SceneTiming[] = [];

  for (const [index, scene] of scenes.entries()) {
    const segmentId = `seg_${scene.sceneId}`;
    const durationSec = sec(scene.endMs - scene.startMs);
    const sentenceIds = scene.sentences.map((sentence) => sentence.sentenceId);
    segments.push({
      id: segmentId,
      sceneId: scene.sceneId,
      index,
      sceneType: "CHARACTER",
      startSec: sec(scene.startMs),
      durationSec,
      plannedStartSec: sec(scene.startMs),
      plannedDurationSec: durationSec,
      text: scene.text,
      sentenceIds,
      words: words(scene.text).length,
      characters: scene.text.length,
      voice: {
        voiceId: "fake-narrator",
        label: "Maya",
        language: "en",
        rate: 1,
        format: "wav",
        sampleRate: 8_000,
      },
      provider: "fake",
      attempts: 1,
      cached: false,
      durationMethod: "provider",
      audio: {
        hash: "b".repeat(64),
        bytes: 16_044,
        mime: "audio/wav",
        format: "wav",
        sampleRate: 8_000,
        durationMs: Math.round(scene.endMs - scene.startMs),
      },
    });

    for (const sentence of scene.sentences) {
      sentences.push({
        sentenceId: sentence.sentenceId,
        sceneId: scene.sceneId,
        segmentId,
        startSec: sec(sentence.startMs),
        endSec: sec(sentence.endMs),
        durationSec: sec(sentence.endMs - sentence.startMs),
        words: words(sentence.text).length,
        characters: sentence.text.length,
        method: "word_timings",
      });
    }

    timings.push({
      sceneId: scene.sceneId,
      index,
      type: "CHARACTER",
      segmentId,
      plannedStartSec: sec(scene.startMs),
      plannedDurationSec: durationSec,
      spokenStartSec: sec(scene.startMs),
      spokenDurationSec: durationSec,
      driftSec: 0,
      verdict: "fits",
    });
  }

  const spokenMs = scenes.reduce((sum, scene) => sum + (scene.endMs - scene.startMs), 0);
  const totalWords = scenes.reduce((sum, scene) => sum + words(scene.text).length, 0);
  const characters = scenes.reduce((sum, scene) => sum + scene.text.length, 0);

  return AudioTrackSchema.parse({
    ...base,
    segments,
    sentences,
    scenes: timings,
    totals: {
      ...base.totals,
      scenes: scenes.length,
      segments: segments.length,
      words: totalWords,
      characters,
      wordsPerSecond: spokenMs === 0 ? 0 : Math.round((totalWords / spokenMs) * 1_000 * 100) / 100,
      plannedDurationSec: sec(spokenMs),
      spokenDurationSec: sec(spokenMs),
      driftSec: 0,
    },
  });
}

const lineFits = (cue: CaptionCue, track: CaptionTrack): boolean =>
  cue.lines.every((line) => line.characters <= track.settings.maxCharsPerLine) &&
  cue.lines.length <= track.settings.maxLinesPerCue;

/** One sentence of a scene, as the cue engine should reproduce it. */
const joined = (cues: readonly CaptionCue[]): string => cues.map((cue) => cueText(cue)).join(" ");

function cuesFor(
  text: string,
  startMs: number,
  endMs: number,
  options: Parameters<typeof buildCaptionTrack>[1] = {},
) {
  const track = trackWith([
    {
      sceneId: "scn_one",
      text,
      startMs,
      endMs,
      sentences: [{ sentenceId: "snt_1", text, startMs, endMs }],
    },
  ]);
  return buildCaptionTrack(track, { now: FIXTURE_CLOCK, ...options });
}

describe("deriving cues", () => {
  it("makes one cue per sentence, on the sentence's own window", () => {
    const track = trackWith([
      {
        sceneId: "scn_one",
        text: "The bridge carries traffic. It has done so since 1954.",
        startMs: 0,
        endMs: 3_000,
        sentences: [
          { sentenceId: "snt_1", text: "The bridge carries traffic.", startMs: 0, endMs: 1_200 },
          { sentenceId: "snt_2", text: "It has done so since 1954.", startMs: 1_200, endMs: 3_000 },
        ],
      },
    ]);
    const captions = buildCaptionTrack(track, { now: FIXTURE_CLOCK });

    expect(captions.cues.map((cue) => cue.id)).toEqual(["cue_0001", "cue_0002"]);
    expect(captions.cues.map((cue) => cue.sentenceId)).toEqual(["snt_1", "snt_2"]);
    expect(captions.cues[0]).toMatchObject({ startMs: 0, endMs: 1_200, method: "sentence" });
    expect(captions.cues[1]).toMatchObject({ startMs: 1_200, endMs: 3_000, method: "sentence" });
    expect(captions.cues.every((cue) => lineFits(cue, captions))).toBe(true);
    expect(captions.issues).toEqual([]);
    expect(captions.totals).toMatchObject({ cues: 2, lines: 2, silentScenes: 0, estimatedCues: 0 });
    expect(captions.totals.captionDurationSec).toBe(3);
    expect(captions.totals.startMs).toBe(0);
    expect(captions.totals.endMs).toBe(3_000);
  });

  it("breaks a long sentence at a punctuation boundary, and keeps every word", () => {
    const text =
      "The bridge carries forty thousand crossings a day, and it is still growing, which nobody expected.";
    const captions = cuesFor(text, 0, 5_120);
    const cues = captions.cues;

    expect(cues.length).toBeGreaterThan(1);
    expect(joined(cues)).toBe(text);
    expect(cues.every((cue) => lineFits(cue, captions))).toBe(true);
    // The first break lands after the comma rather than mid-clause.
    expect(cueText(cues[0])).toMatch(/,$/u);
    expect(cues.every((cue) => cue.method === "split")).toBe(true);
  });

  it("never lets two cues overlap, whatever the windows say", () => {
    const captions = cuesFor("First part. Second part.", 0, 2_000, {
      tuning: { minCueMs: 100, gapMs: 0 },
    });
    const [first, second] = captions.cues;
    expect(first?.endMs).toBeLessThanOrEqual(second?.startMs ?? 0);
    expect(captions.issues.some((issue) => issue.code === "overlap")).toBe(false);

    for (const [index, cue] of captions.cues.entries()) {
      const previous = captions.cues[index - 1];
      if (previous === undefined) continue;
      expect(cue.startMs).toBeGreaterThanOrEqual(previous.endMs);
    }
  });

  it("holds a cue that would flash by, into the silence after it", () => {
    const track = trackWith([
      {
        sceneId: "scn_one",
        text: "Yes. The bridge carries traffic, and it is still growing.",
        startMs: 0,
        endMs: 3_000,
        sentences: [
          { sentenceId: "snt_1", text: "Yes.", startMs: 0, endMs: 300 },
          // A pause in the speech: somewhere to hold the first line without
          // pushing the next one off its own words.
          {
            sentenceId: "snt_2",
            text: "The bridge carries traffic, and it is still growing.",
            startMs: 2_000,
            endMs: 3_000,
          },
        ],
      },
    ]);
    const captions = buildCaptionTrack(track, { now: FIXTURE_CLOCK });

    expect(captions.cues[0]).toMatchObject({ startMs: 0, endMs: 800, method: "sentence" });
    expect(captions.cues[1]?.startMs).toBe(2_000);
    expect(captions.issues.some((issue) => issue.code === "cue_too_short")).toBe(false);
    expect(captions.totals.shortestCueMs).toBe(800);
  });

  it("reports a cue it could not hold: there is no silence to hold it in", () => {
    const track = trackWith([
      {
        sceneId: "scn_one",
        text: "Yes. The bridge carries traffic, and it is still growing.",
        startMs: 0,
        endMs: 3_000,
        sentences: [
          { sentenceId: "snt_1", text: "Yes.", startMs: 0, endMs: 300 },
          {
            sentenceId: "snt_2",
            text: "The bridge carries traffic, and it is still growing.",
            startMs: 300,
            endMs: 3_000,
          },
        ],
      },
    ]);
    const captions = buildCaptionTrack(track, { now: FIXTURE_CLOCK });

    expect(captions.cues[0]?.endMs).toBe(300);
    expect(captions.issues).toEqual([
      expect.objectContaining({ code: "cue_too_short", severity: "warning", cueId: "cue_0001" }),
    ]);
  });

  it("splits a cue that would sit on screen too long, without losing a word", () => {
    const text = "The bridge carries forty thousand crossings.";
    const captions = cuesFor(text, 0, 6_000, { tuning: { maxCueMs: 2_000 } });

    expect(captions.cues.length).toBeGreaterThan(2);
    expect(joined(captions.cues)).toBe(text);
    expect(captions.cues.every((cue) => cue.endMs - cue.startMs <= 2_000)).toBe(true);
    // Splitting for time does not break the line budget.
    expect(captions.cues.every((cue) => lineFits(cue, captions))).toBe(true);
  });

  it("reports captions that read too fast", () => {
    const text = "The bridge still carries forty thousand crossings every single day.";
    const captions = cuesFor(text, 0, 1_000);

    expect(captions.issues).toEqual([
      expect.objectContaining({ code: "too_fast", severity: "warning" }),
    ]);
    expect(captions.totals.overBudgetCues).toBe(1);
    expect(captions.totals.maxCharactersPerSecond).toBeGreaterThan(
      DEFAULT_CAPTION_TUNING.maxCharsPerSecond,
    );
    expect(captions.warnings.join(" ")).toContain("characters/second");
  });
});

describe("safe lines", () => {
  it("wraps at word boundaries, never mid-word", () => {
    expect(
      captionLines("The bridge carries forty thousand crossings a day.", { maxCharsPerLine: 20 }),
    ).toEqual(["The bridge carries", "forty thousand", "crossings a day."]);
    expect(captionLines("crossings", { maxCharsPerLine: 4 })).toEqual(["crossings"]);
  });

  it("honours a tighter line budget end to end", () => {
    const captions = cuesFor(
      "The bridge carries forty thousand crossings a day, and it is still growing.",
      0,
      6_000,
      { tuning: { maxCharsPerLine: 20, maxLinesPerCue: 1 } },
    );

    expect(captions.settings).toMatchObject({ maxCharsPerLine: 20, maxLinesPerCue: 1 });
    expect(captions.cues.every((cue) => cue.lines.length === 1)).toBe(true);
    expect(captions.cues.every((cue) => cue.lines[0]!.characters <= 20)).toBe(true);
    // The tighter budget splits *more*, never differently worded.
    expect(captions.cues.length).toBeGreaterThan(2);
  });

  it("reports a word too long for a line instead of cutting it in half", () => {
    const captions = cuesFor(
      "Visit https://example.com/a/very/long/path/indeed/ok today.",
      0,
      2_000,
      {
        tuning: { maxCharsPerLine: 24, maxLinesPerCue: 1 },
      },
    );

    expect(captions.issues.some((issue) => issue.code === "long_line")).toBe(true);
    expect(captions.cues.some((cue) => cueText(cue).includes("indeed"))).toBe(true);
  });
});

describe("the document", () => {
  it("round-trips through its canonical bytes", () => {
    const captions = cuesFor("The bridge carries traffic.", 0, 1_500);
    const bytes = captionTrackBytes(captions);
    expect(new TextDecoder().decode(bytes).endsWith("}\n")).toBe(true);
    expect(parseCaptionTrack(JSON.parse(new TextDecoder().decode(bytes)))).toEqual(captions);
  });

  it("refuses a document with overlapping cues", () => {
    const captions = cuesFor("First part. Second part.", 0, 3_000);
    const [first, second] = captions.cues;
    const broken = {
      ...captions,
      cues: [
        first as CaptionCue,
        { ...(second as CaptionCue), startMs: (first?.startMs ?? 0) + 10, endMs: 3_000 },
      ],
    };
    const result = CaptionTrackSchema.safeParse(broken);
    expect(result.success).toBe(false);
    const codes =
      result.error?.issues.map((issue) => (issue as { params?: { code?: string } }).params?.code) ??
      [];
    expect(codes).toContain("overlap");
  });

  it("is deterministic, and carries no model in its provenance", () => {
    const track = trackWith([
      {
        sceneId: "scn_one",
        text: "The bridge carries traffic.",
        startMs: 0,
        endMs: 1_500,
        sentences: [
          { sentenceId: "snt_1", text: "The bridge carries traffic.", startMs: 0, endMs: 1_500 },
        ],
      },
    ]);
    const first = buildCaptionTrack(track, { now: FIXTURE_CLOCK, audioTrackHash: "a".repeat(64) });
    const second = buildCaptionTrack(track, { now: FIXTURE_CLOCK, audioTrackHash: "a".repeat(64) });

    expect(new TextDecoder().decode(captionTrackBytes(first))).toBe(
      new TextDecoder().decode(captionTrackBytes(second)),
    );
    expect(first.provenance.aiSteps).toEqual([]);
    expect(first.provenance.deterministicSteps).toEqual([
      "caption.sentences",
      "caption.lines",
      "caption.timings",
    ]);
    expect(first.audioTrackHash).toBe("a".repeat(64));
    expect(first.manifestHash).toBe(track.manifestHash);
  });

  it("answers what is on screen at a moment", () => {
    const captions = cuesFor("The bridge carries traffic. It has done so since 1954.", 0, 3_000, {
      tuning: { minCueMs: 100 },
    });
    const [first, second] = captions.cues;

    expect(cueAt(captions, 0)?.id).toBe(first?.id);
    expect(captionTextAt(captions, 10)).toContain("bridge");
    expect(cueAt(captions, first!.endMs)?.id).toBe(second?.id);
    expect(captionTextAt(captions, 9_999)).toBe("");
  });
});

describe("cues for audio the voice stage could not measure", () => {
  it("estimates the windows and says so", () => {
    const captions = buildCaptionTrack(fixtureTrack({ sentences: [] }), { now: FIXTURE_CLOCK });

    expect(captions.issues.map((issue) => issue.code)).toContain("missing_window");
    expect(captions.cues).toHaveLength(1);
    expect(captions.cues[0]).toMatchObject({ method: "estimated", startMs: 0, endMs: 1_000 });
    expect(cueText(captions.cues[0])).toBe("The bridge carries forty thousand crossings a day.");
    expect(captions.totals.estimatedCues).toBe(1);
    expect(captions.warnings.join(" ")).toContain("estimated duration");
  });
});

describe("captions over real audio", () => {
  it("captions what the voice stage actually produced", async () => {
    const storage = new MemoryBlobStore();
    const manifest = twoSceneManifest();
    const report = await synthesizeNarration(
      { manifest, manifestHash: "d".repeat(64), casting: castingFixture(), now: FIXTURE_CLOCK },
      { tts: fakeTts(storage), storage, clock: fixedClock() },
    );

    const captions = buildCaptionTrack(report.track, { now: FIXTURE_CLOCK });

    expect(captions.cues).toHaveLength(3);
    expect(captions.cues.map((cue) => cue.sentenceId)).toEqual(["snt_1", "snt_2", "snt_3"]);
    expect(captions.cues.map((cue) => cueText(cue))).toEqual([
      "The bridge carries forty thousand crossings a day.",
      "Two sentences here.",
      "The second one is shorter.",
    ]);
    // The cue timeline is the *spoken* timeline: it starts at zero and ends where
    // the last clip does, not where the plan said the scene would end.
    expect(captions.totals.startMs).toBe(0);
    expect(captions.totals.endMs).toBe(5_120);
    expect(captions.totals.spokenDurationSec).toBe(report.track.totals.spokenDurationSec);
    expect(captions.issues.filter((issue) => issue.code === "overlap")).toEqual([]);
    expect(captions.cues.every((cue) => lineFits(cue, captions))).toBe(true);
    expect(captions.cues.every((cue) => cue.sceneId.startsWith("scn_"))).toBe(true);
  });

  it("leaves a scene without audio uncaptioned, and names it", async () => {
    const storage = new MemoryBlobStore();
    const manifest = twoSceneManifest();
    const report = await synthesizeNarration(
      { manifest, manifestHash: "d".repeat(64), casting: castingFixture(), now: FIXTURE_CLOCK },
      {
        tts: new ScriptedTtsProvider(storage, [
          { kind: "ok" },
          { kind: "throw", retryable: false },
        ]),
        storage,
        clock: fixedClock(),
      },
    );

    const captions = buildCaptionTrack(report.track, { now: FIXTURE_CLOCK });

    expect(report.waiting).toBe(true);
    expect(captions.issues).toContainEqual(
      expect.objectContaining({ code: "silent_scene", severity: "warning", sceneId: "scn_two" }),
    );
    // The one clip that *was* produced is captioned; the silent scene is named
    // rather than left to look like it had nothing worth captioning.
    expect(captions.totals.silentScenes).toBe(1);
    expect(captions.cues.map((cue) => cue.sceneId)).toEqual(["scn_one"]);
  });
});
