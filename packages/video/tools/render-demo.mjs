// Render the bundled demonstration scene to a real MP4.
//
//   corepack pnpm build                            # once: the tool imports built packages
//   NEXUS_FFMPEG_PATH=/path/to/ffmpeg \
//     node packages/video/tools/render-demo.mjs    [--out <dir>] [--width 1920] [--height 1080]
//                                                  [--fps 30] [--crf 23] [--preset medium]
//                                                  [--seconds 11.5] [--keep-frames] [--fresh]
//                                                  [--ffmpeg /path/to/ffmpeg]
//
// What it writes (defaults to `<repo>/data/video-demo/`, which is git-ignored):
//
//   demo.mp4          the video, with the narration muxed in and captions burned on
//   metadata.json     what the render measured: inputs by hash, segments, output facts
//   render-log.json   every log event, in order
//   thumbnail.jpg     the poster frame the pipeline picked
//   frame-*.png       a few sample frames (first, middle, last), as rasterised
//
// It is the runnable half of the Phase 11 smoke test: the test asserts the numbers,
// this writes the artefacts a person can watch. The narration is the deterministic
// fake TTS — real PCM, no account, no network — so the demo is reproducible offline.
//
// Re-running is cheap: the work directory is kept under `<out>/work`, so segments
// that did not change are adopted instead of re-encoded (`--fresh` deletes it first).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function load() {
  try {
    const [audio, characters, config, db, providers, render, scenes, video] = await Promise.all([
      import("@nexus/audio"),
      import("@nexus/characters"),
      import("@nexus/config"),
      import("@nexus/db"),
      import("@nexus/providers"),
      import("@nexus/render"),
      import("@nexus/scenes"),
      import("@nexus/video"),
    ]);
    return { audio, characters, config, db, providers, render, scenes, video };
  } catch (error) {
    console.error("Could not import the workspace packages.");
    console.error("Build them first:  corepack pnpm build");
    console.error(String(error));
    process.exit(2);
  }
}

const {
  audio,
  characters,
  config: configLayer,
  db,
  providers,
  render,
  scenes,
  video,
} = await load();
const { Db, Repo, migrate } = db;
const { MemoryBlobStore } = providers;
const { loadDemoScene, createCharacterStage } = render;
const { persistSceneManifest, SceneManifestSchema } = scenes;
const {
  createFFmpegRunner,
  fixtureAudio,
  loadAudioTrack,
  loadCaptionTrack,
  metadataBytes,
  renderLogBytes,
  renderVideo,
  resolveFFmpegPath,
  resolveRenderConfig,
} = { ...video, ...audio };

const outDir = path.resolve(repositoryRoot, argument("out", path.join("data", "video-demo")));
const workRoot = path.join(outDir, "work");
if (flag("fresh")) fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// The scene plan the other phases produce, cut to `--seconds` when asked. Trimming
// keeps the plan valid: events that fall outside the window are dropped and the
// ones that cross its end are clipped.
const seconds = Number.parseFloat(argument("seconds", "0"));
const full = loadDemoScene();
const manifest =
  seconds > 0
    ? SceneManifestSchema.parse({
        ...full,
        totalDurationSec: Math.min(seconds, full.totalDurationSec),
        scenes: full.scenes.map((scene) => {
          const durationSec = Math.min(seconds, scene.durationSec);
          return {
            ...scene,
            durationSec,
            animation: scene.animation
              .filter((event) => event.atSec < durationSec)
              .map((event) => ({
                ...event,
                durationSec: Math.min(event.durationSec, Math.max(0.1, durationSec - event.atSec)),
              })),
            narration: {
              ...scene.narration,
              estimatedDurationSec: Math.min(scene.narration.estimatedDurationSec, durationSec),
            },
          };
        }),
      })
    : full;

const env = configLayer.loadEnv().render;

const config = resolveRenderConfig({
  ...env,
  ffmpegPath: resolveFFmpegPath(argument("ffmpeg", env.ffmpegPath) || undefined),
  width: Number.parseInt(argument("width", String(env.width ?? 1920)), 10),
  height: Number.parseInt(argument("height", String(env.height ?? 1080)), 10),
  fps: Number.parseInt(argument("fps", String(env.fps ?? 30)), 10),
  crf: Number.parseInt(argument("crf", String(env.crf ?? 23)), 10),
  preset: argument("preset", env.preset ?? "medium"),
  keepFrames: flag("keep-frames"),
});

const storage = new MemoryBlobStore();
const database = Db.memory();
migrate(database);
const repo = new Repo(database);

// Plan and narration, through the same loaders the stages use, so the hashes the
// render records are the hashes of the bytes in the store.
const persisted = persistSceneManifest({ storage, repo }, manifest);
const narration = await fixtureAudio(storage, repo, manifest);
const fonts = demoFonts(env.fontFile);

const ffmpeg = createFFmpegRunner({ binary: config.ffmpegPath, timeoutMs: 30 * 60 * 1000 });
const started = Date.now();
const result = renderVideo(
  {
    manifest,
    manifestHash: persisted.hash,
    config,
    characterStage: createCharacterStage(characters.CharacterLibrary.load()),
    audioTrack: loadAudioTrack(storage, narration.trackHash),
    audioTrackHash: narration.trackHash,
    captionTrack: loadCaptionTrack(storage, narration.captionTrackHash),
    captionTrackHash: narration.captionTrackHash,
    fonts,
  },
  { ffmpeg, storage, workRoot },
);
const elapsedMs = Date.now() - started;

// The video, and the evidence around it, written next to each other.
fs.copyFileSync(result.video.file, path.join(outDir, "demo.mp4"));
fs.writeFileSync(path.join(outDir, "metadata.json"), metadataBytes(result.metadata));
fs.writeFileSync(
  path.join(outDir, "render-log.json"),
  renderLogBytes(result.events, {
    renderKey: result.renderKey,
    engine: result.metadata.toolchain.engine,
    engineVersion: result.metadata.toolchain.engineVersion,
  }),
);
if (result.thumbnail !== undefined) {
  fs.copyFileSync(result.thumbnail.file, path.join(outDir, "thumbnail.jpg"));
}

const framesDir = path.join(outDir, "frames");
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
const samples = [
  0,
  Math.floor(result.metadata.output.frameCount / 2),
  result.metadata.output.frameCount - 1,
];
for (const index of samples) {
  const file = path.join(
    workRoot,
    result.work.key.slice(0, 16),
    "frames",
    `frame-${String(index).padStart(6, "0")}.png`,
  );
  if (fs.existsSync(file))
    fs.copyFileSync(file, path.join(framesDir, `frame-${String(index).padStart(6, "0")}.png`));
}

const segmentsReused = result.metadata.totals.segmentsReused;
const lines = [
  `manifest         ${manifest.scenes.length} scene(s), ${manifest.totalDurationSec}s — ${manifest.workingTitle}`,
  `plan hash        ${persisted.hash.slice(0, 16)}…`,
  `render key       ${result.renderKey.slice(0, 16)}… (config ${result.metadata.configHash.slice(0, 12)}…)`,
  `output           ${config.width}x${config.height} @ ${config.fps}fps, ${config.videoCodec} crf ${config.crf}, ${result.metadata.output.durationSec.toFixed(2)}s`,
  `frames           ${result.metadata.totals.frames} total, ${result.metadata.totals.framesRendered} rasterised, ${result.metadata.totals.framesReused} reused`,
  `segments         ${result.metadata.segments.length} total, ${segmentsReused} adopted from a previous run`,
  `captions         ${result.metadata.totals.captionsBurned} cue(s) burned in`,
  `audio            ${result.metadata.audio?.clips ?? 0} clip(s), ${(result.metadata.audio?.durationSec ?? 0).toFixed(2)}s, loudness ${result.metadata.audio?.loudnessLufs?.toFixed(1) ?? "n/a"} LUFS`,
  `ffmpeg           ${result.metadata.toolchain.ffmpegVersion} (${result.metadata.toolchain.ffmpegPath})`,
  `wall clock       ${(elapsedMs / 1000).toFixed(1)}s (raster ${(result.metadata.totals.rasterMs / 1000).toFixed(1)}s, encode ${(result.metadata.totals.encodeMs / 1000).toFixed(1)}s)`,
  `issues           ${result.metadata.issues.length === 0 ? "none" : result.metadata.issues.map((issue) => `${issue.severity}:${issue.code}`).join(", ")}`,
  `written          ${path.relative(repositoryRoot, outDir)}/{demo.mp4, metadata.json, render-log.json${result.thumbnail === undefined ? "" : ", thumbnail.jpg"}, frames/}`,
];
console.log(lines.join("\n"));
console.log(
  `video            ${(fs.statSync(path.join(outDir, "demo.mp4")).size / 1024).toFixed(0)} kB`,
);

/** The faces the rasteriser draws with: the configured one, or the usual suspects. */
function demoFonts(configured) {
  const regularFile =
    configured !== "" ? configured : video.findFont(video.DEFAULT_FONT_CANDIDATES);
  if (regularFile === undefined || !fs.existsSync(regularFile)) {
    console.error("No font file found; set NEXUS_RENDER_FONT to a TrueType face.");
    process.exit(2);
  }
  const boldFile = video.findFont(video.DEFAULT_BOLD_FONT_CANDIDATES);
  return boldFile === undefined || !fs.existsSync(boldFile)
    ? { regular: video.loadFontFile(regularFile) }
    : { regular: video.loadFontFile(regularFile), bold: video.loadFontFile(boldFile) };
}
