/**
 * F31: per-call LLM usage captured from the chat-completions `usage`
 * block (token counts, not estimates).
 */
export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LogEntry = {
  id: string;
  sessionId: string;
  timestamp: string;
  tick: number;
  turnIndex: number;
  module: string;
  event: string;
  actorId?: string;
  actionId?: string;
  parentId?: string;
  input?: unknown;
  output?: unknown;
  prompt?: string;
  /** Full prompt length in chars (system + user), for cost tracking. */
  promptChars?: number;
  /** Rough token estimate (chars / 4) for the full prompt. */
  promptTokensEstimate?: number;
  rawResponse?: string;
  parsedResponse?: unknown;
  reasoning?: string;
  validationErrors?: string[];
  error?: string;
  durationMs?: number;
  /** F31: per-call LLM usage — set on llm-call records (e.g. <module>_completed). */
  usage?: LlmUsage;
  /**
   * F31: accumulated per-turn LLM usage — set on the turn_completed record
   * (the engine accumulates per-call `usage` across the turn).
   */
  turnUsage?: LlmUsage;
};

export type LogInput = Omit<LogEntry, "id" | "sessionId" | "timestamp"> & {
  id?: string;
  sessionId?: string;
  timestamp?: string;
};
