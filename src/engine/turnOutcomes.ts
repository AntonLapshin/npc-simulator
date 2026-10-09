// Per-turn outcome accounting for long-run SLO tracking
// (extracted from turnOrchestrator.ts). Pure: no engine dependencies.

/** Per-turn outcome counts for long-run SLO tracking (Phase 4).
 *
 * Event accounting per resolveRender call:
 * - clean: exactly one `render_accepted` (first-try pass or pass after
 *   the single prose retry);
 * - liveness: one `liveness_applied` (Exp-5 item 6 floor: minimal in-place
 *   reaction after N consecutive fallbacks);
 * - fallback: one `fallback_used` ("Nothing changes.").
 * A turn emits exactly one of the three, so total = clean + liveness +
 * fallback. Pass `logger.store.all()` (or any entry list with `event`).
 */
export type TurnOutcomeSummary = {
  clean: number;
  fallback: number;
  /** Exp-5 item 6: minimal applied turns from the liveness floor. */
  liveness: number;
  total: number;
  cleanRate: number;
  fallbackRate: number;
  livenessRate: number;
};

export function summarizeTurnOutcomes(
  entries: ReadonlyArray<{ event: string }>,
): TurnOutcomeSummary {
  let clean = 0;
  let fallback = 0;
  let liveness = 0;
  for (const e of entries) {
    if (e.event === "render_accepted") clean++;
    else if (e.event === "liveness_applied") liveness++;
    else if (e.event === "fallback_used") fallback++;
  }
  const total = clean + fallback + liveness;
  const rate = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    clean,
    fallback,
    liveness,
    total,
    cleanRate: rate(clean),
    fallbackRate: rate(fallback),
    livenessRate: rate(liveness),
  };
}
