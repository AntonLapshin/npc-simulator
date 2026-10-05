import { appendFile, mkdir } from "node:fs/promises";
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
};

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Captures every module event: input, output, prompt, raw/parsed LLM
 * responses, reasoning, validation results, errors, retries, durations.
 * Stores entries in memory and appends JSONL lines to logs/{sessionId}.jsonl.
 */
export class Logger {
  readonly sessionId: string;
  readonly store: LogStore;
  private readonly logDir?: string;
  private readonly writeToFile: boolean;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LoggerOptions = {}) {
    this.sessionId = options.sessionId ?? `session_${Date.now().toString(36)}`;
    this.store = new LogStore(options.storeCapacity);
    this.logDir = options.logDir;
    this.writeToFile = options.writeToFile ?? options.logDir !== undefined;
  }

  log(input: LogInput): LogEntry {
    const entry: LogEntry = {
      id: input.id ?? newId("log"),
      sessionId: input.sessionId ?? this.sessionId,
      timestamp: new Date().toISOString(),
      ...input,
    } as LogEntry;
    this.store.append(entry);
    if (this.writeToFile && this.logDir) {
      const file = join(this.logDir, `${this.sessionId}.jsonl`);
      const line = JSON.stringify(entry) + "\n";
      this.writeChain = this.writeChain
        .then(() => mkdir(this.logDir!, { recursive: true }))
        .then(() => appendFile(file, line, "utf-8"))
        .catch(() => {
          // Logging must never crash the simulation.
        });
    }
    return entry;
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
