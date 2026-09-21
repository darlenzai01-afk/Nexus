import type { ScriptDoc, ScriptSentence } from "@nexus/script";
import { normalizeWhitespace, wordCount } from "@nexus/script";
import { z } from "zod";

import {
  DATA_DIAGRAM_KINDS,
  SCENE_ISSUE_CODES,
  SCENE_TYPES,
  SceneIssueCodeSchema,
  SceneIssueSeveritySchema,
  SceneManifestSchema,
  sceneIssueSeverity,
  type SceneIssueCode,
  type SceneManifest,
  type SceneType,
} from "./schema.js";
import { SCENE_TYPE_SPECS } from "./scene-types.js";
import { narrationDurationSec } from "./timing.js";

/**
 * Scene manifest validation.
 *
 * `SceneManifestSchema` answers "is this document the right shape?". This module
 * answers the questions that need arithmetic or the script the manifest came
 * from:
 *
 * - does every scene last long enough for the narration it carries, and not much
 *   longer?
 * - is the timeline gapless (`startSec` is the running sum) and is the total the
 *   sum of the scenes?
 * - do the narration references resolve to real script sentences, with the same
 *   words?
 * - does every claim and source reference exist in the script's ledger, and does
 *   every evidence card or data diagram actually cite something?
 *
 * Both layers report through one coded issue list, so a caller never has to read
 * a zod message to know what kind of thing is wrong.
 */

export interface SceneValidationContext {
  /** The script the manifest should have come from; enables every cross-check. */
  readonly script?: ScriptDoc;
  /** Slack for the 0.1 s rounding of every duration. */
  readonly toleranceSec?: number;
  /** How much longer than its narration a scene may hold (deliberate beats). */
  readonly extraHoldSec?: number;
  /** A scene at least this long is worth an editor's eye. */
  readonly longSceneSec?: number;
  /** Narration pace to check the estimates against (default: the manifest's). */
  readonly wordsPerSecond?: number;
}

export const DEFAULT_SCENE_VALIDATION: Required<Omit<SceneValidationContext, "script">> = {
  toleranceSec: 0.2,
  extraHoldSec: 1.5,
  longSceneSec: 20,
  wordsPerSecond: 0,
};

export const SceneIssueSchema = z.strictObject({
  code: SceneIssueCodeSchema,
  severity: SceneIssueSeveritySchema,
  /** The scene the issue is about, or "" when it is about the whole manifest. */
  sceneId: z.string(),
  /** Dotted path into the manifest (`scenes.3.narration.text`). */
  path: z.string(),
  message: z.string(),
  detail: z.string().default(""),
});
export type SceneIssue = z.infer<typeof SceneIssueSchema>;

export const SceneTypeCountsSchema = z.strictObject(
  Object.fromEntries(SCENE_TYPES.map((type) => [type, z.number().int().nonnegative()])) as Record<
    SceneType,
    z.ZodNumber
  >,
);
export type SceneTypeCounts = z.infer<typeof SceneTypeCountsSchema>;

export const SceneValidationStatsSchema = z.strictObject({
  scenes: z.number().int().nonnegative(),
  byType: SceneTypeCountsSchema,
  assets: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  totalDurationSec: z.number().nonnegative(),
});
export type SceneValidationStats = z.infer<typeof SceneValidationStatsSchema>;

export const SceneValidationReportSchema = z.strictObject({
  /** False when anything hard is wrong with the manifest. */
  ok: z.boolean(),
  issues: z.array(SceneIssueSchema),
  stats: SceneValidationStatsSchema,
});
export type SceneValidationReport = z.infer<typeof SceneValidationReportSchema>;

const emptyCounts = (): SceneTypeCounts =>
  Object.fromEntries(SCENE_TYPES.map((type) => [type, 0])) as SceneTypeCounts;

const emptyStats = (): SceneValidationStats => ({
  scenes: 0,
  byType: emptyCounts(),
  assets: 0,
  words: 0,
  totalDurationSec: 0,
});

const issue = (
  code: SceneIssueCode,
  message: string,
  options: { sceneId?: string; path?: string; detail?: string } = {},
): SceneIssue => ({
  code,
  severity: sceneIssueSeverity(code),
  sceneId: options.sceneId ?? "",
  path: options.path ?? "",
  message,
  detail: options.detail ?? "",
});

/** Codes a plain zod failure maps onto, so every report speaks one vocabulary. */
function codeForZodIssue(path: readonly (string | number)[], code: string): SceneIssueCode {
  const segments = path.map(String);
  const last = segments.at(-1) ?? "";
  const inScenes = segments[0] === "scenes";

  if (last === "type" && inScenes) return "unsupported_scene_type";
  if (segments.includes("animation")) return "invalid_animation";
  if (last === "atSec" || last === "durationSec" || last === "minDurationSec")
    return "invalid_duration";
  if (last === "transition") return "invalid_transition";
  if (last === "startSec" || last === "index") return "invalid_timeline";
  if (last === "sceneId" || last === "toSceneId") return "unknown_scene";
  if (segments.includes("narration")) return "missing_narration";
  if (last === "scenes" && code === "too_small") return "empty_manifest";
  return "invalid_manifest";
}

/** Every schema failure as a coded issue, with the path and what was received. */
export function mapZodIssues(error: z.ZodError, input?: unknown): SceneIssue[] {
  return error.issues.map((problem) => {
    const path = problem.path.map(String);
    const tagged = (problem as { params?: { code?: unknown } }).params?.code;
    const code = (
      typeof tagged === "string" && (SCENE_ISSUE_CODES as readonly string[]).includes(tagged)
        ? tagged
        : codeForZodIssue(problem.path, problem.code)
    ) as SceneIssueCode;
    const received =
      "received" in problem && typeof problem.received !== "undefined"
        ? String(problem.received)
        : undefined;
    const sceneId =
      path[0] === "scenes" && typeof input === "object" && input !== null
        ? readSceneId(input, Number(path[1]))
        : "";
    return issue(code, `${path.join(".") || "manifest"}: ${problem.message}`, {
      sceneId,
      path: path.join("."),
      detail:
        received !== undefined && code !== "invalid_manifest"
          ? `received ${received}`
          : (received ?? ""),
    });
  });
}

function readSceneId(input: unknown, index: number): string {
  const scenes = (input as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes) || !Number.isInteger(index) || index < 0) return "";
  const scene = scenes[index] as { id?: unknown } | undefined;
  return typeof scene?.id === "string" ? scene.id : "";
}

interface ScriptIndex {
  readonly sentences: ReadonlyMap<string, { sentence: ScriptSentence; sectionId: string }>;
  readonly sectionIds: ReadonlySet<string>;
  readonly transitions: ReadonlyMap<string, { text: string; role: string }>;
  /** Every spoken word of the script, for checks that cannot name a sentence. */
  readonly spoken: string;
  readonly claims: ScriptDoc["claims"] extends readonly (infer C)[]
    ? ReadonlyMap<string, C>
    : never;
  readonly sourceIds: ReadonlySet<string>;
}

function indexScript(script: ScriptDoc): ScriptIndex {
  const byId = new Map<string, { sentence: ScriptSentence; sectionId: string }>();
  const transitions = new Map<string, { text: string; role: string }>();
  for (const section of script.sections) {
    for (const sentence of section.sentences) {
      if (!byId.has(sentence.id)) byId.set(sentence.id, { sentence, sectionId: section.id });
    }
    transitions.set(section.id, { text: section.transition, role: section.role });
  }
  const claims = new Map<string, ScriptDoc["claims"][number]>();
  const sourceIds = new Set<string>();
  for (const claim of script.claims) {
    if (!claims.has(claim.claimId)) claims.set(claim.claimId, claim);
    for (const evidence of claim.evidence) sourceIds.add(evidence.sourceId);
  }
  const spoken = normalizeWhitespace(
    script.sections
      .flatMap((section) => section.sentences.map((sentence) => sentence.narration))
      .join(" "),
  );
  return {
    sentences: byId,
    sectionIds: new Set(script.sections.map((section) => section.id)),
    transitions,
    spoken,
    claims,
    sourceIds,
  };
}

function sentencesOf(
  index: ScriptIndex,
  ids: readonly string[],
): { text: string; missing: string[] } {
  const parts: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const found = index.sentences.get(id);
    if (found === undefined) missing.push(id);
    else parts.push(found.sentence.narration);
  }
  return { text: normalizeWhitespace(parts.join(" ")), missing };
}

function statsOf(manifest: SceneManifest): SceneValidationStats {
  const byType = emptyCounts();
  let words = 0;
  for (const scene of manifest.scenes) {
    byType[scene.type] += 1;
    words += scene.narration.words;
  }
  return {
    scenes: manifest.scenes.length,
    byType,
    assets: manifest.assets.length,
    words,
    totalDurationSec: manifest.totalDurationSec,
  };
}

export function validateSceneManifest(
  input: unknown,
  context: SceneValidationContext = {},
): SceneValidationReport {
  const tolerance = context.toleranceSec ?? DEFAULT_SCENE_VALIDATION.toleranceSec;
  const extraHold = context.extraHoldSec ?? DEFAULT_SCENE_VALIDATION.extraHoldSec;
  const longScene = context.longSceneSec ?? DEFAULT_SCENE_VALIDATION.longSceneSec;

  const parsed = SceneManifestSchema.safeParse(input);
  if (!parsed.success) {
    return SceneValidationReportSchema.parse({
      ok: false,
      issues: mapZodIssues(parsed.error, input),
      stats: emptyStats(),
    });
  }

  const manifest = parsed.data;
  const issues: SceneIssue[] = [];
  const index = context.script !== undefined ? indexScript(context.script) : undefined;
  const wordsPerSecond =
    context.wordsPerSecond !== undefined && context.wordsPerSecond > 0
      ? context.wordsPerSecond
      : manifest.wordsPerSecond;

  const sceneDuration = new Map(manifest.scenes.map((scene) => [scene.id, scene.durationSec]));
  let running = 0;

  // ── Notes: nothing broken, but worth an editor's eye ───────────────────
  // These live here rather than in the schema because a soft note must never
  // stop a manifest from being parsed and stored.
  const onScreen = new Set(
    manifest.scenes.flatMap((scene) => scene.characters.map((entry) => entry.characterId)),
  );
  for (const member of manifest.cast) {
    if (!onScreen.has(member.id)) {
      issues.push(
        issue("unused_character", `cast member "${member.id}" is never on screen`, {
          path: "cast",
        }),
      );
    }
  }
  const referencedAssets = new Set(manifest.scenes.flatMap((scene) => scene.media?.assets ?? []));
  for (const asset of manifest.assets) {
    if (!referencedAssets.has(asset.id)) {
      issues.push(
        issue("orphan_asset", `asset ${asset.id} is planned but no scene asks for it`, {
          path: "assets",
        }),
      );
    }
  }

  for (const [position, scene] of manifest.scenes.entries()) {
    const at = (field: string): string => `scenes.${position}.${field}`;
    const spec = SCENE_TYPE_SPECS[scene.type];

    // ── Timeline ──────────────────────────────────────────────────────────
    if (Math.abs(scene.startSec - running) > tolerance) {
      issues.push(
        issue(
          "invalid_timeline",
          `scene ${scene.id} starts at ${scene.startSec}s but the scenes before it end at ${running.toFixed(1)}s`,
          { sceneId: scene.id, path: at("startSec") },
        ),
      );
    }
    running += scene.durationSec;

    // ── Durations against the narration ──────────────────────────────────
    const estimate = narrationDurationSec(scene.narration.words, wordsPerSecond);
    if (Math.abs(scene.narration.estimatedDurationSec - estimate) > tolerance) {
      issues.push(
        issue(
          "invalid_duration",
          `scene ${scene.id}: narration is ${scene.narration.words} word(s) = ${estimate}s at ${wordsPerSecond} words/second, but the manifest says ${scene.narration.estimatedDurationSec}s`,
          { sceneId: scene.id, path: at("narration.estimatedDurationSec") },
        ),
      );
    }
    const floor = Math.max(spec.minDurationSec, scene.narration.estimatedDurationSec);
    const ceiling =
      Math.max(spec.minDurationSec, scene.narration.estimatedDurationSec + spec.holdPaddingSec) +
      extraHold;
    if (scene.durationSec < floor - tolerance) {
      issues.push(
        issue(
          "invalid_duration",
          `scene ${scene.id} lasts ${scene.durationSec}s but carries ${scene.narration.estimatedDurationSec}s of narration (a ${scene.type} scene needs at least ${spec.minDurationSec}s)`,
          { sceneId: scene.id, path: at("durationSec") },
        ),
      );
    } else if (scene.durationSec > ceiling + tolerance) {
      issues.push(
        issue(
          "invalid_duration",
          `scene ${scene.id} holds ${(scene.durationSec - scene.narration.estimatedDurationSec).toFixed(1)}s past its narration (at most ${ceiling.toFixed(1)}s for a ${scene.type} scene)`,
          { sceneId: scene.id, path: at("durationSec") },
        ),
      );
    }
    if (scene.durationSec >= longScene) {
      issues.push(
        issue(
          "long_scene",
          `scene ${scene.id} stays on screen for ${scene.durationSec}s — worth an editor's eye`,
          { sceneId: scene.id, path: at("durationSec") },
        ),
      );
    }

    // ── Assets ───────────────────────────────────────────────────────────
    for (const [slot, assetId] of (scene.media?.assets ?? []).entries()) {
      const asset = manifest.assets.find((candidate) => candidate.id === assetId);
      if (asset !== undefined && asset.minDurationSec > scene.durationSec + tolerance) {
        issues.push(
          issue(
            "invalid_duration",
            `scene ${scene.id} needs ${asset.minDurationSec}s of ${asset.kind} but lasts ${scene.durationSec}s`,
            { sceneId: scene.id, path: at(`media.assets.${slot}`) },
          ),
        );
      }
    }

    // ── Narration and claim references against the script ────────────────
    if (index !== undefined) {
      if (scene.narration.kind === "paragraph") {
        if (!index.sectionIds.has(scene.sectionId)) {
          issues.push(
            issue(
              "dangling_narration",
              `scene ${scene.id} sits in section ${scene.sectionId}, which is not in the script`,
              { sceneId: scene.id, path: at("narration.sectionId") },
            ),
          );
        } else if (!index.spoken.includes(normalizeWhitespace(scene.narration.text))) {
          issues.push(
            issue(
              "narration_mismatch",
              `scene ${scene.id}: the narration does not appear in the script, and the scene does not say which sentences it covers`,
              { sceneId: scene.id, path: at("narration.text") },
            ),
          );
        }
      } else if (scene.narration.kind === "transition") {
        const section = index.transitions.get(scene.sectionId);
        if (section === undefined) {
          issues.push(
            issue(
              "dangling_narration",
              `scene ${scene.id} bridges section ${scene.sectionId}, which is not in the script`,
              { sceneId: scene.id, path: at("narration.sectionId") },
            ),
          );
        } else if (
          normalizeWhitespace(section.text) !== normalizeWhitespace(scene.narration.text)
        ) {
          issues.push(
            issue(
              "narration_mismatch",
              `scene ${scene.id}: the spoken transition does not match the script's section ${scene.sectionId} transition`,
              { sceneId: scene.id, path: at("narration.text") },
            ),
          );
        }
      } else {
        const { text, missing } = sentencesOf(index, scene.narration.sentenceIds);
        if (missing.length > 0) {
          issues.push(
            issue(
              "dangling_narration",
              `scene ${scene.id} speaks ${missing.join(", ")}, which the script does not have`,
              { sceneId: scene.id, path: at("narration.sentenceIds"), detail: missing.join(", ") },
            ),
          );
        } else if (text !== normalizeWhitespace(scene.narration.text)) {
          issues.push(
            issue(
              "narration_mismatch",
              `scene ${scene.id}: the narration is not the script's ${scene.narration.sentenceIds.join(", ")} verbatim`,
              { sceneId: scene.id, path: at("narration.text") },
            ),
          );
        }
      }

      for (const [slot, claim] of scene.sources.entries()) {
        const known = index.claims.get(claim.claimId);
        if (known === undefined) {
          issues.push(
            issue(
              "unknown_claim",
              `scene ${scene.id} shows claim ${claim.claimId}, which is not in the script's claim ledger`,
              { sceneId: scene.id, path: at(`sources.${slot}.claimId`) },
            ),
          );
          continue;
        }
        const knownSources = new Set(known.evidence.map((evidence) => evidence.sourceId));
        for (const [link, evidence] of claim.evidence.entries()) {
          if (!knownSources.has(evidence.sourceId)) continue;
          const inLedger = known.evidence.some(
            (candidate) =>
              candidate.sourceId === evidence.sourceId && candidate.excerpt === evidence.excerpt,
          );
          if (!inLedger) {
            issues.push(
              issue(
                "unknown_source",
                `scene ${scene.id}: the quotation attributed to ${evidence.sourceId} is not the ledger's excerpt for ${claim.claimId}`,
                { sceneId: scene.id, path: at(`sources.${slot}.evidence.${link}`) },
              ),
            );
          }
        }
      }

      for (const [slot, sourceId] of scene.sourceIds.entries()) {
        if (!index.sourceIds.has(sourceId)) {
          issues.push(
            issue(
              "unknown_source",
              `scene ${scene.id} names source ${sourceId}, which backs no claim in the script`,
              { sceneId: scene.id, path: at(`sourceIds.${slot}`) },
            ),
          );
        }
      }

      if (scene.diagram !== undefined) {
        for (const [slot, claimId] of scene.diagram.claimIds.entries()) {
          if (!index.claims.has(claimId)) {
            issues.push(
              issue(
                "unknown_claim",
                `scene ${scene.id}: the diagram is built from ${claimId}, which is not in the script's claim ledger`,
                { sceneId: scene.id, path: at(`diagram.claimIds.${slot}`) },
              ),
            );
          }
        }
      }
    }

    // ── Whatever shows somebody else's material must cite it ──────────────
    const showsEvidence =
      scene.type === "EVIDENCE" &&
      scene.text !== undefined &&
      ["quote", "claim", "number"].includes(scene.text.kind);
    if (showsEvidence && scene.sources.length === 0) {
      issues.push(
        issue(
          "missing_source_refs",
          `scene ${scene.id} shows a ${scene.text?.kind} card but references no claim`,
          { sceneId: scene.id, path: at("sources") },
        ),
      );
    }
    if (
      scene.diagram !== undefined &&
      DATA_DIAGRAM_KINDS.includes(scene.diagram.kind) &&
      scene.diagram.claimIds.length === 0
    ) {
      issues.push(
        issue(
          "missing_source_refs",
          `scene ${scene.id} plots a ${scene.diagram.kind} but cites no researched claim`,
          { sceneId: scene.id, path: at("diagram.claimIds") },
        ),
      );
    }
  }

  // ── The manifest total is the timeline ─────────────────────────────────
  if (Math.abs(manifest.totalDurationSec - running) > tolerance) {
    issues.push(
      issue(
        "duration_mismatch",
        `the manifest claims ${manifest.totalDurationSec}s but its scenes add up to ${running.toFixed(1)}s`,
        { path: "totalDurationSec" },
      ),
    );
  }
  if (sceneDuration.size !== manifest.scenes.length) {
    issues.push(issue("duplicate_scene_id", "two scenes share an id", { path: "scenes" }));
  }

  return SceneValidationReportSchema.parse({
    ok: !issues.some((entry) => entry.severity === "hard"),
    issues,
    stats: statsOf(manifest),
  });
}

/** Words a manifest's narration holds — the length the voice stage will speak. */
export function manifestWordCount(manifest: SceneManifest): number {
  return manifest.scenes.reduce((total, scene) => total + wordCount(scene.narration.text), 0);
}
