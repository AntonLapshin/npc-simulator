// Pure text helpers for the physical validator (extracted from physicalValidator.ts).

/** Edit distance between two strings (case-insensitive). */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const dp: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i]![j]! = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[x.length]![y.length]!;
}

/**
 * Exp-3 item 7: fuzzy id repair. The validator already names the unknown
 * id — append the closest roster ids (edit distance, normalized names
 * compared so "coffee mug" meets "lounge_mug") so the retry can succeed
 * instead of falling back. Returns e.g. `"anton_mug", "dana_mug"` or "".
 */
export function suggestSimilarIds(unknownId: string, candidates: string[], k = 3): string {
  const norm = (s: string): string[] => {
    const base = [s.toLowerCase()];
    // "tanya's_desk"-style possessives: compare the de-possessivized form too.
    const deposs = s.toLowerCase().replace(/['']s/g, "s").replace(/_/g, " ");
    if (deposs !== base[0]) base.push(deposs);
    return base;
  };
  const scored = candidates.map((c) => {
    const variants = norm(c);
    const uVariants = norm(unknownId);
    let best = Infinity;
    for (const cv of variants) {
      for (const uv of uVariants) {
        // Token overlap shortcut: "coffee mug" shares "mug" with "*_mug".
        const cToks = new Set(cv.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
        const uToks = new Set(uv.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
        const shared = [...uToks].filter((t) => cToks.has(t)).length;
        const d = editDistance(uv, cv) - shared * 3;
        if (d < best) best = d;
      }
    }
    return { id: c, score: best };
  });
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return scored
    .slice(0, k)
    .filter((s) => s.score <= Math.max(unknownId.length, 4) + 4)
    .map((s) => `"${s.id}"`)
    .join(", ");
}
