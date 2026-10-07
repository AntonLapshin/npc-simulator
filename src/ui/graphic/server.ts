// Graphic engine server — drives the web UI from the real simulation engine.
//
// SECURITY POSTURE (F30 — deliberate, owner-approved behavior changes):
//   * Binds 127.0.0.1 by default (loopback only). Set HOST=0.0.0.0 to expose
//     on the LAN — do so only on a network you trust, since the API below
//     spends LLM calls / API budget.
//   * Optional token auth: when NPC_API_TOKEN is set, POST /action,
//     POST /reset, and GET /logs require either an `x-api-token` header or
//     `Authorization: Bearer <token>` and answer 401 otherwise. Unset (the
//     default) means no auth — same as before.
//   * CORS Access-Control-Allow-Origin remains `*` on API and static
//     responses; with loopback binding this is a local browser convenience,
//     not a LAN exposure.
// See .env.example (HOST, NPC_API_TOKEN) for the knobs.
//
// Run: npm run start:graphic -- [scenario] [--provider <backend>] [--model <id>]
//        [--base-url <url>] [--mock] [--debug] [--no-autosave] [--port <n>]
//   scenario defaults to scenarios/office.json (same default as the text UI).
//   --provider selects the LLM backend: joingonka (default), laya-local, ollama.
//     Aliases: --backend. Overrides LLM_BACKEND (and .env) for this run.
//   --model / --base-url override the model id / endpoint for the backend.
//   --mock forces deterministic mock engines (no network, no API key).
//   Without --mock the real LLM engines are used; on setup failure the
//   server falls back to mocks with a warning so the UI stays usable.
//   --port / -p selects the HTTP port (default 8123). A bare numeric first
//     arg is also accepted as the port (legacy static-server usage).
//
// The server holds the authoritative World in memory (exactly like the text
// UI session): the browser never simulates, it only renders World snapshots
// and POSTs user actions. Endpoints (see js/sim/httpAdapter.js):
//   GET  /health  -> { ok, engine, scenario, tick, userActorId }
//   GET  /world   -> { world, presentation }
//   POST /action  { text } -> { world, events } (user turn + auto NPC turns)
//   GET  /events  -> SSE stream of turn progress (engine onProgress)
//   GET  /logs?limit&module&tick -> recent log entries (debug)
//   POST /reset   -> reload the scenario file from disk
// Everything else serves the static UI from src/ui/graphic/; index.html is
// served with window.__NPC_ENGINE__ injected so the UI auto-connects to the
// same origin instead of falling back to the offline mock scenario.
// The scene layer is NOT served from here directly: src/ui/graphic/ui-lib is
// a symlink to the sibling npc-simulator-ui project, so /ui-lib/* URLs and
// the js/scene/ui.js bridge resolve through the static file serving below.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "../../types.js";
import { loadScenario } from "../../engine/scenarioLoader.js";
import { getCurrentActor } from "../../engine/worldStore.js";
import { runTurn, type EngineDependencies } from "../../engine/turnOrchestrator.js";
import { resolveConfig } from "../../config.js";
import { Logger } from "../../logging/logger.js";
import { MockProposalEngine } from "../../mocks/mockProposalEngine.js";
import { MockSelectionEngine } from "../../mocks/mockSelectionEngine.js";
import { MockConsequenceEngine } from "../../mocks/mockConsequenceEngine.js";
import { createLlmEngines, resolveLlmEnv } from "../../llm/index.js";
import { historyEntryText, renderTurnStory } from "../../logging/storyTrace.js";
import { loadEnvFile } from "../../util/loadEnv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPHIC_ROOT = resolve(HERE);
const REPO_ROOT = resolve(HERE, "../../..");
const DEFAULT_SCENARIO = join(REPO_ROOT, "scenarios/office.json");

type GraphicOptions = {
  scenarioPath?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  useMock?: boolean;
  debug?: boolean;
  autosave?: boolean;
  port?: number;
  help?: boolean;
};

function takeValue(argv: string[], i: number, flag: string): string | undefined {
  const eq = flag.indexOf("=");
  if (eq !== -1) return flag.slice(eq + 1).trim() || undefined;
  return argv[i + 1]?.trim() || undefined;
}

function parseArgv(argv: string[]): GraphicOptions {
  const opts: GraphicOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mock") opts.useMock = true;
    else if (a === "--debug") opts.debug = true;
    else if (a === "--no-autosave") opts.autosave = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--port" || a === "-p" || a.startsWith("--port=")) {
      const v = takeValue(argv, i, a);
      if (!v) throw new Error("--port needs a value (e.g. --port 8123)");
      opts.port = Number(v);
      if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error(`--port must be a positive integer (got '${v}')`);
      if (!a.includes("=")) i++;
    } else if (a === "--provider" || a === "--backend" || a.startsWith("--provider=") || a.startsWith("--backend=")) {
      const v = takeValue(argv, i, a);
      if (!v) throw new Error(`${a.split("=")[0]} needs a value: joingonka | laya-local | ollama`);
      opts.provider = v;
      if (!a.includes("=")) i++;
    } else if (a === "--model" || a.startsWith("--model=")) {
      const v = takeValue(argv, i, a);
      if (!v) throw new Error("--model needs a value (model id)");
      opts.model = v;
      if (!a.includes("=")) i++;
    } else if (a === "--base-url" || a === "--baseUrl" || a.startsWith("--base-url=") || a.startsWith("--baseUrl=")) {
      const v = takeValue(argv, i, a);
      if (!v) throw new Error("--base-url needs a value (endpoint URL)");
      opts.baseUrl = v;
      if (!a.includes("=")) i++;
    } else if (!a.startsWith("--")) positional.push(a);
    else throw new Error(`unknown flag: ${a}`);
  }
  // Legacy static-server usage: `serve [port]` — a lone numeric arg is a port.
  if (positional.length === 1 && /^\d+$/.test(positional[0]!) && opts.port === undefined) {
    opts.port = Number(positional[0]);
  } else if (positional[0]) {
    opts.scenarioPath = positional[0];
  }
  if (positional.length > 1) throw new Error(`too many positional args: ${positional.join(" ")}`);
  return opts;
}

/** Apply --provider/--model/--base-url overrides on top of process.env. */
function resolveRuntimeEnv(opts: Pick<GraphicOptions, "provider" | "model" | "baseUrl">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const provider = opts.provider?.trim();
  if (provider) env["LLM_BACKEND"] = provider;
  const backend = (env["LLM_BACKEND"] ?? "joingonka").trim();
  if (opts.model?.trim()) {
    if (backend === "ollama") env["OLLAMA_MODEL"] = opts.model.trim();
    else if (backend === "laya-local") env["LAYA_MODEL"] = opts.model.trim();
    else env["JOINGONKA_MODEL"] = opts.model.trim();
  }
  if (opts.baseUrl?.trim()) {
    if (backend === "ollama") env["OLLAMA_BASE_URL"] = opts.baseUrl.trim();
    else if (backend === "laya-local") env["LAYA_BASE_URL"] = opts.baseUrl.trim();
    else env["JOINGONKA_BASE_URL"] = opts.baseUrl.trim();
  }
  return env;
}

function buildDeps(
  logger: Logger,
  useMock: boolean,
  autosave: boolean,
  llmOpts: Pick<GraphicOptions, "provider" | "model" | "baseUrl"> = {},
): { deps: EngineDependencies; usingMock: boolean; llmLabel?: string } {
  const config = resolveConfig({ autosaveEnabled: autosave });
  if (useMock) {
    return {
      usingMock: true,
      deps: {
        proposalEngine: new MockProposalEngine(logger),
        selectionEngine: new MockSelectionEngine(logger),
        consequenceEngine: new MockConsequenceEngine(logger),
        logger,
        config,
      },
    };
  }
  try {
    const env = resolveRuntimeEnv(llmOpts);
    const engines = createLlmEngines(logger, { env });
    const cfg = resolveLlmEnv(env);
    const hardModel =
      cfg.backend === "ollama" ? cfg.ollama.model : cfg.backend === "laya-local" ? cfg.laya.model : cfg.joingonka.model;
    const simpleModel = cfg.simpleModel ??
      (cfg.simpleBackend === "ollama" ? cfg.ollama.model : cfg.simpleBackend === "laya-local" ? cfg.laya.model : cfg.joingonka.model);
    return { usingMock: false, deps: { ...engines, logger, config }, llmLabel: `hard=${cfg.backend}/${hardModel} simple=${cfg.simpleBackend}/${simpleModel}` };
  } catch (err) {
    console.log(
      `LLM setup failed (${err instanceof Error ? err.message : String(err)}). Falling back to mock engines. Use --mock to silence this.`,
    );
    return {
      usingMock: true,
      deps: {
        proposalEngine: new MockProposalEngine(logger),
        selectionEngine: new MockSelectionEngine(logger),
        consequenceEngine: new MockConsequenceEngine(logger),
        logger,
        config,
      },
    };
  }
}

/* ── speech recovery (mirrors js/sim/textParse.js) ─────────────────────── */

function extractQuoted(text: string): string | null {
  const m = text.match(/“([^”]+)”/) || text.match(/"([^"]+)"/) || text.match(/'([^']{2,})'/);
  return m ? m[1]!.trim() : null;
}

function speechFromAction(text: string): { text: string; kind: string } | null {
  const quoted = extractQuoted(text);
  if (!quoted) return null;
  const kind = /\b(thinks?|wonders?|muses?|reali[sz]es?)\b/i.test(text) ? "thought" : "say";
  return { text: quoted, kind };
}

/* ── security helpers (F30) ────────────────────────────────────────── */

/**
 * Bind address for the HTTP server. Defaults to loopback (127.0.0.1) so the
 * server is not reachable from the LAN unless the operator opts in with
 * HOST=0.0.0.0. Exported for unit tests.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const h = env["HOST"]?.trim();
  return h ? h : "127.0.0.1";
}

/**
 * Optional API token. When set (non-blank), POST /action, POST /reset, and
 * GET /logs require it; when unset there is no auth. Exported for unit tests.
 */
export function resolveApiToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = env["NPC_API_TOKEN"]?.trim();
  return t ? t : undefined;
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * True when the request may proceed: either no API token is configured, or
 * the request carries it as an `x-api-token` header or an
 * `Authorization: Bearer <token>` header. Exported for unit tests.
 */
export function isAuthorized(
  headers: Record<string, string | string[] | undefined>,
  apiToken: string | undefined,
): boolean {
  if (!apiToken) return true;
  const headerToken = headers["x-api-token"];
  const h = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof h === "string" && tokensEqual(h.trim(), apiToken)) return true;
  const auth = headers["authorization"];
  const a = Array.isArray(auth) ? auth[0] : auth;
  const m = typeof a === "string" ? /^Bearer\s+(.+)$/i.exec(a.trim()) : null;
  return m !== null && tokensEqual(m[1]!.trim(), apiToken);
}

/* ── server state ──────────────────────────────────────────────────────── */

type TurnEvent = {
  actorId: string;
  isUser: boolean;
  actionText: string;
  speech: { text: string; kind: string } | null;
  narrative: string;
  world: World;
  /** Concise story debug trace for this turn (text-UI `debug on` format, no ANSI colors). Only set when --debug. */
  story?: string | null;
  /** Engine tick the turn ran at (matches the story block header). */
  tick?: number;
};

async function main(): Promise<void> {
  // Skipped under Vitest so tests stay hermetic.
  if (process.env["VITEST"] === undefined) {
    loadEnvFile(REPO_ROOT);
  }

  let opts: GraphicOptions;
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.log(
      "Usage: npm run start:graphic -- [scenario] [--provider <backend>] [--model <id>] [--base-url <url>] [--mock] [--debug] [--no-autosave] [--port <n>]",
    );
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(
      [
        "Usage: npm run start:graphic -- [scenario] [--provider <backend>] [--model <id>] [--base-url <url>] [--mock] [--debug] [--no-autosave] [--port <n>]",
        "  backends: joingonka | laya-local | ollama (aliases: --backend)",
        "  scenario defaults to scenarios/office.json",
        "  Serves the graphic UI (http://localhost:8123/) driven by the real engine:",
        "  GET /world, POST /action {text}, GET /events (SSE), GET /health, GET /logs, POST /reset.",
      ].join("\n"),
    );
    return;
  }

  const port = opts.port ?? 8123;
  // F30: loopback by default; HOST opts in to a wider bind. Read after
  // loadEnvFile so .env can set HOST / NPC_API_TOKEN.
  const host = resolveBindHost();
  const apiToken = resolveApiToken();
  const scenarioPath = opts.scenarioPath ? resolve(process.cwd(), opts.scenarioPath) : DEFAULT_SCENARIO;
  const logger = new Logger({
    sessionId: `graphic_${Date.now().toString(36)}`,
    logDir: resolveConfig().logDir,
    writeToFile: true,
  });
  const { deps, usingMock, llmLabel } = buildDeps(logger, opts.useMock ?? false, opts.autosave ?? true, opts);
  const engineLabel = usingMock ? "mock (offline)" : `REAL LLM (${llmLabel ?? "see .env"})`;

  let world: World;
  let presentation: unknown = null;
  const loadFromDisk = async (): Promise<void> => {
    const raw = JSON.parse(await readFile(scenarioPath, "utf-8")) as Record<string, unknown>;
    presentation = (raw["presentation"] as unknown) ?? null;
    const { presentation: _drop, ...scenarioRaw } = raw;
    world = loadScenario(scenarioRaw, logger);
  };
  try {
    await loadFromDisk();
  } catch (err) {
    console.error(`Could not load scenario '${scenarioPath}': ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let busy = false;
  const sseClients = new Set<ServerResponse>();
  const broadcast = (payload: { actorId?: string; stage: string; message: string }): void => {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(line);
      } catch {
        // Drop broken SSE connections lazily on socket close.
      }
    }
  };
  deps.onProgress = (event) => {
    broadcast({ actorId: event.actorId, stage: event.stage, message: event.message });
  };

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  };

  /** F30: when NPC_API_TOKEN is set, reject unauthenticated API calls with 401. */
  const requireAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isAuthorized(req.headers, apiToken)) return true;
    sendJson(res, 401, { error: "Unauthorized: provide the API token via x-api-token header or Authorization: Bearer <token>" });
    return false;
  };

  const readBody = (req: IncomingMessage, limit = 1_000_000): Promise<string> =>
    new Promise((resolveBody, rejectBody) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          rejectBody(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", rejectBody);
    });

  /** Run one user round: drain leading NPCs, resolve the user action, then
   *  auto-advance trailing NPCs until control returns to the user — the same
   *  flow as the text UI's runUserTurnAndNpcs(). */
  const runUserRound = async (userText: string): Promise<TurnEvent[]> => {
    const events: TurnEvent[] = [];
    const collect = async (forcedUserText?: string): Promise<void> => {
      const actor = getCurrentActor(world);
      deps.getUserAction =
        actor.id === world.userActorId && forcedUserText !== undefined
          ? async () => forcedUserText
          : async () => {
              throw new Error("getUserAction called outside the user turn");
            };
      const beforeTick = world.tick;
      world = await runTurn(world, deps);
      const actionText = historyEntryText(world.history.at(-1)) ?? `${actor.name}: ${forcedUserText ?? ""}`;
      // Debug story trace (same format as the text UI's `debug on` output:
      // proposal → selection → action → consequence → validation → history).
      let story: string | null = null;
      if (opts.debug) {
        try {
          const roster = world.actors.map((a) => ({ id: a.id, name: a.name }));
          story = renderTurnStory(
            logger.store.all().filter((e) => e.tick === beforeTick),
            beforeTick,
            roster,
            { userActorId: world.userActorId, color: false },
          );
        } catch {
          story = null;
        }
      }
      events.push({
        actorId: actor.id,
        isUser: actor.id === world.userActorId,
        actionText,
        speech: speechFromAction(actionText),
        narrative: actionText,
        world: structuredClone(world),
        story,
        tick: beforeTick,
      });
    };
    const guard = Math.max(1, world.order.length);
    for (let i = 0; i < guard; i++) {
      if (getCurrentActor(world).id === world.userActorId) break;
      await collect();
    }
    await collect(userText);
    for (let i = 0; i < Math.max(0, world.order.length - 1); i++) {
      if (getCurrentActor(world).id === world.userActorId) break;
      await collect();
    }
    return events;
  };

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = decodeURIComponent(url.pathname);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Api-Token, Authorization",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, {
          ok: true,
          engine: engineLabel,
          mock: usingMock,
          debug: opts.debug ?? false,
          scenario: { id: world.id, title: world.title, path: scenarioPath },
          tick: world.tick,
          userActorId: world.userActorId,
          actors: world.actors.map((a) => a.id),
        });
        return;
      }

      if (req.method === "GET" && path === "/world") {
        sendJson(res, 200, { world, presentation: presentation ?? null, debug: opts.debug ?? false });
        return;
      }

      if (req.method === "GET" && path === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(`: npc-simulator stream\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (req.method === "GET" && path === "/logs") {
        if (!requireAuth(req, res)) return;
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
        const module = url.searchParams.get("module") ?? undefined;
        const tickParam = url.searchParams.get("tick");
        let entries = logger.store.all();
        if (module) entries = entries.filter((e) => e.module === module);
        if (tickParam !== null && tickParam !== "") {
          const tick = Number(tickParam);
          if (Number.isInteger(tick)) entries = entries.filter((e) => e.tick === tick);
        }
        sendJson(res, 200, { entries: entries.slice(-limit), total: entries.length });
        return;
      }

      if (req.method === "POST" && path === "/reset") {
        if (!requireAuth(req, res)) return;
        if (busy) {
          sendJson(res, 409, { error: "A turn is already running" });
          return;
        }
        try {
          await loadFromDisk();
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        sendJson(res, 200, { world, presentation: presentation ?? null, debug: opts.debug ?? false });
        return;
      }

      if (req.method === "POST" && path === "/action") {
        if (!requireAuth(req, res)) return;
        if (busy) {
          sendJson(res, 409, { error: "A turn is already running" });
          return;
        }
        let text = "";
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { text?: unknown };
          text = String(body.text ?? "").trim();
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body (expected { text })" });
          return;
        }
        if (!text) {
          sendJson(res, 400, { error: "Empty action" });
          return;
        }
        busy = true;
        try {
          const t0 = Date.now();
          const events = await runUserRound(text);
          if (opts.debug) {
            console.log(`[graphic] action resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s (${events.length} turn(s))`);
          }
          sendJson(res, 200, { world, events, debug: opts.debug ?? false });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          busy = false;
        }
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      // Static UI files.
      let filePath = path === "/" ? "/index.html" : path;
      const file = join(GRAPHIC_ROOT, normalize(filePath));
      if (!file.startsWith(GRAPHIC_ROOT)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      let data = await readFile(file);
      const type = MIME[extname(file)] || "application/octet-stream";
      if (file.endsWith("index.html")) {
        // Tell the UI it was served by the engine (same-origin backend with
        // the requested scenario/engines) so it connects back here instead
        // of booting the offline mock scenario.
        const inject =
          `<script>window.__NPC_ENGINE__=${JSON.stringify({ backend: "same-origin", engine: engineLabel, mock: usingMock, scenario: world.title, scenarioId: world.id, debug: opts.debug ?? false })};</script>\n`;
        const html = data.toString("utf-8").replace(`<script type="module" src="js/main.js">`, `${inject}<script type="module" src="js/main.js">`);
        data = Buffer.from(html, "utf-8");
      }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      res.end(data);
    } catch {
      if (!res.headersSent) {
        try {
          if ((req.url ?? "").startsWith("/world") || (req.url ?? "").startsWith("/action") || (req.url ?? "").startsWith("/health")) {
            sendJson(res, 404, { error: "Not found" });
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
          }
        } catch {
          // Socket already gone.
        }
      }
    }
  });

  // F30: explicit loopback bind by default (server.listen(port) with no host
  // binds all interfaces — the flaw). HOST overrides.
  server.listen(port, host, () => {
    console.log(`NPC Simulator UI → http://${host}:${port}/`);
    console.log(`Scenario: ${world.title} (${scenarioPath}, you play ${world.userActorId})`);
    console.log(`Engines: ${engineLabel}.`);
    if (apiToken) console.log("API token auth enabled for POST /action, POST /reset, GET /logs.");
    if (opts.debug) console.log("Debug mode ON.");
  });
  await logger.flush().catch(() => {});
}

const isMain = process.argv[1] !== undefined && /server(\.ts|\.js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(`graphic server crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
