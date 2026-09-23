import { z } from "zod";

/**
 * The character contract (Phase 8).
 *
 * A **character** is a reusable definition: who they are (identity), how they
 * look (visual configuration), how they move (poses, gestures), how they feel
 * (expressions), what they wear (clothing, accessories) and which art files carry
 * all of it (assets). A scene never copies any of that: it references a character
 * by id and asks for a pose, an expression and an outfit, and the resolver turns
 * that into an ordered layer stack of asset references.
 *
 * Two rules shape the schema:
 *
 * 1. **Every block is a `z.strictObject`.** An unknown field is an error, so a
 *    definition cannot carry a `posses` list that nobody notices.
 * 2. **Ids are the interface.** Variants are referenced by id, assets are
 *    referenced by id, and the closure rules (every referenced variant/asset
 *    exists, every asset belongs to exactly one variant, slots match their kind)
 *    are enforced on load — before anything tries to draw a character.
 */

export const CHARACTER_SCHEMA_VERSION = 1 as const;

/** 1-64 chars, readable in a log line and safe in a filename. */
const IdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u,
    "expected a 1-64 char id (letters, digits, . _ : -)",
  );

/** `#rrggbb`, lowercase — so two identical colours are always one string. */
export const HexColourSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/u, "expected a lowercase #rrggbb colour");

/** A path inside the character library root: relative, POSIX separators, no `..`. */
export const CharacterAssetPathSchema = z
  .string()
  .min(3)
  .max(200)
  .refine((value) => !value.startsWith("/") && !value.includes("..") && !value.includes("\\"), {
    message: "expected a relative POSIX path inside the character library",
  });

// ── Identity ─────────────────────────────────────────────────────────────

export const CharacterIdentitySchema = z.strictObject({
  /** Display name. Original characters only — see `licence`. */
  name: z.string().min(2).max(60),
  /** Short label for captions and lower thirds. */
  shortName: z.string().min(1).max(24),
  pronoun: z.string().min(2).max(20),
  description: z.string().min(10).max(400),
  traits: z.array(z.string().min(2).max(40)).max(6).default([]),
});
export type CharacterIdentity = z.infer<typeof CharacterIdentitySchema>;

/** The channel role this character can be cast in (mirrors the scene manifest). */
export const CharacterRoleSchema = z.enum(["host", "narrator", "guest", "expert", "character"]);
export type CharacterRole = z.infer<typeof CharacterRoleSchema>;

// ── Visual configuration ─────────────────────────────────────────────────

export const CharacterCanvasSchema = z.strictObject({
  width: z.number().int().min(256).max(8192),
  height: z.number().int().min(256).max(8192),
});

export const CharacterPaletteSchema = z.strictObject({
  skin: HexColourSchema,
  hair: HexColourSchema,
  /** Main garment colour. */
  primary: HexColourSchema,
  /** Second garment colour: trousers, sleeves, layers. */
  secondary: HexColourSchema,
  /** Small, saturated highlight: straps, trim, props. */
  accent: HexColourSchema,
  /** Outlines, eyes, hair shadow. */
  ink: HexColourSchema,
  /** Neutral card tone, for a future backdrop layer. */
  backdrop: HexColourSchema,
});
export type CharacterPalette = z.infer<typeof CharacterPaletteSchema>;

/** Body proportions in canvas units — the whole rig is derived from these. */
export const CharacterProportionsSchema = z.strictObject({
  headRadius: z.number().min(8).max(400),
  shoulderWidth: z.number().min(8).max(800),
  torsoLength: z.number().min(8).max(1200),
  armLength: z.number().min(8).max(1200),
  legLength: z.number().min(8).max(1600),
  limbWidth: z.number().min(2).max(120),
});

export const CharacterHairStyleSchema = z.enum(["short", "wavy", "curly", "bun", "buzz"]);

export const CharacterVisualSchema = z.strictObject({
  canvas: CharacterCanvasSchema,
  /** Where the figure stands on the canvas, as a fraction of width/height. */
  anchor: z.strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  proportions: CharacterProportionsSchema,
  palette: CharacterPaletteSchema,
  hair: z.strictObject({
    style: CharacterHairStyleSchema,
    /** Which palette entry the hair uses. */
    colourKey: z.enum(["hair", "primary", "secondary", "accent"]).default("hair"),
  }),
});

// ── Assets (the art files) ───────────────────────────────────────────────

export const CharacterSlotSchema = z.enum([
  "base",
  "pose",
  "expression",
  "gesture",
  "clothing",
  "accessory",
]);
export type CharacterSlot = z.infer<typeof CharacterSlotSchema>;

/**
 * The draw order of the slots: the body first, then limbs, then clothes over the
 * torso, the face on top of the head, worn items over everything, and any gesture
 * prop last of all.
 */
export const SLOT_ORDER: Readonly<Record<CharacterSlot, number>> = {
  base: 0,
  pose: 1,
  clothing: 2,
  expression: 3,
  accessory: 4,
  gesture: 5,
};

/**
 * Which part of the figure a layer covers. This is what makes layer composition
 * unambiguous: a gesture that draws its own arms *replaces* the pose's arms
 * instead of drawing a second pair on top of them (see `resolve.ts`).
 */
export const CharacterPaintSchema = z.enum([
  "plate",
  "body",
  "arms",
  "torso",
  "face",
  "worn",
  "prop",
]);
export type CharacterPaint = z.infer<typeof CharacterPaintSchema>;

/**
 * Which regions each slot is allowed to paint.
 *
 * The figure is composed from one layer per region: a **pose** owns the body
 * (torso, head and legs) and the arms, a **gesture** may replace those arms (and
 * add a held prop), **clothing** draws over the torso and upper arms, an
 * **expression** redraws the face, and an **accessory** goes over everything but a
 * prop. The base plate is the canvas underneath it all.
 */
export const SLOT_PAINTS: Readonly<Record<CharacterSlot, readonly CharacterPaint[]>> = {
  base: ["plate"],
  pose: ["body", "arms"],
  clothing: ["torso"],
  expression: ["face"],
  accessory: ["worn"],
  gesture: ["arms", "prop"],
};

export const CharacterAssetSchema = z.strictObject({
  id: IdSchema,
  slot: CharacterSlotSchema,
  /** The region this layer covers; a later slot wins a contested region. */
  paints: CharacterPaintSchema,
  /** File path relative to the character library root (POSIX separators). */
  path: CharacterAssetPathSchema,
  kind: z.literal("svg"),
  /** Draw order inside the slot; lower draws first. */
  order: z.number().int().min(0).max(999),
  /** sha256 of the file bytes — verified when the library loads. */
  hash: z.string().regex(/^[0-9a-f]{64}$/u, "expected a sha256 hex digest"),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type CharacterAsset = z.infer<typeof CharacterAssetSchema>;

// ── Variants: poses, expressions, gestures, clothing, accessories ────────

/**
 * Tags that let the scene planner pick a variant for a context: `studio`,
 * `field`, or a section role (`hook`, `introduction`, `narrative`, `conclusion`).
 * An empty list means "always usable".
 */
export const CharacterContextTagSchema = z.enum([
  "studio",
  "field",
  "hook",
  "introduction",
  "narrative",
  "conclusion",
]);
export type CharacterContextTag = z.infer<typeof CharacterContextTagSchema>;

const variantFields = {
  id: IdSchema,
  name: z.string().min(2).max(60),
  description: z.string().min(5).max(240),
  /** Asset ids that make up this variant, in the slot's own draw order. */
  assets: z.array(IdSchema).min(1).max(4),
  contexts: z.array(CharacterContextTagSchema).max(6).default([]),
};

export const CharacterPoseSchema = z.strictObject({ ...variantFields });
export const CharacterExpressionSchema = z.strictObject({ ...variantFields });
export const CharacterGestureSchema = z.strictObject({ ...variantFields });
export const CharacterClothingSchema = z.strictObject({ ...variantFields });
export const CharacterAccessorySchema = z.strictObject({ ...variantFields });

export type CharacterPose = z.infer<typeof CharacterPoseSchema>;
export type CharacterExpression = z.infer<typeof CharacterExpressionSchema>;
export type CharacterGesture = z.infer<typeof CharacterGestureSchema>;
export type CharacterClothing = z.infer<typeof CharacterClothingSchema>;
export type CharacterAccessory = z.infer<typeof CharacterAccessorySchema>;

/** What a character wears and does when a scene does not say. */
export const CharacterDefaultPerformanceSchema = z.strictObject({
  pose: IdSchema,
  expression: IdSchema,
  gesture: IdSchema.optional(),
  clothing: z.array(IdSchema).min(1).max(4),
  accessories: z.array(IdSchema).max(4).default([]),
});
export type CharacterDefaultPerformance = z.infer<typeof CharacterDefaultPerformanceSchema>;

// ── Provenance and licence ───────────────────────────────────────────────

export const CharacterProvenanceSchema = z.strictObject({
  /** How the definition came to exist. */
  origin: z.enum(["generated", "authored", "imported"]),
  /** The tool that produced the assets, when `origin` is `generated`. */
  generator: z.string().max(80).default(""),
  note: z.string().max(400).default(""),
});

/**
 * Characters must be original work. `kind: "original"` is the only value the
 * bundled set may use; anything else is an operator's own licensing statement.
 */
export const CharacterLicenceSchema = z.strictObject({
  kind: z.enum(["original", "cc0", "licensed"]),
  note: z.string().min(5).max(400),
});

// ── The definition ───────────────────────────────────────────────────────

const VARIANT_SLOTS: Readonly<Record<string, CharacterSlot>> = {
  poses: "pose",
  expressions: "expression",
  gestures: "gesture",
  clothing: "clothing",
  accessories: "accessory",
};

export const CharacterSchema = z
  .strictObject({
    version: z.literal(CHARACTER_SCHEMA_VERSION),
    /** The character's id everywhere: cast lists, scene references, asset paths. */
    id: IdSchema,
    identity: CharacterIdentitySchema,
    /** The role this character is cast in by default. */
    role: CharacterRoleSchema,
    visual: CharacterVisualSchema,
    defaultPerformance: CharacterDefaultPerformanceSchema,
    poses: z.array(CharacterPoseSchema).min(1).max(24),
    expressions: z.array(CharacterExpressionSchema).min(1).max(24),
    gestures: z.array(CharacterGestureSchema).max(24).default([]),
    clothing: z.array(CharacterClothingSchema).min(1).max(12),
    accessories: z.array(CharacterAccessorySchema).max(12).default([]),
    assets: z.array(CharacterAssetSchema).min(1).max(120),
    provenance: CharacterProvenanceSchema,
    licence: CharacterLicenceSchema,
  })
  .superRefine((character, ctx) => {
    const fail = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [...path] });
    };

    // Asset ids are unique, and every asset belongs to the slot its variant uses.
    const assetById = new Map<string, CharacterAsset>();
    for (const [index, asset] of character.assets.entries()) {
      if (assetById.has(asset.id))
        fail(`asset id ${asset.id} is used twice`, ["assets", index, "id"]);
      assetById.set(asset.id, asset);
    }

    for (const [index, asset] of character.assets.entries()) {
      if (!SLOT_PAINTS[asset.slot].includes(asset.paints)) {
        fail(
          `${asset.slot} asset ${asset.id} paints "${asset.paints}"; a ${asset.slot} layer may paint ${SLOT_PAINTS[asset.slot].join(" or ")}`,
          ["assets", index, "paints"],
        );
      }
    }

    const usedAssetIds = new Set<string>();
    const variantIds = new Set<string>();
    const variantLists: readonly (readonly [
      string,
      readonly { id: string; assets: readonly string[] }[],
    ])[] = [
      ["poses", character.poses],
      ["expressions", character.expressions],
      ["gestures", character.gestures],
      ["clothing", character.clothing],
      ["accessories", character.accessories],
    ];
    for (const [key, variants] of variantLists) {
      const slot = VARIANT_SLOTS[key] ?? "base";
      for (const [index, variant] of variants.entries()) {
        const label = `${slot}:${variant.id}`;
        if (variantIds.has(label)) {
          fail(`${slot} id ${variant.id} is used twice`, [key, index, "id"]);
        }
        variantIds.add(label);
        for (const [slotIndex, assetId] of variant.assets.entries()) {
          const asset = assetById.get(assetId);
          if (asset === undefined) {
            fail(`${label} references asset ${assetId}, which is not in the asset table`, [
              key,
              index,
              "assets",
              slotIndex,
            ]);
            continue;
          }
          if (asset.slot !== slot) {
            fail(`${label} references asset ${assetId}, whose slot is ${asset.slot}`, [
              key,
              index,
              "assets",
              slotIndex,
            ]);
          }
          usedAssetIds.add(assetId);
        }
      }
    }
    for (const [index, asset] of character.assets.entries()) {
      // Base layers are always drawn (the plate sits under every performance), so
      // they need no variant to reference them; every other slot must be reachable.
      if (asset.slot !== "base" && !usedAssetIds.has(asset.id)) {
        fail(`asset ${asset.id} is defined but no variant uses it`, ["assets", index, "id"]);
      }
    }

    // The default performance has to name things that exist.
    const has = (list: readonly { id: string }[], id: string): boolean =>
      list.some((entry) => entry.id === id);
    const defaults = character.defaultPerformance;
    if (!has(character.poses, defaults.pose)) {
      fail(`default pose ${defaults.pose} is not defined`, ["defaultPerformance", "pose"]);
    }
    if (!has(character.expressions, defaults.expression)) {
      fail(`default expression ${defaults.expression} is not defined`, [
        "defaultPerformance",
        "expression",
      ]);
    }
    if (defaults.gesture !== undefined && !has(character.gestures, defaults.gesture)) {
      fail(`default gesture ${defaults.gesture} is not defined`, ["defaultPerformance", "gesture"]);
    }
    for (const [index, id] of defaults.clothing.entries()) {
      if (!has(character.clothing, id)) {
        fail(`default clothing ${id} is not defined`, ["defaultPerformance", "clothing", index]);
      }
    }
    for (const [index, id] of defaults.accessories.entries()) {
      if (!has(character.accessories, id)) {
        fail(`default accessory ${id} is not defined`, [
          "defaultPerformance",
          "accessories",
          index,
        ]);
      }
    }
  });
export type Character = z.infer<typeof CharacterSchema>;

/** Parse a definition, filling the defaults. Throws with the exact path. */
export function parseCharacter(input: unknown): Character {
  return CharacterSchema.parse(input);
}

/** Canonical bytes of a definition — what its hash is taken over. */
export function characterBytes(character: Character): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(character, null, 2)}\n`);
}

// ── Library index ────────────────────────────────────────────────────────

export const CharacterCastEntrySchema = z.strictObject({
  characterId: IdSchema,
  role: CharacterRoleSchema,
});
export type CharacterCastEntry = z.infer<typeof CharacterCastEntrySchema>;

export const CharacterLibraryIndexSchema = z.strictObject({
  version: z.literal(CHARACTER_SCHEMA_VERSION),
  /** Human-readable name of the set, e.g. "Nexus Forge demonstration set". */
  name: z.string().min(2).max(80),
  /** The cast the planner uses when a project does not say otherwise. */
  defaultCast: z.array(CharacterCastEntrySchema).min(1).max(8),
  /** Definition files, relative to the library root, in load order. */
  characters: z.array(CharacterAssetPathSchema).min(1).max(64),
});
export type CharacterLibraryIndex = z.infer<typeof CharacterLibraryIndexSchema>;

export function parseCharacterLibraryIndex(input: unknown): CharacterLibraryIndex {
  return CharacterLibraryIndexSchema.parse(input);
}
