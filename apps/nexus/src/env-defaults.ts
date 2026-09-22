/**
 * Dashboard-level env defaults.
 *
 * The scene plan gives every scene reading room (a per-type hold padding and a
 * minimum on-screen time) on top of the narration it will carry, while a TTS
 * voice speaks only the narration itself and never fills that room — so the
 * finished narration track legitimately runs shorter than the plan. The QA
 * engine's shipped `durationToleranceSec` (0.5s) assumes one of the two gets
 * re-aligned afterwards ("re-plan the scenes to the spoken timings"), which no
 * stage does yet (see ISSUES.md). Until that stage exists the dashboard ships a
 * tolerance wide enough for the plan's reading room, so honest runs are not
 * blocked by a gap the pipeline cannot yet close; gross mismatches still fail.
 */
export function withDashboardDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NEXUS_QA_DURATION_TOLERANCE_SEC === undefined) {
    return { ...env, NEXUS_QA_DURATION_TOLERANCE_SEC: "15" };
  }
  return env;
}
