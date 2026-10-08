// Roster-discipline prompt helpers (exp local-8b item C1).
//
// Small models invent roster members ("Anton"/"Tanya" attractors in the
// local-8b experiment) even with a ROSTER RULE present. Repeating the
// actual ids inline (retrieval beats recall) plus one concrete negative
// example of invented names lowers the invention base rate. Pure.

/** Negative-example names, filtered to ones absent from the given roster. */
function inventedNameExamples(rosterIds: string[]): string[] {
  const known = new Set(rosterIds.map((id) => id.toLowerCase()));
  // Exp-3 M2: the 8B invented "leon" on a roster where Anton/Tanya/Dana
  // are legitimate — the attractor now hides inside real vocabulary, so
  // the negative examples name the shape explicitly.
  return ["Anton", "Tanya", "Leon", "Liam", "John"].filter(
    (n) => !known.has(n.toLowerCase()),
  );
}

/**
 * Item C1: the roster-discipline prompt line. Repeats the actual roster
 * ids (retrieval beats recall) plus one negative example naming people
 * who are NOT in this roster — e.g. the model inventing "Anton"/"Tanya"
 * when the roster is different.
 */
export function buildRosterDisciplineLine(rosterIds: string[]): string {
  const ids = rosterIds.length > 0 ? rosterIds.map((id) => `"${id}"`).join(", ") : "(none)";
  const invented = inventedNameExamples(rosterIds).slice(0, 2);
  const badExample =
    invented.length > 0
      ? invented.map((n) => `"${n}"`).join(" or ")
      : `"Nobody"`;
  return (
    `ROSTER DISCIPLINE: the ONLY people who exist are ${ids}. ` +
    `Never name, address, quote, or patch anyone else — ` +
    `writing ${badExample} when it is not in the list above is INVALID (a made-up person). ` +
    // Exp-3 item 1 (M2): the 8B invents people AND places mid-collapse
    // ("Leon", "a stranger", "the cafe", "coffee table" for lounge_table).
    // No new proper noun for a person or place may appear anywhere —
    // every person comes from the ROSTER, every object from OBJECT IDS.
    `Never introduce ANY new proper noun for a person or place — no 'Leon', no 'a stranger', ` +
    `no 'the cafe', no renamed objects. If a name is not in the ROSTER list above, it does not exist.`
  );
}

/**
 * Item C1: retry-feedback roster repeat. Appended to validation feedback
 * when the failure names unknown actors — the model re-reads the real
 * ids instead of recalling them.
 */
export function buildRosterRetryLine(rosterIds: string[]): string {
  const ids = rosterIds.length > 0 ? rosterIds.map((id) => `"${id}"`).join(", ") : "(none)";
  return `ROSTER REPEAT: the ONLY valid actor ids are ${ids} — re-read them, any other name is invented.`;
}

/**
 * Exp-2 item 1: positive-example actors for prompt examples, drawn from
 * the real roster. The static "Anton walks toward Tanya" movement example
 * was copied verbatim by the 8B in exp-2 m1 attempt 2 — for any other
 * roster those names are invented people shown as POSITIVE examples,
 * priming the attractor the discipline line tries to suppress. Returns
 * the first two roster ids (display name = id with the first letter
 * capitalized); empty when the roster is empty so callers can keep the
 * legacy Anton/Tanya examples byte-identical.
 */
export function rosterExampleActors(rosterIds: string[]): Array<{ id: string; name: string }> {
  return rosterIds.slice(0, 2).map((id) => ({
    id,
    name: id.length > 0 ? id[0]!.toUpperCase() + id.slice(1) : id,
  }));
}
