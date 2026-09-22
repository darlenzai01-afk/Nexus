import type { AudioTrack, SentenceTiming } from "@nexus/audio";
import type { Scene, SceneManifest } from "@nexus/scenes";

import {
  SHORTS_ENGINE,
  ShortsCandidateSchema,
  ShortsPlanSchema,
  type ShortsCandidate,
  type ShortsConfig,
  type ShortsFactor,
  type ShortsFactorCode,
  type ShortsRejection,
  type ShortsPlan,
} from "./schema.js";

/**
 * The selection engine: a finished episode's documents in, structured short
 * candidates out.
 *
 * Inputs (per the brief):
 * - the **scene manifest** — scene boundaries, section roles, claim/source
 *   references and the scene visual metadata (media, text, diagram, camera,
 *   characters, animation) the visual factor reads;
 * - the **narration track** — the narration timestamps: per-scene segments and
 *   per-sentence windows on the *spoken* timeline, which is where a cut will
 *   actually land in the finished video;
 * - the transcript is the narration text those timestamps carry (the same
 *   sentences the script wrote); the finished video itself is referenced by
 *   hash — the engine decides timecodes, it does not re-encode anything.
 *
 * Candidates are **scene-aligned spans** of the narration, never fixed-length
 * chunks: every (start, end) scene pair inside the duration bounds is scored
 * on seven factors, penalised for context dependence, and spans that *depend
 * on missing context* are rejected outright with the reason recorded. The
 * engine is deterministic and model-free: it reads documents, applies rules,
 * and shows its reasons.
 */

// ── Lexicons (deliberate, small, and readable in the reasons) ────────────

const QUESTION_OPENERS =
  /^(what|why|how|who|when|where|which|is|are|was|were|do|does|did|can|could|will|would|should|has|have)\b/iu;

const SUPERLATIVES =
  /\b(most|least|best|worst|biggest|fastest|slowest|longest|shortest|largest|smallest|first|last|only|record)\b/iu;

const NEGATIONS =
  /\b(never|no one|nobody|nothing|none|nowhere|isn't|aren't|doesn't|don't|didn't)\b/iu;

const IMMERSIVE = /\b(imagine|picture (this|that)|think about|consider|look at|watch|listen)\b/iu;

const SECOND_PERSON = /\b(you|your|you're|yours)\b/iu;

const CURIOSITY_MARKERS =
  /\b(the reason|here's why|what happened|nobody knows|it turns out|turns out|the secret|the mystery|the puzzle|no one expected|the question|remains? (unanswered|unknown)|until (now|recently))\b/giu;

const CONTRAST_MARKERS =
  /\b(but|however|instead|actually|although|despite|yet|except|rather than|the problem|went wrong|mistake|myth|wrong|surprising|shockingly|surprisingly|unexpected)\b/giu;

const PAYOFF_MARKERS =
  /\b(so (the|that|it)|that's why|which means|that's how|the result|in the end|eventually|and so|which is why|the answer|today)\b/iu;

const EMOTION_MARKERS =
  /\b(amazing|shocking|terrifying|terrified|heartbreaking|incredible|unbelievable|furious|beautiful|dramatic|dangerous|scary|strange|bizarre|beloved|believe|love|hate|fear|afraid|proud|tragic)\b/giu;

const INTENSIFIERS = /\b(so|incredibly|absolutely|extremely|insanely|completely|totally)\b/giu;

/** Subject pronouns and bare demonstratives: a sentence that opens here is talking about something else. */
const UNRESOLVED_OPENERS = /^(it|they|he|she|we|this|that|these|those)\b/iu;

/** What may legally follow an "unresolved" opener before it is judged context-dependent. */
const VERBISH =
  /^(is|are|was|were|'s|'re|'ve|'m|has|have|had|will|would|can|could|should|do|does|did|seems?|looks?|sounds?|turns?|means?|started?|begins?)\b/iu;

const CONNECTIVE_OPENERS =
  /^(but|and|so|then|however|therefore|yet|also|plus|which|because|that's|thus|hence|meanwhile|instead|although|though|still|afterwards|afterward|finally|secondly|anyway)\b/iu;

const BACKWARD_REFERENCES =
  /\b(as we (saw|heard|learned)|as (we|i) mentioned|earlier(,| we|i )|previously|in the last (section|scene|part|chapter)|the previous (section|scene|part)|remember when|we just (saw|heard)|a moment ago|like (we|i) said)\b/iu;

const FORWARD_PROMISES_ANYWHERE =
  /\b(stick around|coming up|later in this video|at the end of this video|subscribe|follow along)\b/iu;

const FORWARD_PROMISES_AT_END =
  /\b(more on that later|we('ll| will) get (there|to (that|it))|later on|but that's another)\b/iu;

const TOPIC_STOPWORDS =
  /\b(the|a|an|of|in|on|at|to|and|or|why|how|what|when|where|who|is|are|does|do|did|it|its|this|that)\b/giu;

// ── Text helpers ─────────────────────────────────────────────────────────

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

const countMatches = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

const firstWord = (sentence: string): string => sentence.split(/\s+/u)[0] ?? "";

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut.slice(0, max)).trimEnd()}…`;
};

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40) || "short";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

// ── The spoken timeline ──────────────────────────────────────────────────

export interface SceneWindow {
  readonly sceneId: string;
  readonly index: number;
  /** Where the scene's speech starts/ends in the finished video. */
  readonly startSec: number;
  readonly endSec: number;
  readonly voiced: boolean;
}

/**
 * Each scene's window on the *spoken* timeline, from the narration track.
 * A scene with no segment (deliberately silent) inherits its planned window,
 * so a span through it still has honest timecodes.
 */
export function sceneWindowsOf(manifest: SceneManifest, track: AudioTrack): SceneWindow[] {
  const byScene = new Map(track.segments.map((segment) => [segment.sceneId, segment]));
  return manifest.scenes.map((scene) => {
    const segment = byScene.get(scene.id);
    if (segment === undefined) {
      return {
        sceneId: scene.id,
        index: scene.index,
        startSec: scene.startSec,
        endSec: round3(scene.startSec + scene.durationSec),
        voiced: false,
      };
    }
    return {
      sceneId: scene.id,
      index: scene.index,
      startSec: round3(segment.startSec),
      endSec: round3(segment.startSec + segment.durationSec),
      voiced: true,
    };
  });
}

interface SpanText {
  readonly sentences: readonly { readonly text: string; readonly timing: SentenceTiming }[];
  readonly text: string;
  readonly opener: string;
  readonly closer: string;
}

function spanTextOf(scenes: readonly Scene[], track: AudioTrack): SpanText {
  const sentences = track.sentences.filter((timing) =>
    scenes.some((scene) => scene.id === timing.sceneId),
  );
  const byScene = new Map<string, SentenceTiming[]>();
  for (const timing of sentences) {
    const list = byScene.get(timing.sceneId) ?? [];
    list.push(timing);
    byScene.set(timing.sceneId, list);
  }
  const lines: { text: string; timing: SentenceTiming }[] = [];
  for (const scene of scenes) {
    const timings = (byScene.get(scene.id) ?? []).sort(
      (left, right) => left.startSec - right.startSec,
    );
    const texts = sentencesOf(scene.narration.text);
    // The track's sentence windows are derived from the same sentences in the
    // same order; zip them, and keep a text-only line if a timing is missing.
    for (const [position, text] of texts.entries()) {
      const timing = timings[position];
      lines.push(
        timing !== undefined
          ? { text, timing }
          : {
              text,
              timing: {
                sentenceId: scene.narration.sentenceIds[position] ?? `${scene.id}_s${position}`,
                sceneId: scene.id,
                segmentId: "",
                startSec: scene.startSec,
                endSec: scene.startSec + scene.durationSec,
                durationSec: scene.durationSec,
                words: text.split(/\s+/u).filter(Boolean).length,
                characters: text.length,
                method: "proportional" as const,
              },
            },
      );
    }
  }
  const text = scenes.map((scene) => scene.narration.text).join(" ");
  return {
    sentences: lines,
    text,
    opener: lines[0]?.text ?? "",
    closer: lines[lines.length - 1]?.text ?? "",
  };
}

// ── The factors ──────────────────────────────────────────────────────────

interface FactorInput {
  readonly span: SpanText;
  readonly scenes: readonly Scene[];
  readonly manifest: SceneManifest;
  readonly topicKeyword: string;
}

const factor = (
  code: ShortsFactorCode,
  score: number,
  weight: number,
  reasons: string[],
): ShortsFactor => {
  // Every factor always explains what it saw — including "nothing".
  if (reasons.length === 0) reasons.push(`no ${code} signal in this span`);
  return {
    code,
    score: round3(clamp01(score)),
    weight,
    reasons: reasons.slice(0, 8).map((reason) => truncate(reason, 200)),
  };
};

function hookFactor(input: FactorInput, weight: number): ShortsFactor {
  const opener = input.span.opener;
  const reasons: string[] = [];
  let score = 0;
  if (opener.includes("?")) {
    score += 0.35;
    reasons.push("opens on a question");
  } else if (QUESTION_OPENERS.test(opener)) {
    score += 0.2;
    reasons.push("opens on a question word");
  }
  if (
    /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|forty|fifty|hundred|thousand|million|billion)\b/iu.test(
      opener,
    )
  ) {
    score += 0.2;
    reasons.push("opens on a number");
  }
  if (SUPERLATIVES.test(opener)) {
    score += 0.15;
    reasons.push("opens on a superlative");
  }
  if (NEGATIONS.test(opener)) {
    score += 0.15;
    reasons.push("opens on a negation");
  }
  if (IMMERSIVE.test(opener)) {
    score += 0.2;
    reasons.push("opens on an invitation to imagine");
  }
  if (SECOND_PERSON.test(opener)) {
    score += 0.15;
    reasons.push("speaks to the viewer");
  }
  const first = input.scenes[0];
  if (first?.role === "hook") {
    score += 0.2;
    reasons.push("starts at the episode's own hook");
  }
  return factor("hook", score, weight, reasons);
}

function curiosityFactor(input: FactorInput, weight: number): ShortsFactor {
  const reasons: string[] = [];
  const questions = countMatches(input.span.text, /\?/gu);
  const markers = countMatches(input.span.text, CURIOSITY_MARKERS);
  let score = 0;
  if (questions > 0) {
    score += Math.min(0.4, questions * 0.25);
    reasons.push(`${questions} question(s) left open`);
  }
  if (markers > 0) {
    score += Math.min(0.6, markers * 0.3);
    reasons.push("curiosity markers in the narration");
  }
  return factor("curiosity", score, weight, reasons);
}

function surpriseFactor(input: FactorInput, weight: number): ShortsFactor {
  const reasons: string[] = [];
  const contrasts = countMatches(input.span.text, CONTRAST_MARKERS);
  let score = 0;
  if (contrasts > 0) {
    score += Math.min(0.7, contrasts * 0.3);
    reasons.push(`${contrasts} contrast marker(s)`);
  }
  const contested = input.scenes.some((scene) =>
    scene.sources.some(
      (claim) => claim.status === "contradicted" || claim.certainty === "disputed",
    ),
  );
  if (contested) {
    score += 0.4;
    reasons.push("carries a contested claim");
  }
  return factor("surprise", score, weight, reasons);
}

function standaloneFactor(input: FactorInput, weight: number): ShortsFactor {
  const reasons: string[] = [];
  const sentences = input.span.sentences;
  // Soft signal: any sentence opening on a pronoun/demonstrative leans on its
  // neighbour ("This bridge…" resolves itself, "It turns out…" does not — the
  // outright-dependent openers were already rejected above).
  const leaning = sentences.filter((line) => UNRESOLVED_OPENERS.test(firstWord(line.text))).length;
  const anchored = 1 - leaning / Math.max(1, sentences.length);
  let score = 0.55 * anchored;
  if (leaning === 0) reasons.push("no sentence leans on a missing antecedent");
  else reasons.push(`${leaning} sentence(s) open on a reference word`);

  const mentionsTopic =
    input.topicKeyword !== "" && new RegExp(input.topicKeyword, "iu").test(input.span.text);
  score += 0.45 * (mentionsTopic ? 1 : 0.3);
  reasons.push(mentionsTopic ? "names the subject" : "never names the subject outright");
  return factor("standalone", score, weight, reasons);
}

function payoffFactor(input: FactorInput, weight: number): ShortsFactor {
  const closer = input.span.closer;
  const reasons: string[] = [];
  let score = 0;
  if (PAYOFF_MARKERS.test(closer)) {
    score += 0.45;
    reasons.push("closes on a resolution marker");
  }
  if (!closer.trimEnd().endsWith("?")) {
    score += 0.2;
    reasons.push("ends on a statement, not a question");
  }
  const last = input.scenes[input.scenes.length - 1];
  if (last?.role === "conclusion") {
    score += 0.35;
    reasons.push("ends at the episode's conclusion");
  }
  if (/\d|\b(hundred|thousand|million|billion)\b/iu.test(closer)) {
    score += 0.2;
    reasons.push("ends on a number");
  }
  return factor("payoff", score, weight, reasons);
}

function emotionFactor(input: FactorInput, weight: number): ShortsFactor {
  const reasons: string[] = [];
  const affect = countMatches(input.span.text, EMOTION_MARKERS);
  const intensifiers = countMatches(input.span.text, INTENSIFIERS);
  let score = 0;
  if (affect > 0) {
    score += Math.min(0.6, affect * 0.3);
    reasons.push(`${affect} emotion word(s)`);
  }
  if (intensifiers > 0) {
    score += Math.min(0.2, intensifiers * 0.15);
    reasons.push("intensified language");
  }
  if (input.scenes.some((scene) => scene.text?.kind === "quote")) {
    score += 0.3;
    reasons.push("shows a quotation on screen");
  }
  return factor("emotion", score, weight, reasons);
}

function visualFactor(input: FactorInput, weight: number): ShortsFactor {
  const reasons: string[] = [];
  let score = 0;
  const withMedia = input.scenes.filter((scene) => scene.media !== undefined).length;
  const withDiagram = input.scenes.filter((scene) => scene.diagram !== undefined).length;
  const withText = input.scenes.filter((scene) => scene.text !== undefined).length;
  const withCast = input.scenes.filter((scene) => scene.characters.length > 0).length;
  const total = input.scenes.length;
  score += 0.3 * (withMedia / total);
  score += 0.2 * (withDiagram / total);
  score += 0.15 * (withText / total);
  score += 0.15 * (withCast / total);
  if (withMedia > 0) reasons.push(`${withMedia} scene(s) with sourced media`);
  if (withDiagram > 0) reasons.push(`${withDiagram} diagram scene(s)`);
  if (withCast > 0) reasons.push(`${withCast} scene(s) with the cast`);
  const shots = new Set(input.scenes.map((scene) => scene.camera.shot));
  if (shots.size > 1) {
    score += Math.min(0.2, 0.07 * shots.size);
    reasons.push(`${shots.size} distinct camera setups`);
  }
  const events = input.scenes.reduce((sum, scene) => sum + scene.animation.length, 0);
  if (events > 0) {
    score += Math.min(0.1, 0.03 * (events / total));
    reasons.push(`${events} animation event(s)`);
  }
  return factor("visual", score, weight, reasons);
}

// ── Context dependence ───────────────────────────────────────────────────

interface ContextVerdict {
  readonly rejection: ShortsRejection | undefined;
  readonly penalty: number;
  readonly penaltyReasons: string[];
}

function contextVerdict(
  allScenes: readonly Scene[],
  scenes: readonly Scene[],
  span: SpanText,
  window: { startSec: number; endSec: number },
): ContextVerdict {
  const sceneIds = scenes.map((scene) => scene.id);
  const reject = (code: ShortsRejection["code"], reason: string): ContextVerdict => ({
    rejection: {
      code,
      sceneIds,
      startSec: window.startSec,
      endSec: window.endSec,
      reason: truncate(reason, 300),
    },
    penalty: 1,
    penaltyReasons: [reason],
  });

  const opener = span.opener.trim();
  const openerFirst = firstWord(opener);
  const openerSecond = opener.split(/\s+/u)[1] ?? "";

  if (CONNECTIVE_OPENERS.test(openerFirst)) {
    return reject(
      "context_connective_open",
      `opens on "${openerFirst}", which needs the sentence before it`,
    );
  }
  if (UNRESOLVED_OPENERS.test(openerFirst) && VERBISH.test(openerSecond)) {
    return reject(
      "context_opener_unresolved",
      `opens on "${openerFirst} ${openerSecond}…" — the referent is outside the clip`,
    );
  }
  if (BACKWARD_REFERENCES.test(span.text)) {
    return reject(
      "context_backward_reference",
      `points backward ("${(BACKWARD_REFERENCES.exec(span.text)?.[0] ?? "").trim()}")`,
    );
  }
  if (/(but|however|though|yet|which means|because|so|and)\s*$/iu.test(span.closer)) {
    return reject(
      "context_unfinished_contrast",
      `ends mid-contrast ("…${span.closer.trim().slice(-40)}")`,
    );
  }
  if (FORWARD_PROMISES_ANYWHERE.test(span.text) || FORWARD_PROMISES_AT_END.test(span.closer)) {
    return reject("context_dangling_promise", "promises content the clip never delivers");
  }

  // Soft penalties: not disqualifying, but the score should feel them.
  const penaltyReasons: string[] = [];
  let penalty = 0;
  const first = scenes[0];
  const firstIsSectionStart =
    first !== undefined &&
    allScenes.find((scene) => scene.sectionId === first.sectionId)?.id === first.id;
  if (!firstIsSectionStart) {
    penalty += 0.5;
    penaltyReasons.push("starts mid-section");
  }
  if (UNRESOLVED_OPENERS.test(openerFirst)) {
    penalty += 0.3;
    penaltyReasons.push(`opens on "${openerFirst}"`);
  }
  return { rejection: undefined, penalty: clamp01(penalty), penaltyReasons };
}

// ── The engine ───────────────────────────────────────────────────────────

export interface SelectShortsInput {
  readonly manifest: SceneManifest;
  readonly track: AudioTrack;
}

export interface SelectShortsOptions {
  readonly config?: Partial<ShortsConfig>;
  readonly now?: string;
  /** The hashes the plan should record (the stage knows them; a library caller may not). */
  readonly source?: Partial<ShortsPlan["source"]>;
}

export function selectShorts(
  input: SelectShortsInput,
  options: SelectShortsOptions = {},
): ShortsPlan {
  const config: ShortsConfig = {
    minDurationSec: options.config?.minDurationSec ?? 15,
    maxDurationSec: options.config?.maxDurationSec ?? 60,
    maxCandidates: options.config?.maxCandidates ?? 3,
    weights: {
      hook: options.config?.weights?.hook ?? 0.2,
      curiosity: options.config?.weights?.curiosity ?? 0.15,
      surprise: options.config?.weights?.surprise ?? 0.15,
      standalone: options.config?.weights?.standalone ?? 0.2,
      payoff: options.config?.weights?.payoff ?? 0.15,
      emotion: options.config?.weights?.emotion ?? 0.075,
      visual: options.config?.weights?.visual ?? 0.075,
    },
    contextPenaltyWeight: options.config?.contextPenaltyWeight ?? 0.6,
  };
  const now = options.now ?? "1970-01-01T00:00:00.000Z";

  const windows = sceneWindowsOf(input.manifest, input.track);
  const topicKeyword = topicKeywordOf(input.manifest.topic);

  interface Scored {
    readonly candidate: ShortsCandidate;
  }

  const scored: Scored[] = [];
  const rejected: ShortsRejection[] = [];
  let considered = 0;

  for (let start = 0; start < windows.length; start += 1) {
    for (let end = start; end < windows.length; end += 1) {
      const first = windows[start]!;
      const last = windows[end]!;
      const durationSec = round3(last.endSec - first.startSec);
      if (durationSec < config.minDurationSec) continue;
      if (durationSec > config.maxDurationSec) break;

      const scenes = input.manifest.scenes.slice(start, end + 1);
      const span = spanTextOf(scenes, input.track);
      considered += 1;

      const verdict = contextVerdict(input.manifest.scenes, scenes, span, {
        startSec: first.startSec,
        endSec: last.endSec,
      });
      if (verdict.rejection !== undefined) {
        rejected.push(verdict.rejection);
        continue;
      }

      const factorInput: FactorInput = { span, scenes, manifest: input.manifest, topicKeyword };
      const factors: ShortsFactor[] = [
        hookFactor(factorInput, config.weights.hook),
        curiosityFactor(factorInput, config.weights.curiosity),
        surpriseFactor(factorInput, config.weights.surprise),
        standaloneFactor(factorInput, config.weights.standalone),
        payoffFactor(factorInput, config.weights.payoff),
        emotionFactor(factorInput, config.weights.emotion),
        visualFactor(factorInput, config.weights.visual),
      ];
      const weightSum = factors.reduce((sum, entry) => sum + entry.weight, 0) || 1;
      const weighted =
        factors.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / weightSum;
      const total = round3(clamp01(weighted * (1 - config.contextPenaltyWeight * verdict.penalty)));

      const hookSentence = truncate(span.opener.replace(/\s+/gu, " ").trim(), 400);
      const candidate = ShortsCandidateSchema.parse({
        id: `short_${slugOf(hookSentence)}_${start}_${end}`,
        title: truncate(`${input.manifest.workingTitle} — ${hookSentence}`, 200),
        hookSentence,
        sceneIds: scenes.map((scene) => scene.id),
        startIndex: start,
        endIndex: end,
        startSec: first.startSec,
        endSec: last.endSec,
        durationSec,
        transcript: span.sentences.map((line) => ({
          sentenceId: line.timing.sentenceId,
          sceneId: line.timing.sceneId,
          text: line.text,
          startSec: round3(line.timing.startSec),
          endSec: round3(line.timing.endSec),
        })),
        claimIds: [
          ...new Set(scenes.flatMap((scene) => scene.sources.map((claim) => claim.claimId))),
        ],
        sourceIds: [...new Set(scenes.flatMap((scene) => scene.sourceIds))],
        score: {
          total,
          factors,
          contextPenalty: round3(verdict.penalty),
          penaltyReasons: verdict.penaltyReasons.map((reason) => truncate(reason, 200)),
        },
      });
      scored.push({ candidate });
    }
  }

  // Best first, then take non-overlapping spans (a scene can only serve one short).
  scored.sort((left, right) => right.candidate.score.total - left.candidate.score.total);
  const chosen: ShortsCandidate[] = [];
  for (const entry of scored) {
    if (chosen.length >= config.maxCandidates) break;
    const overlaps = chosen.some(
      (candidate) =>
        entry.candidate.startIndex <= candidate.endIndex &&
        entry.candidate.endIndex >= candidate.startIndex,
    );
    if (!overlaps) chosen.push(entry.candidate);
  }

  return ShortsPlanSchema.parse({
    version: 1,
    source: {
      manifestHash: options.source?.manifestHash ?? "0".repeat(64),
      trackHash: options.source?.trackHash ?? "",
      scriptHash:
        options.source?.scriptHash ?? (input.track.scriptHash === "" ? "" : input.track.scriptHash),
      videoHash: options.source?.videoHash ?? "",
    },
    topic: input.manifest.topic,
    generatedAt: now,
    config,
    candidates: chosen,
    rejected: rejected.slice(0, 400),
    considered,
    warnings: [],
    provenance: { engine: SHORTS_ENGINE, deterministic: true },
  });
}

/** The subject word the `standalone` factor checks the span against. */
export function topicKeywordOf(topic: string): string {
  const words = topic
    .toLowerCase()
    .replace(TOPIC_STOPWORDS, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 2);
  return words[0] ? words[0].replace(/[^\w]/gu, "") : "";
}

// Exposed for the layout module and tests: the span text reader.
export { sentencesOf, spanTextOf };
