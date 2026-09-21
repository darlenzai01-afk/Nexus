import type { Look } from "./types.js";

/**
 * The engine's own colours.
 *
 * A scene manifest says *what* is on screen; it deliberately says nothing about
 * type colour or panel fills (that belongs to a look, not a plan). The compositor
 * therefore carries one look per composition, and every element the engine itself
 * draws — panels, cards, bands, captions — is drawn from it. Swapping the look
 * re-grades the whole video without touching a manifest.
 */
export const DEFAULT_LOOK: Look = {
  background: "#12161c",
  ink: "#f6f4ee",
  accent: "#e0a33c",
  panel: "#1e252e",
  panelInk: "#dfe4e0",
  caption: "#9fb0bd",
  fontFamily: "Inter, Helvetica, Arial, sans-serif",
};

/** A look, with any field overridden. */
export function makeLook(overrides: Partial<Look> = {}): Look {
  return { ...DEFAULT_LOOK, ...overrides };
}
