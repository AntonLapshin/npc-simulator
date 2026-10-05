// Robust JSON extraction for LLM outputs (Milestone 2, §16.3-16.4).
//
// Real LLMs often wrap JSON in markdown fences or add surrounding prose.
// This module isolates all parsing so the engines stay small. It never
// judges content — only JSON validity.

/** Strip markdown code fences and extract the JSON payload from raw text. */
export function extractJsonPayload(raw: string): string {
  let text = raw.trim();
  if (text.length === 0) throw new Error("empty LLM response");

  // Remove ```json ... ``` or ``` ... ``` fences (take the first block).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  // Fast path: whole payload is JSON.
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return text;
    } catch {
      // Fall through to brace scanning below.
    }
  }

  // Scan for the first balanced {...} object (handles leading/trailing prose).
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in LLM response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        JSON.parse(candidate); // throws with position info on failure
        return candidate;
      }
    }
  }
  // No balanced close found — the model was likely cut off by max_tokens
  // (pretty-printed multi-line JSON is the usual victim). Attempt a
  // best-effort repair: close the open string, then close open
  // arrays/objects. Succeeds for truncated tail output; throws the original
  // error when the head itself is corrupt.
  const repaired = tryCloseTruncatedJson(text.slice(start));
  if (repaired !== undefined) return repaired;
  throw new Error("truncated or unbalanced JSON in LLM response");
}

/**
 * Best-effort repair for max_tokens-truncated JSON: terminate the open
 * string (if any), drop a trailing partial token (e.g. `"reasoning": "To
 * gauge...` with no close), then append the missing `"]}` closers.
 * Returns the repaired payload when it parses, else undefined.
 */
function tryCloseTruncatedJson(fragment: string): string | undefined {
  let text = fragment.trim();
  if (!text.startsWith("{")) return undefined;
  // Drop a trailing partial string value: `... "key": "unterminated`
  // -> `... "key": ""`. Only when the tail has an odd (unclosed) quote.
  let inString = false;
  let escaped = false;
  let lastQuoteIndex = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastQuoteIndex = -1;
      }
    } else if (ch === '"') {
      inString = true;
      lastQuoteIndex = i;
    }
  }
  if (inString && lastQuoteIndex >= 0) {
    // Close the dangling string. If it looks like a partial value after a
    // colon (no closing quote at all), just terminate it.
    text = `${text}"`;
  }
  // Re-scan to count unclosed braces/brackets (strings now balanced).
  let depth = 0;
  let brackets = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
  }
  if (inString) return undefined; // still unbalanced despite close attempt
  // Strip a trailing comma before closing (`{...,"key": ...,`).
  text = text.replace(/,\s*$/, "");
  // Close open arrays then objects. A trailing `:` or dangling key without
  // a value cannot be repaired — give up in that case.
  if (/[{:,]\s*$/.test(text) && !text.endsWith('"') && !/[\]}0-9]$/.test(text)) {
    // Tail ends mid-token (e.g. `"reasoning": "To gauge`) — drop back to
    // the last complete `",` boundary and retry once.
    const cut = text.lastIndexOf('",');
    if (cut > 0) {
      text = text.slice(0, cut + 1);
      return tryCloseTruncatedJson(text);
    }
    return undefined;
  }
  const candidate = `${text}${"]".repeat(Math.max(0, brackets))}${"}".repeat(Math.max(0, depth))}`;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/** Extract and parse a JSON object from raw LLM text. */
export function parseJsonObject<T = unknown>(raw: string): T {
  return JSON.parse(extractJsonPayload(raw)) as T;
}

/** Repair prompt appended after a parse failure (§16.3 formatting retry). */
export function formatRepairPrompt(raw: string, error: string): string {
  // Cap the echoed response: full verbose dumps (e.g. wall-by-wall patches)
  // bloat the retry prompt and make a second truncation more likely.
  const clipped = raw.length > 2000 ? `${raw.slice(0, 2000)}\n…(truncated)` : raw;
  return [
    "Your previous response was not valid JSON.",
    `Parse error: ${error}`,
    "Return ONLY the corrected JSON object now.",
    "Return COMPACT single-line JSON (no pretty-print, no markdown). Keep strings short; include ONLY affected actors/objects.",
    "Do not include markdown, commentary, or extra text.",
    "Previous invalid response:",
    clipped,
  ].join("\n");
}
