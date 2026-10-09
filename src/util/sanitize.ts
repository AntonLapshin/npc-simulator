/**
 * Exp-7 items A10/T3: sanitize text for user-facing display and for
 * re-ingestion into prompts.
 *
 * Drops:
 * - Unicode noncharacters (U+FDD0-U+FDEF and the U+FFFE/U+FFFF of every
 *   plane) - including NOT_DONE_SENTINEL (U+10FFFF). The sentinel is a
 *   machine marker for fallback detection (F22); it must never render as
 *   garbage at the end of "(not done)" lines (T3) or leak into prompts
 *   where it contributes to echo attractors (B2).
 * - C0/C1 control codes (except LF and TAB), which models occasionally
 *   emit inside narratives.
 *
 * Stored history/log entries keep the sentinel (machine detection reads
 * the stored text); only the display/prompt rendering is stripped.
 * Pure.
 */
export function sanitizeDisplayText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x1f && cp !== 0x0a && cp !== 0x09) continue;
    if (cp >= 0x7f && cp <= 0x9f) continue;
    if (cp >= 0xfdd0 && cp <= 0xfdef) continue;
    if (cp >= 0xfffe && (cp & 0xffff) >= 0xfffe) continue;
    out += ch;
  }
  return out;
}
