// Unified diagnostics: graphic-UI availability + AI layer checks.
//
// Usage:
//   npm run diagnose              # everything, offline (fast, no network)
//   npm run diagnose -- --live    # + live probes (JoinGonka, laya-serve, Ollama)
//   npm run diagnose -- --ui-only # only the graphic-UI availability checks
//   npm run diagnose -- --ai-only # only the AI layer checks (== diagnose:ai)
//
// Exit code is 1 when any check FAILs, 0 otherwise.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printUiChecks, runUiChecks } from "./diagnose-ui.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Usage: npm run diagnose [-- --live | --ui-only | --ai-only]",
        "  (default)  graphic-UI availability + offline AI checks",
        "  --live     also probe JoinGonka, laya-serve and Ollama over the network",
        "  --ui-only  only graphic-UI availability (sibling npc-simulator-ui + console link)",
        "  --ai-only  only AI layer checks (same as npm run diagnose:ai)",
      ].join("\n"),
    );
    return;
  }

  let fails = 0;

  if (!args.includes("--ai-only")) {
    console.log("== graphic UI availability ==");
    const { fails: uiFails } = printUiChecks(runUiChecks(ROOT));
    fails += uiFails;
    console.log("");
  }

  if (!args.includes("--ui-only")) {
    console.log("== AI layer ==");
    const tsx = join(ROOT, "node_modules", ".bin", "tsx");
    const aiArgs = [join(ROOT, "scripts", "diagnose-ai.ts")];
    if (args.includes("--live")) aiArgs.push("--live");
    if (!existsSync(tsx)) {
      console.log("FAIL  runner — node_modules/.bin/tsx missing, run: npm install");
      fails += 1;
    } else {
      const res = spawnSync(tsx, aiArgs, { cwd: ROOT, stdio: "inherit" });
      if (res.error) {
        console.log(`FAIL  runner — could not run diagnose-ai.ts: ${(res.error as Error).message}`);
        fails += 1;
      } else if ((res.status ?? 1) !== 0) {
        fails += 1;
      }
    }
  }

  if (fails > 0) {
    console.log(`\ndiagnose: ${fails} failing section(s).`);
    process.exitCode = 1;
  } else {
    console.log("\ndiagnose: all green.");
  }
}

main().catch((err) => {
  console.error(`diagnose crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
