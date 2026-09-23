import { readFileSync } from "node:fs";

import type { ArtifactRef, ArtifactRow, Repo } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import {
  failureBytes,
  isRenderComplete,
  metadataBytes,
  RENDER_ENGINE_NAME,
  RENDER_ENGINE_VERSION,
  RenderMetadataSchema,
  type RenderFailure,
  type RenderMetadata,
} from "./schema.js";

/**
 * Persistence for a rendered video.
 *
 * The pipeline writes its files into the render work directory, because FFmpeg
 * needs paths; this module is what puts the *result* where the rest of the system
 * looks for it: the content-addressed store, one entry per artifact —
 *
 * | artifact | kind | role | what it is |
 * | -------- | ---- | ---- | ---------- |
 * | `video_master` | `video` | the deliverable | the assembled MP4 |
 * | `render_thumbnail` | `thumbnail` | the poster frame | a JPEG of one frame |
 * | `narration_track` | `audio` | the muxed narration | the WAV the video carries |
 * | `render_metadata` | `metadata` | the evidence | toolchain, inputs, segments, issues |
 * | `render_log` | `document` | what happened | the structured log, line by line |
 *
 * `registerArtifact` is idempotent by hash, so re-running a render that produced
 * the same video registers nothing new — and a job's step carries the whole
 * deliverable, not a path somebody might later move.
 */

export const VIDEO_ARTIFACT_KIND = "video" as const;
export const VIDEO_ARTIFACT_ROLE = "video_master" as const;
export const THUMBNAIL_ARTIFACT_KIND = "thumbnail" as const;
export const THUMBNAIL_ARTIFACT_ROLE = "render_thumbnail" as const;
export const NARRATION_ARTIFACT_KIND = "audio" as const;
export const NARRATION_ARTIFACT_ROLE = "narration_track" as const;
export const METADATA_ARTIFACT_KIND = "metadata" as const;
export const METADATA_ARTIFACT_ROLE = "render_metadata" as const;
export const LOG_ARTIFACT_KIND = "document" as const;
export const LOG_ARTIFACT_ROLE = "render_log" as const;
export const FAILURE_ARTIFACT_KIND = "metadata" as const;
export const FAILURE_ARTIFACT_ROLE = "render_failure" as const;

export interface PersistRenderDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
}

/**
 * Artifact metadata is a small, fixed vocabulary (width, height, fps, durationSec,
 * codec, generatedBy) — deliberately, so the `artifacts` table stays a status view
 * and never a second copy of a document. Everything richer lives in the metadata
 * artifact, one read away.
 */
type ArtifactMeta = Readonly<{
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  codec?: string;
  generatedBy?: { readonly provider: string; readonly model?: string };
}>;

export interface PersistedRender {
  readonly video: ArtifactRow;
  readonly metadata: ArtifactRow;
  readonly log: ArtifactRow;
  readonly thumbnail?: ArtifactRow | undefined;
  readonly narration?: ArtifactRow | undefined;
}

export interface RenderFiles {
  readonly video: { readonly file: string; readonly hash: string; readonly bytes: number };
  readonly thumbnail?:
    { readonly file: string; readonly hash: string; readonly bytes: number } | undefined;
  readonly narration?:
    { readonly file: string; readonly hash: string; readonly bytes: number } | undefined;
}

export function persistRender(
  deps: PersistRenderDeps,
  files: RenderFiles,
  metadata: RenderMetadata,
  logJsonl: Uint8Array,
): PersistedRender {
  const valid = RenderMetadataSchema.parse(metadata);
  const video = putFile(deps, files.video.file, VIDEO_ARTIFACT_KIND, {
    codec: valid.output.videoCodec,
    durationSec: valid.output.durationSec,
    width: valid.output.width,
    height: valid.output.height,
    fps: config_fps(valid),
  });
  const metadataArtifact = putBytes(deps, metadataBytes(valid), METADATA_ARTIFACT_KIND, {
    // `codec` names what the bytes are; a render that could not complete is not a
    // deliverable, and the metadata says so in one word.
    codec: isRenderComplete(valid) ? "complete" : "incomplete",
    durationSec: valid.output.durationSec,
    generatedBy: { provider: `${RENDER_ENGINE_NAME} ${RENDER_ENGINE_VERSION}` },
  });
  const log = putBytes(deps, logJsonl, LOG_ARTIFACT_KIND, { codec: "jsonl" });
  const thumbnail =
    files.thumbnail === undefined
      ? undefined
      : putFile(deps, files.thumbnail.file, THUMBNAIL_ARTIFACT_KIND, {
          codec: "jpeg",
          width: valid.thumbnail?.width,
          height: valid.thumbnail?.height,
        });
  const narration =
    files.narration === undefined
      ? undefined
      : putFile(deps, files.narration.file, NARRATION_ARTIFACT_KIND, {
          codec: "pcm_s16le",
          durationSec: valid.audio?.durationSec ?? valid.output.durationSec,
        });

  return {
    video,
    metadata: metadataArtifact,
    log,
    ...(thumbnail !== undefined ? { thumbnail } : {}),
    ...(narration !== undefined ? { narration } : {}),
  };
}

/** The artifact references a completed `render` stage reports to the runner. */
export function renderArtifactRefs(persisted: PersistedRender): ArtifactRef[] {
  return [
    { hash: persisted.video.hash, kind: VIDEO_ARTIFACT_KIND, role: VIDEO_ARTIFACT_ROLE },
    { hash: persisted.metadata.hash, kind: METADATA_ARTIFACT_KIND, role: METADATA_ARTIFACT_ROLE },
    { hash: persisted.log.hash, kind: LOG_ARTIFACT_KIND, role: LOG_ARTIFACT_ROLE },
    ...(persisted.thumbnail !== undefined
      ? [
          {
            hash: persisted.thumbnail.hash,
            kind: THUMBNAIL_ARTIFACT_KIND,
            role: THUMBNAIL_ARTIFACT_ROLE,
          },
        ]
      : []),
    ...(persisted.narration !== undefined
      ? [
          {
            hash: persisted.narration.hash,
            kind: NARRATION_ARTIFACT_KIND,
            role: NARRATION_ARTIFACT_ROLE,
          },
        ]
      : []),
  ];
}

/**
 * A failed render's report, in the CAS like everything else.
 *
 * The stage persists this before it throws, so the job row, the dashboard and the
 * operator's next visit all point at the same document: which phase failed, what
 * FFmpeg said, and which segments are already rendered and worth reusing.
 */
export function persistRenderFailure(deps: PersistRenderDeps, failure: RenderFailure): ArtifactRow {
  const artifact = putBytes(deps, failureBytes(failure), FAILURE_ARTIFACT_KIND, {
    codec: "failed",
  });
  return artifact;
}

export function renderFailureArtifactRef(artifact: ArtifactRow): ArtifactRef {
  return {
    hash: artifact.hash,
    kind: FAILURE_ARTIFACT_KIND,
    role: FAILURE_ARTIFACT_ROLE,
  };
}

/** Read a render's metadata back (the QA stage and the dashboard do this). */
export function loadRenderMetadata(storage: BlobStore, hash: string): RenderMetadata {
  return RenderMetadataSchema.parse(JSON.parse(new TextDecoder().decode(storage.read(hash))));
}

/** The video bytes of a render, straight out of the CAS. */
export function readVideo(storage: BlobStore, hash: string): Uint8Array {
  return storage.read(hash);
}

/** The render log as JSON Lines: one event per line, append-friendly. */
export function renderLogBytes(
  events: readonly {
    readonly at: number;
    readonly level: string;
    readonly event: string;
    readonly message: string;
    readonly data?: Readonly<Record<string, unknown>> | undefined;
  }[],
  header: { readonly renderKey: string; readonly engine: string; readonly engineVersion: string },
): Uint8Array {
  const lines = [
    JSON.stringify({
      kind: "render.log",
      ...header,
      engine: RENDER_ENGINE_NAME,
      engineVersion: RENDER_ENGINE_VERSION,
    }),
    ...events.map((event) => JSON.stringify(event)),
  ];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

/** The container's fps is a rational; the artifact meta wants whole frames. */
function config_fps(metadata: RenderMetadata): number {
  return Math.max(1, Math.round(metadata.output.fps));
}

function putFile(
  deps: PersistRenderDeps,
  file: string,
  kind: string,
  meta: ArtifactMeta,
): ArtifactRow {
  const bytes = new Uint8Array(readFileSync(file));
  return putBytes(deps, bytes, kind, meta);
}

function putBytes(
  deps: PersistRenderDeps,
  bytes: Uint8Array,
  kind: string,
  meta: ArtifactMeta,
): ArtifactRow {
  const put = deps.storage.put(bytes);
  return deps.repo.registerArtifact({
    hash: put.hash,
    kind: kind as ArtifactRow["kind"],
    bytes: put.bytes,
    meta,
  });
}
