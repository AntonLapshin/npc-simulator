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
  rawResponse?: string;
  parsedResponse?: unknown;
  reasoning?: string;
  validationErrors?: string[];
  error?: string;
  durationMs?: number;
};

export type LogInput = Omit<LogEntry, "id" | "sessionId" | "timestamp"> & {
  id?: string;
  sessionId?: string;
  timestamp?: string;
};
