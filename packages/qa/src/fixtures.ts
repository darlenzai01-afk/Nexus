import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAudioTrack, loadCaptionTrack, type AudioTrack, type CaptionTrack } from "@nexus/audio";
import { CharacterLibrary } from "@nexus/characters";
import { Db, Repo, migrate, type ArtifactRef } from "@nexus/db";
import { LONG_FORM_PIPELINE } from "@nexus/jobs";
import { MemoryBlobStore } from "@nexus/providers";
import { createCharacterStage } from "@nexus/render";
import { ResearchPackageSchema, researchPackageBytes, type ResearchPackage } from "@nexus/research";
import { SceneManifestSchema, persistSceneManifest, type SceneManifest } from "@nexus/scenes";
import { ScriptDocSchema, scriptDocBytes, type ScriptDoc } from "@nexus/script";
import { sha256 } from "@nexus/storage";
import {
  DEFAULT_BOLD_FONT_CANDIDATES,
  DEFAULT_FONT_CANDIDATES,
  FIXTURE_CLOCK,
  RenderMetadataSchema,
  createScriptedFFmpeg,
  findFont,
  fixtureAudio,
  fixtureManifest,
  loadFontFile,
  renderVideo,
  resolveRenderConfig,
  type FontSet,
  type RenderMetadata,
} from "@nexus/video";
import { existsSync } from "node:fs";

import type { QADeps, QAEvidence } from "./evidence.js";
import { DEFAULT_QA_SETTINGS } from "./settings.js";
import type { PipelineSnapshot, PipelineStepSnapshot } from "./snapshot.js";
import type { QASettings } from "./schema.js";

/**
 * QA fixtures: one episode that passes, and the pieces to break it with.
 *
 * The tests for a QA engine are mostly *negative* — every rule needs a case where
 * it fires, and a case where a clean episode produces nothing — so the fixture is
 * a real one: a plan of five long-form sections (the shape the script structure
 * rules require), the bundled character library, narration from the deterministic
 * fake TTS writing actual PCM through the real Phase 10 pipeline, the caption
 * track the caption builder derives, a script and a research package that agree
 * with each other about one supported claim, and — when a test needs it — a video
 * rendered from that plan.
 *
 * The durations are not invented: they are the fake TTS's own output (320 ms per
 * word), so the narration the plan promises and the narration that exists are the
 * same length and nothing in QA has to be told to look the other way.
 */

export const QA_FIXTURE_CLOCK = FIXTURE_CLOCK;
export const QA_FIXTURE_CLAIM = "cl_kira_bridge";
export const QA_FIXTURE_SOURCE = "src_kira_bridge";
export const QA_FIXTURE_EVIDENCE = "ev_kira_bridge";
export const QA_FIXTURE_STATEMENT = "The Kira bridge carries forty thousand crossings a day.";
export const QA_FIXTURE_URL = "https://example.org/kira";

/** The long-form section shape: one hook, one introduction, a body, a conclusion. */
export const QA_SECTION_ROLES = [
  "hook",
  "introduction",
  "narrative",
  "narrative",
  "conclusion",
] as const;

/** One sentence per section, written for the fixture's claim. */
export const QA_NARRATION: readonly string[] = [
  "The Kira bridge carries forty thousand crossings a day.",
  "An engineer counted every vehicle.",
  "A second team counted again.",
  "Both counts agree.",
  "The figure is an estimate.",
];

/** What the fake TTS will produce for those words: 320 ms each. */
const MS_PER_WORD = 320;

export interface QAFixture {
  readonly storage: MemoryBlobStore;
  readonly repo: Repo;
  readonly manifest: SceneManifest;
  readonly manifestHash: string;
  readonly script: { readonly doc: ScriptDoc; readonly hash: string };
  readonly research: { readonly doc: ResearchPackage; readonly hash: string };
  readonly audio: { readonly doc: AudioTrack; readonly hash: string };
  readonly captions: { readonly doc: CaptionTrack; readonly hash: string };
  /** The narration clips, by scene id — for tests that corrupt one of them. */
  readonly clips: ReadonlyMap<string, string>;
  readonly evidence: QAEvidence;
  readonly deps: QADeps;
  /** A copy of the evidence with documents replaced. */
  with(patch: Partial<QAEvidence>): QAEvidence;
  /** The deps with different thresholds (and optionally different readers). */
  depsWith(settings: Partial<QASettings>, patch?: Partial<QADeps>): QADeps;
  /** Render the plan, for the checks that read a file. */
  render(options?: RenderFixtureOptions): RenderedFixture;
}

export interface QAFixtureOptions {
  readonly sections?: readonly (typeof QA_SECTION_ROLES)[number][];
  /** Attach a pipeline snapshot (the job state the pipeline checks read). */
  readonly pipeline?: PipelineSnapshot | undefined;
  /** Leave the script and research documents out of the evidence. */
  readonly withoutContent?: boolean;
  /** Leave the narration track out. */
  readonly withoutAudio?: boolean;
  readonly width?: number;
  readonly height?: number;
}

export interface RenderFixtureOptions {
  /** The render's own size (the plan's resolution is the design size). */
  readonly width?: number;
  readonly height?: number;
  /** Must equal the plan's own rate: a plan's animation is timed in frames. */
  readonly fps?: number;
  readonly segmentFrames?: number;
  /** Mux the narration; `false` renders a silent file. */
  readonly audio?: boolean;
  /** Burn in the captions; `false` renders an uncaptioned file. */
  readonly captions?: boolean;
}

export interface RenderedFixture {
  readonly file: string;
  readonly metadata: RenderMetadata;
  readonly metadataHash: string;
  readonly videoHash: string;
}

let tempRoot: string | undefined;

/** Remove what `render()` wrote (call it from the test file's `afterAll`). */
export function cleanupQAFixtureTemp(): void {
  if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
}

export async function qaFixture(options: QAFixtureOptions = {}): Promise<QAFixture> {
  const storage = new MemoryBlobStore();
  const db = Db.memory();
  migrate(db);
  const repo = new Repo(db);

  // Order matters: the script is written from the plan, then the plan records the
  // hash of the script it was planned from (which is what QA cross-references),
  // and only then are the plan, the narration and the captions written.
  const draft = planFixture({
    sections: options.sections ?? QA_SECTION_ROLES,
    width: options.width ?? 1_920,
    height: options.height ?? 1_080,
  });
  const research = researchFixture();
  const script = scriptFixture(draft, research.hash, storage);
  const manifest = SceneManifestSchema.parse({
    ...draft,
    scriptId: "scr_qa_fixture",
    scriptHash: script.hash,
  });
  const persisted = persistSceneManifest({ storage, repo }, manifest);
  const narration = await fixtureAudio(storage, repo, manifest);
  const audio = loadAudioTrack(storage, narration.trackHash);
  const captions = loadCaptionTrack(storage, narration.captionTrackHash);

  const evidence: QAEvidence = {
    episodeId: "ep_qa_fixture",
    jobId: "job_qa_fixture",
    manifest,
    manifestHash: persisted.hash,
    ...(options.withoutContent === true ? {} : { script, research }),
    ...(options.withoutAudio === true
      ? {}
      : {
          audio: { doc: audio, hash: narration.trackHash },
          captions: { doc: captions, hash: narration.captionTrackHash },
        }),
    ...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
  };

  const settings = DEFAULT_QA_SETTINGS;
  const fonts = fixtureFonts();
  const deps: QADeps = {
    storage,
    characters: CharacterLibrary.load(),
    ...(fonts !== undefined ? { fonts } : {}),
    settings,
    now: QA_FIXTURE_CLOCK,
  };

  return {
    storage,
    repo,
    manifest,
    manifestHash: persisted.hash,
    script,
    research,
    audio: { doc: audio, hash: narration.trackHash },
    captions: { doc: captions, hash: narration.captionTrackHash },
    clips: new Map(audio.segments.map((segment) => [segment.sceneId, segment.audio.hash])),
    evidence,
    deps,
    with: (patch) => ({ ...evidence, ...patch }),
    depsWith: (overrides, patch = {}) => ({
      ...deps,
      settings: { ...settings, ...overrides },
      ...patch,
    }),
    render: (renderOptions = {}) =>
      renderFixture(
        manifest,
        persisted.hash,
        storage,
        audio,
        narration.trackHash,
        captions,
        narration.captionTrackHash,
        renderOptions,
      ),
  };
}

/** The faces the readability checks measure with, when the machine has any. */
export function fixtureFonts(): FontSet | undefined {
  const regularFile = findFont(DEFAULT_FONT_CANDIDATES);
  if (regularFile === undefined || !existsSync(regularFile)) return undefined;
  const boldFile = findFont(DEFAULT_BOLD_FONT_CANDIDATES);
  return boldFile !== undefined && existsSync(boldFile)
    ? { regular: loadFontFile(regularFile), bold: loadFontFile(boldFile) }
    : { regular: loadFontFile(regularFile) };
}

/**
 * The plan: the bundled demonstration scene, repeated once per section, with the
 * fixture's own narration.
 *
 * The scene is a real one — the same manifest Phase 9 ships, with its cast, its
 * animation events and its media panel — so the composer, the character stage and
 * the rasteriser all see the shapes they see in production. Each scene gets one
 * section's sentence, and its duration is the length that sentence will actually
 * be spoken at.
 */
export function planFixture(options: {
  readonly sections: readonly (typeof QA_SECTION_ROLES)[number][];
  readonly width: number;
  readonly height: number;
}): SceneManifest {
  const base = fixtureManifest({ seconds: 1.2, width: options.width, height: options.height });
  const template = base.scenes[0]!;
  const roles = options.sections;
  let cursor = 0;
  const scenes = roles.map((role, index) => {
    const text = QA_NARRATION[index] ?? `Section ${index}.`;
    const words = text.split(/\s+/u).filter((word) => word.length > 0).length;
    const durationSec = (words * MS_PER_WORD) / 1_000;
    const sentenceId = `snt_${index}`;
    const sectionId = `sec_${role}_${index}`;
    const scene = {
      ...template,
      id: `scn_${role}_${index}`,
      index,
      sectionId,
      role,
      startSec: cursor,
      durationSec,
      narration: {
        ...template.narration,
        text,
        sectionId,
        role,
        sentenceIds: [sentenceId],
        words,
        estimatedDurationSec: durationSec,
      },
      // Cues that start inside the scene survive; the rest belong to a longer cut.
      animation: template.animation
        .filter((event) => event.atSec < durationSec)
        .map((event) => ({
          ...event,
          durationSec: Math.min(event.durationSec, Math.max(0.1, durationSec - event.atSec)),
        })),
      transition: {
        ...template.transition,
        toSceneId: index === roles.length - 1 ? "" : `scn_${roles[index + 1]!}_${index + 1}`,
      },
      media: { ...template.media, assets: [`plate_${index}`] },
      // A static wide shot: the fixture is about the documents and the composition,
      // not about framing, and an off-centre camera moves every box in the frame.
      camera: {
        ...template.camera,
        shot: "wide" as const,
        movement: "static" as const,
        focus: "background" as const,
      },
      // On-screen text goes above the caption band, which is what a captioned
      // episode has to do: the caption-band rule (which measures the drawn text, not
      // the box) reports that a lower third the size of this block reaches 1142 px at
      // 1080p while the band starts at 988 px — every scene, every cue (ISSUES.md,
      // CI-43). The value is short enough to fit one line.
      text: { ...template.text, position: "upper_third" as const, value: "{n} frames" },
      // Only the hook shows a claim: the body reasons, it does not assert.
      sources: index === 0 && role === "hook" ? [sceneClaim()] : [],
      sourceIds: index === 0 && role === "hook" ? [QA_FIXTURE_SOURCE] : [],
    };
    cursor += durationSec;
    return scene;
  });

  return SceneManifestSchema.parse({
    ...base,
    resolution: { width: options.width, height: options.height },
    totalDurationSec: cursor,
    scenes,
    assets: scenes.map((scene) => ({
      ...base.assets[0]!,
      id: `plate_${scene.index}`,
      sceneId: scene.id,
      minDurationSec: 1,
      status: "resolved",
      uri: `generated://qa-fixture/plate-${scene.index}.png`,
      licence: "generated",
    })),
  });
}

/** The claim the hook's scene shows, in the plan's own vocabulary. */
export function sceneClaim() {
  return {
    claimId: QA_FIXTURE_CLAIM,
    statement: QA_FIXTURE_STATEMENT,
    usage: "fact" as const,
    status: "supported" as const,
    certainty: "established" as const,
    confidence: 0.9,
    evidence: [
      {
        sourceId: QA_FIXTURE_SOURCE,
        url: QA_FIXTURE_URL,
        excerpt: sourceContent(),
        locator: `0:${sourceContent().length}`,
      },
    ],
  };
}

/** The one source's stored text: the excerpt the claim rests on. */
export function sourceContent(): string {
  return "Traffic counts on the Kira bridge recorded forty thousand crossings on an average weekday.";
}

/** A research package with one question, one source, one supported claim. */
export function researchFixture(overrides: Partial<ResearchPackage> = {}): {
  doc: ResearchPackage;
  hash: string;
} {
  const content = sourceContent();
  const doc = ResearchPackageSchema.parse({
    version: 1,
    topic: "The Kira bridge",
    createdAt: QA_FIXTURE_CLOCK,
    questions: [
      { id: "q1", question: "How busy is the Kira bridge?", queries: ["kira bridge traffic"] },
    ],
    sources: [
      {
        id: QA_FIXTURE_SOURCE,
        url: QA_FIXTURE_URL,
        originalUrl: QA_FIXTURE_URL,
        domain: "example.org",
        title: "Kira bridge traffic study",
        publisher: "Example Institute",
        retrievedAt: QA_FIXTURE_CLOCK,
        provider: "fake",
        questionIds: ["q1"],
        content,
        contentHash: sha256(new TextEncoder().encode(content)),
        contentLength: content.length,
        retrieval: "provider_snippet",
      },
    ],
    evidence: [
      {
        id: QA_FIXTURE_EVIDENCE,
        sourceId: QA_FIXTURE_SOURCE,
        excerpt: content,
        locator: { kind: "source_content", start: 0, end: content.length },
        questionIds: ["q1"],
        extractedBy: { provider: "fake", model: "fake-model" },
      },
    ],
    claims: [
      {
        id: QA_FIXTURE_CLAIM,
        statement: QA_FIXTURE_STATEMENT,
        links: [
          {
            sourceId: QA_FIXTURE_SOURCE,
            evidenceId: QA_FIXTURE_EVIDENCE,
            stance: "supports",
            strength: 0.9,
          },
        ],
        status: "supported",
        certainty: "established",
        confidence: 0.9,
        corroboration: { supportingSources: [QA_FIXTURE_SOURCE], independentSources: 1 },
        contested: false,
        mayStateAsFact: true,
        provenance: { extractedBy: [{ provider: "fake", model: "fake-model" }] },
      },
    ],
    conflicts: [],
    verification: {
      claims: 1,
      byStatus: { supported: 1 },
      established: 1,
      contested: 0,
      conflicts: 0,
      reviewRequired: false,
      blockingClaimIds: [],
    },
    provenance: {
      engine: { name: "nexus-research-fixture", version: "1.0.0" },
      schemaVersion: 1,
      topic: "The Kira bridge",
      startedAt: QA_FIXTURE_CLOCK,
      finishedAt: QA_FIXTURE_CLOCK,
      durationMs: 1,
      providers: { llm: "fake", research: "fake" },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
    },
    ...overrides,
  });
  return { doc, hash: sha256(researchPackageBytes(doc)) };
}

/** A script document that matches the plan: one sentence per section. */
export function scriptFixture(
  manifest: SceneManifest,
  researchPackageHash: string,
  storage: MemoryBlobStore,
): { doc: ScriptDoc; hash: string } {
  const sections = manifest.scenes.map((scene, index) => ({
    id: scene.sectionId,
    role: scene.role,
    title: index === 0 ? "The bridge" : `Section ${index}`,
    sentences: [
      {
        id: scene.narration.sentenceIds[0] ?? `snt_${index}`,
        narration: scene.narration.text,
        assertion: index === 0 ? ("fact" as const) : ("attributed" as const),
        claimRefs: index === 0 ? [QA_FIXTURE_CLAIM] : [],
        sourceRefs: index === 0 ? [] : [QA_FIXTURE_SOURCE],
      },
    ],
  }));
  const words = manifest.scenes.reduce((sum, scene) => sum + scene.narration.words, 0);
  const doc = ScriptDocSchema.parse({
    version: 2,
    topic: manifest.topic,
    workingTitle: manifest.workingTitle,
    logline: "One claim, counted twice.",
    sections,
    claims: [
      {
        claimId: QA_FIXTURE_CLAIM,
        statement: QA_FIXTURE_STATEMENT,
        status: "supported",
        certainty: "established",
        confidence: 0.9,
        mayStateAsFact: true,
        usage: "fact",
        sentenceIds: [manifest.scenes[0]?.narration.sentenceIds[0] ?? "snt_0"],
        evidence: [
          {
            sourceId: QA_FIXTURE_SOURCE,
            url: QA_FIXTURE_URL,
            excerpt: sourceContent(),
            locator: `0:${sourceContent().length}`,
          },
        ],
      },
    ],
    quality: { issues: [], repairRounds: 0, reviewRequired: false, droppedSentences: [] },
    stats: {
      sections: sections.length,
      sentences: sections.length,
      words,
      estimatedDurationSec: words / 2.5,
    },
    provenance: {
      engine: { name: "nexus-script-fixture", version: "1.0.0" },
      researchPackageHash,
      providers: { llm: "fake" },
      steps: [],
      aiSteps: [],
      deterministicSteps: [],
      repairRounds: 0,
      generatedAt: QA_FIXTURE_CLOCK,
      durationMs: 1,
    },
    warnings: [],
  });
  const stored = storage.put(scriptDocBytes(doc));
  return { doc, hash: stored.hash };
}

/**
 * Render the fixture plan with the scripted encoder.
 *
 * The frames are real (the rasteriser runs), the muxing is scripted, and the
 * metadata is the render pipeline's own document — so the video checks read a file
 * and a record of it that the renderer actually produced, at the fixture's proxy
 * size rather than its design size.
 */
function renderFixture(
  manifest: SceneManifest,
  manifestHash: string,
  storage: MemoryBlobStore,
  audio: AudioTrack,
  audioTrackHash: string,
  captions: CaptionTrack,
  captionTrackHash: string,
  options: RenderFixtureOptions,
): RenderedFixture {
  const config = resolveRenderConfig({
    width: options.width ?? 320,
    height: options.height ?? 180,
    fps: options.fps ?? manifest.fps,
    segmentFrames: options.segmentFrames ?? 30,
    measureLoudness: false,
    threads: 1,
  });
  tempRoot ??= mkdtempSync(path.join(tmpdir(), "nexus-qa-fixture-"));
  const fonts = fixtureFonts();
  const result = renderVideo(
    {
      manifest,
      manifestHash,
      config,
      characterStage: createCharacterStage(CharacterLibrary.load()),
      ...(options.audio === false ? {} : { audioTrack: audio, audioTrackHash }),
      ...(options.captions === false || options.audio === false
        ? {}
        : { captionTrack: captions, captionTrackHash }),
      ...(fonts !== undefined ? { fonts } : {}),
      now: QA_FIXTURE_CLOCK,
    },
    {
      ffmpeg: createScriptedFFmpeg({ width: config.width, height: config.height, fps: config.fps }),
      storage,
      workRoot: tempRoot,
    },
  );
  const metadata = RenderMetadataSchema.parse(result.metadata);
  const stored = storage.put(new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`));
  // The video goes into the store too, so a test can hand QA a hash instead of a
  // path — the two ways the stage can find the deliverable.
  const video = storage.put(new Uint8Array(readFileSync(result.video.file)));
  return {
    file: result.video.file,
    metadata,
    metadataHash: stored.hash,
    videoHash: video.hash,
  };
}

// ── Pipeline snapshots ─────────────────────────────────────────────────────

export interface SnapshotOptions {
  readonly steps?: readonly PipelineStepSnapshot[];
  readonly jobState?: PipelineSnapshot["jobState"];
  readonly episodeState?: PipelineSnapshot["episode"]["state"];
  readonly leaseExpired?: boolean;
  readonly hasArtifact?: boolean;
  readonly pipeline?: string;
  /** Omit the pipeline definition, to exercise the unknown-pipeline rule. */
  readonly withDefinition?: boolean;
}

/**
 * A job that ran the long-form pipeline through `qa`: every stage in the
 * definition up to and including QA has a step, QA's predecessors are DONE, and
 * the stages after QA are still PENDING — which is where a real job is while the
 * QA gate runs.
 *
 * The steps are *derived from the pipeline definition*, not written out, so the
 * fixture cannot drift from the pipeline it claims to describe: each step
 * registers the artifact kinds its stage declares, and the episode sits where the
 * last completed stage leaves it.
 */
export function passingSnapshot(options: SnapshotOptions = {}): PipelineSnapshot {
  const definition = LONG_FORM_PIPELINE;
  const qaIndex = definition.stages.findIndex((stage) => stage.key === "qa");
  const upto = qaIndex === -1 ? definition.stages.length : qaIndex + 1;
  const steps: readonly PipelineStepSnapshot[] =
    options.steps ??
    definition.stages.slice(0, upto).map((stage) =>
      step(
        stage.key,
        stage.produces.map((kind) => artifact(kind, kind, stage.key)),
      ),
    );
  const lastDone = [...steps].reverse().find((entry) => entry.state === "DONE");
  const stage = definition.stages.find((entry) => entry.key === lastDone?.key);
  return {
    jobId: "job_qa_fixture",
    jobState: options.jobState ?? "RUNNING",
    pipeline: options.pipeline ?? definition.id,
    attempt: 1,
    failureStep: "",
    error: "",
    leaseExpired: options.leaseExpired ?? false,
    episode: {
      id: "ep_qa_fixture",
      state: options.episodeState ?? stage?.episodeStateOnComplete ?? "APPROVAL",
    },
    steps,
    ...(options.withDefinition === false || options.pipeline !== undefined ? {} : { definition }),
    hasArtifact: () => options.hasArtifact ?? true,
  };
}

/** The same job after every stage finished, episode published. */
export function completedSnapshot(options: SnapshotOptions = {}): PipelineSnapshot {
  const definition = LONG_FORM_PIPELINE;
  return passingSnapshot({
    ...options,
    jobState: options.jobState ?? "DONE",
    episodeState: options.episodeState ?? "PUBLISHED",
    steps:
      options.steps ??
      definition.stages.map((stage) =>
        step(
          stage.key,
          stage.produces.map((kind) => artifact(kind, kind, stage.key)),
        ),
      ),
  });
}

/** One step, with the artifacts it registered. `output: undefined` means none. */
export function step(
  key: string,
  artifacts: readonly ArtifactRef[] = [],
  overrides: Partial<Omit<PipelineStepSnapshot, "key" | "artifacts">> = {},
): PipelineStepSnapshot {
  const state = overrides.state ?? "DONE";
  return {
    key,
    state,
    attempt: overrides.attempt ?? 1,
    artifacts,
    output: "output" in overrides ? overrides.output : { stage: key },
    error: overrides.error ?? "",
  };
}

/** One registered artifact, with a real hash (the CAS lookup is stubbed anyway). */
export function artifact(
  kind: PipelineStepSnapshot["artifacts"][number]["kind"],
  role: string,
  seed: string,
): ArtifactRef {
  return { hash: sha256(new TextEncoder().encode(`qa-fixture:${seed}`)), kind, role };
}
