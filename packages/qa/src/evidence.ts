import { readFileSync } from "node:fs";

import type { CaptionTrack, AudioTrack } from "@nexus/audio";
import type { CharacterLibrary } from "@nexus/characters";
import type { ResearchPackage } from "@nexus/research";
import type { SceneManifest } from "@nexus/scenes";
import type { ScriptDoc } from "@nexus/script";
import type { BlobStore } from "@nexus/storage";
import type { FontSet, RenderMetadata } from "@nexus/video";

import type { CheckResult } from "./findings.js";
import type { PipelineSnapshot } from "./snapshot.js";
import type { QASettings } from "./schema.js";

/**
 * What QA reads, and what it is allowed to do.
 *
 * The engine takes **documents that are already loaded** rather than paths and
 * hashes it fetches itself. That is deliberate: it makes the checks pure
 * functions of their evidence (so every failing case is a small test that hands
 * over a broken document), and it keeps "where the bytes come from" in the stage
 * task, which is the only place that knows the pipeline.
 *
 * The exceptions are the two places where the *bytes* are the evidence — an audio
 * clip's PCM and the encoded video file — and those go through the small reader
 * interface below, so a test can point at a fixture without a real file.
 */

export interface Loaded<T> {
  readonly doc: T;
  readonly hash: string;
}

export interface QAEvidence {
  readonly episodeId: string;
  readonly jobId: string;
  /** The plan every visual check is written against. Required: no plan, no QA. */
  readonly manifest: SceneManifest;
  readonly manifestHash: string;
  readonly script?: Loaded<ScriptDoc> | undefined;
  readonly research?: Loaded<ResearchPackage> | undefined;
  readonly audio?: Loaded<AudioTrack> | undefined;
  readonly captions?: Loaded<CaptionTrack> | undefined;
  readonly render?: Loaded<RenderMetadata> | undefined;
  /** The encoded deliverable: a path when it is on disk, a hash when it is in the CAS. */
  readonly video?:
    { readonly path?: string | undefined; readonly hash?: string | undefined } | undefined;
  /** The job's own state, when QA is running inside the pipeline. */
  readonly pipeline?: PipelineSnapshot | undefined;
}

export interface QADeps {
  /** Reads artifact bytes by hash (audio clips, a video stored in the CAS). */
  readonly storage: BlobStore;
  /** The character library, when the visual checks may verify layer files. */
  readonly characters?: CharacterLibrary | undefined;
  /** The faces text is measured with; without them, readability is reported as unchecked. */
  readonly fonts?: FontSet | undefined;
  readonly settings?: QASettings | undefined;
  /** Overrides `generatedAt` (fixtures are reproducible). */
  readonly now?: string | undefined;
  /** Where a file's bytes come from; `node:fs` by default. */
  readonly readFile?: ((path: string) => Uint8Array) | undefined;
}

export type Checker = (evidence: QAEvidence, deps: QADeps, settings: QASettings) => CheckResult;

/** Byte reads used by the checks that need bytes rather than documents. */
export function readBytes(deps: QADeps, file: string): Uint8Array {
  return (deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path))))(file);
}
