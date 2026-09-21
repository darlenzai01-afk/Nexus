import {
  ScriptDocSchema,
  scriptDocBytes,
  type ArtifactRef,
  type ArtifactRow,
  type ClaimRow,
  type ScriptDoc,
  type ScriptRow,
} from "@nexus/db";
import type { Repo } from "@nexus/db";
import type { ResearchPackage } from "@nexus/research";
import type { BlobStore } from "@nexus/storage";

/**
 * Persistence for a finished script.
 *
 * Three things land, and together they are the claim/evidence chain:
 *
 * 1. **The script artifact** — the whole document in the CAS (`kind: "script"`,
 *    the kind the `script` stage declares it produces), registered with its
 *    `generatedBy` provenance. It carries the claim ledger, so the traceability
 *    survives even if the SQL rows are pruned.
 * 2. **A `scripts` row** — version per episode, `draft` status, `doc_hash`
 *    pointing at the artifact; the scene/caption stages hang off it.
 * 3. **`claims` + `claim_evidence` rows** — one claim row per researched claim
 *    the script uses (bound to the sentence that states it) and one evidence row
 *    per (claim, source) pair with the verbatim excerpt. This is the OD-15
 *    hand-off: pre-script claims live in the research package, script-bound
 *    claims live here.
 */

export const SCRIPT_ARTIFACT_KIND = "script" as const;
export const SCRIPT_ARTIFACT_ROLE = "script_doc" as const;

export interface PersistScriptOptions {
  readonly episodeId: string;
  /** Script status: `draft` by default — approval is a separate human gate. */
  readonly status?: "draft" | "approved" | "rejected" | "superseded";
  readonly generatedBy?: {
    readonly provider: string;
    readonly model?: string;
    readonly templateVersion?: string;
  };
}

export interface PersistedScript {
  readonly hash: string;
  readonly bytes: number;
  readonly created: boolean;
  readonly artifact: ArtifactRow;
  readonly script: ScriptRow;
  readonly claims: readonly ClaimRow[];
  /** Research source id → `sources` row id, for every source the script cites. */
  readonly sourceIds: Readonly<Record<string, string>>;
  /** Claims whose evidence could not be resolved to a `sources` row. */
  readonly unresolvedEvidence: readonly string[];
}

export interface PersistScriptDeps {
  readonly storage: BlobStore;
  readonly repo: Repo;
}

/**
 * Resolve the research package's source ids to `sources` rows.
 *
 * `repo.addSource` is idempotent (it returns the existing row when the URL or
 * the content hash is already known), so this is also what makes a script
 * re-run attach to the same source rows instead of duplicating them.
 */
export function resolveSourceIds(
  repo: Repo,
  pkg: ResearchPackage,
): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const source of pkg.sources) {
    const row = repo.addSource({
      url: source.url,
      content: source.content,
      title: source.title,
      publisher: source.publisher,
      addedBy: source.retrieval === "operator_text" ? "operator" : "provider",
    });
    map[source.id] = row.id;
  }
  return map;
}

export function persistScript(
  deps: PersistScriptDeps,
  doc: ScriptDoc,
  pkg: ResearchPackage,
  options: PersistScriptOptions,
): PersistedScript {
  // Validate before writing: everything downstream trusts the CAS bytes.
  const valid = ScriptDocSchema.parse(doc);
  const put = deps.storage.put(scriptDocBytes(valid));
  const artifact = deps.repo.registerArtifact({
    hash: put.hash,
    kind: SCRIPT_ARTIFACT_KIND,
    bytes: put.bytes,
    meta: {
      generatedBy: options.generatedBy ?? {
        provider: valid.provenance.providers.llm,
        model: valid.provenance.steps.find((step) => step.model !== undefined)?.model,
        templateVersion: valid.provenance.steps.find((step) => step.templateVersion !== undefined)
          ?.templateVersion,
      },
    },
  });

  const script = deps.repo.createScript({
    episodeId: options.episodeId,
    doc: valid,
    docHash: put.hash,
    ...(options.status !== undefined ? { status: options.status } : {}),
  });

  // Sources must exist before claim evidence can reference them.
  const sourceIds = resolveSourceIds(deps.repo, pkg);
  const unresolved: string[] = [];

  const claims = deps.repo.replaceClaims(
    script.id,
    valid.claims.map((entry) => {
      const primarySentence = entry.sentenceIds[0] ?? "";
      const evidence = entry.evidence
        .map((ref) => {
          const sourceId = sourceIds[ref.sourceId];
          if (sourceId === undefined) {
            unresolved.push(`${entry.claimId}→${ref.sourceId}`);
            return undefined;
          }
          return {
            sourceId,
            excerpt: ref.excerpt,
            locator: ref.locator,
            score: entry.confidence,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== undefined);
      return {
        claimRef: entry.claimId,
        sentenceId: primarySentence,
        text: entry.statement,
        // The research vocabulary and the claim vocabulary are the same five
        // values, so the status carries over without translation.
        status: entry.status,
        score: entry.confidence,
        evidence,
      };
    }),
  );

  return {
    hash: put.hash,
    bytes: put.bytes,
    created: put.created,
    artifact,
    script,
    claims,
    sourceIds,
    unresolvedEvidence: unresolved,
  };
}

/** The artifact reference a completed `script` stage reports to the runner. */
export function scriptArtifactRef(persisted: Pick<PersistedScript, "hash">): ArtifactRef {
  return { hash: persisted.hash, kind: SCRIPT_ARTIFACT_KIND, role: SCRIPT_ARTIFACT_ROLE };
}

/** Read a persisted script back (downstream stages and the reuse guard). */
export function loadScriptDoc(storage: BlobStore, hash: string): ScriptDoc {
  return ScriptDocSchema.parse(JSON.parse(new TextDecoder().decode(storage.read(hash))));
}
