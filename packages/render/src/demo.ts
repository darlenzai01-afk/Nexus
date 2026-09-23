import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSceneManifest, type SceneManifest } from "@nexus/scenes";

/**
 * The demonstration scene.
 *
 * Phase 9 ships **one** complete scene, written by hand as a scene manifest and
 * used by the smoke test and the demo tool. It is the smallest thing that proves
 * the whole chain — manifest → character library → performance → animation events
 * → composed frames → SVG — and it is deliberately synthetic: its narration and
 * its on-screen text say so, because a demonstration scene is not research and
 * must never read like a claim about the world.
 */

export const DEMO_SUBDIR = "demo";
export const DEMO_SCENE_FILE = "scene.json";

/** The root of the `@nexus/render` package (this file lives in `src/`). */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new Error(
      "cannot locate the @nexus/render package root (pass an explicit file to loadDemoScene)",
    );
  }
  return root;
}

/** Where the bundled demonstration scene lives. */
export function demoSceneFile(): string {
  return path.join(packageRoot(), DEMO_SUBDIR, DEMO_SCENE_FILE);
}

export interface LoadDemoSceneOptions {
  readonly file?: string | undefined;
}

/** Read and validate the bundled demonstration scene. */
export function loadDemoScene(options: LoadDemoSceneOptions = {}): SceneManifest {
  const file = options.file ?? demoSceneFile();
  if (!fs.existsSync(file)) throw new Error(`no demonstration scene at ${file}`);
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return parseSceneManifest(parsed);
}
