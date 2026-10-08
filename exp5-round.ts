// Exp-5 round driver: 1 user turn + NPC turns until control returns.
// Usage: npx tsx ./exp5-round.ts '<action text>' saves/exp5-laya-anton.json exp5_laya
// Env (set by caller for "local defaults + laya max + debug"):
//   LLM_BACKEND=ollama LLM_SIMPLE_BACKEND=ollama
//   OLLAMA_MODEL=fluffy/l3-8b-stheno-v3.2 LLM_SIMPLE_MODEL=huihui_ai/llama3.2-abliterate:3b
//   LAYA_MODE=dynamic LAYA_SELECTION=1 LAYA_JUDGE=1 LAYA_TRIAGE=1 LAYA_SALIENCE=1
//   LAYA_PLANNER=1 LAYA_PLAUSIBILITY=1 LAYA_URL=http://127.0.0.1:8000
//   NPC_LOG_PROMPTS=1 LLM_JSON_MODE=1 LLM_USER_CAPABLE_TIER=1
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadScenario } from "./src/engine/scenarioLoader.js";
import { getCurrentActor } from "./src/engine/worldStore.js";
import { loadWorld, saveWorld } from "./src/engine/persistence.js";
import { runTurn } from "./src/engine/turnOrchestrator.js";
import { resolveConfig } from "./src/config.js";
import { Logger } from "./src/logging/logger.js";
import { createLlmEngines } from "./src/llm/index.js";
import { historyEntryText } from "./src/logging/storyTrace.js";
import { loadEnvFile } from "./src/util/loadEnv.js";

const [, , actionText, savePath, sessionId] = process.argv;
if (!actionText || !savePath || !sessionId) {
  console.error("usage: npx tsx ./exp5-round.ts '<action>' <savePath> <sessionId>");
  process.exit(2);
}

loadEnvFile(process.cwd());

const logger = new Logger({ sessionId, logDir: "logs", writeToFile: true });
const config = resolveConfig({ autosaveEnabled: false });
const engines = createLlmEngines(logger, {});
const deps: any = { ...engines, logger, config };
deps.getUserAction = async () => actionText;
deps.onProgress = () => {};

let world: any;
if (existsSync(savePath)) {
  world = await loadWorld(savePath, logger);
} else {
  const raw = JSON.parse(await readFile("scenarios/office-anton.json", "utf-8"));
  world = loadScenario(raw, logger);
}

const order = world.order as string[];
const maxSteps = order.length; // 1 user + up to 2 NPC
for (let i = 0; i < maxSteps; i++) {
  const actor = getCurrentActor(world);
  const isUser = actor.id === world.userActorId;
  if (i > 0 && isUser) break;
  // NPC turns must not consume the forced user text
  if (i > 0) deps.getUserAction = async () => {
    throw new Error("getUserAction called on NPC turn");
  };
  const beforeTick = world.tick;
  world = await runTurn(world, deps);
  const entry = historyEntryText(world.history.at(-1)) ?? "(no history)";
  const me = world.actors.find((a: any) => a.id === actor.id);
  console.log(`--- tick ${beforeTick} actor=${actor.id} pos=(${me?.x},${me?.y}) state=${me?.state} pose=${me?.pose} prop=${me?.prop}`);
  console.log(`    ${entry}`);
}

await saveWorld(savePath, world, logger);
await logger.flush();
const cur = getCurrentActor(world);
console.log(`=== saved ${savePath} tick=${world.tick} next=${cur.id} ===`);
console.log(`positions: ${world.actors.map((a: any) => `${a.id}(${a.x},${a.y})`).join(" ")}`);
