import type { ArtifactRef, ArtifactRow, Repo, SourceRow } from "@nexus/db";
import type { BlobStore } from "@nexus/storage";

import {
  ResearchPackageSchema,
  researchPackageBytes,
  type GeneratedBy,
  type ResearchPackage,
} from "./types.js";

/**
 * Persistence for a finished research run.
 *
 * What goes where, and why:
 *
 * - **The package** is one JSON document in the CAS (`kind: "document"`, the
 *   kind the `research` stage already declares it produces), registered in the
 *   `artifacts` table with its `generatedBy` provenance. It is the source of
 *   truth for evidence, claims, conflicts and verification status.
 * - **Sources** go to the `sources` table and are linked to the episode
 *   (`episode_sources`), so later stages and the operator can reach the actual
 *   retrieved material without parsing the package. `repo.addSource` dedupes by
 *   URL *or* content hash, so re-running research never duplicates a source.
 * - **Claims stay in the package** for now: the `claims` table is keyed by
 *   `script_id` + `sentence_id`, so a pre-script claim has no row to live in.
 *   The fact-check stage turns accepted claims into script-bound rows (see
 *   OD-15 in docs/plans/ISSUES.md).
 */

export const RESEARCH_ARTIFACT_KIND = "document" as const;
export const RESEARCH_ARTIFACT_ROLE = "research_package" as const;

export interface PersistResearchOptions {
  readonly episodeId?: string;
  /** `episode_sources.role` for the links (default `research`). */
  readonly role?: string;
  readonly generatedBy?: GeneratedBy;
  readonly clock?: { nowIso(): string };
}

export interface PersistedResearch {
  /** CAS hash of the canonical package JSON. */
  readonly hash: string;
  readonly bytes: number;
  /** False when identical package bytes were already in the CAS (free re-run). */
  readonly created: boolean;
  readonly artifact?: ArtifactRow;
  /** Package source id → `sources` row id (empty without a repo). */
  readonly sourceIds: Readonly<Record<string, string>>;
  /** Rows written to `episode_sources`. */
  readonly linked: number;
  readonly rows: readonly SourceRow[];
}

export interface PersistResearchDeps {
  readonly storage: BlobStore;
  readonly repo?: Repo;
}

export function persistResearchPackage(
  deps: PersistResearchDeps,
  pkg: ResearchPackage,
  options: PersistResearchOptions = {},
): PersistedResearch {
  // Re-validate before writing: an artifact that cannot be parsed back is worse
  // than a failed run, because everything downstream trusts the CAS.
  const valid = ResearchPackageSchema.parse(pkg);
  const bytes = researchPackageBytes(valid);
  const put = deps.storage.put(bytes);

  const sourceIds: Record<string, string> = {};
  const rows: SourceRow[] = [];
  let linked = 0;
  let artifact: ArtifactRow | undefined;
  const repo = deps.repo;

  if (repo !== undefined) {
    artifact = repo.registerArtifact({
      hash: put.hash,
      kind: RESEARCH_ARTIFACT_KIND,
      bytes: put.bytes,
      ...(options.generatedBy !== undefined ? { meta: { generatedBy: options.generatedBy } } : {}),
    });

    for (const source of valid.sources) {
      const row = repo.addSource({
        url: source.url,
        content: source.content,
        title: source.title,
        publisher: source.publisher,
        // Operator-pasted text stays operator-sourced: provenance is not cosmetic.
        addedBy: source.retrieval === "operator_text" ? "operator" : "provider",
      });
      sourceIds[source.id] = row.id;
      rows.push(row);
      if (options.episodeId !== undefined) {
        repo.linkEpisodeSource(options.episodeId, row.id, options.role ?? "research");
        linked += 1;
      }
    }
  }

  return {
    hash: put.hash,
    bytes: put.bytes,
    created: put.created,
    ...(artifact !== undefined ? { artifact } : {}),
    sourceIds,
    linked,
    rows,
  };
}

/** The artifact reference a completed `research` stage reports to the runner. */
export function researchArtifactRef(persisted: Pick<PersistedResearch, "hash">): ArtifactRef {
  return { hash: persisted.hash, kind: RESEARCH_ARTIFACT_KIND, role: RESEARCH_ARTIFACT_ROLE };
}

/** Read a persisted package back (used by downstream stages and reuse guards). */
export function loadResearchPackage(storage: BlobStore, hash: string): ResearchPackage {
  return ResearchPackageSchema.parse(JSON.parse(new TextDecoder().decode(storage.read(hash))));
}
