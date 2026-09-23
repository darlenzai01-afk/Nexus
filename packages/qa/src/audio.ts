import { probeAudio } from "@nexus/audio";
import { decodeWav } from "@nexus/video";

import type { QADeps, QAEvidence } from "./evidence.js";
import { checkResult, finding, round2, type CheckResult } from "./findings.js";
import type { QASettings } from "./schema.js";

/**
 * Audio QA: is there a voice, is it the right length, does it say anything?
 *
 * Phase 10 measures what it can (a WAV header, an MP3 frame header, an honest
 * estimate) and records the method. QA is the second pair of eyes on the
 * *finished* track:
 *
 * - **missing audio** — no track at all, a track with no clips, or a scene that
 *   was written to be spoken and has no segment;
 * - **duration mismatch** — the track against the plan, against its own segment
 *   sum, and against the caption track's last cue;
 * - **unexpected silence** — the clips are decoded to PCM and scanned in windows:
 *   a stretch of silence this long inside a sentence, or a whole clip below the
 *   floor, is a defect whether the adapter reported success or not;
 * - **invalid artifact** — a hash the store does not have, bytes that are not the
 *   container the track claims, a measured duration that disagrees with the
 *   recorded one, or a file smaller than a syllable.
 *
 * Silence detection is honest about its limits: only uncompressed WAV can be
 * scanned, so an MP3 clip is reported as **unmeasurable** rather than assumed
 * fine.
 */

export function checkAudio(evidence: QAEvidence, deps: QADeps, settings: QASettings): CheckResult {
  const findings = [];
  let examined = 0;
  const track = evidence.audio?.doc;

  if (track === undefined) {
    return checkResult("audio.track", "audio", 0, [
      finding(
        "audio_missing",
        "episode",
        "no narration track was supplied, so the episode has no voice",
        {},
        "run the voice stage, or render a silent episode deliberately",
      ),
    ]);
  }

  const { manifest } = evidence;
  examined += track.segments.length;

  if (track.segments.length === 0) {
    findings.push(
      finding(
        "audio_missing",
        "track",
        "the narration track has no segments, so nothing is spoken",
        { segments: 0, plannedScenes: manifest.scenes.length },
      ),
    );
  }

  // ── A scene that should speak, and does not ──────────────────────────────
  for (const scene of manifest.scenes) {
    if (scene.narration.text.trim() === "") continue;
    examined += 1;
    const segment = track.segments.find((entry) => entry.sceneId === scene.id);
    if (segment === undefined) {
      findings.push(
        finding(
          "audio_segment_missing",
          scene.id,
          `scene ${scene.id} narrates ${scene.narration.words} word(s) but has no segment in the track`,
          { sceneId: scene.id, words: scene.narration.words },
          "re-run the voice stage for this scene",
        ),
      );
    }
  }

  // ── Duration: the track against the plan and against itself ──────────────
  const spoken = track.totals.spokenDurationSec;
  const planned = manifest.totalDurationSec;
  const drift = round2(spoken - planned);
  examined += 1;
  if (Math.abs(spoken - planned) > settings.durationToleranceSec) {
    findings.push(
      finding(
        "audio_duration_mismatch",
        "track",
        `the narration runs ${round2(spoken)}s against a plan of ${round2(planned)}s ` +
          `(${drift > 0 ? "+" : ""}${drift}s, tolerance ${settings.durationToleranceSec}s)`,
        {
          spokenSec: round2(spoken),
          plannedSec: round2(planned),
          driftSec: drift,
          toleranceSec: settings.durationToleranceSec,
        },
        "re-plan the scenes to the spoken timings, or re-voice to the plan",
      ),
    );
  } else if (Math.abs(spoken - planned) > settings.durationWarnSec) {
    findings.push(
      finding(
        "audio_drift",
        "track",
        `the narration runs ${round2(spoken)}s against a plan of ${round2(planned)}s (${drift}s)`,
        { spokenSec: round2(spoken), plannedSec: round2(planned), driftSec: drift },
      ),
    );
  }
  if (evidence.captions !== undefined) {
    const cues = evidence.captions.doc.cues;
    const lastCueMs = cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
    examined += 1;
    if (lastCueMs / 1000 > spoken + settings.durationToleranceSec) {
      findings.push(
        finding(
          "audio_duration_mismatch",
          "captions",
          `the caption track holds a cue until ${round2(lastCueMs / 1000)}s, past the end of the narration (${round2(spoken)}s)`,
          { lastCueSec: round2(lastCueMs / 1000), spokenSec: round2(spoken) },
          "rebuild the caption track from the current audio",
        ),
      );
    }
  }

  // ── The clips themselves: present, the right container, and audible ──────
  const silentWindows: string[] = [];
  let unmeasurable = 0;
  for (const segment of track.segments) {
    examined += 1;
    const label = `${segment.sceneId}/${segment.id}`;
    let bytes: Uint8Array;
    try {
      if (!deps.storage.has(segment.audio.hash)) throw new Error("not in the store");
      bytes = deps.storage.read(segment.audio.hash);
    } catch {
      findings.push(
        finding(
          "audio_artifact_invalid",
          label,
          `clip ${segment.audio.hash.slice(0, 12)}… is not in the artifact store`,
          { sceneId: segment.sceneId, hash: segment.audio.hash, bytes: segment.audio.bytes },
          "re-run the voice stage; the cache entry points at bytes that are gone",
        ),
      );
      continue;
    }
    if (bytes.byteLength !== segment.audio.bytes) {
      findings.push(
        finding(
          "audio_artifact_invalid",
          label,
          `clip ${label} measures ${bytes.byteLength} bytes in the store but the track records ${segment.audio.bytes}`,
          {
            sceneId: segment.sceneId,
            storedBytes: bytes.byteLength,
            recordedBytes: segment.audio.bytes,
          },
        ),
      );
    }
    if (bytes.byteLength < 512) {
      findings.push(
        finding(
          "audio_artifact_invalid",
          label,
          `clip ${label} is ${bytes.byteLength} bytes, too short to contain the ${segment.words} word(s) it speaks`,
          { sceneId: segment.sceneId, bytes: bytes.byteLength, words: segment.words },
        ),
      );
      continue;
    }

    const probe = probeAudio(bytes);
    if (probe.format !== segment.audio.format) {
      findings.push(
        finding(
          "audio_artifact_invalid",
          label,
          `clip ${label} is ${probe.format} but the track records ${segment.audio.format}`,
          { sceneId: segment.sceneId, probed: probe.format, recorded: segment.audio.format },
        ),
      );
    }
    if (probe.durationMs !== undefined) {
      const measured = probe.durationMs / 1000;
      examined += 1;
      if (Math.abs(measured - segment.durationSec) > settings.durationWarnSec) {
        findings.push(
          finding(
            "audio_artifact_invalid",
            label,
            `clip ${label} is ${round2(measured)}s of audio but the track times it at ${round2(segment.durationSec)}s`,
            {
              sceneId: segment.sceneId,
              measuredSec: round2(measured),
              recordedSec: round2(segment.durationSec),
              method: segment.durationMethod,
            },
            "re-probe the clip; the timings downstream are built on this number",
          ),
        );
      }
    }

    if (probe.format !== "wav") {
      unmeasurable += 1;
      continue;
    }
    let wav;
    try {
      wav = decodeWav(bytes);
    } catch (error) {
      findings.push(
        finding(
          "audio_artifact_invalid",
          label,
          `clip ${label} claims to be WAV but cannot be decoded: ${error instanceof Error ? error.message : String(error)}`,
          { sceneId: segment.sceneId, hash: segment.audio.hash.slice(0, 12) },
        ),
      );
      continue;
    }

    const level = rmsOf(wav.samples);
    if (level < settings.minClipRms) {
      findings.push(
        finding(
          "audio_silence",
          label,
          `clip ${label} speaks ${segment.words} word(s) but sits at ${round2(level * 1_000) / 1_000} RMS ` +
            `(floor ${settings.minClipRms}), so nothing is audible`,
          { sceneId: segment.sceneId, rms: round2(level), words: segment.words },
          "re-voice the scene",
        ),
      );
      continue;
    }

    const quiet = silentWindowsOf(wav.samples, wav.sampleRate, settings);
    if (quiet.length > 0) {
      silentWindows.push(
        `${label} (${quiet.map((window) => `${round2(window.startSec)}s`).join(", ")})`,
      );
      findings.push(
        finding(
          "audio_silence",
          label,
          `clip ${label} goes silent for ${quiet.length} stretch(es) of ` +
            `${settings.silenceWindowSec}s or more while it should be speaking ` +
            `(first at ${round2(quiet[0]?.startSec ?? 0)}s)`,
          {
            sceneId: segment.sceneId,
            windows: quiet.length,
            longestSec: round2(quiet.reduce((max, window) => Math.max(max, window.lengthSec), 0)),
            thresholdRms: settings.silenceRms,
          },
          "re-voice the scene, or trim the gap in the adapter",
        ),
      );
    }
  }

  if (unmeasurable > 0) {
    findings.push(
      finding(
        "audio_unmeasurable",
        "track",
        `${unmeasurable} clip(s) are compressed, so silence inside them was not measured`,
        { clips: unmeasurable },
        "have the adapter emit WAV if silence detection matters for this episode",
      ),
    );
  }

  const note = [
    `${track.segments.length} segment(s)`,
    `${round2(track.totals.wordsPerSecond)} words/s`,
    track.totals.estimatedSegments > 0 ? `${track.totals.estimatedSegments} estimated clip(s)` : "",
    unmeasurable > 0 ? `${unmeasurable} unmeasurable clip(s)` : "",
  ]
    .filter((part) => part !== "")
    .join(", ");

  return checkResult("audio.track", "audio", examined, findings, note);
}

/** Root-mean-square of interleaved samples, folded to one level. */
function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

interface SilentWindow {
  readonly startSec: number;
  readonly lengthSec: number;
}

/**
 * Windows of silence inside a clip, in seconds.
 *
 * Exported because it is the one piece of QA that is arithmetic rather than
 * comparison, and its tests should not have to build a whole episode.
 *
 * The whole clip's RMS is not enough: a clip can be loud on average and still
 * contain a hole where a sentence should be. So the samples are scanned with a
 * short moving window (50 ms — fine enough that the reported start and length are
 * usable, while a run has to reach `silenceWindowSec` before it counts at all),
 * and every qualifying run is kept. The scan is a prefix sum, so the cost is one
 * pass regardless of the window size.
 */
export function silentWindowsOf(
  samples: Float32Array,
  sampleRate: number,
  settings: QASettings,
): readonly SilentWindow[] {
  const hopFrames = Math.max(1, Math.round(sampleRate * 0.05));
  const minRunFrames = Math.max(hopFrames, Math.round(settings.silenceWindowSec * sampleRate));
  const prefix = new Float64Array(samples.length + 1);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    prefix[index + 1] = prefix[index]! + value * value;
  }
  const rmsAt = (start: number): number => {
    const sum = prefix[start + hopFrames]! - prefix[start]!;
    return Math.sqrt(sum / hopFrames);
  };

  const windows: SilentWindow[] = [];
  let runStart = -1;
  let runFrames = 0;
  for (let start = 0; start + hopFrames <= samples.length; start += hopFrames) {
    if (rmsAt(start) < settings.silenceRms) {
      if (runStart < 0) runStart = start;
      runFrames += hopFrames;
      continue;
    }
    if (runStart >= 0) {
      if (runFrames >= minRunFrames) {
        windows.push({ startSec: runStart / sampleRate, lengthSec: runFrames / sampleRate });
      }
      runStart = -1;
      runFrames = 0;
    }
  }
  if (runStart >= 0 && runFrames >= minRunFrames) {
    windows.push({ startSec: runStart / sampleRate, lengthSec: runFrames / sampleRate });
  }
  return windows;
}
