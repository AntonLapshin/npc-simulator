// AI setup diagnostics: verifies the LLM layer is installed and configured.
//
// Usage:
//   npm run diagnose:ai            # offline checks (fast, no network)
//   npm run diagnose:ai:live      # + live probes against JoinGonka and laya-serve
//
// Exit code is 1 when any check FAILs, 0 otherwise. Secrets are never printed.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "../src/types.js";
import {
  createLlmEngines,
  createProviderFromEnv,
  defaultTimeoutMsFor,
  extractJsonPayload,
  isThinkingModel,
  ollamaApiRoot,
  OllamaProvider,
  readModelLatencyMs,
  recordModelLatencyMs,
  resolveLlmEnv,
  resolveTaskModel,
  type LLMProvider,
} from "../src/llm/index.js";
import { createTestLogger } from "../src/logging/logger.js";
import { loadEnvFile } from "../src/util/loadEnv.js";
import { LayaClient, LayaUnavailableError } from "../src/decision/layaClient.js";

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
  return loadEnvFile(ROOT);
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

async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const dotEnv = loadDotEnv();
  const cfg = resolveLlmEnv();
  const layaLocal = cfg.backend === "laya-local";
  const ollamaActive = cfg.backend === "ollama";
  // Local-Laya findings are WARN when hosted is the active backend (local
  // decisions simply unused), and FAIL when laya-local is selected.
  const localSeverity = (name: string, detail: string) =>
    layaLocal ? fail(name, detail) : warn(name, detail);
  // Same rule for Ollama: missing server/models only FAIL when
  // LLM_BACKEND=ollama, otherwise WARN.
  const ollamaSeverity = (name: string, detail: string) =>
    ollamaActive ? fail(name, detail) : warn(name, detail);

  // 1. Runtime -------------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) pass("node", `v${process.versions.node} (>= 20 required)`);
  else fail("node", `v${process.versions.node} — Node.js 20+ is required`);

  if (existsSync(join(ROOT, "node_modules", "zod"))) pass("dependencies", "node_modules installed");
  else fail("dependencies", "node_modules missing — run: npm install");

  if (dotEnv) pass(".env", "loaded from project root");
  else warn(".env", "not found — copy it: cp .env.example .env");

  // 2. Backend selection (tiered: hard vs simple) -----------------------------
  const rawBackend = process.env["LLM_BACKEND"];
  if (!rawBackend) pass("LLM_BACKEND", `unset, hard tasks default to "${cfg.backend}"`);
  else if (rawBackend === "joingonka" || rawBackend === "laya-local" || rawBackend === "ollama")
    pass("LLM_BACKEND", `hard tasks on "${cfg.backend}"`);
  else warn("LLM_BACKEND", `unknown value "${rawBackend}" — falling back to "${cfg.backend}"`);
  const rawSimple = process.env["LLM_SIMPLE_BACKEND"];
  if (!rawSimple) pass("LLM_SIMPLE_BACKEND", `unset, simple tasks (selection/semantic) default to "${cfg.simpleBackend}"`);
  else if (rawSimple === "joingonka" || rawSimple === "laya-local" || rawSimple === "ollama")
    pass("LLM_SIMPLE_BACKEND", `simple tasks (selection/semantic) on "${cfg.simpleBackend}"${cfg.simpleModel ? ` model "${cfg.simpleModel}"` : ""}`);
  else warn("LLM_SIMPLE_BACKEND", `unknown value "${rawSimple}" — falling back to "${cfg.simpleBackend}"`);
  const taskOverrides = (Object.entries(cfg.taskBackends) as Array<[string, string]>)
    .map(([t, b]) => `${t}=${b}`)
    .join(", ");
  if (taskOverrides) pass("LLM_BACKEND_* overrides", taskOverrides);
  else pass("LLM_BACKEND_* overrides", "none (tier defaults apply)");

  // 3. Hosted provider (JoinGonka) ------------------------------------------
  if (cfg.joingonka.apiKey) {
    try {
      createProviderFromEnv(process.env, "joingonka");
      pass("joingonka config", `key set; model "${cfg.joingonka.model}" @ ${cfg.joingonka.baseUrl}`);
    } catch (err) {
      fail("joingonka config", err instanceof Error ? err.message : String(err));
    }
  } else if (layaLocal || ollamaActive) {
    warn("joingonka config", `JOINGONKA_API_KEY not set (not needed while LLM_BACKEND=${cfg.backend})`);
  } else {
    fail("joingonka config", "JOINGONKA_API_KEY is not set — get one at https://gate.joingonka.ai/dashboard");
  }

  // 4. Numeric tuning values --------------------------------------------------
  const numerics: Array<[string, number, (n: number) => boolean]> = [
    ["LLM_TIMEOUT_MS", cfg.timeoutMs, (n) => Number.isFinite(n) && n > 0],
    ["LLM_TEMPERATURE", cfg.temperature, (n) => Number.isFinite(n) && n >= 0],
    ["LLM_REPEAT_PENALTY", cfg.repeatPenalty, (n) => Number.isFinite(n) && n >= 1.0 && n <= 2.0],
    ["LLM_MAX_TOKENS", cfg.maxTokens, (n) => Number.isFinite(n) && n > 0],
  ];
  const badNumerics = numerics.filter(([key, value, valid]) => process.env[key] !== undefined && !valid(value));
  if (badNumerics.length === 0) {
    pass("tuning", `timeout=${cfg.timeoutMs}ms temperature=${cfg.temperature} repeat_penalty=${cfg.repeatPenalty} maxTokens=${cfg.maxTokens}`);
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

  // 6b. Ollama installation / server / models ----------------------------------
  try {
    createProviderFromEnv(process.env, "ollama");
    pass("ollama config", `model "${cfg.ollama.model}" @ ${cfg.ollama.baseUrl}`);
  } catch (err) {
    ollamaSeverity("ollama config", err instanceof Error ? err.message : String(err));
  }

  const ollamaBin = run("ollama", ["--version"]);
  if (ollamaBin.ok) pass("ollama binary", ollamaBin.out.split("\n")[0] ?? "ollama found");
  else ollamaSeverity("ollama binary", "ollama not on PATH — run: npm run setup:ollama");

  const ollamaRoot = ollamaApiRoot(cfg.ollama.baseUrl);
  const tagsData = await fetchJson(`${ollamaRoot}/api/tags`);
  const tagModels: string[] = Array.isArray((tagsData as { models?: unknown })?.models)
    ? ((tagsData as { models: Array<{ name?: unknown }> }).models
        .map((m) => (typeof m.name === "string" ? m.name : ""))
        .filter(Boolean))
    : [];
  if (tagsData !== undefined) {
    pass("ollama reachable", `${ollamaRoot} answered /api/tags (${tagModels.length} model${tagModels.length === 1 ? "" : "s"})`);
  } else {
    ollamaSeverity("ollama reachable", `${ollamaRoot} refused connection — start it: ollama serve (or npm run setup:ollama)`);
  }

  if (tagsData !== undefined) {
    const norm = (s: string) => s.toLowerCase();
    const present = new Set(tagModels.map(norm));
    const baseName = (ref: string) => ref.split("/").pop() ?? ref;
    const matches = (ref: string) =>
      present.has(norm(ref)) ||
      [...present].some((p) => p === norm(baseName(ref)) || p.startsWith(`${norm(ref)}:`) || norm(ref).startsWith(`${p.split(":")[0]}:`));
    const missing = OllamaProvider.RECOMMENDED_MODELS.filter((m) => !matches(m));
    const configuredOk = matches(cfg.ollama.model);
    if (missing.length === 0) {
      pass("ollama models", `all recommended models present (${tagModels.join(", ")})`);
    } else if (!configuredOk) {
      ollamaSeverity(
        "ollama models",
        `configured OLLAMA_MODEL "${cfg.ollama.model}" not pulled — run: npm run setup:ollama (missing: ${missing.join(", ")})`,
      );
    } else {
      // Configured model works; the other recommended one is just absent.
      warn("ollama models", `configured "${cfg.ollama.model}" present; also recommended: ${missing.join(", ")} — run: npm run setup:ollama`);
    }
  } else {
    ollamaSeverity("ollama models", "unknown — server unreachable, run: npm run setup:ollama");
  }

  // 6c. Thinking-model overhead (offline) --------------------------------------
  // Exp-6 item 3: thinking-class models burn completion tokens on
  // chain-of-thought (exp-6: median 772 completion tokens for ~100-token
  // JSON). Flag it loudly when thinking is left on.
  {
    const hardBackend = cfg.taskBackends.proposal ?? cfg.backend;
    const hardModel = resolveTaskModel("proposal", cfg);
    const thinkEnv = process.env["LLM_THINK"];
    const thinkOff = thinkEnv === "0" || thinkEnv?.toLowerCase() === "false";
    if (isThinkingModel(hardModel) && !thinkOff) {
      warn(
        "thinking overhead",
        `"${hardModel}" is a thinking model and LLM_THINK is not 0 — every call pays ` +
          `hundreds of <think> tokens against max_tokens (exp-6: a flat 1500 budget truncated JSON). ` +
          `Set LLM_THINK=0 to disable chain-of-thought (Ollama honors think:false), or raise ` +
          `LLM_MAX_TOKENS_CONSEQUENCE / LLM_MAX_TOKENS_PROPOSAL`,
      );
    } else if (isThinkingModel(hardModel) && thinkOff) {
      pass("thinking overhead", `LLM_THINK=0 — chain-of-thought disabled for "${hardModel}"`);
    }
  }

  // 6d. GPU offload state (offline, needs the ollama binary) --------------------
  // Exp-6 S1: qwen3:14b sat half in VRAM (7.8/16 GB) with llama-server at
  // ~355% CPU — `ollama ps` is the ground truth for what actually
  // offloaded. Anything under 100% GPU on a 16 GB card for a 9.3 GB model
  // is a configuration problem, not a hardware one.
  if (ollamaBin.ok) {
    const ps = run("ollama", ["ps"]);
    if (ps.ok && ps.out.length > 0) {
      const lines = ps.out.split("\n").slice(1).filter((l) => l.trim().length > 0);
      const configured = cfg.ollama.model.toLowerCase();
      const hit = lines.find((l) => l.toLowerCase().includes(configured.split(":")[0] ?? ""));
      if (hit) {
        const gpuMatch = /(\d+)%\s*GPU/i.exec(hit);
        const pct = gpuMatch ? Number(gpuMatch[1]) : NaN;
        if (Number.isFinite(pct) && pct < 100) {
          warn(
            "gpu offload",
            `"${cfg.ollama.model}" is at ${pct}% GPU — for full VRAM offload unload other ` +
              `models (ollama stop <model>), set OLLAMA_NUM_PARALLEL=1, and use the tuned ` +
              `variant (PARAMETER num_gpu 999 — see scripts/setup-ollama.sh)`,
          );
        } else if (Number.isFinite(pct)) {
          pass("gpu offload", `"${cfg.ollama.model}" at 100% GPU`);
        } else {
          warn("gpu offload", `could not parse \`ollama ps\` output: ${hit.slice(0, 100)}`);
        }
      } else {
        pass("gpu offload", `no model currently loaded (idle) — check again mid-run with: ollama ps`);
      }
    }
  }

  // 7. Engine wiring (offline, stub provider) ----------------------------------
  try {
    const stub: LLMProvider = {
      name: "diagnose-stub",
      complete: async () => JSON.stringify({ action: "Stay where you are.", reasoning: "diagnose" }),
    };
    const logger = createTestLogger("diagnose");
    // Stub all engines so this check never needs credentials or network.
    const engines = createLlmEngines(logger, {
      providers: { proposal: stub, selection: stub, consequence: stub, semantic: stub },
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

    // Real 2-option choice probe through the typed LayaClient: asserts a sane
    // answer shape (winner is one of the options, probabilities sum ~1).
    try {
      const client = new LayaClient({ baseUrl: serveUrl, timeoutMs: 60_000 });
      const options = ["diagnostics ping", "real user traffic"];
      const answers = await client.decide("diagnose ping", {
        ping: {
          type: "choice",
          instructions: "What kind of request is this?",
          options,
        },
      });
      const answer = answers["ping"];
      if (!answer || answer.type !== "choice") throw new Error("missing choice answer");
      if (!options.includes(answer.winner)) {
        throw new Error(`winner "${answer.winner}" not among options`);
      }
      const total = options.reduce((s, o) => s + (answer.probabilities[o] ?? 0), 0);
      if (!(total > 0.9 && total < 1.1)) {
        throw new Error(`probabilities sum to ${total.toFixed(3)}, expected ~1`);
      }
      pass(
        "laya live",
        `choice probe ok: winner="${answer.winner}" p=${(answer.probabilities[answer.winner] ?? 0).toFixed(2)}`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof LayaUnavailableError) {
        if (layaLocal) fail("laya live", `${detail} and LLM_BACKEND=laya-local`);
        else warn("laya live", `${detail} (ok while hosted backend is active)`);
      } else {
        warn("laya live", `probe shape assertion failed: ${detail}`);
      }
    }

    const ollamaModelsUrl = `${cfg.ollama.baseUrl.replace(/\/+$/, "")}/models`;
    const ollamaStatus = await probeHttp(ollamaModelsUrl, undefined, 15_000);
    if (ollamaStatus === 200) {
      const data = await fetchJson(ollamaModelsUrl, 15_000) as { data?: Array<{ id?: string }> } | undefined;
      const ids = Array.isArray(data?.data) ? data.data.map((d) => d.id).filter(Boolean) : [];
      const hasConfigured = ids.some((id) => id === cfg.ollama.model);
      if (hasConfigured || ids.length === 0) pass("ollama live", `OpenAI endpoint answered /models (${ids.length} model${ids.length === 1 ? "" : "s"} listed)`);
      else if (ids.length > 0) warn("ollama live", `server is up but "${cfg.ollama.model}" not in /models [${ids.join(", ")}] — run: npm run setup:ollama`);
      else pass("ollama live", "server answered /models");
    } else if (ollamaStatus !== undefined) {
      if (ollamaActive) fail("ollama live", `unexpected HTTP ${ollamaStatus} from Ollama endpoint`);
      else warn("ollama live", `Ollama endpoint answered HTTP ${ollamaStatus}`);
    } else if (ollamaActive) fail("ollama live", "server unreachable and LLM_BACKEND=ollama — run: npm run setup:ollama");
    else warn("ollama live", "server unreachable (ok while another backend is active)");
  }

    // Exp-6 item 6: per-model latency probe. Times 3 tiny completions
    // against the hard-tier LOCAL model, records the median to the
    // latency cache, and prints the derived default timeout. Hosted
    // backends are skipped (don't burn hosted tokens on telemetry).
    {
      const hardBackend = cfg.taskBackends.proposal ?? cfg.backend;
      const hardModel = resolveTaskModel("proposal", cfg);
      if (hardBackend === "ollama" || hardBackend === "laya-local") {
        try {
          const provider = createProviderFromEnv(process.env, hardBackend);
          const samples: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = Date.now();
            await provider.complete(
              "Reply with exactly: ok",
              "Reply with exactly: ok",
            );
            samples.push(Date.now() - t0);
          }
          samples.sort((a, b) => a - b);
          const median = samples[1] ?? samples[0] ?? 0;
          if (median > 0) {
            recordModelLatencyMs(hardBackend, hardModel, median);
            const suggested = defaultTimeoutMsFor(hardBackend, hardModel, undefined);
            const prev = readModelLatencyMs(hardBackend, hardModel);
            pass(
              "model latency",
              `"${hardModel}" median ${median}ms over 3 tiny probes (recorded, n=${prev !== undefined ? "updated" : "new"}) — ` +
                `derived default LLM_TIMEOUT_MS=${suggested}ms` +
                (cfg.timeoutMsExplicit ? ` (explicit LLM_TIMEOUT_MS=${cfg.timeoutMs} wins)` : ""),
            );
            if (!cfg.timeoutMsExplicit && suggested > 60_000) {
              warn(
                "timeout derivation",
                `LLM_TIMEOUT_MS is unset — the engine will now default to ${suggested}ms for ` +
                  `"${hardModel}" (4× measured median, from the latency cache). ` +
                  `Set LLM_TIMEOUT_MS explicitly to override`,
              );
            }
          } else {
            warn("model latency", "probe returned no timing samples");
          }
        } catch (err) {
          warn("model latency", `probe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        warn("model latency", `skipped — hard tier is hosted ("${hardBackend}"); no local telemetry burned`);
      }
    }
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
    console.log("Fix: npm run setup:ollama  →  npm run setup:laya  →  cp .env.example .env (add keys)  →  npm run serve:laya");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`diagnose crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
