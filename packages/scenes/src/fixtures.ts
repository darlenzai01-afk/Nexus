import { FixedClock } from "@nexus/providers";
import type { ScriptDoc } from "@nexus/script";

import { buildSceneManifest } from "./plan.js";
import { parseSceneManifest, type SceneManifest, type SceneManifestInput } from "./schema.js";

/**
 * Shared fixtures for the scene planner.
 *
 * The script fixture is shaped exactly like the one `@nexus/script` produces: a
 * claim ledger with verbatim evidence, per-sentence assertion types, and one
 * sentence per visual kind — so planning it exercises **all six scene types** and
 * every block a scene can carry (text, diagram, media, assets, sources).
 *
 * The hand-written manifest fixture is the other direction: a small document a
 * person could type, which the strict schemas must accept and fill in.
 */

export const SCRIPT_HASH = "c".repeat(64);
export const CLOCK_ISO = "2024-05-01T00:00:00.000Z";

const EXCERPT_OPENING = "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.";
const EXCERPT_COUNT = "Traffic counts show 40,000 vehicles a day crossing the Kira bridge.";
const EXCERPT_DRIVERS = "Some drivers report the crossing takes fifteen minutes at peak.";

export const CLEAR_CLAIM_ID = "cl_clear";
export const THIN_CLAIM_ID = "cl_thin";

/** A validated script document, with a sentence for every visual kind. */
export function scriptFixture(overrides: Partial<ScriptDoc> = {}): ScriptDoc {
  return {
    version: 2,
    topic: "The Kira bridge",
    workingTitle: "Forty Thousand Crossings a Day",
    logline: "How one 1973 bridge became the busiest crossing in the city.",
    sections: [
      {
        id: "sec1",
        role: "hook",
        title: "Forty thousand a day",
        transition: "",
        sentences: [
          {
            id: "s1_1",
            narration: "Forty thousand vehicles cross the Kira bridge every single day.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "none",
              description: "Presenter to camera, no graphics",
              searchHint: "",
            },
          },
        ],
      },
      {
        id: "sec2",
        role: "introduction",
        title: "The bridge nobody expected to matter",
        transition: "That number is hard to picture, so here is the bridge itself.",
        sentences: [
          {
            id: "s2_1",
            narration: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "broll",
              description: "Traffic streaming across the bridge at rush hour",
              searchHint: "bridge traffic aerial",
            },
          },
          {
            id: "s2_2",
            narration: "Two independent counts agree on that figure.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "text",
              description: "The daily figure on a full-frame card",
              searchHint: "",
            },
          },
        ],
      },
      {
        id: "sec3",
        role: "narrative",
        title: "What the counters found",
        transition: "The story starts with two counts taken years apart.",
        sentences: [
          {
            id: "s3_1",
            narration:
              'A driver on the forum writes that "the crossing takes fifteen minutes at peak".',
            assertion: "attributed",
            claimRefs: [THIN_CLAIM_ID],
            sourceRefs: ["src_forum"],
            visual: {
              kind: "quote",
              description: "The forum post, quoted on screen",
              searchHint: "forum post",
            },
          },
          {
            id: "s3_2",
            narration: "Data.example.org counts 40,000 vehicles a day on the deck.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: ["src_data"],
            visual: {
              kind: "chart",
              description: "Daily crossings across the year",
              searchHint: "traffic chart",
            },
          },
        ],
      },
      {
        id: "sec4",
        role: "narrative",
        title: "Why the planners were wrong",
        transition: "The gap between the forecast and the traffic is the whole story.",
        sentences: [
          {
            id: "s4_1",
            narration: "The design assumed far fewer cars than the city now sends across it.",
            assertion: "context",
            claimRefs: [],
            sourceRefs: [],
            visual: {
              kind: "image",
              description: "Archive photograph of the bridge under construction",
              searchHint: "bridge construction 1973",
            },
          },
          {
            id: "s4_2",
            narration: "Numbers on a page rarely survive contact with a growing city.",
            assertion: "context",
            claimRefs: [],
            sourceRefs: [],
          },
          {
            id: "s4_3",
            narration: "The city kept growing around a bridge built for another era.",
            assertion: "context",
            claimRefs: [],
            sourceRefs: [],
            visual: {
              kind: "image",
              description: "Wide aerial of the city either side of the river",
              searchHint: "city aerial river",
            },
          },
        ],
      },
      {
        id: "sec5",
        role: "conclusion",
        title: "Payoff",
        transition: "Which brings us back to that number.",
        sentences: [
          {
            id: "s5_1",
            narration: "Forty thousand crossings a day is what a 1973 design now has to carry.",
            assertion: "fact",
            claimRefs: [CLEAR_CLAIM_ID],
            sourceRefs: [],
            visual: {
              kind: "broll",
              description: "Sunset over the bridge with traffic in both directions",
              searchHint: "bridge sunset traffic",
            },
          },
        ],
      },
    ],
    claims: [
      {
        claimId: CLEAR_CLAIM_ID,
        statement: "The Kira bridge opened in 1973 and carries 40,000 vehicles a day.",
        status: "supported",
        certainty: "established",
        confidence: 0.75,
        mayStateAsFact: true,
        usage: "fact",
        sentenceIds: ["s1_1", "s2_1", "s2_2", "s3_2", "s5_1"],
        evidence: [
          {
            sourceId: "src_news",
            url: "https://news.example.com/bridge",
            excerpt: EXCERPT_OPENING,
            locator: "0:65",
          },
          {
            sourceId: "src_data",
            url: "https://data.example.org/kira",
            excerpt: EXCERPT_COUNT,
            locator: "0:67",
          },
        ],
      },
      {
        claimId: THIN_CLAIM_ID,
        statement: "Crossing the Kira bridge takes fifteen minutes at peak.",
        status: "supported",
        certainty: "likely",
        confidence: 0.6,
        mayStateAsFact: false,
        usage: "attributed",
        sentenceIds: ["s3_1"],
        evidence: [
          {
            sourceId: "src_forum",
            url: "https://forum.example.net/kira",
            excerpt: EXCERPT_DRIVERS,
            locator: "0:63",
          },
        ],
      },
    ],
    quality: { issues: [], repairRounds: 0, reviewRequired: false, droppedSentences: [] },
    stats: { sections: 5, sentences: 9, words: 141, estimatedDurationSec: 56.4 },
    provenance: {
      engine: { name: "nexus-script", version: "1.0.0" },
      researchPackageHash: "b".repeat(64),
      providers: { llm: "stub-llm" },
      steps: [],
      aiSteps: ["write"],
      deterministicSteps: ["select", "validate", "finalize"],
      repairRounds: 0,
      generatedAt: CLOCK_ISO,
      durationMs: 5,
    },
    warnings: [],
    ...overrides,
  };
}

/** The plan of the fixture script — the canonical valid manifest in these tests. */
export function manifestFixture(overrides: Partial<ScriptDoc> = {}): SceneManifest {
  return buildSceneManifest(scriptFixture(overrides), {
    scriptHash: SCRIPT_HASH,
    scriptId: "script_1",
    clock: new FixedClock(CLOCK_ISO),
  });
}

/**
 * A small manifest a person could type: two scenes, both with narration, the
 * second with the minimum an `ENVIRONMENT` scene needs. Every optional field is
 * left out on purpose — the schema has to fill it in.
 */
export function handWrittenManifest(): SceneManifestInput {
  return {
    version: 1,
    topic: "The Kira bridge",
    workingTitle: "Hand-written plan",
    scriptHash: SCRIPT_HASH,
    generatedAt: CLOCK_ISO,
    resolution: { width: 1920, height: 1080 },
    totalDurationSec: 5.9,
    cast: [{ id: "presenter", name: "Presenter", role: "host" }],
    scenes: [
      {
        id: "scn_1",
        index: 0,
        type: "CHARACTER",
        sectionId: "sec1",
        role: "hook",
        startSec: 0,
        durationSec: 2.7,
        narration: {
          kind: "sentence",
          text: "The Kira bridge opened in 1973.",
          sectionId: "sec1",
          role: "hook",
          sentenceIds: ["s1_1"],
          words: 6,
          estimatedDurationSec: 2.4,
        },
        characters: [{ characterId: "presenter", state: "talking" }],
        camera: { shot: "medium", movement: "static", angle: "eye_level", focus: "presenter" },
        transition: { kind: "cut", toSceneId: "scn_2" },
      },
      {
        id: "scn_2",
        index: 1,
        type: "ENVIRONMENT",
        sectionId: "sec2",
        role: "introduction",
        startSec: 2.7,
        durationSec: 3.2,
        narration: {
          kind: "sentence",
          text: "Traffic streams across it all day.",
          sectionId: "sec2",
          role: "introduction",
          sentenceIds: ["s2_1"],
          words: 6,
          estimatedDurationSec: 2.4,
        },
        media: { kind: "image", description: "The bridge at sunset", assets: ["asset_a"] },
        camera: { shot: "wide", movement: "pan_right", angle: "eye_level", focus: "background" },
        transition: { kind: "cut", toSceneId: "" },
      },
    ],
    assets: [
      {
        id: "asset_a",
        sceneId: "scn_2",
        kind: "image",
        purpose: "still",
        description: "The bridge at sunset",
      },
    ],
    provenance: {
      engine: { name: "hand", version: "0" },
      generatedAt: CLOCK_ISO,
    },
  };
}

/** The hand-written fixture, parsed: defaults filled, ready to hand around. */
export function handWritten(): SceneManifest {
  return parseSceneManifest(handWrittenManifest());
}

/** Deep-clone a manifest and apply an edit — the shape every broken case starts from. */
export function editManifest(
  manifest: SceneManifest,
  edit: (draft: SceneManifest) => void,
): SceneManifest {
  const draft = structuredClone(manifest) as SceneManifest;
  edit(draft);
  return draft;
}
