/**
 * Build the bundled demonstration character set.
 *
 *   node packages/characters/tools/build-demo-set.mjs
 *
 * This is the *only* way the demo set's art is produced, and it is deterministic:
 * running it again rewrites byte-identical SVG files, so the sha256 recorded in
 * every definition stays valid and `CharacterLibrary.load({ verifyAssets: true })`
 * keeps passing. The art is deliberately simple — flat shapes on a 512×1024
 * canvas, one file per layer — because the point of the set is the *system*: a
 * small, original cast that exercises identity, visual configuration, poses,
 * expressions, gestures, clothing, accessories and asset references.
 *
 * JSON is written through the repository's own formatter, so the generated
 * definitions are `pnpm format:check` clean without a second pass.
 *
 * Nothing here is modelled on, or named after, any existing channel or person.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// The repository's own formatting rules, applied to the JSON this tool writes (the
// API does not resolve `.prettierrc.json` from `filepath`, so read it explicitly).
const prettierConfig = JSON.parse(
  fs.readFileSync(path.resolve(root, "..", "..", ".prettierrc.json"), "utf8"),
);
const definitionsDir = path.join(root, "characters");

const WIDTH = 512;
const HEIGHT = 1024;
const CX = WIDTH / 2;
const FEET_Y = 964;

const fmt = (value) => Number(value.toFixed(1)).toString();

/** Write JSON the way the repository formats it (values arrive already sorted by use). */
async function writeJson(file, value) {
  fs.writeFileSync(
    file,
    await format(JSON.stringify(value), { ...prettierConfig, parser: "json", filepath: file }),
  );
}
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">\n` +
  `${body}\n</svg>\n`;

const capsule = (x1, y1, x2, y2, colour, width) =>
  `<path d="M ${fmt(x1)} ${fmt(y1)} Q ${fmt((x1 + x2) / 2 + 8)} ${fmt((y1 + y2) / 2)} ${fmt(x2)} ${fmt(y2)}"` +
  ` fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round"/>`;

/** The geometry every asset of one character shares. */
function rig(character) {
  const { proportions: p } = character.visual;
  return {
    ...p,
    cx: CX,
    feetY: FEET_Y,
    hipY: FEET_Y - p.legLength,
    shoulderY: FEET_Y - p.legLength - p.torsoLength,
    headCy: FEET_Y - p.legLength - p.torsoLength - p.headRadius - 14,
    shoulderHalf: p.shoulderWidth / 2,
    legWidth: p.limbWidth + 10,
  };
}

/** Hair: a cap that leaves the face showing, plus a per-style silhouette. */
function hairOf(character, r) {
  const { palette, hair: hairStyle } = character.visual;
  const colour = palette[hairStyle.colourKey] ?? palette.hair;
  const { headCy } = rig(character);
  const cap = `<circle cx="${CX}" cy="${fmt(headCy)}" r="${fmt(hairStyle.style === "buzz" ? r - 5 : r)}" fill="${colour}"/>`;
  const extra = {
    short: `<path d="M ${fmt(CX - r + 6)} ${fmt(headCy + 4)} Q ${CX} ${fmt(headCy - r - 10)} ${fmt(CX + r - 6)} ${fmt(headCy + 4)}" fill="none" stroke="${colour}" stroke-width="14" stroke-linecap="round"/>`,
    wavy: `<circle cx="${fmt(CX - r + 4)}" cy="${fmt(headCy + 10)}" r="${fmt(r * 0.34)}" fill="${colour}"/><circle cx="${fmt(CX + r - 4)}" cy="${fmt(headCy + 10)}" r="${fmt(r * 0.34)}" fill="${colour}"/>`,
    curly: `<circle cx="${fmt(CX - r * 0.7)}" cy="${fmt(headCy - r * 0.5)}" r="${fmt(r * 0.34)}" fill="${colour}"/><circle cx="${CX}" cy="${fmt(headCy - r * 0.95)}" r="${fmt(r * 0.36)}" fill="${colour}"/><circle cx="${fmt(CX + r * 0.7)}" cy="${fmt(headCy - r * 0.5)}" r="${fmt(r * 0.34)}" fill="${colour}"/>`,
    bun: `<circle cx="${CX}" cy="${fmt(headCy - r * 0.95)}" r="${fmt(r * 0.4)}" fill="${colour}"/>`,
    buzz: `<path d="M ${fmt(CX - r + 4)} ${fmt(headCy - 6)} Q ${CX} ${fmt(headCy - r)} ${fmt(CX + r - 4)} ${fmt(headCy - 6)}" fill="none" stroke="${colour}" stroke-width="10" stroke-linecap="round"/>`,
  }[hairStyle.style];
  return { cap, extra, colour };
}

/** One pose's body: legs, torso, neck, head, hair, face-less. */
function bodyOf(character, pose) {
  const r = rig(character);
  const { palette } = character.visual;
  const { cap, extra } = hairOf(character, r.headRadius);
  const leg = (hipX, footX, footY) =>
    `<path d="M ${fmt(hipX)} ${fmt(r.hipY)} Q ${fmt((hipX + footX) / 2)} ${fmt((r.hipY + footY) / 2)} ${fmt(footX)} ${fmt(footY)}" fill="none" stroke="${palette.secondary}" stroke-width="${r.legWidth}" stroke-linecap="round"/>`;
  const stride = pose === "walk" ? 96 : 12;
  const legs =
    leg(CX - 42, CX - 42 - stride, r.feetY) +
    leg(CX + 42, CX + 42 + stride, pose === "walk" ? r.feetY - 14 : r.feetY);
  const lean = pose === "talk" ? 6 : 0;
  const torso =
    `<rect x="${fmt(CX - r.shoulderHalf + lean)}" y="${fmt(r.shoulderY)}" width="${fmt(r.shoulderWidth)}"` +
    ` height="${fmt(r.torsoLength)}" rx="${fmt(r.shoulderWidth * 0.22)}" fill="${palette.primary}"/>` +
    `<rect x="${fmt(CX - 17)}" y="${fmt(r.shoulderY - 22)}" width="34" height="44" rx="12" fill="${palette.skin}"/>`;
  const head =
    `<circle cx="${CX}" cy="${fmt(r.headCy + 14)}" r="${fmt(r.headRadius - 4)}" fill="${palette.skin}"/>` +
    cap +
    extra +
    `<ellipse cx="${CX}" cy="${fmt(r.headCy + 14)}" rx="${fmt(r.headRadius - 7)}" ry="${fmt(r.headRadius - 6)}" fill="${palette.skin}"/>` +
    `<circle cx="${fmt(CX - r.headRadius + 5)}" cy="${fmt(r.headCy + 18)}" r="9" fill="${palette.skin}"/>` +
    `<circle cx="${fmt(CX + r.headRadius - 5)}" cy="${fmt(r.headCy + 18)}" r="9" fill="${palette.skin}"/>`;
  return legs + torso + head;
}

/** One pose's arms (or a gesture's). */
function armsOf(character, pose) {
  const r = rig(character);
  const { palette } = character.visual;
  const shoulderY = r.shoulderY + 20;
  const joint = (side) => CX + side * (r.shoulderHalf - 6);
  const shapes = {
    stand: (side) =>
      capsule(
        joint(side),
        shoulderY,
        joint(side) + side * 26,
        r.shoulderY + r.torsoLength * 0.92,
        palette.skin,
        r.limbWidth,
      ),
    walk: (side) =>
      capsule(
        joint(side),
        shoulderY,
        joint(side) + side * 30,
        r.shoulderY + r.torsoLength * (side > 0 ? 0.7 : 1.0),
        palette.skin,
        r.limbWidth,
      ),
    talk: (side) =>
      capsule(joint(side), shoulderY, side * 44 + CX, r.hipY - 44, palette.skin, r.limbWidth),
    point: (side) =>
      side > 0
        ? capsule(joint(side), shoulderY, CX + 152, r.shoulderY + 34, palette.skin, r.limbWidth)
        : capsule(
            joint(side),
            shoulderY,
            joint(side) - 14,
            r.shoulderY + r.torsoLength * 0.9,
            palette.skin,
            r.limbWidth,
          ),
    open_palms: (side) =>
      capsule(joint(side), shoulderY, CX + side * 150, r.shoulderY + 96, palette.skin, r.limbWidth),
  }[pose];
  return shapes(-1) + shapes(1);
}

function faceOf(character, expression) {
  const r = rig(character);
  const { palette } = character.visual;
  const ink = palette.ink;
  const eyeY = r.headCy + 8;
  const eye = (side, rx, ry) =>
    `<ellipse cx="${fmt(CX + side * 21)}" cy="${fmt(eyeY)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="${ink}"/>`;
  const brow = (side, height) =>
    `<path d="M ${fmt(CX + side * 32)} ${fmt(eyeY - height)} L ${fmt(CX + side * 11)} ${fmt(eyeY - height - 3)}" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`;
  const mouth = (path) =>
    `<path d="${path}" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`;
  switch (expression) {
    case "neutral":
      return (
        eye(-1, 6.5, 8) +
        eye(1, 6.5, 8) +
        mouth(`M ${fmt(CX - 12)} ${fmt(r.headCy + 44)} L ${fmt(CX + 12)} ${fmt(r.headCy + 44)}`)
      );
    case "explaining":
      return (
        eye(-1, 6.5, 5.5) +
        eye(1, 6.5, 5.5) +
        brow(-1, 22) +
        brow(1, 22) +
        `<ellipse cx="${CX}" cy="${fmt(r.headCy + 46)}" rx="10" ry="7" fill="${ink}"/>`
      );
    case "engaged":
      return (
        eye(-1, 6.5, 8) +
        eye(1, 6.5, 8) +
        mouth(
          `M ${fmt(CX - 14)} ${fmt(r.headCy + 42)} Q ${CX} ${fmt(r.headCy + 56)} ${fmt(CX + 14)} ${fmt(r.headCy + 42)}`,
        )
      );
    case "surprised":
      return (
        eye(-1, 9, 9) +
        eye(1, 9, 9) +
        brow(-1, 26) +
        brow(1, 26) +
        `<circle cx="${CX}" cy="${fmt(r.headCy + 46)}" r="7" fill="${ink}"/>`
      );
    default:
      throw new Error(`unknown expression ${expression}`);
  }
}

function clothingOf(character, outfit) {
  const r = rig(character);
  const { palette } = character.visual;
  const top = r.shoulderY - 6;
  const height = r.torsoLength + 22;
  const sleeve = (side) =>
    capsule(
      CX + side * (r.shoulderHalf - 6),
      r.shoulderY + 20,
      CX + side * (r.shoulderHalf + 18),
      r.shoulderY + r.torsoLength * (outfit === "field" ? 0.42 : 0.58),
      palette.secondary,
      r.limbWidth + 10,
    );
  const base =
    `<rect x="${fmt(CX - r.shoulderHalf - 6)}" y="${fmt(top)}" width="${fmt(r.shoulderWidth + 12)}" height="${fmt(height)}"` +
    ` rx="${fmt(r.shoulderWidth * 0.24)}" fill="${palette.secondary}"/>` +
    sleeve(-1) +
    sleeve(1);
  if (outfit === "studio") {
    return (
      base +
      `<path d="M ${fmt(CX - 34)} ${fmt(top + 6)} L ${CX} ${fmt(top + 92)} L ${fmt(CX + 34)} ${fmt(top + 6)}" fill="${palette.primary}"/>` +
      `<path d="M ${fmt(CX - 46)} ${fmt(top + 20)} L ${fmt(CX + 46)} ${fmt(top + 20)}" fill="none" stroke="${palette.accent}" stroke-width="7"/>` +
      `<rect x="${fmt(CX + 24)}" y="${fmt(r.hipY - 46)}" width="46" height="34" rx="6" fill="${palette.accent}" opacity="0.85"/>`
    );
  }
  return (
    base +
    `<path d="M ${fmt(CX - 30)} ${fmt(top + 4)} L ${fmt(CX - 30)} ${fmt(top + height - 12)}" fill="none" stroke="${palette.primary}" stroke-width="8"/>` +
    `<path d="M ${fmt(CX + 30)} ${fmt(top + 4)} L ${fmt(CX + 30)} ${fmt(top + height - 12)}" fill="none" stroke="${palette.primary}" stroke-width="8"/>` +
    `<rect x="${fmt(CX - 62)}" y="${fmt(r.hipY - 66)}" width="52" height="40" rx="6" fill="${palette.primary}" opacity="0.9"/>` +
    `<rect x="${fmt(CX + 10)}" y="${fmt(r.hipY - 66)}" width="52" height="40" rx="6" fill="${palette.primary}" opacity="0.9"/>` +
    `<path d="M ${fmt(CX - r.shoulderHalf + 4)} ${fmt(top + 34)} L ${fmt(CX + r.shoulderHalf - 4)} ${fmt(top + 34)}" fill="none" stroke="${palette.accent}" stroke-width="10"/>`
  );
}

function accessoryOf(character, accessory) {
  const r = rig(character);
  const { palette } = character.visual;
  if (accessory === "studio_badge") {
    return (
      `<path d="M ${fmt(CX - 40)} ${fmt(r.shoulderY + 8)} L ${CX} ${fmt(r.shoulderY + 116)} L ${fmt(CX + 40)} ${fmt(r.shoulderY + 8)}" fill="none" stroke="${palette.accent}" stroke-width="9"/>` +
      `<rect x="${fmt(CX - 30)}" y="${fmt(r.shoulderY + 112)}" width="60" height="42" rx="6" fill="${palette.backdrop}" stroke="${palette.ink}" stroke-width="4"/>`
    );
  }
  return (
    `<path d="M ${fmt(CX - r.shoulderHalf + 10)} ${fmt(r.shoulderY + 4)} L ${fmt(CX + r.shoulderHalf - 14)} ${fmt(r.hipY + 40)}" fill="none" stroke="${palette.accent}" stroke-width="14"/>` +
    `<rect x="${fmt(CX + 40)}" y="${fmt(r.hipY + 8)}" width="86" height="70" rx="12" fill="${palette.primary}" stroke="${palette.ink}" stroke-width="4"/>`
  );
}

function propOf(character, gesture) {
  const r = rig(character);
  const { palette } = character.visual;
  if (gesture === "point") {
    const handX = CX + 152;
    const handY = r.shoulderY + 34;
    return (
      `<path d="M ${fmt(handX)} ${fmt(handY)} L ${fmt(handX + 88)} ${fmt(handY - 40)}" fill="none" stroke="${palette.ink}" stroke-width="9" stroke-linecap="round"/>` +
      `<circle cx="${fmt(handX + 88)}" cy="${fmt(handY - 40)}" r="7" fill="${palette.accent}"/>`
    );
  }
  return (
    `<rect x="${fmt(CX - 96)}" y="${fmt(r.shoulderY + 74)}" width="192" height="132" rx="12" fill="${palette.backdrop}" stroke="${palette.ink}" stroke-width="6"/>` +
    `<path d="M ${fmt(CX - 74)} ${fmt(r.shoulderY + 108)} L ${fmt(CX + 74)} ${fmt(r.shoulderY + 108)}" fill="none" stroke="${palette.accent}" stroke-width="8"/>` +
    `<path d="M ${fmt(CX - 74)} ${fmt(r.shoulderY + 138)} L ${fmt(CX + 34)} ${fmt(r.shoulderY + 138)}" fill="none" stroke="${palette.secondary}" stroke-width="8"/>`
  );
}

/**
 * The base plate: the stand the figure is drawn on — a soft, semi-transparent
 * backdrop card and a ground shadow. It is deliberately *not* an opaque
 * full-frame fill: two characters in one frame must both be visible, and a
 * compositor that wants no per-character backdrop simply drops the plate layer.
 */
function plateOf(character) {
  const { palette } = character.visual;
  const shadow = FEET_Y + 20;
  return (
    `<ellipse cx="${CX}" cy="${fmt(shadow - 320)}" rx="176" ry="336" fill="${palette.backdrop}" opacity="0.45"/>` +
    `<path d="M ${CX - 168} ${fmt(shadow)} Q ${CX} ${fmt(shadow + 36)} ${CX + 168} ${fmt(shadow)}" fill="none" stroke="${palette.ink}" stroke-width="22" stroke-linecap="round" opacity="0.14"/>`
  );
}

// ── The demonstration cast ──────────────────────────────────────────────

const CAST = [
  {
    id: "maya",
    identity: {
      name: "Maya Okonkwo",
      shortName: "Maya",
      pronoun: "she/her",
      description:
        "The channel's studio host: a working engineer who explains systems on camera, sleeves rolled up, chalk-quiet and precise.",
      traits: ["curious", "precise", "dry humour"],
    },
    role: "host",
    visual: {
      canvas: { width: WIDTH, height: HEIGHT },
      anchor: { x: 0.5, y: 1 },
      proportions: {
        headRadius: 66,
        shoulderWidth: 188,
        torsoLength: 236,
        armLength: 232,
        legLength: 348,
        limbWidth: 40,
      },
      palette: {
        skin: "#8a5a3b",
        hair: "#1b1418",
        primary: "#1f6f6a",
        secondary: "#2b3440",
        accent: "#e0a33c",
        ink: "#141a1f",
        backdrop: "#e7e2d8",
      },
      hair: { style: "curly", colourKey: "hair" },
    },
    defaultPerformance: {
      pose: "stand",
      expression: "neutral",
      gesture: "open_palms",
      clothing: ["studio"],
      accessories: ["studio_badge"],
    },
  },
  {
    id: "tomas",
    identity: {
      name: "Tomás Reyes",
      shortName: "Tomás",
      pronoun: "he/him",
      description:
        "Field narrator: films on location, carries a notebook and a camera bag, tells the story of a place from inside it.",
      traits: ["observant", "patient", "warm"],
    },
    role: "narrator",
    visual: {
      canvas: { width: WIDTH, height: HEIGHT },
      anchor: { x: 0.5, y: 1 },
      proportions: {
        headRadius: 62,
        shoulderWidth: 204,
        torsoLength: 226,
        armLength: 236,
        legLength: 356,
        limbWidth: 44,
      },
      palette: {
        skin: "#d9a06a",
        hair: "#3a2a1c",
        primary: "#8c4a2f",
        secondary: "#4a5240",
        accent: "#e8d9a8",
        ink: "#191c17",
        backdrop: "#dfe4e0",
      },
      hair: { style: "wavy", colourKey: "hair" },
    },
    defaultPerformance: {
      pose: "stand",
      expression: "neutral",
      gesture: "point",
      clothing: ["field"],
      accessories: ["field_bag"],
    },
  },
];

const POSES = [
  {
    id: "stand",
    name: "Standing",
    description: "Weight settled, feet apart — the resting stance.",
    contexts: [],
  },
  {
    id: "walk",
    name: "Walking",
    description: "Mid-stride, moving into or out of the frame.",
    contexts: ["field"],
  },
  {
    id: "talk",
    name: "Talking",
    description: "Turned slightly to camera with the arms brought in towards the chest.",
    contexts: ["studio"],
  },
];
const EXPRESSIONS = [
  {
    id: "neutral",
    name: "Neutral",
    description: "Relaxed face, no particular feeling.",
    contexts: [],
  },
  {
    id: "explaining",
    name: "Explaining",
    description: "Brows up, mouth open — mid-sentence.",
    contexts: ["studio"],
  },
  {
    id: "engaged",
    name: "Engaged",
    description: "A slight smile, listening or agreeing.",
    contexts: [],
  },
  {
    id: "surprised",
    name: "Surprised",
    description: "Wide eyes, small mouth — a reversal in the story.",
    contexts: [],
  },
];
const GESTURES = [
  {
    id: "open_palms",
    name: "Open palms",
    description: "Both hands open, holding out a slate — 'here is how it works'.",
    contexts: ["studio"],
  },
  {
    id: "point",
    name: "Point",
    description: "Right arm extended with a pointer — indicating something off-frame.",
    contexts: ["field"],
  },
];
const CLOTHING = [
  {
    id: "studio",
    name: "Studio jacket",
    description: "Charcoal jacket over the house colours, lanyard pocket.",
    contexts: ["studio"],
  },
  {
    id: "field",
    name: "Field vest",
    description: "Utility vest with webbing straps and deep pockets.",
    contexts: ["field"],
  },
];
const ACCESSORIES = [
  {
    id: "studio_badge",
    name: "Studio badge",
    description: "Access badge on a lanyard.",
    contexts: ["studio"],
  },
  {
    id: "field_bag",
    name: "Camera bag",
    description: "Crossbody camera bag on a wide strap.",
    contexts: ["field"],
  },
];

function assetFile(character, file) {
  return `assets/${character.id}/${file}`;
}

async function buildCharacter(spec) {
  const character = { id: spec.id, visual: spec.visual };
  const assets = [];
  const variants = { poses: [], expressions: [], gestures: [], clothing: [], accessories: [] };

  const emit = (slot, paints, id, body) => {
    const file = `${id}.svg`;
    const relative = assetFile(character, file);
    const contents = svg(body);
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    const bytes = new TextEncoder().encode(contents);
    assets.push({
      id,
      slot,
      paints,
      path: relative,
      kind: "svg",
      order: 0,
      hash: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      width: WIDTH,
      height: HEIGHT,
    });
    return id;
  };

  emit("base", "plate", `${spec.id}_plate`, plateOf(character));

  for (const pose of POSES) {
    const bodyId = emit(
      "pose",
      "body",
      `${spec.id}_pose_${pose.id}_body`,
      bodyOf(character, pose.id),
    );
    const armsId = emit(
      "pose",
      "arms",
      `${spec.id}_pose_${pose.id}_arms`,
      armsOf(character, pose.id),
    );
    variants.poses.push({ ...pose, assets: [bodyId, armsId] });
  }
  for (const expression of EXPRESSIONS) {
    const id = emit(
      "expression",
      "face",
      `${spec.id}_expr_${expression.id}`,
      faceOf(character, expression.id),
    );
    variants.expressions.push({ ...expression, assets: [id] });
  }
  for (const gesture of GESTURES) {
    const armsId = emit(
      "gesture",
      "arms",
      `${spec.id}_gesture_${gesture.id}_arms`,
      armsOf(character, gesture.id),
    );
    const propId = emit(
      "gesture",
      "prop",
      `${spec.id}_gesture_${gesture.id}_prop`,
      propOf(character, gesture.id),
    );
    variants.gestures.push({ ...gesture, assets: [armsId, propId] });
  }
  for (const outfit of CLOTHING) {
    const id = emit(
      "clothing",
      "torso",
      `${spec.id}_cloth_${outfit.id}`,
      clothingOf(character, outfit.id),
    );
    variants.clothing.push({ ...outfit, assets: [id] });
  }
  for (const accessory of ACCESSORIES) {
    const id = emit(
      "accessory",
      "worn",
      `${spec.id}_acc_${accessory.id}`,
      accessoryOf(character, accessory.id),
    );
    variants.accessories.push({ ...accessory, assets: [id] });
  }

  // Draw order inside a slot: the body of a pose before its arms, an arms layer
  // before the prop it holds. Everything else is a single layer per region.
  const ordered = assets.map((asset) => ({
    ...asset,
    order:
      asset.id.endsWith("_arms") && asset.slot === "pose"
        ? 1
        : asset.id.endsWith("_arms")
          ? 0
          : asset.id.endsWith("_prop")
            ? 1
            : 0,
  }));

  const definition = {
    version: 1,
    id: spec.id,
    identity: spec.identity,
    role: spec.role,
    visual: spec.visual,
    defaultPerformance: spec.defaultPerformance,
    poses: variants.poses,
    expressions: variants.expressions,
    gestures: variants.gestures,
    clothing: variants.clothing,
    accessories: variants.accessories,
    assets: ordered,
    provenance: {
      origin: "generated",
      generator: "packages/characters/tools/build-demo-set.mjs",
      note: "Flat-shape demonstration art: one SVG per layer, generated deterministically from the proportions in this definition.",
    },
    licence: {
      kind: "original",
      note: "Original character created for the Nexus Forge demonstration set. Not modelled on, named after, or styled after any existing person or channel.",
    },
  };

  const file = path.join(definitionsDir, `${spec.id}.json`);
  fs.mkdirSync(definitionsDir, { recursive: true });
  await writeJson(file, definition);
  return { definition, assets };
}

const built = await Promise.all(CAST.map(buildCharacter));
const index = {
  version: 1,
  name: "Nexus Forge demonstration set",
  defaultCast: CAST.map((spec) => ({ characterId: spec.id, role: spec.role })),
  characters: CAST.map((spec) => `characters/${spec.id}.json`),
};
await writeJson(path.join(definitionsDir, "index.json"), index);

const files = built.flatMap((entry) => entry.assets);
const bytes = files.reduce((total, asset) => total + asset.bytes, 0);
console.log(
  JSON.stringify({
    characters: built.map((entry) => entry.definition.id),
    assets: files.length,
    bytes,
    definitions: `characters/${CAST.map((spec) => spec.id).join(".json, characters/")}.json`,
  }),
);
