// AI setup diagnostics: verifies the LLM layer is installed and configured.
//
// Usage:
//   npm run diagnose:ai            # offline checks (fast, no network)
//   npm run diagnose:ai:live      # + live probes against JoinGonka and laya-serve
//
// Exit code is 1 when any check FAILs, 0 otherwise. Secrets are never printed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "../src/types.js";
import {
  createLlmEngines,
  createProviderFromEnv,
  extractJsonPayload,
  resolveLlmEnv,
  type LLMProvider,
} from "../src/llm/index.js";
import { createTestLogger } from "../src/logging/logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--live");

type Status = "PASS" | "WARN" | "FAIL";
type Check = { name: string; status: Status; detail: string };

const checks: Check[] = [];
const pass = (name: string, detail = "") => checks.push({ name, status: "PASS", detail });
const warn = (name: string, detail = "") => checks.push({ name, status: "WARN", detail });
const fail = (name: string, detail = "") => checks.push({ name, status: "FAIL", detail });

// Load .env (if present) without overriding real environment variables.
function loadDotEnv(): boolean {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

function run(cmd: string, args: string[], timeoutMs = 30_000): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, out };
  } catch {
    return { ok: false, out: "" };
  }
}

function findPython(): string | undefined {
  const venvPy = join(ROOT, ".laya-venv", "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  if (process.env["LAYA_PYTHON"]) return process.env["LAYA_PYTHON"];
  return run("python3", ["--version"]).ok ? "python3" : undefined;
}

async function probeHttp(url: string, init?: RequestInit, timeoutMs = 8_000): Promise<number | undefined> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const dotEnv = loadDotEnv();
  const cfg = resolveLlmEnv();
  const layaLocal = cfg.backend === "laya-local";
  // Local-Laya findings are WARN when hosted is the active backend (local
  // decisions simply unused), and FAIL when laya-local is selected.
  const localSeverity = (name: string, detail: string) =>
    layaLocal ? fail(name, detail) : warn(name, detail);

  // 1. Runtime -------------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) pass("node", `v${process.versions.node} (>= 20 required)`);
  else fail("node", `v${process.versions.node} — Node.js 20+ is required`);

  if (existsSync(join(ROOT, "node_modules", "zod"))) pass("dependencies", "node_modules installed");
  else fail("dependencies", "node_modules missing — run: npm install");

  if (dotEnv) pass(".env", "loaded from project root");
  else warn(".env", "not found — copy it: cp .env.example .env");

  // 2. Backend selection ----------------------------------------------------
  const rawBackend = process.env["LLM_BACKEND"];
  if (!rawBackend) pass("LLM_BACKEND", `unset, defaulting to "${cfg.backend}"`);
  else if (rawBackend === "joingonka" || rawBackend === "laya-local") pass("LLM_BACKEND", `"${cfg.backend}"`);
  else warn("LLM_BACKEND", `unknown value "${rawBackend}" — falling back to "${cfg.backend}"`);

  // 3. Hosted provider (JoinGonka) ------------------------------------------
  if (cfg.joingonka.apiKey) {
    try {
      createProviderFromEnv(process.env, "joingonka");
      pass("joingonka config", `key set; model "${cfg.joingonka.model}" @ ${cfg.joingonka.baseUrl}`);
    } catch (err) {
      fail("joingonka config", err instanceof Error ? err.message : String(err));
    }
  } else if (layaLocal) {
    warn("joingonka config", "JOINGONKA_API_KEY not set (not needed while LLM_BACKEND=laya-local)");
  } else {
    fail("joingonka config", "JOINGONKA_API_KEY is not set — get one at https://gate.joingonka.ai/dashboard");
  }

  // 4. Numeric tuning values --------------------------------------------------
  const numerics: Array<[string, number, (n: number) => boolean]> = [
    ["LLM_TIMEOUT_MS", cfg.timeoutMs, (n) => Number.isFinite(n) && n > 0],
    ["LLM_TEMPERATURE", cfg.temperature, (n) => Number.isFinite(n) && n >= 0],
    ["LLM_MAX_TOKENS", cfg.maxTokens, (n) => Number.isFinite(n) && n > 0],
  ];
  const badNumerics = numerics.filter(([key, value, valid]) => process.env[key] !== undefined && !valid(value));
  if (badNumerics.length === 0) {
    pass("tuning", `timeout=${cfg.timeoutMs}ms temperature=${cfg.temperature} maxTokens=${cfg.maxTokens}`);
  } else {
    warn("tuning", `ignoring invalid: ${badNumerics.map(([k]) => k).join(", ")}`);
  }

  // 5. Local Laya installation ------------------------------------------------
  const python = findPython();
  if (!python) {
    localSeverity("python", "python3 not found — install Python 3.10+ or run: npm run setup:laya");
  } else {
    const ver = run(python, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"]);
    const [pyMajor = 0, pyMinor = 0] = ver.out.split(".").map(Number);
    if (ver.ok && (pyMajor > 3 || (pyMajor === 3 && pyMinor >= 10))) pass("python", `${ver.out} (${python})`);
    else localSeverity("python", `${ver.out || "unknown"} — Python 3.10+ is required for laya`);
  }

  let layaVersion = "";
  if (python) {
    const mod = run(python, ["-c", "import laya; print(getattr(laya, '__version__', 'unknown'))"], 60_000);
    if (mod.ok) {
      layaVersion = mod.out;
      pass("laya package", `v${layaVersion} importable`);
    } else {
      localSeverity("laya package", "`import laya` failed — run: npm run setup:laya");
    }
  }

  const serveBin = existsSync(join(ROOT, ".laya-venv", "bin", "laya-serve"))
    ? join(ROOT, ".laya-venv", "bin", "laya-serve")
    : run("laya-serve", ["--help"]).ok
      ? "laya-serve (PATH)"
      : undefined;
  if (serveBin) pass("laya-serve", `found: ${serveBin}`);
  else localSeverity("laya-serve", "binary not found — run: npm run setup:laya");

  const hfCache = join(homedir(), ".cache", "huggingface", "hub", "models--convaiinnovations--laya");
  if (existsSync(hfCache)) pass("laya checkpoint", `cached at ${hfCache}`);
  else localSeverity("laya checkpoint", "convaiinnovations/laya not in HF cache — setup downloads it (~808 MB)");

  // 6. Local server reachability (offline: any HTTP status means "up") --------
  const serveUrl = (process.env["LAYA_SERVE_URL"] ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const probePaths = [`${serveUrl}/v1/systemone`, `${serveUrl}/`];
  let upStatus: number | undefined;
  for (const url of probePaths) {
    upStatus = await probeHttp(url);
    if (upStatus !== undefined) break;
  }
  if (upStatus !== undefined) {
    pass("laya-serve reachable", `${serveUrl} answered HTTP ${upStatus}`);
  } else {
    localSeverity("laya-serve reachable", `${serveUrl} refused connection — start it: npm run serve:laya`);
  }

  // 7. Engine wiring (offline, stub provider) ----------------------------------
  try {
    const stub: LLMProvider = {
      name: "diagnose-stub",
      complete: async () => JSON.stringify({ action: "Stay where you are.", reasoning: "diagnose" }),
    };
    const logger = createTestLogger("diagnose");
    // Stub all three engines so this check never needs credentials or network.
    const engines = createLlmEngines(logger, {
      providers: { proposal: stub, selection: stub, consequence: stub },
    });
    const world: World = {
      version: 1,
      id: "diagnose",
      title: "Diagnose",
      narrative: "Diagnostics world.",
      userActorId: "u",
      order: ["u"],
      tick: 0,
      turnIndex: 0,
      history: [],
      scene: { width: 5, height: 5, objects: [] },
      actors: [
        {
          id: "u", name: "U", persona: "Diagnostics persona.", x: 1, y: 1,
          state: "standing", emotion: "calm", goal: "Verify wiring.",
          memories: [], beliefs: [], relationships: [],
        },
      ],
    };
    const selection = await engines.selectionEngine.select(world, "u", ["Do nothing."]);
    if (selection.action !== "Stay where you are.") throw new Error("unexpected stub action");
    const parsed = extractJsonPayload('```json\n{"ok": true}\n```') as string;
    if (parsed !== '{"ok": true}') throw new Error("JSON extraction broken");
    void layaVersion;
    pass("engine wiring", "selection engine + JSON utilities work (stub provider)");
  } catch (err) {
    fail("engine wiring", err instanceof Error ? err.message : String(err));
  }

  // 8. Live probes -------------------------------------------------------------
  if (LIVE) {
    if (cfg.joingonka.apiKey) {
      const status = await probeHttp(`${cfg.joingonka.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${cfg.joingonka.apiKey}` },
      }, 15_000);
      if (status === 200) pass("joingonka live", "gateway answered /models (key accepted)");
      else if (status === 401 || status === 403) fail("joingonka live", `HTTP ${status} — API key rejected`);
      else if (status !== undefined) fail("joingonka live", `unexpected HTTP ${status} from gateway`);
      else fail("joingonka live", "no response — network or gateway unreachable");
    } else {
      warn("joingonka live", "skipped — JOINGONKA_API_KEY not set");
    }

    const liveBody = {
      state: { document: "diagnose ping" },
      questions: { ping: { type: "noul", instructions: "Is this a diagnostics ping?" } },
    };
    const status = await probeHttp(`${serveUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(liveBody),
    }, 60_000);
    if (status === 200) pass("laya live", "server answered a decisions request");
    else if (status !== undefined) warn("laya live", `server is up but answered HTTP ${status} for the probe payload`);
    else if (layaLocal) fail("laya live", "server unreachable and LLM_BACKEND=laya-local");
    else warn("laya live", "server unreachable (ok while hosted backend is active)");
  }

  // Report ----------------------------------------------------------------------
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const detail = c.detail ? ` — ${c.detail}` : "";
    console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(width)}${detail}`);
  }
  const fails = checks.filter((c) => c.status === "FAIL").length;
  const warns = checks.filter((c) => c.status === "WARN").length;
  console.log(`\n${checks.length - fails - warns} passed, ${warns} warnings, ${fails} failures.`);
  if (fails > 0) {
    console.log("Fix: npm run setup:laya  →  cp .env.example .env (add keys)  →  npm run serve:laya");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`diagnose crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
