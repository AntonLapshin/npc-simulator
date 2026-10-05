import type { LogEntry, LogInput } from "./logTypes.js";

// In-memory ring buffer for tests and UI.
export class LogStore {
  private entries: LogEntry[] = [];
  private readonly capacity: number;

  constructor(capacity = 5000) {
    this.capacity = capacity;
  }

  append(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  byModule(module: string): LogEntry[] {
    return this.entries.filter((e) => e.module === module);
  }

  byEvent(event: string): LogEntry[] {
    return this.entries.filter((e) => e.event === event);
  }

  byTick(tick: number): LogEntry[] {
    return this.entries.filter((e) => e.tick === tick);
  }

  events(): string[] {
    return this.entries.map((e) => e.event);
  }
}
