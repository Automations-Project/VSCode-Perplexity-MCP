import type { DebugEvent } from "@perplexity/shared";

export class DebugCollector {
  private buffer: (DebugEvent | undefined)[];
  private head = 0;
  private count = 0;
  private capacity: number;
  private sessionStart?: { ts: string; index: number };
  private sessionEnd?: { ts: string };
  onEvent?: (event: DebugEvent) => void;

  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(event: DebugEvent): void {
    const lastIdx = (this.head - 1 + this.capacity) % this.capacity;
    const last = this.buffer[lastIdx];
    if (last && last.source === event.source && last.category === event.category && last.event === event.event && last.error === event.error) {
      last.repeated = (last.repeated ?? 1) + 1;
      return;
    }
    this.buffer[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    this.count++;
    this.onEvent?.(event);
  }

  trace(source: DebugEvent["source"], category: DebugEvent["category"], event: string, data: Record<string, unknown> = {}, error?: string): void {
    this.push({ ts: new Date().toISOString(), source, category, event, data, ...(error ? { error } : {}) });
  }

  startSession(): void {
    this.sessionStart = { ts: new Date().toISOString(), index: this.head };
    this.sessionEnd = undefined;
  }

  stopSession(): { start: string; end: string } | null {
    if (!this.sessionStart) return null;
    this.sessionEnd = { ts: new Date().toISOString() };
    return { start: this.sessionStart.ts, end: this.sessionEnd.ts };
  }

  getEvents(sessionOnly: boolean): { events: DebugEvent[]; dropped: number } {
    const events: DebugEvent[] = [];
    const total = Math.min(this.count, this.capacity);
    for (let i = 0; i < total; i++) {
      const idx = (this.head - total + i + this.capacity) % this.capacity;
      const ev = this.buffer[idx];
      if (ev) {
        if (sessionOnly && this.sessionStart) {
          if (ev.ts >= this.sessionStart.ts && (!this.sessionEnd || ev.ts <= this.sessionEnd.ts)) {
            events.push(ev);
          }
        } else {
          events.push(ev);
        }
      }
    }
    return { events, dropped: Math.max(0, this.count - this.capacity) };
  }

  get eventCount(): number { return this.count; }
  get bufferCapacity(): number { return this.capacity; }
  get isSessionActive(): boolean { return !!this.sessionStart && !this.sessionEnd; }

  resize(newCapacity: number): void {
    const { events } = this.getEvents(false);
    this.capacity = newCapacity;
    this.buffer = new Array(newCapacity);
    this.head = 0;
    this.count = 0;
    const toKeep = events.slice(-newCapacity);
    for (const ev of toKeep) {
      this.buffer[this.head] = ev;
      this.head = (this.head + 1) % this.capacity;
      this.count++;
    }
  }
}
