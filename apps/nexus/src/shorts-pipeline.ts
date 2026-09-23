import { loadAudioTrack } from "@nexus/audio";
import type { AudioTrack } from "@nexus/audio";
import { ScriptDocSchema, scriptDocBytes, type ScriptDoc } from "@nexus/script";
import { SCENE_MANIFEST_ARTIFACT_KIND, loadSceneManifest, type SceneManifest } from "@nexus/scenes";
import { sceneWindowsOf, selectShorts, topicKeywordOf, verticalReflow } from "@nexus/shorts";
import type { ShortsCandidate, ShortsPlan } from "@nexus/shorts";
import type { BlobStore } from "@nexus/storage";
import {
  SHORTS_PIPELINE,
  PermanentError,
  stageKeys,
  type PipelineDef,
  type Task,
  type TaskContext,
  type TaskResult,
} from "@nexus/jobs";
import type { Repo } from "@nexus/db";
import { createQATask } from "@nexus/qa";
import { createRenderTask, type FFmpegRunner, type RenderConfigInput } from "@nexus/video";

/**
 * The shorts pipeline's stage tasks: the app glue that carries a finished
 * long-form episode into `@nexus/shorts` and a rendered 9:16 video out of it.
 *
 *   LONG VIDEO → transcript/timeline (short_analyze)
 *              → candidates (short_select)
 *              → the short's own scoped script (short_rewrite)
 *              → vertical layout (short_layout)
 *              → render (short_render, 9:16)
 *              → QA (short_qa) → human approval (SHORT_APPROVAL)
 *
 * Everything here is deterministic: no AI provider is involved, because the
 * content already exists — the short re-uses the parent episode's narration,
 * claims and evidence byte-for-byte. The one policy the app owns (and the
 * engine deliberately does not): a dashboard short must be a **complete arc**
 * — the same structure rule the QA engine enforces on any script (one hook,
 * one introduction, at least two narrative sections, one conclusion) — so a
 * selected candidate that would produce a structurally incomplete script is
 * not offered, and an episode with no such candidate fails loudly.
 */

export const SHORTS_DASHBOARD_PIPELINE: PipelineDef = {
  ...SHORTS_PIPELINE,
  stages: SHORTS_PIPELINE.stages.filter((stage) => stage.key !== "short_publish"),
};

export const SHORTS_DASHBOARD_STEPS: readonly string[] = stageKeys(SHORTS_DASHBOARD_PIPELINE);

const nowIso = (): string => new Date().toISOString();

// ── the parent episode's finished documents ─────────────────────────────────

interface ParentDocuments {
  readonly manifest: SceneManifest;
  readonly track: AudioTrack;
  readonly manifestHash: string;
  readonly trackHash: string;
  readonly parentJobId: string;
}

function stepOutputOf(repo: Repo, jobId: string, stage: string): Record<string, unknown> {
  const step = repo.getJobStep(jobId, stage);
  if (step === undefined || step.output === null) return {};
  try {
    const parsed: unknown = JSON.parse(step.output);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hashOf(output: Record<string, unknown>, key: string): string | undefined {
  const value = output[key];
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

/**
 * The long-form episode a short is cut from: the media-resolved manifest (the
 * one the long render actually drew) and the final narration track. A parent
 * without a completed run is a hard, readable error — there is nothing to cut.
 */
function parentDocumentsOf(
  repo: Repo,
  storage: BlobStore,
  parentEpisodeId: string | null,
): ParentDocuments {
  if (parentEpisodeId === null || parentEpisodeId === "") {
    throw new PermanentError("short_analyze requires a parent episode (parent_episode_id)");
  }
  const job = repo
    .listJobs(parentEpisodeId)
    .filter((entry) => entry.state === "DONE")
    .at(-1);
  if (job === undefined) {
    throw new PermanentError(
      `the parent episode ${parentEpisodeId} has no completed run yet — finish the long-form pipeline first`,
    );
  }
  const media = stepOutputOf(repo, job.id, "source_media");
  const plan = stepOutputOf(repo, job.id, "plan");
  const render = stepOutputOf(repo, job.id, "render");
  const voice = stepOutputOf(repo, job.id, "voice");
  const manifestHash = hashOf(media, "manifestHash") ?? hashOf(plan, "manifestHash");
  const trackHash = hashOf(render, "audioTrackHash") ?? hashOf(voice, "trackHash");
  if (manifestHash === undefined || trackHash === undefined) {
    throw new PermanentError(
      `the parent episode's run ${job.id} has no scene manifest or narration track to analyze`,
    );
  }
  return {
    manifest: loadSceneManifest(storage, manifestHash),
    track: loadAudioTrack(storage, trackHash),
    manifestHash,
    trackHash,
    parentJobId: job.id,
  };
}

function putArtifact(
  storage: BlobStore,
  repo: Repo,
  bytes: Uint8Array,
  kind: "document" | "metadata" | "script" | "scene_graph" | "audio",
): string {
  const stored = storage.put(bytes);
  repo.registerArtifact({ hash: stored.hash, kind, bytes: stored.bytes });
  return stored.hash;
}

function readJson<T>(storage: BlobStore, hash: string): T {
  return JSON.parse(new TextDecoder().decode(storage.read(hash))) as T;
}

// ── short_analyze: transcript / timeline ────────────────────────────────────

export function createShortAnalyzeTask(deps: { storage: BlobStore; repo: Repo }): Task {
  return {
    stageKey: "short_analyze",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const parent = parentDocumentsOf(deps.repo, deps.storage, ctx.episode.parent_episode_id);
      // The transcript/timeline: the parent's scenes on their SPOKEN clock —
      // the same windows the selection engine cuts on.
      const windows = sceneWindowsOf(parent.manifest, parent.track);
      const document = {
        version: 1 as const,
        kind: "short_transcript" as const,
        parentEpisodeId: ctx.episode.parent_episode_id,
        parentJobId: parent.parentJobId,
        topic: parent.manifest.topic,
        manifestHash: parent.manifestHash,
        trackHash: parent.trackHash,
        windows,
        sentences: parent.track.sentences,
        totals: {
          scenes: windows.length,
          words: parent.track.totals.words,
          spokenDurationSec: parent.track.totals.spokenDurationSec,
        },
        generatedAt: nowIso(),
      };
      const documentHash = putArtifact(
        deps.storage,
        deps.repo,
        new TextEncoder().encode(JSON.stringify(document, null, 2)),
        "document",
      );
      ctx.log("short.analyzed", `transcript/timeline of ${windows.length} scene(s)`, {
        manifestHash: parent.manifestHash,
        trackHash: parent.trackHash,
      });
      return {
        output: {
          parentEpisodeId: ctx.episode.parent_episode_id,
          parentJobId: parent.parentJobId,
          manifestHash: parent.manifestHash,
          trackHash: parent.trackHash,
          documentHash,
          scenes: windows.length,
          words: parent.track.totals.words,
          spokenDurationSec: parent.track.totals.spokenDurationSec,
        },
        artifacts: [{ hash: documentHash, kind: "document", role: "short_transcript" }],
      };
    },
  };
}

// ── the complete-arc policy ─────────────────────────────────────────────────

/** The section structure QA enforces on any script — a short must satisfy it too. */
function completeArcSections(
  candidate: ShortsCandidate,
  manifest: SceneManifest,
): string[] | undefined {
  const byId = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
  const sections: { id: string; role: SceneManifest["scenes"][number]["role"] }[] = [];
  const sentences = new Map<string, number>();
  for (const sceneId of candidate.sceneIds) {
    const scene = byId.get(sceneId);
    if (scene === undefined) return undefined;
    if (!sections.some((section) => section.id === scene.sectionId)) {
      sections.push({ id: scene.sectionId, role: scene.role });
    }
    sentences.set(
      scene.sectionId,
      (sentences.get(scene.sectionId) ?? 0) + scene.narration.sentenceIds.length,
    );
  }
  const countOf = (role: string): number =>
    sections.filter((section) => section.role === role).length;
  const ordered =
    rankOrdered(sections) &&
    countOf("hook") === 1 &&
    countOf("introduction") === 1 &&
    countOf("conclusion") === 1 &&
    countOf("narrative") >= 2 &&
    sections.every((section) => (sentences.get(section.id) ?? 0) > 0);
  return ordered ? sections.map((section) => section.id) : undefined;
}

const ROLE_RANK: Record<string, number> = { hook: 0, introduction: 1, narrative: 2, conclusion: 3 };
function rankOrdered(sections: { role: string }[]): boolean {
  for (let index = 1; index < sections.length; index += 1) {
    if (ROLE_RANK[sections[index]!.role]! < ROLE_RANK[sections[index - 1]!.role]!) return false;
  }
  return true;
}

// ── short_select: candidates ────────────────────────────────────────────────

export function createShortSelectTask(deps: {
  storage: BlobStore;
  repo: Repo;
  /** Selection bounds; the shorts engine's defaults apply when omitted. */
  config?: { minDurationSec?: number; maxDurationSec?: number; maxCandidates?: number };
}): Task {
  return {
    stageKey: "short_select",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const analyze = ctx.upstream["short_analyze"] as
        { manifestHash?: string; trackHash?: string } | undefined;
      if (analyze?.manifestHash === undefined || analyze.trackHash === undefined) {
        throw new PermanentError("short_select has no transcript: run short_analyze first");
      }
      const manifest = loadSceneManifest(deps.storage, analyze.manifestHash);
      const track = loadAudioTrack(deps.storage, analyze.trackHash);

      const plan = selectShorts(
        { manifest, track },
        { ...(deps.config !== undefined ? { config: deps.config } : {}) },
      );
      // The dashboard's policy: a short is a complete arc (QA's own script
      // structure rule). Candidates that cannot satisfy it are recorded as
      // set aside, with the reason — not silently dropped.
      const qualified = plan.candidates.filter(
        (candidate) => completeArcSections(candidate, manifest) !== undefined,
      );
      const planWithArcs = {
        ...plan,
        candidates: qualified.map((candidate) => ({
          ...candidate,
          arcSections: completeArcSections(candidate, manifest) ?? [],
        })),
        setAside: plan.candidates
          .filter((candidate) => !qualified.includes(candidate))
          .map((candidate) => ({
            id: candidate.id,
            reason: "incomplete story arc for a standalone short",
          })),
      };
      if (qualified.length === 0) {
        throw new PermanentError(
          `no candidate spans a complete story arc (hook → introduction → 2× narrative → conclusion) ` +
            `within ${deps.config?.minDurationSec ?? 15}–${deps.config?.maxDurationSec ?? 60}s — ` +
            `the episode has ${plan.considered} candidate span(s), best ${plan.candidates[0]?.id ?? "none"}`,
        );
      }
      const planHash = putArtifact(
        deps.storage,
        deps.repo,
        new TextEncoder().encode(JSON.stringify(planWithArcs, null, 2)),
        "metadata",
      );
      const best = qualified[0]!;
      ctx.log("short.selected", `${qualified.length} arc-complete candidate(s); best ${best.id}`, {
        planHash,
        candidates: qualified.length,
        considered: plan.considered,
      });
      return {
        output: {
          planHash,
          candidateCount: qualified.length,
          setAside: planWithArcs.setAside.length,
          considered: plan.considered,
          best: {
            id: best.id,
            durationSec: best.durationSec,
            startSec: best.startSec,
            endSec: best.endSec,
            scoreTotal: best.score.total,
            sceneIds: best.sceneIds,
          },
        },
        artifacts: [{ hash: planHash, kind: "metadata", role: "shorts_plan" }],
      };
    },
  };
}

// ── short_rewrite: the short's own scoped script ────────────────────────────

export function createShortRewriteTask(deps: { storage: BlobStore; repo: Repo }): Task {
  return {
    stageKey: "short_rewrite",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const analyze = ctx.upstream["short_analyze"] as { manifestHash?: string } | undefined;
      const select = ctx.upstream["short_select"] as { planHash?: string } | undefined;
      if (analyze?.manifestHash === undefined || select?.planHash === undefined) {
        throw new PermanentError("short_rewrite needs short_analyze + short_select upstream");
      }
      const manifest = loadSceneManifest(deps.storage, analyze.manifestHash);
      const plan = readJson<ShortsPlan>(deps.storage, select.planHash);
      const candidate = plan.candidates[0];
      if (candidate === undefined) {
        throw new PermanentError("the selection plan carries no qualified candidate");
      }

      // The parent script, scoped to what the short actually speaks. Claims
      // and evidence references are carried over untouched — the short never
      // asserts anything the long form did not.
      const parent = ScriptDocSchema.parse(readJson(deps.storage, manifest.scriptHash));
      const spanSceneIds = new Set(candidate.sceneIds);
      const spanScenes = manifest.scenes.filter((scene) => spanSceneIds.has(scene.id));
      const sectionOrder: string[] = [];
      const sentencesBySection = new Map<string, string[]>();
      for (const scene of spanScenes) {
        if (!sectionOrder.includes(scene.sectionId)) sectionOrder.push(scene.sectionId);
        const known = sentencesBySection.get(scene.sectionId) ?? [];
        sentencesBySection.set(scene.sectionId, [
          ...known,
          ...scene.narration.sentenceIds.filter((id) => !known.includes(id)),
        ]);
      }
      const sections = sectionOrder.flatMap((sectionId) => {
        const source = parent.sections.find((section) => section.id === sectionId);
        if (source === undefined) return [];
        const keep = sentencesBySection.get(sectionId) ?? [];
        const sentences = source.sentences.filter((sentence) => keep.includes(sentence.id));
        return sentences.length > 0 ? [{ ...source, sentences }] : [];
      });
      const keptSentenceIds = new Set(
        sections.flatMap((section) => section.sentences.map((sentence) => sentence.id)),
      );
      const claims = parent.claims
        .map((claim) => ({
          ...claim,
          sentenceIds: claim.sentenceIds.filter((id) => keptSentenceIds.has(id)),
        }))
        .filter((claim) => claim.sentenceIds.length > 0);

      const words = sections.reduce(
        (sum, section) =>
          sum +
          section.sentences.reduce(
            (sentenceSum, sentence) =>
              sentenceSum + sentence.narration.split(/\s+/u).filter(Boolean).length,
            0,
          ),
        0,
      );
      const title = (candidate.hookSentence || manifest.workingTitle).trim().slice(0, 100);
      const description = candidate.transcript
        .slice(0, 2)
        .map((line) => line.text)
        .join(" ")
        .trim();
      const topicKeyword = topicKeywordOf(manifest.topic);
      const doc: ScriptDoc = ScriptDocSchema.parse({
        version: 2,
        topic: manifest.topic,
        workingTitle: title,
        logline: `Vertical cut of "${manifest.workingTitle}" — ${candidate.id}`,
        sections,
        claims,
        quality: {
          issues: [],
          repairRounds: 0,
          reviewRequired: false,
          // The condensation is honest about what it dropped.
          droppedSentences: parent.sections
            .flatMap((section) => section.sentences.map((sentence) => sentence.id))
            .filter((id) => !keptSentenceIds.has(id)),
        },
        stats: {
          sections: sections.length,
          sentences: keptSentenceIds.size,
          words,
          estimatedDurationSec: Math.round((words / 2.5) * 10) / 10,
        },
        provenance: {
          ...parent.provenance,
          engine: { name: "nexus-shorts-rewrite", version: "1.0.0" },
          deterministicSteps: [
            ...new Set([...parent.provenance.deterministicSteps, "shorts.rewrite"]),
          ],
          steps: [
            {
              step: "finalize",
              engine: "none",
              startedAt: nowIso(),
              finishedAt: nowIso(),
              durationMs: 0,
              calls: 0,
              cached: 0,
              units: 0,
              outcome: "ok",
              notes: [`scoped to ${candidate.id} by the shorts selection plan`],
            },
          ],
          generatedAt: nowIso(),
          durationMs: 0,
        },
        warnings: [
          `deterministic vertical condensation of script ${manifest.scriptHash.slice(0, 12)}… (no AI rewrite)`,
        ],
      });

      const scriptHash = putArtifact(deps.storage, deps.repo, scriptDocBytes(doc), "script");
      ctx.log("short.rewritten", `scoped script for ${candidate.id}`, {
        scriptHash,
        sections: sections.length,
        sentences: keptSentenceIds.size,
      });
      return {
        output: {
          scriptHash,
          candidateId: candidate.id,
          parentScriptHash: manifest.scriptHash,
          title,
          description,
          ...(topicKeyword !== "" ? { tags: [topicKeyword] } : {}),
          sections: sections.length,
          sentences: keptSentenceIds.size,
          words,
        },
        artifacts: [{ hash: scriptHash, kind: "script", role: "shorts_script" }],
      };
    },
  };
}

// ── short_layout: the vertical plan ─────────────────────────────────────────

export function createShortLayoutTask(deps: {
  storage: BlobStore;
  repo: Repo;
  /** The vertical canvas; the worker swaps the long-form render resolution. */
  canvas: { width: number; height: number };
}): Task {
  return {
    stageKey: "short_layout",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const analyze = ctx.upstream["short_analyze"] as
        { manifestHash?: string; trackHash?: string } | undefined;
      const select = ctx.upstream["short_select"] as { planHash?: string } | undefined;
      const rewrite = ctx.upstream["short_rewrite"] as
        { scriptHash?: string; candidateId?: string } | undefined;
      if (
        analyze?.manifestHash === undefined ||
        analyze.trackHash === undefined ||
        select?.planHash === undefined ||
        rewrite?.scriptHash === undefined
      ) {
        throw new PermanentError("short_layout needs short_analyze/select/rewrite upstream");
      }
      const manifest = loadSceneManifest(deps.storage, analyze.manifestHash);
      const track = loadAudioTrack(deps.storage, analyze.trackHash);
      const plan = readJson<ShortsPlan>(deps.storage, select.planHash);
      const candidateId = rewrite.candidateId ?? plan.candidates[0]?.id;
      const candidate = plan.candidates.find((entry) => entry.id === candidateId);
      if (candidate === undefined) {
        throw new PermanentError(`candidate ${candidateId ?? "?"} is not in the selection plan`);
      }

      const reflow = verticalReflow(
        { manifest, track, candidate },
        {
          canvas: deps.canvas,
          scriptHash: rewrite.scriptHash,
          now: nowIso(),
        },
      );
      const manifestHash = putArtifact(
        deps.storage,
        deps.repo,
        new TextEncoder().encode(JSON.stringify(reflow.manifest, null, 2)),
        "scene_graph",
      );
      // The persisted vertical manifest's hash is what the re-based track
      // records (the pair is what later stages load together).
      const trackWithHash = { ...reflow.track, manifestHash };
      const trackHash = putArtifact(
        deps.storage,
        deps.repo,
        new TextEncoder().encode(JSON.stringify(trackWithHash, null, 2)),
        "audio",
      );
      const layoutHash = putArtifact(
        deps.storage,
        deps.repo,
        new TextEncoder().encode(JSON.stringify(reflow.layout, null, 2)),
        "metadata",
      );
      ctx.log(
        "short.layout",
        `9:16 plan for ${candidate.id}: ${reflow.manifest.scenes.length} scene(s), ${deps.canvas.width}×${deps.canvas.height}`,
        { manifestHash, trackHash, layoutHash },
      );
      return {
        output: {
          manifestHash,
          trackHash,
          layoutHash,
          candidateId: candidate.id,
          scenes: reflow.manifest.scenes.length,
          durationSec: reflow.manifest.totalDurationSec,
          canvas: deps.canvas,
          // The re-based track re-uses the parent's audio bytes verbatim.
          audioHashes: [...new Set(reflow.track.segments.map((segment) => segment.audio.hash))],
        },
        artifacts: [
          { hash: manifestHash, kind: SCENE_MANIFEST_ARTIFACT_KIND, role: "short_manifest" },
          { hash: trackHash, kind: "audio", role: "short_track" },
          { hash: layoutHash, kind: "metadata", role: "shorts_layout" },
        ],
      };
    },
  };
}

// ── short_render / short_qa: the engines, pointed at the vertical plan ──────

/**
 * The long-form render engine with a 9:16 config and the short pipeline's
 * upstream names mapped onto the ones it reads (`plan`/`voice`). Nothing about
 * the render engine changes — the compositor was always resolution-agnostic.
 */
export function createShortRenderTask(deps: {
  storage: BlobStore;
  repo: Repo;
  config: RenderConfigInput;
  ffmpeg?: FFmpegRunner;
}): Task {
  const inner = createRenderTask({
    storage: deps.storage,
    repo: deps.repo,
    config: deps.config,
    ...(deps.ffmpeg !== undefined ? { ffmpeg: deps.ffmpeg } : {}),
  });
  return {
    ...inner,
    stageKey: "short_render",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const layout = ctx.upstream["short_layout"] as
        { manifestHash?: string; trackHash?: string } | undefined;
      if (layout?.manifestHash === undefined || layout.trackHash === undefined) {
        throw new PermanentError("short_render has no vertical plan: run short_layout first");
      }
      const result = await inner.execute({
        ...ctx,
        upstream: {
          plan: { manifestHash: layout.manifestHash },
          voice: { trackHash: layout.trackHash },
        },
      });
      if (result === undefined || result === null) {
        throw new PermanentError("short_render produced no result");
      }
      return result;
    },
  };
}

/** The QA engine over the vertical plan, with the same upstream mapping. */
export function createShortQATask(deps: {
  storage: BlobStore;
  repo: Repo;
  characters?: unknown;
  fonts?: unknown;
  settings?: unknown;
}): Task {
  const inner = createQATask({
    storage: deps.storage,
    repo: deps.repo,
    ...(deps.characters !== undefined ? { characters: deps.characters } : {}),
    ...(deps.fonts !== undefined ? { fonts: deps.fonts } : {}),
    ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
  } as never);
  return {
    ...inner,
    stageKey: "short_qa",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      const layout = ctx.upstream["short_layout"] as
        { manifestHash?: string; trackHash?: string } | undefined;
      const render = ctx.upstream["short_render"] as
        { videoHash?: string; metadataHash?: string } | undefined;
      if (layout?.manifestHash === undefined || render?.videoHash === undefined) {
        throw new PermanentError("short_qa needs short_layout + short_render upstream");
      }
      const result = await inner.execute({
        ...ctx,
        upstream: {
          plan: { manifestHash: layout.manifestHash },
          render: {
            videoHash: render.videoHash,
            ...(render.metadataHash !== undefined ? { metadataHash: render.metadataHash } : {}),
            audioTrackHash: layout.trackHash,
          },
        },
      });
      if (result === undefined || result === null) {
        throw new PermanentError("short_qa produced no result");
      }
      return result;
    },
  };
}

// ── short_approval: the human gate ──────────────────────────────────────────

export function createShortApprovalTask(): Task {
  return {
    stageKey: "short_approval",

    async execute(ctx: TaskContext): Promise<TaskResult> {
      return {
        waiting: ctx.stage.gate ?? "SHORT_APPROVAL",
        waitingReason: "awaiting the operator's decision on the vertical short",
      };
    },
  };
}
