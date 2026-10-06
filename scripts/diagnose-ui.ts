// Graphic-UI availability diagnostics: verifies the extracted scene project
// (npc-simulator-ui, sibling checkout) is present and the thin graphic
// console (src/ui/graphic) is correctly linked to it.
//
// Usage:
//   npm run diagnose:ui          # UI checks only
//   npm run diagnose             # unified: UI checks + AI layer checks
//   npm run diagnose -- --ui-only
//
// Exit code is 1 when any check FAILs, 0 otherwise.

import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type UiStatus = "PASS" | "WARN" | "FAIL";
export type UiCheck = { name: string; status: UiStatus; detail: string };

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Run the graphic-UI availability checks against a repo root.
 * Pure filesystem checks (offline, fast) — safe to embed in other runners.
 */
export function runUiChecks(repoRoot: string = ROOT): UiCheck[] {
  const checks: UiCheck[] = [];
  const pass = (name: string, detail = "") => checks.push({ name, status: "PASS", detail });
  const warn = (name: string, detail = "") => checks.push({ name, status: "WARN", detail });
  const fail = (name: string, detail = "") => checks.push({ name, status: "FAIL", detail });

  const sib = join(repoRoot, "..", "npc-simulator-ui");
  const graphic = join(repoRoot, "src", "ui", "graphic");
  const link = join(graphic, "ui-lib");
  const bridge = join(graphic, "js", "scene", "ui.js");
  const bundle = join(graphic, "preview.html");

  // 1. Sibling project -------------------------------------------------------
  if (!isDir(sib)) {
    fail(
      "ui project",
      `missing: ${sib} — check out npc-simulator-ui next to this repo (see src/ui/graphic/README.md)`,
    );
  } else {
    pass("ui project", sib);
  }

  // 2. Sibling package identity ----------------------------------------------
  const pkgFile = join(sib, "package.json");
  if (!isFile(pkgFile)) {
    fail("ui package", `missing ${pkgFile}`);
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf-8")) as { name?: unknown };
      if (pkg.name === "npc-simulator-ui") pass("ui package", "npc-simulator-ui");
      else warn("ui package", `unexpected name "${String(pkg.name)}" in ${pkgFile}`);
    } catch {
      fail("ui package", `${pkgFile} is not valid JSON`);
    }
  }

  // 3. Scene layer files ------------------------------------------------------
  const renderer = join(sib, "js", "render", "sceneRenderer.js");
  const objectsIndex = join(sib, "js", "render", "objects", "index.js");
  const character = join(sib, "js", "render", "character.js");
  const background = join(sib, "js", "render", "background.js");
  const bubble = join(sib, "js", "render", "bubble.js");
  const avatar = join(sib, "js", "render", "avatar.js");
  const sceneData = join(sib, "js", "data", "scenes", "officeFloor3.js");
  const sceneRegistry = join(sib, "js", "data", "scenes", "index.js");
  const missingCore = [renderer, objectsIndex, character, background, bubble, sceneData, sceneRegistry].filter(
    (f) => !isFile(f),
  );
  if (missingCore.length > 0) {
    fail("ui scene layer", `missing: ${missingCore.map((f) => f.replace(sib + "/", "")).join(", ")}`);
  } else {
    let painters = 0;
    try {
      painters = readdirSync(join(sib, "js", "render", "objects")).filter(
        (f) => f.endsWith(".js") && f !== "index.js" && f !== "direction.js",
      ).length;
    } catch {
      painters = 0;
    }
    const extra = isFile(avatar) ? "" : " (avatar.js missing)";
    pass("ui scene layer", `renderer + ${painters} object painters + office scene${extra}`);
  }

  // 4. Standalone pages --------------------------------------------------------
  const showcase = join(sib, "showcase.html");
  const scenePage = join(sib, "scene.html");
  const missingPages = [showcase, scenePage].filter((f) => !isFile(f));
  if (missingPages.length > 0) {
    fail("ui pages", `missing: ${missingPages.map((f) => f.replace(sib + "/", "")).join(", ")}`);
  } else {
    pass("ui pages", "showcase.html + scene.html serve via `npm start` in npc-simulator-ui");
  }

  // 5. Console link ------------------------------------------------------------
  if (!existsSync(link)) {
    fail("console ui-lib link", `missing: ${link} — recreate it: ln -s ../../../../npc-simulator-ui ${link}`);
  } else if (!isDir(link)) {
    fail("console ui-lib link", `${link} dangles — the sibling npc-simulator-ui checkout is missing`);
  } else {
    try {
      const target = realpathSync(link);
      const expected = realpathSync(sib);
      if (target === expected) pass("console ui-lib link", `ui-lib/ → sibling npc-simulator-ui`);
      else warn("console ui-lib link", `ui-lib/ points at ${target} (expected ${expected})`);
    } catch {
      fail("console ui-lib link", `${link} cannot be resolved`);
    }
    try {
      readlinkSync(link);
    } catch {
      warn("console ui-lib link", `${link} is not a symlink (works, but prefer a symlink — see README)`);
    }
  }

  // 6. Console bridge -----------------------------------------------------------
  if (!isFile(bridge)) {
    fail("console scene bridge", `missing: ${bridge} — the console cannot import SceneRenderer`);
  } else {
    pass("console scene bridge", "js/scene/ui.js re-exports the scene layer");
  }

  // 7. Generated console bundle --------------------------------------------------
  if (!isFile(bundle)) {
    warn("console preview bundle", "preview.html missing — regenerate: npm run bundle:graphic");
  } else {
    try {
      const sizeKb = statSync(bundle).size / 1024;
      if (sizeKb < 10) warn("console preview bundle", `preview.html suspiciously small (${sizeKb.toFixed(1)} KB) — regenerate: npm run bundle:graphic`);
      else pass("console preview bundle", `preview.html (${sizeKb.toFixed(1)} KB)`);
    } catch {
      warn("console preview bundle", "preview.html unreadable — regenerate: npm run bundle:graphic");
    }
  }

  return checks;
}

export function printUiChecks(checks: UiCheck[]): { fails: number; warns: number } {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const detail = c.detail ? ` — ${c.detail}` : "";
    console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(width)}${detail}`);
  }
  const fails = checks.filter((c) => c.status === "FAIL").length;
  const warns = checks.filter((c) => c.status === "WARN").length;
  console.log(`\n${checks.length - fails - warns} passed, ${warns} warnings, ${fails} failures.`);
  return { fails, warns };
}

const isMain = process.argv[1] !== undefined && /diagnose-ui(\.ts|\.js)$/.test(process.argv[1]);
if (isMain) {
  console.log("graphic UI availability");
  const { fails } = printUiChecks(runUiChecks());
  if (fails > 0) {
    console.log("Fix: check out npc-simulator-ui next to this repo, then re-run.");
    process.exitCode = 1;
  }
}
