import type { ArtifactRef, ArtifactRow, Repo } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import {
  AudioTrackSchema,
  audioTrackBytes,
  type AudioFormat,
  type AudioSegment,
  type AudioTrack,
} from "./schema.js";

/**
 * Persistence for a voice track.
 *
 * Every synthesized clip is **already in the CAS** — the adapter put it there, so
 * a segment never carries bytes through memory twice — and this module registers
 * it as an `audio` artifact (the kind the `voice` stage declares it produces) with
 * the metadata a status view wants without opening a blob: the duration in
 * seconds, the codec, and nothing else (the artifact-meta schema is deliberately
 * small; everything richer belongs in the track document).
 *
 * `codec` always names what the artifact's **bytes** are. A segment is audio, so
 * it carries the real codec (`pcm_s16le`, `mp3`); the track is the JSON document
 * that describes the episode's audio, so it says `json` — the container, sample
 * rate and voice of every clip are in the document itself, one read away.
 *
 * `registerArtifact` is idempotent by hash, so the operator-supplied clip the
 * pipeline adopted and the blob the adapter wrote both register exactly once.
 */

export const AUDIO_ARTIFACT_KIND = "audio" as const;
export const AUDIO_TRACK_ARTIFACT_ROLE = "voice_track" as const;
export const AUDIO_SEGMENT_ARTIFACT_ROLE = "voice_segment" as const;

export interface PersistAudioDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
}

export interface PersistedAudioTrack {
  readonly hash: string;
  readonly bytes: number;
  readonly created: boolean;
  readonly artifact: ArtifactRow;
  readonly segments: readonly ArtifactRow[];
}

export function codecOf(format: AudioFormat): string {
  return format === "wav" ? "pcm_s16le" : "mp3";
}

/** The track artifact is the JSON timing document, not playable audio. */
export const TRACK_DOCUMENT_CODEC = "json";

export function persistAudioTrack(deps: PersistAudioDeps, track: AudioTrack): PersistedAudioTrack {
  // Validate before writing: everything downstream trusts the CAS bytes.
  const valid = AudioTrackSchema.parse(track);
  const segments = valid.segments.map((segment) => registerSegmentAudio(deps, segment));
  const put = deps.storage.put(audioTrackBytes(valid));
  const artifact = deps.repo.registerArtifact({
    hash: put.hash,
    kind: AUDIO_ARTIFACT_KIND,
    bytes: put.bytes,
    meta: {
      durationSec: valid.totals.spokenDurationSec,
      codec: TRACK_DOCUMENT_CODEC,
    },
  });
  return { hash: put.hash, bytes: put.bytes, created: put.created, artifact, segments };
}

/** The clip artifact row for one segment (idempotent: keyed by content hash). */
export function registerSegmentAudio(deps: PersistAudioDeps, segment: AudioSegment): ArtifactRow {
  return deps.repo.registerArtifact({
    hash: segment.audio.hash,
    kind: AUDIO_ARTIFACT_KIND,
    bytes: segment.audio.bytes,
    meta: {
      durationSec: segment.durationSec,
      codec: codecOf(segment.audio.format),
    },
  });
}

/** The artifact reference a completed `voice` stage reports to the runner. */
export function audioTrackArtifactRef(persisted: Pick<PersistedAudioTrack, "hash">): ArtifactRef {
  return { hash: persisted.hash, kind: AUDIO_ARTIFACT_KIND, role: AUDIO_TRACK_ARTIFACT_ROLE };
}

/** One reference per clip, so the job's step carries the whole voice as artifacts. */
export function audioSegmentArtifactRefs(track: AudioTrack): readonly ArtifactRef[] {
  return track.segments.map((segment) => ({
    hash: segment.audio.hash,
    kind: AUDIO_ARTIFACT_KIND,
    role: AUDIO_SEGMENT_ARTIFACT_ROLE,
  }));
}

/** Read a persisted track back (captions, mux, QA and the renderer do this). */
export function loadAudioTrack(storage: BlobStore, hash: string): AudioTrack {
  return AudioTrackSchema.parse(JSON.parse(new TextDecoder().decode(storage.read(hash))));
}

/** The clip bytes of one segment, read from the CAS by the hash in the track. */
export function readSegmentAudio(storage: BlobStore, segment: AudioSegment): Uint8Array {
  return storage.read(segment.audio.hash);
}
