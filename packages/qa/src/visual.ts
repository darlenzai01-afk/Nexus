import {
  buildTimeline,
  composeVideo,
  createCharacterStage,
  type Frame,
  type FrameElement,
} from "@nexus/render";
import { DEFAULT_CAPTION_STYLE, elementMatrix, measureRun, missingGlyphs } from "@nexus/video";
import type { FontSet } from "@nexus/video";

import type { QAEvidence, QADeps } from "./evidence.js";
import {
  checkResult,
  finding,
  round2,
  type CheckResult,
  type FindingEvidence,
} from "./findings.js";
import type { QASettings } from "./schema.js";

/**
 * Visual QA: what the plan promises to put on screen, and whether it can be seen.
 *
 * The checks run against the **composed frames**, not the manifest's prose: the
 * composer is the thing that decides where a text box lands, how big a character
 * is at this shot, and what a reveal has covered by frame *n*. Measuring anything
 * else would be measuring a different video. So the plan is composed once, and
 * every frame's elements are checked:
 *
 * - **assets** — a `media` element with no `uri` is a hole in the picture; a
 *   character whose layer files are missing or changed is a broken reference;
 * - **scenes** — a transition into a scene that does not exist, a scene with no
 *   narration, an empty plan;
 * - **readable text** — type smaller than the readable minimum *in output
 *   pixels*, and the glyphs the font cannot draw;
 * - **layout** — a box that falls outside the frame or the safe area, a zero-size
 *   box, text wider than its own box, and the burned-in caption band colliding
 *   with on-screen text.
 */

const CAPTION_BAND = DEFAULT_CAPTION_STYLE;

export function checkVisual(evidence: QAEvidence, deps: QADeps, settings: QASettings): CheckResult {
  const findings = [];
  const { manifest } = evidence;
  const frame = { width: manifest.resolution.width, height: manifest.resolution.height };
  let examined = 0;

  // ── Scenes: the plan's own consistency ───────────────────────────────────
  examined += manifest.scenes.length;
  const sceneIds = new Set(manifest.scenes.map((scene) => scene.id));
  for (const scene of manifest.scenes) {
    if (scene.transition.toSceneId !== "" && !sceneIds.has(scene.transition.toSceneId)) {
      findings.push(
        finding(
          "visual_scene_missing",
          scene.id,
          `scene ${scene.id} transitions into ${scene.transition.toSceneId}, which the plan does not have`,
          { sceneId: scene.id, toSceneId: scene.transition.toSceneId, kind: scene.transition.kind },
          "re-plan the transition chain",
        ),
      );
    }
    if (scene.narration.text.trim() === "") {
      findings.push(
        finding(
          "visual_scene_missing",
          scene.id,
          `scene ${scene.id} has no narration, so it cannot be voiced, captioned or timed`,
          { sceneId: scene.id },
        ),
      );
    }
    if (scene.transition.toSceneId === "" && scene.index !== manifest.scenes.length - 1) {
      findings.push(
        finding(
          "visual_scene_missing",
          scene.id,
          `scene ${scene.id} is not the last scene but hands over to nothing`,
          { sceneId: scene.id, index: scene.index },
        ),
      );
    }
  }

  // ── Assets: planned-but-absent media, and character layers ───────────────
  examined += manifest.assets.length;
  for (const asset of manifest.assets) {
    const scene = manifest.scenes.find((entry) => entry.id === asset.sceneId);
    const drawn = scene?.media !== undefined && scene.media.assets.includes(asset.id);
    if (asset.status === "planned" || asset.uri === "") {
      findings.push(
        finding(
          "visual_asset_missing",
          asset.id,
          `asset ${asset.id} (${asset.purpose} for ${asset.sceneId}) is still ${asset.status} with no file` +
            (drawn === true ? "; the scene draws it as a placeholder" : ""),
          {
            assetId: asset.id,
            sceneId: asset.sceneId,
            kind: asset.kind,
            purpose: asset.purpose,
            licence: asset.licence,
            drawn: drawn === true,
          },
          "source the asset in the media stage, or change what the scene shows",
        ),
      );
    }
  }

  const library = deps.characters;
  const cast = new Map(manifest.cast.map((member) => [member.id, member]));
  for (const scene of manifest.scenes) {
    for (const entry of scene.characters) {
      examined += 1;
      const member = cast.get(entry.characterId);
      if (member === undefined) {
        findings.push(
          finding(
            "visual_asset_reference_broken",
            `${scene.id}/${entry.characterId}`,
            `scene ${scene.id} casts ${entry.characterId}, which is not in the manifest's cast`,
            { sceneId: scene.id, characterId: entry.characterId },
            "re-sync the manifest against the character library",
          ),
        );
        continue;
      }
      if (library === undefined) continue;
      const definition = library.get(entry.characterId);
      if (definition === undefined) {
        findings.push(
          finding(
            "visual_asset_reference_broken",
            `${scene.id}/${entry.characterId}`,
            `scene ${scene.id} casts ${entry.characterId}, which the character library does not have`,
            {
              sceneId: scene.id,
              characterId: entry.characterId,
              version: member.definition?.version ?? null,
            },
          ),
        );
        continue;
      }
      if (member.definition !== undefined && definition.version !== member.definition.version) {
        findings.push(
          finding(
            "visual_asset_reference_broken",
            `${scene.id}/${entry.characterId}`,
            `the manifest pins ${entry.characterId} v${member.definition.version} but the library has v${definition.version}`,
            {
              sceneId: scene.id,
              characterId: entry.characterId,
              pinned: member.definition.version,
              library: definition.version,
            },
            "re-sync the manifest with the character library",
          ),
        );
      }
    }
  }

  // Broken layer files: the library can verify its own hashes, and a render would
  // draw a hole where a mismatched layer should be.
  if (library !== undefined) {
    for (const { characterId, checks } of library.verifyAssets()) {
      examined += checks.length;
      for (const check of checks) {
        if (check.ok) continue;
        findings.push(
          finding(
            "visual_asset_reference_broken",
            `${characterId}/${check.assetId}`,
            `character ${characterId}'s layer ${check.assetId} (${check.path}) is ${check.problem}: ` +
              `expected ${check.expected.bytes} bytes, found ${check.actual?.bytes ?? 0}`,
            {
              characterId,
              assetId: check.assetId,
              path: check.path,
              problem: check.problem ?? "unknown",
              expectedHash: check.expected.hash.slice(0, 16),
              actualHash: check.actual?.hash.slice(0, 16) ?? null,
            },
            "regenerate the art, or update the definition",
          ),
        );
      }
    }
  }

  // ── Text and layout: the composed frames are the truth ───────────────────
  const fonts = deps.fonts;
  if (fonts === undefined) {
    findings.push(
      finding(
        "qa_check_skipped",
        "visual.text",
        "no font is available, so text was not measured; readability is unchecked",
        {},
        "install a TrueType face or set NEXUS_RENDER_FONT",
      ),
    );
  }

  let composed: ReturnType<typeof composeVideo> | undefined;
  try {
    composed = composeVideo(buildTimeline(manifest), {
      deps: { ...(library !== undefined ? { characters: createCharacterStage(library) } : {}) },
    });
  } catch (error) {
    findings.push(
      finding(
        "visual_layout_invalid",
        "plan",
        `the plan cannot be composed into frames: ${error instanceof Error ? error.message : String(error)}`,
        {},
        "fix the plan before rendering it",
      ),
    );
    return checkResult("visual.frames", "visual", examined, findings, "composition failed");
  }

  const scale = frame.width / manifest.resolution.width;
  const frames = composed.scenes.flatMap((scene) => [...scene.frames]);
  const sceneOf = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
  const worstText = new Map<
    string,
    { frame: Frame; element: Extract<FrameElement, { kind: "text" }> }
  >();

  for (const frameDocument of frames) {
    for (const element of frameDocument.elements) {
      examined += 1;
      if (element.kind === "text") {
        // One finding per text element, about the frame it is worst on: the last
        // frame of its scene, when every reveal has finished and every animation
        // has run — the frames arrive in order, so the last write wins.
        worstText.set(`${frameDocument.sceneId}/${element.id}`, { frame: frameDocument, element });
      }
      if (element.kind === "media" && element.uri === "") {
        // Reported once per scene below, not once per frame.
        continue;
      }
      const box = placedRect(element, scale);
      if (box.width <= 0 || box.height <= 0) {
        findings.push(
          finding(
            "visual_layout_invalid",
            `${frameDocument.sceneId}/${element.id}`,
            `element ${element.id} in ${frameDocument.sceneId} has a zero-sized box ` +
              `(${round2(box.width)}x${round2(box.height)} px), so it cannot be seen`,
            { sceneId: frameDocument.sceneId, elementId: element.id, kind: element.kind },
          ),
        );
        continue;
      }
      // What is *drawn* is not always the box: text is laid out inside it as a block
      // of lines, so the box can be a wide guide while the words sit well inside it.
      // Measuring the block is what makes "is it on screen?" a question about the
      // picture rather than about the planner's rectangle.
      const ink = inkBox(element, box, scale, fonts);
      const miss = offFrame(ink, frame);
      if (miss === "none") {
        findings.push(
          finding(
            "visual_layout_invalid",
            `${frameDocument.sceneId}/${element.id}`,
            `element ${element.id} in ${frameDocument.sceneId} lands entirely outside the frame, so it ` +
              `cannot be seen`,
            {
              sceneId: frameDocument.sceneId,
              elementId: element.id,
              kind: element.kind,
              x: round2(ink.x),
              y: round2(ink.y),
              width: round2(ink.width),
              height: round2(ink.height),
              frameWidth: frame.width,
              frameHeight: frame.height,
            },
            "move the element back inside the frame",
          ),
        );
      } else if (miss === "partly") {
        findings.push(
          finding(
            "visual_layout_clipped",
            `${frameDocument.sceneId}/${element.id}`,
            `element ${element.id} in ${frameDocument.sceneId} is partly outside the frame ` +
              `(${round2(ink.x)}…${round2(ink.x + ink.width)} px of ${frame.width} px)`,
            {
              sceneId: frameDocument.sceneId,
              elementId: element.id,
              kind: element.kind,
              x: round2(ink.x),
              width: round2(ink.width),
              frameWidth: frame.width,
            },
            "tighten the framing, or accept the crop and record it as a warning",
          ),
        );
      }
    }
  }

  // Media placeholders, once per scene that draws one.
  for (const scene of manifest.scenes) {
    const drawn = frames.find((entry) => entry.sceneId === scene.id)?.elements ?? [];
    for (const element of drawn) {
      if (element.kind !== "media" || element.uri !== "") continue;
      findings.push(
        finding(
          "visual_asset_missing",
          `${scene.id}/${element.id}`,
          `scene ${scene.id} draws media ${element.id} with no file behind it`,
          { sceneId: scene.id, elementId: element.id, assets: element.assetIds.join(",") },
          "source the asset, or change the scene's type",
        ),
      );
    }
  }

  // Readability and fit, per text element.
  for (const [key, { frame: frameDocument, element }] of worstText) {
    const matrix = elementMatrix(element, scale);
    const deviceFontPx = element.style.fontSizePx * Math.hypot(matrix.a, matrix.b);
    const evidence: FindingEvidence = {
      sceneId: frameDocument.sceneId,
      elementId: element.id,
      fontSizePx: round2(element.style.fontSizePx),
      deviceFontPx: round2(deviceFontPx),
      minFontPx: settings.minFontPx,
      lines: element.lines.length,
    };
    if (deviceFontPx < settings.minFontPx) {
      findings.push(
        finding(
          "visual_text_unreadable",
          key,
          `text ${element.id} in ${frameDocument.sceneId} renders at ${round2(deviceFontPx)} px, ` +
            `below the readable minimum of ${settings.minFontPx} px`,
          evidence,
          "shorten the line, or enlarge the box",
        ),
      );
    } else if (deviceFontPx < settings.tightFontPx) {
      findings.push(
        finding(
          "visual_text_tight",
          key,
          `text ${element.id} in ${frameDocument.sceneId} renders at ${round2(deviceFontPx)} px, ` +
            `tight for a phone screen (${settings.tightFontPx} px is comfortable)`,
          evidence,
        ),
      );
    }

    if (fonts !== undefined) {
      const measured = element.lines.map((line) =>
        measureRun(fonts, {
          text: line,
          x: 0,
          baselineY: 0,
          fontSizePx: element.style.fontSizePx,
          weight: element.style.weight,
          italic: element.style.italic,
          anchor: "start",
          colour: element.style.colour,
        }),
      );
      const widest = measured.reduce((max, width) => Math.max(max, width), 0);
      if (widest > element.rect.width) {
        findings.push(
          finding(
            "visual_layout_invalid",
            key,
            `a line of text ${element.id} in ${frameDocument.sceneId} is ${round2(widest)} px wide ` +
              `in a ${round2(element.rect.width)} px box, so it overflows`,
            {
              ...evidence,
              widestLinePx: round2(widest),
              boxWidthPx: round2(element.rect.width),
              longestLine: longestLine(element.lines, measured),
            },
            "re-wrap the text, or widen the box",
          ),
        );
      }
      const undrawable = missingGlyphs(fonts, element.lines.join(" ") + element.attribution);
      if (undrawable.length > 0) {
        findings.push(
          finding(
            "visual_text_undrawable",
            key,
            `text ${element.id} in ${frameDocument.sceneId} contains ${undrawable.length} character(s) ` +
              `the font cannot draw (${undrawable.slice(0, 8).join("")})`,
            { ...evidence, missing: undrawable.join("") },
            "choose different wording, or a font with those glyphs",
          ),
        );
      }
    }
  }

  // ── The caption band must not sit on top of on-screen text ───────────────
  if (settings.checkCaptionSafeArea && evidence.captions !== undefined && frames.length > 0) {
    const bandHeight = captionBandHeight();
    const bandTop = frame.height - CAPTION_BAND.marginPx - bandHeight;
    const cues = evidence.captions.doc.cues;
    examined += cues.length;
    for (const cue of cues) {
      const sceneId = cue.sceneId;
      const scene = sceneOf.get(sceneId);
      if (scene === undefined) continue;
      const atFrame =
        frames.find((entry) => entry.sceneId === sceneId && entry.timeSec >= cue.startMs / 1000) ??
        frames.find((entry) => entry.sceneId === sceneId);
      if (atFrame === undefined) continue;
      for (const element of atFrame.elements) {
        if (element.kind !== "text") continue;
        const box = inkBox(element, placedRect(element, scale), scale, fonts);
        if (box.y + box.height <= bandTop) continue;
        findings.push(
          finding(
            "visual_layout_invalid",
            `${sceneId}/${element.id}`,
            `caption ${cue.id} is drawn over text ${element.id} in ${sceneId} ` +
              `(text reaches ${round2(box.y + box.height)} px, the caption band starts at ${round2(bandTop)} px)`,
            {
              sceneId,
              elementId: element.id,
              cueId: cue.id,
              textBottomPx: round2(box.y + box.height),
              bandTopPx: round2(bandTop),
            },
            "move the text higher, or turn captions off for this episode",
          ),
        );
      }
      for (const line of cue.lines) {
        if (fonts === undefined) break;
        const width = measureRun(fonts, {
          text: line.text,
          x: 0,
          baselineY: 0,
          fontSizePx: CAPTION_BAND.fontPx,
          weight: 600,
          italic: false,
          anchor: "start",
          colour: CAPTION_BAND.ink,
        });
        if (width > frame.width * CAPTION_BAND.safeWidthRatio) {
          findings.push(
            finding(
              "visual_layout_invalid",
              cue.id,
              `caption line "${line.text}" is ${round2(width)} px wide, over the ` +
                `${round2(frame.width * CAPTION_BAND.safeWidthRatio)} px safe width`,
              {
                cueId: cue.id,
                widthPx: round2(width),
                safeWidthPx: round2(frame.width * CAPTION_BAND.safeWidthRatio),
              },
              "re-wrap the caption",
            ),
          );
        }
      }
    }
  }

  return checkResult("visual.frames", "visual", examined, findings);
}

/** The caption band's own height, in output pixels: two lines, plus padding. */
function captionBandHeight(): number {
  return Math.round(CAPTION_BAND.fontPx * 1.25 * 2 + CAPTION_BAND.fontPx * 0.6);
}

/** A line's width, described for the message. */
function longestLine(lines: readonly string[], widths: readonly number[]): string {
  let index = 0;
  for (let position = 1; position < widths.length; position += 1) {
    if ((widths[position] ?? 0) > (widths[index] ?? 0)) index = position;
  }
  return (lines[index] ?? "").slice(0, 60);
}

/** The element's box after its transform, in output pixels (rotation is reported). */
function placedRect(
  element: FrameElement,
  scale: number,
): { x: number; y: number; width: number; height: number } {
  const box = elementBox(element);
  const width = box.width * scale * element.transform.scale;
  const height = box.height * scale * element.transform.scale;
  const x = element.transform.x * scale - element.transform.origin.x * width;
  const y = element.transform.y * scale - element.transform.origin.y * height;
  return { x, y, width, height };
}

/** The element's own box, in plan pixels (mirrors the rasteriser's `elementBox`). */
function elementBox(element: FrameElement): { width: number; height: number } {
  if (element.kind === "text") return { width: element.rect.width, height: element.rect.height };
  if (element.kind === "character")
    return { width: element.canvas.width, height: element.canvas.height };
  if (element.kind === "diagram") return { width: element.rect.width, height: element.rect.height };
  if (element.kind === "media") return { width: element.rect.width, height: element.rect.height };
  return { width: element.rect.width, height: element.rect.height };
}

interface InkBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the element actually covers, in output pixels.
 *
 * For everything but text that is the box. For text it is the block the renderer
 * draws: the lines it wrapped (measured with the same `measureRun` the rasteriser
 * uses) plus the attribution line, centred in the box the way `drawTextElement`
 * centres it. A rotated element is reported by its box: the axis-aligned block
 * would be wrong, and a wrong measurement is worse than a rough one.
 */
function inkBox(
  element: FrameElement,
  box: InkBox,
  scale: number,
  fonts: FontSet | undefined,
): InkBox {
  if (element.kind !== "text") return box;
  const matrix = elementMatrix(element, scale);
  const scaleOf = Math.hypot(matrix.a, matrix.b);
  const lines = element.lines;
  if (lines.length === 0 || element.transform.rotationDeg !== 0) return box;

  const lineHeight = Math.round(element.style.fontSizePx * 1.25);
  const block = [...lines, ...(element.attribution === "" ? [] : [element.attribution])];
  const height = ((block.length - 1) * lineHeight + element.style.fontSizePx) * scaleOf;
  const widest =
    fonts === undefined
      ? element.rect.width
      : block.reduce((max, line, index) => {
          const size =
            index >= lines.length ? element.style.fontSizePx * 0.78 : element.style.fontSizePx;
          return Math.max(
            max,
            measureRun(fonts, {
              text: line,
              x: 0,
              baselineY: 0,
              fontSizePx: size,
              weight: element.style.weight,
              italic: element.style.italic,
              anchor: "start",
              colour: element.style.colour,
            }),
          );
        }, 0) * scaleOf;
  const width = Math.min(widest, box.width);
  const x = element.style.align === "center" ? box.x + (box.width - width) / 2 : box.x;
  const y = box.y + (box.height - height) / 2;
  return { x, y, width, height };
}

/** How an element misses the frame: `none` (invisible), `partly`, or neither. */
function offFrame(
  ink: InkBox,
  frame: { width: number; height: number },
): "none" | "partly" | undefined {
  const visible =
    ink.x + ink.width > 0 && ink.x < frame.width && ink.y + ink.height > 0 && ink.y < frame.height;
  if (!visible) return "none";
  const inside =
    ink.x >= -1 &&
    ink.y >= -1 &&
    ink.x + ink.width <= frame.width + 1 &&
    ink.y + ink.height <= frame.height + 1;
  return inside ? undefined : "partly";
}
