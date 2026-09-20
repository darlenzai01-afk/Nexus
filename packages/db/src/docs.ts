import { z } from "zod";

import { ArtifactKindSchema, Sha256Schema } from "./types.js";

/**
 * Schemas for the JSON documents stored in CAS artifacts and JSON columns.
 * These are the typed contracts pipeline stages exchange (discovery §5):
 * validated on write, validated again on read.
 */

// ── Project configuration (projects.config) ──────────────────────────────

export const AspectSpecSchema = z.object({
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  fps: z.number().int().min(1).max(60),
});
export type AspectSpec = z.infer<typeof AspectSpecSchema>;

export const ProjectConfigSchema = z.object({
  styleGuide: z.string().default(""),
  voiceProfile: z
    .object({
      id: z.string().default("narrator"),
      description: z.string().default(""),
    })
    .default({}),
  /** Licenses the media policy engine accepts for this project (AD-09). */
  allowedLicenses: z.array(z.string().min(1)).default(["original", "CC0", "CC-BY", "CC-BY-SA"]),
  aspects: z
    .object({
      horizontal: AspectSpecSchema.default({ width: 640, height: 360, fps: 12 }),
      vertical: AspectSpecSchema.default({ width: 540, height: 960, fps: 12 }),
    })
    .default({}),
  publishingDefaults: z
    .object({
      privacy: z.enum(["private", "unlisted", "public"]).default("private"),
      aiDisclosure: z.boolean().default(true),
    })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ── Episode outline (episodes.outline) ───────────────────────────────────

export const OutlineSchema = z.array(z.string().min(1));
export type Outline = z.infer<typeof OutlineSchema>;

// ── Script documents (CAS artifact, kind='script') ───────────────────────

export const ScriptClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const ScriptSentenceSchema = z.object({
  /** Stable id used by claims, captions, and scenes (discovery §6.1). */
  id: z.string().min(1),
  text: z.string().min(1),
  claimRef: z.string().optional(),
});

export const ScriptSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  claims: z.array(ScriptClaimSchema).default([]),
  sentences: z.array(ScriptSentenceSchema).min(1),
});

export const ScriptDocSchema = z.object({
  version: z.literal(1),
  topic: z.string().min(1),
  logline: z.string().default(""),
  sections: z.array(ScriptSectionSchema).min(1),
});
export type ScriptDoc = z.infer<typeof ScriptDocSchema>;

// ── Scene payloads (scenes.data) ─────────────────────────────────────────

export const SceneCharacterSchema = z.object({
  name: z.string().min(1),
  expression: z.enum(["idle", "talk", "point", "react"]),
});

export const SceneDataSchema = z.object({
  title: z.string().default(""),
  body: z.string().default(""),
  character: SceneCharacterSchema.optional(),
  claimId: z.string().optional(),
  mediaHash: z.string().optional(),
  paletteIndex: z.number().int().min(0).default(0),
});
export type SceneData = z.infer<typeof SceneDataSchema>;

// ── Artifact references (pipeline_job_steps.artifacts) ───────────────────

/**
 * A pointer to an artifact, never the bytes. `role` describes what the
 * artifact *is* to the producing stage (e.g. "master", "captions", "audio"),
 * which keeps multi-output stages (render → video + thumbnail + captions)
 * machine-readable for later stages and for the upload kit.
 */
export const ArtifactRefSchema = z.object({
  hash: Sha256Schema,
  kind: ArtifactKindSchema,
  role: z.string().default(""),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactRefListSchema = z.array(ArtifactRefSchema).default([]);

// ── Artifact metadata (artifacts.meta) ───────────────────────────────────

export const GeneratedBySchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  templateVersion: z.string().optional(),
});

export const ArtifactMetaSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  codec: z.string().optional(),
  /** Provenance for generated content (AD-07: every AI artifact is tagged). */
  generatedBy: GeneratedBySchema.optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;
