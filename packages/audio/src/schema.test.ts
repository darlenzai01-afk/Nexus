import { describe, expect, it } from "vitest";

import { audioManifest, audioScene, fixtureTrack } from "./fixtures.js";
import {
  AUDIO_ISSUE_CODES,
  AudioTrackSchema,
  OperatorAudioListSchema,
  VoiceCastingSchema,
  audioTrackBytes,
  isHardAudioIssue,
  parseAudioTrack,
} from "./schema.js";

/**
 * The document contract.
 *
 * These schemas are what a cache index, a hand-written casting and every loaded
 * artifact are parsed through, so the tests care about the same things the
 * pipeline does: strictness (a typo must not read as a valid document), the
 * optional voice id, and the severity split that decides whether a track may
 * travel downstream.
 */

describe("the audio documents", () => {
  it("accepts an empty voice id only where it means something", () => {
    const casting = VoiceCastingSchema.parse({
      version: 1,
      language: "en",
      format: "wav",
      sampleRate: 24_000,
      rate: 1,
      narrator: { voiceId: "", label: "Narrator", language: "en", rate: 1 },
      cast: [{ characterId: "maya", voiceId: "" }],
    });
    expect(casting.narrator.voiceId).toBe("");
    expect(casting.cast[0]?.voiceId).toBe("");

    const bad = VoiceCastingSchema.safeParse({
      version: 1,
      language: "en",
      format: "wav",
      sampleRate: 24_000,
      rate: 1,
      narrator: { voiceId: "not a voice id!", label: "Narrator", language: "en", rate: 1 },
      cast: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects two voices for one cast member, with a code", () => {
    const result = VoiceCastingSchema.safeParse({
      version: 1,
      language: "en",
      format: "wav",
      sampleRate: 24_000,
      rate: 1,
      narrator: { voiceId: "fake-warm", label: "Narrator", language: "en", rate: 1 },
      cast: [
        { characterId: "maya", voiceId: "fake-warm" },
        { characterId: "maya", voiceId: "fake-deep" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("two voices");
      const custom = result.error.issues[0] as { params?: { code?: string } } | undefined;
      expect(custom?.params?.code).toBe("duplicate_voice");
    }
  });

  it("refuses unknown fields anywhere in the document", () => {
    const track = fixtureTrack();
    expect(AudioTrackSchema.safeParse({ ...track, engine: "extra" }).success).toBe(false);
    const [segment] = track.segments;
    expect(
      AudioTrackSchema.safeParse({ ...track, segments: [{ ...segment, speed: 1 }] }).success,
    ).toBe(false);
  });

  it("round-trips through its canonical bytes", () => {
    const track = fixtureTrack();
    const bytes = audioTrackBytes(track);
    const parsed = parseAudioTrack(JSON.parse(new TextDecoder().decode(bytes)));
    expect(parsed).toEqual(track);
    expect(new TextDecoder().decode(bytes).endsWith("}\n")).toBe(true);
  });

  it("calls a track complete only when no hard issue remains", () => {
    expect(isHardAudioIssue("provider_failed")).toBe(true);
    expect(isHardAudioIssue("spoken_overflow")).toBe(false);
    expect(AUDIO_ISSUE_CODES).toHaveLength(14);
    const track = fixtureTrack();
    expect(
      track.issues.every((issue) => (issue.severity === "error") === isHardAudioIssue(issue.code)),
    ).toBe(true);
  });

  it("bounds the operator's clip list", () => {
    expect(
      OperatorAudioListSchema.parse([{ sceneId: "scn_one", hash: "a".repeat(64) }]),
    ).toHaveLength(1);
    expect(OperatorAudioListSchema.safeParse([{ sceneId: "scn_one", hash: "nope" }]).success).toBe(
      false,
    );
    expect(
      OperatorAudioListSchema.safeParse(
        Array.from({ length: 65 }, (_entry, index) => ({
          sceneId: `scn_${index}`,
          hash: "a".repeat(64),
        })),
      ).success,
    ).toBe(false);
  });

  it("leaves captions out of the scene manifest entirely", () => {
    const manifest = audioManifest([
      audioScene({ id: "scn_one", index: 0, durationSec: 4, sentenceIds: ["snt_1"] }),
    ]);
    const scene = manifest.scenes[0]!;
    expect(scene.narration.sentenceIds).toEqual(["snt_1"]);
    // Captions are *derived* (narration + timing), never embedded per scene: the
    // manifest carries the words and nothing that looks like a caption track.
    const keys = Object.keys(scene);
    expect(keys).not.toContain("captions");
    expect(keys).not.toContain("caption");
    expect(keys).not.toContain("subtitles");
    expect(JSON.stringify(scene)).not.toContain("captions");
    expect(JSON.stringify(manifest)).not.toContain("captions");
  });
});
