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
  throw new Error("truncated or unbalanced JSON in LLM response");
}

/** Extract and parse a JSON object from raw LLM text. */
export function parseJsonObject<T = unknown>(raw: string): T {
  return JSON.parse(extractJsonPayload(raw)) as T;
}

/** Repair prompt appended after a parse failure (§16.3 formatting retry). */
export function formatRepairPrompt(raw: string, error: string): string {
  return [
    "Your previous response was not valid JSON.",
    `Parse error: ${error}`,
    "Return ONLY the corrected JSON object now.",
    "Do not include markdown, commentary, or extra text.",
    "Previous invalid response:",
    raw,
  ].join("\n");
}
