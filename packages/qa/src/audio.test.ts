import type { AudioTrack } from "@nexus/audio";
import { decodeWav, encodeWav, type WavData } from "@nexus/video";
import { describe, expect, it } from "vitest";

import { checkAudio, silentWindowsOf } from "./audio.js";
import { qaFixture, type QAFixture } from "./fixtures.js";
import { DEFAULT_QA_SETTINGS } from "./settings.js";

/**
 * Audio QA: the narration track, its clips and the silence inside them.
 *
 * The fixture's narration is real PCM written by the fake TTS, so the cases here
 * replace a clip with one that is silent, one with a hole in it, or a different
 * container — which is what the checks actually have to survive. The clean run is
 * asserted first.
 */

/** The fixture's track with one clip replaced by these bytes. */
function withClip(
  fixture: QAFixture,
  index: number,
  bytes: Uint8Array,
  format?: string,
): AudioTrack {
  const stored = fixture.storage.put(bytes);
  const track = fixture.audio.doc;
  const segments = track.segments.map((segment, position) =>
    position === index
      ? {
          ...segment,
          audio: {
            ...segment.audio,
            hash: stored.hash,
            bytes: stored.bytes,
            ...(format !== undefined ? { format } : {}),
          },
        }
      : segment,
  );
  return { ...track, segments } as AudioTrack;
}

async function check(fixture: QAFixture, track?: AudioTrack, manifest = fixture.manifest) {
  const result = checkAudio(
    fixture.with({
      manifest,
      ...(track === undefined ? {} : { audio: { doc: track, hash: fixture.audio.hash } }),
    }),
    fixture.deps,
    DEFAULT_QA_SETTINGS,
  );
  return { result, codes: result.findings.map((finding) => finding.code) };
}

function silentLike(sampleRate: number, channels: number, frames: number): WavData {
  return {
    sampleRate,
    channels,
    samples: new Float32Array(frames * channels),
    frames,
    durationSec: frames / sampleRate,
  };
}

describe("audio checks", () => {
  it("passes the fixture narration", async () => {
    const fixture = await qaFixture();
    const { result, codes: found } = await check(fixture);
    expect(found).toEqual([]);
    expect(result.report.examined).toBeGreaterThan(fixture.audio.doc.segments.length);
    expect(result.report.note).toContain("segment(s)");
  });

  it("reports a missing track", async () => {
    const fixture = await qaFixture({ withoutAudio: true });
    const { result, codes: found } = await check(fixture);
    expect(found).toEqual(["audio_missing"]);
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("reports a track with no clips", async () => {
    const fixture = await qaFixture();
    const empty = { ...fixture.audio.doc, segments: [] } as unknown as AudioTrack;
    const { codes: found } = await check(fixture, empty);
    expect(found).toContain("audio_missing");
  });

  it("reports a scene that should speak and has no segment", async () => {
    const fixture = await qaFixture();
    const track = {
      ...fixture.audio.doc,
      segments: fixture.audio.doc.segments.slice(1),
    } as unknown as AudioTrack;
    const { result } = await check(fixture, track);
    const finding = result.findings.find((entry) => entry.code === "audio_segment_missing");
    expect(finding?.subject).toBe("scn_hook_0");
    expect(finding?.message).toMatch(/narrates \d+ word/u);
  });

  it("reports narration that does not run the length of the plan", async () => {
    const fixture = await qaFixture();
    const manifest = {
      ...fixture.manifest,
      totalDurationSec: fixture.manifest.totalDurationSec + 4,
    };
    const { result } = await check(fixture, undefined, manifest as typeof fixture.manifest);
    const finding = result.findings.find((entry) => entry.code === "audio_duration_mismatch");
    expect(finding?.subject).toBe("track");
    expect(finding?.evidence.driftSec).toBeLessThan(0);
  });

  it("warns about narration that drifts a little", async () => {
    const fixture = await qaFixture();
    const manifest = {
      ...fixture.manifest,
      totalDurationSec: fixture.manifest.totalDurationSec + 0.3,
    };
    const { codes: found } = await check(fixture, undefined, manifest as typeof fixture.manifest);
    expect(found).toContain("audio_drift");
    expect(found).not.toContain("audio_duration_mismatch");
  });

  it("reports a caption held past the end of the narration", async () => {
    const fixture = await qaFixture();
    const cues = fixture.captions.doc.cues.map((cue, index) =>
      index === fixture.captions.doc.cues.length - 1 ? { ...cue, endMs: cue.endMs + 5_000 } : cue,
    );
    const result = checkAudio(
      fixture.with({
        captions: { doc: { ...fixture.captions.doc, cues }, hash: fixture.captions.hash },
      }),
      fixture.deps,
      DEFAULT_QA_SETTINGS,
    );
    const finding = result.findings.find((entry) => entry.code === "audio_duration_mismatch");
    expect(finding?.subject).toBe("captions");
  });

  it("reports a clip whose bytes are not in the store", async () => {
    const fixture = await qaFixture();
    const track = {
      ...fixture.audio.doc,
      segments: fixture.audio.doc.segments.map((segment, index) =>
        index === 0 ? { ...segment, audio: { ...segment.audio, hash: "f".repeat(64) } } : segment,
      ),
    } as unknown as AudioTrack;
    const { result } = await check(fixture, track);
    const finding = result.findings.find((entry) => entry.code === "audio_artifact_invalid");
    expect(finding?.message).toContain("not in the artifact store");
  });

  it("reports a clip whose size is not what the track recorded", async () => {
    const fixture = await qaFixture();
    const track = {
      ...fixture.audio.doc,
      segments: fixture.audio.doc.segments.map((segment, index) =>
        index === 0 ? { ...segment, audio: { ...segment.audio, bytes: 999_999 } } : segment,
      ),
    } as unknown as AudioTrack;
    const { result } = await check(fixture, track);
    const finding = result.findings.find((entry) => entry.code === "audio_artifact_invalid");
    expect(finding?.message).toContain("999999");
  });

  it("reports a clip too small to hold the words it speaks", async () => {
    const fixture = await qaFixture();
    const track = withClip(fixture, 0, new Uint8Array(120).fill(7));
    const { result } = await check(fixture, track);
    const finding = result.findings.find((entry) => entry.code === "audio_artifact_invalid");
    expect(finding?.message).toContain("too short");
  });

  it("reports a clip that is silent where it should be speaking", async () => {
    const fixture = await qaFixture();
    const segment = fixture.audio.doc.segments[0]!;
    const decoded = decodeWav(fixture.storage.read(segment.audio.hash));
    const track = withClip(
      fixture,
      0,
      encodeWav(silentLike(decoded.sampleRate, decoded.channels, decoded.frames)),
    );
    const { result } = await check(fixture, track);
    const finding = result.findings.find((entry) => entry.code === "audio_silence");
    expect(finding?.message).toContain("nothing is audible");
  });

  it("reports a silent hole inside a clip", async () => {
    const fixture = await qaFixture();
    const segment = fixture.audio.doc.segments[0]!;
    const decoded = decodeWav(fixture.storage.read(segment.audio.hash));
    const samples = Float32Array.from(decoded.samples);
    const holeStart = Math.round(decoded.sampleRate * 0.4);
    const holeFrames = Math.round(decoded.sampleRate * 0.9);
    for (let frame = holeStart; frame < holeStart + holeFrames; frame += 1) {
      for (let channel = 0; channel < decoded.channels; channel += 1) {
        samples[frame * decoded.channels + channel] = 0;
      }
    }
    const track = withClip(fixture, 0, encodeWav({ ...decoded, samples }));
    const { result } = await check(fixture, track);
    const finding = result.findings.find((entry) => entry.code === "audio_silence");
    expect(finding?.message).toMatch(/goes silent for 1 stretch/u);
    expect(String(finding?.message)).toMatch(/first at 0\.4s/u);
  });

  it("reports a compressed clip as unmeasurable rather than fine", async () => {
    const fixture = await qaFixture();
    const mp3 = new Uint8Array(900);
    mp3.set([0xff, 0xfb, 0x90, 0x00], 0);
    const { result } = await check(fixture, withClip(fixture, 0, mp3, "mp3"));
    const finding = result.findings.find((entry) => entry.code === "audio_unmeasurable");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("silence inside them was not measured");
  });

  it("finds windows of silence in raw samples", async () => {
    const sampleRate = 8_000;
    const samples = new Float32Array(sampleRate * 3);
    // Loud from 0–1 s, silent 1–2 s, loud 2–3 s.
    for (let frame = 0; frame < sampleRate * 3; frame += 1) {
      const inSilence = frame >= sampleRate && frame < sampleRate * 2;
      samples[frame] = inSilence ? 0 : 0.4;
    }
    const windows = silentWindowsOf(samples, sampleRate, DEFAULT_QA_SETTINGS);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startSec).toBeCloseTo(1, 2);
    expect(windows[0]?.lengthSec).toBeCloseTo(1, 2);
  });
});
