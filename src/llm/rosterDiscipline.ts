// Roster-discipline prompt helpers (exp local-8b item C1).
//
// Small models invent roster members ("Anton"/"Tanya" attractors in the
// local-8b experiment) even with a ROSTER RULE present. Repeating the
// actual ids inline (retrieval beats recall) plus one concrete negative
// example of invented names lowers the invention base rate. Pure.

/** Negative-example names, filtered to ones absent from the given roster. */
function inventedNameExamples(rosterIds: string[]): string[] {
  const known = new Set(rosterIds.map((id) => id.toLowerCase()));
  return ["Anton", "Tanya", "Liam", "John"].filter((n) => !known.has(n.toLowerCase()));
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
    `When in doubt, re-read the list: if a name is not there, it does not exist.`
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
