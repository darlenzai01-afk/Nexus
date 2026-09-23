import { FAKE_VOICES } from "@nexus/providers";
import { describe, expect, it } from "vitest";

import { audioManifest, audioScene, castingFixture, twoSceneManifest } from "./fixtures.js";
import { VoiceCastingSchema } from "./schema.js";
import {
  castingFor,
  resolveVoicePlan,
  speakerForScene,
  validateCasting,
  voicePlanFor,
} from "./voices.js";

/**
 * Voice configuration.
 *
 * The three questions these tests answer: who speaks a scene (the scene decides),
 * which voice a speaker gets (the casting decides), and what happens when the
 * casting asks for a voice the adapter does not have (it is reported, never
 * silently swapped).
 */

describe("voice configuration", () => {
  it("casts the narrator and every cast member from the configured defaults", () => {
    const manifest = audioManifest([
      audioScene({
        id: "scn_one",
        index: 0,
        characters: [{ characterId: "maya", state: "talking" }],
      }),
    ]);
    const casting = castingFor(manifest, {
      voiceId: "",
      label: "Studio",
      language: "en",
      rate: 1,
      format: "wav",
      sampleRate: 8_000,
    });

    expect(casting.narrator).toMatchObject({ voiceId: "", label: "Studio", rate: 1 });
    expect(casting.cast).toHaveLength(1);
    expect(casting.cast[0]).toMatchObject({
      characterId: "maya",
      voiceId: "",
      label: "Maya Okonkwo",
    });
    expect(VoiceCastingSchema.safeParse(casting).success).toBe(true);
  });

  it("lets an explicit override beat the defaults", () => {
    const manifest = twoSceneManifest();
    const casting = castingFor(
      manifest,
      { voiceId: "fake-warm", language: "en", rate: 1, format: "wav", sampleRate: 8_000 },
      [{ characterId: "maya", voiceId: "fake-deep", rate: 0.9 }],
    );
    expect(casting.narrator.voiceId).toBe("fake-warm");
    expect(casting.cast.find((member) => member.characterId === "maya")).toMatchObject({
      voiceId: "fake-deep",
      rate: 0.9,
    });
  });

  it("names the speaker: the presenting character, or the narrator", () => {
    const talking = audioScene({ characters: [{ characterId: "maya", state: "talking" }] });
    const listening = audioScene({ characters: [{ characterId: "tomas", state: "listening" }] });
    const entering = audioScene({ characters: [{ characterId: "maya", state: "entering" }] });
    const both = audioScene({
      characters: [
        { characterId: "tomas", state: "listening" },
        { characterId: "maya", state: "gesturing" },
      ],
    });

    expect(speakerForScene(talking)).toBe("maya");
    expect(speakerForScene(both)).toBe("maya");
    // A listening guest and somebody walking into frame are read by the narrator:
    // the state says who is *speaking*, not who is visible.
    expect(speakerForScene(listening)).toBe("");
    expect(speakerForScene(entering)).toBe("");
  });

  it("gives each speaker its plan, falling back to the narrator", () => {
    const casting = castingFixture();
    expect(voicePlanFor(casting, "maya")).toMatchObject({
      voiceId: "fake-narrator",
      label: "Maya",
    });
    expect(voicePlanFor(casting, "tomas")).toMatchObject({ voiceId: "fake-warm" });
    expect(voicePlanFor(casting, "")).toMatchObject({ voiceId: "fake-warm", label: "Narrator" });
  });

  it("resolves an empty voice id to the adapter's first voice", () => {
    const casting = VoiceCastingSchema.parse({
      ...castingFixture(),
      narrator: { voiceId: "", label: "Narrator", language: "en", rate: 1 },
    });
    const resolved = resolveVoicePlan(voicePlanFor(casting, ""), FAKE_VOICES);
    expect("settings" in resolved && resolved.settings.voiceId).toBe(FAKE_VOICES[0]?.id);
    expect("settings" in resolved && resolved.settings.label).toBe("Narrator");
  });

  it("never swaps a named voice the adapter does not offer", () => {
    const casting = castingFixture();
    const missing = resolveVoicePlan(voicePlanFor(casting, "maya"), [
      { id: "some-other-voice", label: "Other", language: "en" },
    ]);
    expect("issue" in missing && missing.issue.code).toBe("voice_unavailable");
    expect("issue" in missing && missing.issue.message).toContain("fake-narrator");

    const none = resolveVoicePlan(voicePlanFor(casting, "maya"), []);
    expect("issue" in none && none.issue.code).toBe("voice_unavailable");
  });

  it("keeps the model's gender hint when the adapter offers one", () => {
    const casting = VoiceCastingSchema.parse({
      ...castingFixture(),
      cast: [{ characterId: "maya", voiceId: "fake-deep" }],
    });
    const resolved = resolveVoicePlan(voicePlanFor(casting, "maya"), FAKE_VOICES);
    expect("settings" in resolved && resolved.settings.gender).toBe("masculine");
  });

  it("reports a cast member with no voice, a voice for a stranger, and a language clash", () => {
    const manifest = audioManifest([
      audioScene({
        id: "scn_one",
        index: 0,
        characters: [{ characterId: "maya", state: "talking" }],
      }),
      audioScene({
        id: "scn_two",
        index: 1,
        startSec: 4,
        characters: [{ characterId: "tomas", state: "listening" }],
      }),
    ]);

    const missing = validateCasting(castingFixture(), manifest);
    expect(missing.ok).toBe(false);
    expect(missing.issues.map((issue) => issue.code)).toEqual(["missing_voice"]);
    expect(missing.issues[0]?.characterId).toBe("tomas");

    const stranger = validateCasting(
      VoiceCastingSchema.parse({
        ...castingFixture(),
        cast: [
          { characterId: "maya", voiceId: "fake-warm" },
          { characterId: "tomas", voiceId: "fake-deep" },
          { characterId: "ghost", voiceId: "fake-deep" },
        ],
      }),
      manifest,
    );
    expect(stranger.issues.map((issue) => issue.code)).toEqual(["unknown_cast_member"]);

    const language = validateCasting(
      VoiceCastingSchema.parse({
        ...castingFixture(),
        cast: [
          { characterId: "maya", voiceId: "fake-warm", language: "fr" },
          { characterId: "tomas", voiceId: "fake-deep" },
        ],
      }),
      manifest,
    );
    expect(language.issues.map((issue) => issue.code)).toEqual(["language_mismatch"]);

    const complete = validateCasting(
      VoiceCastingSchema.parse({
        ...castingFixture(),
        cast: [
          { characterId: "maya", voiceId: "fake-warm" },
          { characterId: "tomas", voiceId: "fake-deep" },
        ],
      }),
      manifest,
    );
    expect(complete.ok).toBe(true);
    expect(complete.issues).toEqual([]);
  });
});
