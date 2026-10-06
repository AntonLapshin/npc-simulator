// sim/textParse.js — free-form action text helpers shared by adapters and
// the live view state. The engine treats actions as free text; the UI needs
// a best-effort way to recover quoted speech for bubbles.

/** Extract the first quoted segment ("…" or “…” or '…') from action text. */
export function extractQuoted(text) {
  if (typeof text !== "string") return null;
  const m =
    text.match(/“([^”]+)”/) ||
    text.match(/"([^"]+)"/) ||
    text.match(/'([^']{2,})'/);
  return m ? m[1].trim() : null;
}

/** True when the text reads like explicit speech ("says …", "tells …"). */
export function looksLikeSpeech(text) {
  return /\b(says?|tells?|asks?|replies?|answers?|shouts?|whispers?|mumbles?|mutters?|calls out)\b/i.test(
    String(text || ""),
  );
}

/** True when the text reads like an inner thought ("thinks …"). */
export function looksLikeThought(text) {
  return /\b(thinks?|wonders?|muses?|reali[sz]es?)\b/i.test(String(text || ""));
}

/**
 * Best-effort speech parse of a history/action line:
 *   'Maya: walks over and says "Hi!"' → { text: 'Hi!', kind: 'say' }
 *   'Noah: thinks "maybe later"'       → { text: 'maybe later', kind: 'thought' }
 * Returns null when the line has no utterance.
 */
export function parseSpeechFromAction(text) {
  const quoted = extractQuoted(text);
  if (!quoted) return null;
  return { text: quoted, kind: looksLikeThought(text) ? "thought" : "say" };
}
