import type { ArtifactRef, ArtifactRow, Repo } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import { SceneManifestSchema, sceneManifestBytes, type SceneManifest } from "./schema.js";

/**
 * Persistence for a scene manifest.
 *
 * The manifest is **one CAS artifact**, `kind: "scene_graph"` — the kind the
 * `plan` stage declares it produces — and the artifact row carries the metadata
 * a status view wants without opening the blob (duration, fps, frame size).
 *
 * No `scenes` rows are written yet, deliberately (OD-19): the table's `kind`
 * CHECK constraint only knows `title | talk | fact | media | quote`, and widening
 * a CHECK means rebuilding the table (approval-gated, OD-10). The six-type
 * vocabulary is richer than those five values, so the mapping lives in
 * `legacySceneKind()` and the rows can be written by the stage that actually
 * consumes them (media sourcing / rendering), without re-deriving anything.
 */

export const SCENE_MANIFEST_ARTIFACT_KIND = "scene_graph" as const;
export const SCENE_MANIFEST_ARTIFACT_ROLE = "scene_manifest" as const;

export interface PersistSceneManifestDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
}

export interface PersistedSceneManifest {
  readonly hash: string;
  readonly bytes: number;
  readonly created: boolean;
  readonly artifact: ArtifactRow;
}

export function persistSceneManifest(
  deps: PersistSceneManifestDeps,
  manifest: SceneManifest,
  _options: { readonly episodeId?: string } = {},
): PersistedSceneManifest {
  // Validate before writing: everything downstream trusts the CAS bytes.
  const valid = SceneManifestSchema.parse(manifest);
  const put = deps.storage.put(sceneManifestBytes(valid));
  const artifact = deps.repo.registerArtifact({
    hash: put.hash,
    kind: SCENE_MANIFEST_ARTIFACT_KIND,
    bytes: put.bytes,
    meta: {
      durationSec: valid.totalDurationSec,
      fps: valid.fps,
      width: valid.resolution.width,
      height: valid.resolution.height,
    },
  });
  return { hash: put.hash, bytes: put.bytes, created: put.created, artifact };
}

/** The artifact reference a completed `plan` stage reports to the runner. */
export function sceneManifestArtifactRef(
  persisted: Pick<PersistedSceneManifest, "hash">,
): ArtifactRef {
  return {
    hash: persisted.hash,
    kind: SCENE_MANIFEST_ARTIFACT_KIND,
    role: SCENE_MANIFEST_ARTIFACT_ROLE,
  };
}

/** Read a persisted manifest back (media, voice and render stages do this). */
export function loadSceneManifest(storage: BlobStore, hash: string): SceneManifest {
  return SceneManifestSchema.parse(JSON.parse(new TextDecoder().decode(storage.read(hash))));
}
