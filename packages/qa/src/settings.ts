import { sha256 } from "@nexus/storage";

import { QASettingsSchema, type QASettings, type QASettingsInput } from "./schema.js";

/**
 * The QA thresholds, in one place and with one owner.
 *
 * The engine never reads the environment: `@nexus/config` validates
 * `NEXUS_QA_*` and hands the app layer an object shaped exactly like
 * `QASettingsInput`, so `resolveQASettings(loadEnv().qa)` needs no translation.
 * `DEFAULT_QA_SETTINGS` is what a test and a fresh install run with, and
 * `settingsHash` is what makes a stored report say which rules produced it.
 */

export const DEFAULT_QA_SETTINGS: QASettings = QASettingsSchema.parse({});

/** Parse + fill defaults. Unknown keys are refused, not ignored. */
export function resolveQASettings(overrides: QASettingsInput = {}): QASettings {
  return QASettingsSchema.parse(overrides);
}

/** Stable identity of a settings object: the same rules ⇒ the same hash. */
export function settingsHash(settings: QASettings): string {
  const ordered = QASettingsSchema.parse(settings);
  const keys = Object.keys(ordered).sort();
  const canonical = JSON.stringify(
    Object.fromEntries(keys.map((key) => [key, ordered[key as never]])),
  );
  return sha256(new TextEncoder().encode(canonical));
}
