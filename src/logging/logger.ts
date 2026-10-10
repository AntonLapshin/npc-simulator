import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LogEntry, LogInput } from "./logTypes.js";
import { LogStore } from "./logStore.js";

export type LoggerOptions = {
  sessionId?: string;
  logDir?: string;
  /** When false, skip file writes (useful for unit tests). */
  writeToFile?: boolean;
  storeCapacity?: number;
  /**
   * When false, full prompt/response bodies are stripped from LLM-call log
   * records (prompt, rawResponse, parsedResponse, reasoning); metadata
   * (model/backend in input, latencies, token estimates, error codes) is
   * kept. Defaults from the NPC_LOG_PROMPTS env var (default 1 = keep).
   */
  logPromptBodies?: boolean;
  /** Rotate the JSONL file once it reaches this size (default 10 MiB). */
  maxLogFileBytes?: number;
};

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Modules whose log records are LLM calls (Worker B: src/llm/complete.ts). */
const LLM_CALL_MODULES = new Set(["intent", "consequence", "semantic"]);

/** Rotation policy (F29): keep the live file plus this many rotated copies. */
const LOG_ROTATIONS_KEPT = 3;

function promptBodiesEnabledByEnv(): boolean {
  return process.env["NPC_LOG_PROMPTS"] !== "0";
}

/**
 * Captures every module event: input, output, prompt, raw/parsed LLM
 * responses, reasoning, validation results, errors, retries, durations.
 * Stores entries in memory and appends JSONL lines to logs/{sessionId}.jsonl.
 *
 * Privacy (F29): when NPC_LOG_PROMPTS=0, full prompt/response bodies are
 * stripped from LLM-call log records at this write path — so it covers all
 * callers — while metadata (model, backend, latencies, token usage, error
 * codes) is preserved.
 *
 * Rotation (F29): the JSONL file is rotated at maxLogFileBytes (default
 * 10 MiB), keeping 3 rotations: `<session>.jsonl`, `.jsonl.1`, `.jsonl.2`,
 * `.jsonl.3` (oldest).
 */
export class Logger {
  readonly sessionId: string;
  readonly store: LogStore;
  private readonly logDir?: string;
  private readonly writeToFile: boolean;
  private readonly logPromptBodies: boolean;
  private readonly maxLogFileBytes: number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LoggerOptions = {}) {
    this.sessionId = options.sessionId ?? `session_${Date.now().toString(36)}`;
    this.store = new LogStore(options.storeCapacity);
    this.logDir = options.logDir;
    this.writeToFile = options.writeToFile ?? options.logDir !== undefined;
    this.logPromptBodies = options.logPromptBodies ?? promptBodiesEnabledByEnv();
    this.maxLogFileBytes = options.maxLogFileBytes ?? 10 * 1024 * 1024;
  }

  log(input: LogInput): LogEntry {
    const entry: LogEntry = {
      id: input.id ?? newId("log"),
      sessionId: input.sessionId ?? this.sessionId,
      timestamp: new Date().toISOString(),
      ...input,
    } as LogEntry;
    if (!this.logPromptBodies && LLM_CALL_MODULES.has(entry.module)) {
      // Strip full prompt/response bodies; keep metadata.
      entry.prompt = undefined;
      entry.rawResponse = undefined;
      entry.parsedResponse = undefined;
      entry.reasoning = undefined;
    }
    this.store.append(entry);
    if (this.writeToFile && this.logDir) {
      const file = join(this.logDir, `${this.sessionId}.jsonl`);
      const line = JSON.stringify(entry) + "\n";
      this.writeChain = this.writeChain
        .then(() => mkdir(this.logDir!, { recursive: true }))
        .then(() => this.maybeRotate(file))
        .then(() => appendFile(file, line, "utf-8"))
        .catch(() => {
          // Logging must never crash the simulation.
        });
    }
    return entry;
  }

  /**
   * Rotate the JSONL log when it reaches maxLogFileBytes: shift
   * `.jsonl.2`→`.jsonl.3`, `.jsonl.1`→`.jsonl.2`, `.jsonl`→`.jsonl.1`
   * (deleting the previous `.jsonl.3`), so the next append starts a fresh
   * file. Best-effort — never throws.
   */
  private async maybeRotate(file: string): Promise<void> {
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      return; // No file yet — nothing to rotate.
    }
    if (size < this.maxLogFileBytes) return;
    try {
      await rm(`${file}.${LOG_ROTATIONS_KEPT}`, { force: true });
      for (let i = LOG_ROTATIONS_KEPT - 1; i >= 1; i--) {
        try {
          await rename(`${file}.${i}`, `${file}.${i + 1}`);
        } catch {
          // Missing rotation slot — nothing to shift.
        }
      }
      await rename(file, `${file}.1`);
    } catch {
      // Rotation is best-effort; the append below still proceeds.
    }
  }

  /** Await pending file writes (tests / shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  childDefaults(tick: number, turnIndex: number): { tick: number; turnIndex: number } {
    return { tick, turnIndex };
  }
}

export function createTestLogger(sessionId = "test_session"): Logger {
  return new Logger({ sessionId, writeToFile: false });
}
