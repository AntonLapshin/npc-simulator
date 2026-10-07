// Per-turn outcome accounting for long-run SLO tracking
// (extracted from turnOrchestrator.ts). Pure: no engine dependencies.

/** Per-turn outcome counts for long-run SLO tracking (Phase 4).
 *
 * Event accounting per resolveWithValidation call:
 * - clean: exactly one `validation_passed` (first-try pass or pass after
 *   retry / deterministic movement repair);
 * - salvaged: one `partial_applied` (degraded-but-advancing: valid patches
 *   kept, speech/object nits logged as warnings);
 * - liveness: one `liveness_applied` (Exp-5 item 6 floor: minimal in-place
 *   reaction after N consecutive fallbacks);
 * - fallback: one `fallback_used` ("Nothing changes.").
 * A turn emits exactly one of the four, so total = clean + salvaged +
 * liveness + fallback. Pass `logger.store.all()` (or any entry list with `event`).
 */
export type TurnOutcomeSummary = {
  clean: number;
  salvaged: number;
  fallback: number;
  /** Exp-5 item 6: minimal applied turns from the liveness floor. */
  liveness: number;
  total: number;
  cleanRate: number;
  salvagedRate: number;
  fallbackRate: number;
  livenessRate: number;
  /** Degraded-but-advancing share (salvaged / total) — the Phase 4 SLO. */
  degradedRate: number;
};

export function summarizeTurnOutcomes(
  entries: ReadonlyArray<{ event: string }>,
): TurnOutcomeSummary {
  let clean = 0;
  let salvaged = 0;
  let fallback = 0;
  let liveness = 0;
  for (const e of entries) {
    if (e.event === "validation_passed") clean++;
    else if (e.event === "partial_applied") salvaged++;
    else if (e.event === "liveness_applied") liveness++;
    else if (e.event === "fallback_used") fallback++;
  }
  const total = clean + salvaged + fallback + liveness;
  const rate = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    clean,
    salvaged,
    fallback,
    liveness,
    total,
    cleanRate: rate(clean),
    salvagedRate: rate(salvaged),
    fallbackRate: rate(fallback),
    livenessRate: rate(liveness),
    degradedRate: rate(salvaged),
  };
}
