// Compose the bundled demonstration scene and write the result to disk.
//
//   corepack pnpm build                      # once: the tool imports built packages
//   node packages/render/tools/compose-demo.mjs [--out <dir>] [--tiles 16]
//
// What it writes (defaults to `<repo>/data/render-demo/`, which is git-ignored):
//
//   storyboard.svg   a contact sheet of sampled frames — one file, the whole scene
//   frames.json      the frame documents it sampled, as the engine produced them
//   frame-<n>.svg    full-resolution frames at four points of the scene
//
// It is the runnable half of the Phase 9 smoke test: the test asserts the numbers,
// this writes the artefacts an operator can open in a browser.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

async function load() {
  try {
    const [characters, render] = await Promise.all([
      import("@nexus/characters"),
      import("@nexus/render"),
    ]);
    return { characters, render };
  } catch (error) {
    console.error("Could not import the workspace packages.");
    console.error("Build them first:  corepack pnpm build");
    console.error(String(error));
    process.exit(2);
  }
}

const { characters, render } = await load();
const { CharacterLibrary } = characters;
const {
  buildTimeline,
  composeScene,
  createCharacterStage,
  frameToSvg,
  loadDemoScene,
  storyboardSvg,
  verifyAssets,
} = render;

const manifest = loadDemoScene();
const library = CharacterLibrary.load();
const stage = createCharacterStage(library);
const timeline = buildTimeline(manifest);
const scene = manifest.scenes[0];

const tiles = Number.parseInt(argument("tiles", "16"), 10);
const outDir = path.resolve(repositoryRoot, argument("out", path.join("data", "render-demo")));
fs.mkdirSync(outDir, { recursive: true });

const composed = composeScene(timeline, scene.id, { deps: { characters: stage } });
const assetCheck = verifyAssets(composed, stage);

// Sampled frames: an even spread across the scene, always including the first and
// the last frame (so the opening fade-in and the closing seam are both on the sheet).
const step = Math.max(1, Math.floor((composed.frames.length - 1) / Math.max(1, tiles - 1)));
const sampled = [];
for (let index = 0; index < composed.frames.length; index += step)
  sampled.push(composed.frames[index]);
if (sampled[sampled.length - 1] !== composed.frames[composed.frames.length - 1]) {
  sampled.push(composed.frames[composed.frames.length - 1]);
}

const read = (assetPath) => stage.read(assetPath);
const storyboard = storyboardSvg(sampled, { read, title: scene.id });
fs.writeFileSync(path.join(outDir, "storyboard.svg"), storyboard.svg);
fs.writeFileSync(path.join(outDir, "frames.json"), `${JSON.stringify(sampled, null, 2)}\n`);

const keyFrames = [
  0,
  Math.floor(composed.frames.length * 0.33),
  Math.floor(composed.frames.length * 0.66),
  composed.frames.length - 1,
];
for (const index of keyFrames) {
  const frame = composed.frames[index];
  const written = frameToSvg(frame, { read, xmlDeclaration: true });
  fs.writeFileSync(path.join(outDir, `frame-${String(index).padStart(4, "0")}.svg`), written.svg);
}

const charactersOnScreen = [
  ...new Set(
    composed.frames[Math.floor(composed.frames.length / 2)].elements
      .filter((element) => element.kind === "character")
      .map((element) => `${element.characterId} (${element.pose}, ${element.expression})`),
  ),
];

const lines = [
  `scene            ${scene.id} — ${scene.type}, ${scene.durationSec}s at ${timeline.fps}fps`,
  `frames           ${composed.frames.length} composed (${timeline.frameCount} in the timeline)`,
  `characters       ${charactersOnScreen.join(", ")}`,
  `cast             ${manifest.cast.map((member) => `${member.id}@${member.definition.hash.slice(0, 10)}`).join(", ")}`,
  `assets           ${assetCheck.report.length} layers drawn, ${assetCheck.report.filter((entry) => entry.ok).length} verified against the definitions`,
  `animation        ${scene.animation.length} events: ${scene.animation.map((event) => event.kind).join(", ")}`,
  `camera           ${scene.camera.shot} / ${scene.camera.movement} / ${scene.camera.angle} / ${scene.camera.focus}`,
  `transition       ${scene.transition.kind} over ${scene.transition.durationSec}s`,
  `frame digest     ${composed.digest}`,
  `diagnostics      ${composed.diagnostics.length === 0 ? "none" : composed.diagnostics.map((entry) => entry.code).join(", ")}`,
  `written          ${path.relative(repositoryRoot, outDir)}/storyboard.svg (${(storyboard.bytes / 1024).toFixed(1)} kB), frames.json, ${keyFrames.length} full frames`,
];

console.log(lines.join("\n"));
