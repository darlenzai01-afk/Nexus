import type { SceneAnimationKind } from "@nexus/scenes";

/**
 * Easing.
 *
 * The animation vocabulary in the scene manifest carries no easing field on
 * purpose: an event says *what* happens, and the compositor owns *how* it feels.
 * That keeps the manifest small and keeps motion consistent across a whole video —
 * a `fade_in` is the same curve in every scene that uses one.
 */

export type EaseName = "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeOutBack";

export type Ease = (t: number) => number;

export const EASINGS: Readonly<Record<EaseName, Ease>> = {
  linear: (t) => t,
  easeIn: (t) => t * t * t,
  easeOut: (t) => 1 - (1 - t) ** 3,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  /** Slight overshoot: used where a scale-up should land with a little life. */
  easeOutBack: (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2,
};

/** Which curve a kind animates with. Entrances arrive, exits leave, loops breathe. */
export function easeFor(kind: SceneAnimationKind): EaseName {
  switch (kind) {
    case "type_on":
    case "count_up":
      return "linear";
    case "fade_in":
    case "slide_in":
    case "wipe_in":
    case "push_in":
    case "split_open":
    case "lower_third":
    case "dissolve_out":
      return "easeOut";
    case "fade_out":
    case "slide_out":
      return "easeIn";
    case "scale_in":
      return "easeOutBack";
    default:
      return "easeInOut";
  }
}
