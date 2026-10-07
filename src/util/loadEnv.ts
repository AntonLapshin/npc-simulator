// Minimal .env loader (no dependency on dotenv).
//
// Reads `<repoRoot>/.env` line-by-line (`KEY=value`, `#` comments,
// optional surrounding quotes) and copies entries into `process.env`
// WITHOUT overriding variables that are already set. Returns true when a
// file was found and processed.
//
// Previously copy-pasted in src/ui/graphic/server.ts, src/ui/text/textUi.ts
// and scripts/diagnose-ai.ts; behavior is unchanged.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadEnvFile(repoRoot: string): boolean {
  const file = join(repoRoot, ".env");
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}
