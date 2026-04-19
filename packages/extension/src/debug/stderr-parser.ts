import type { DebugCollector } from "./collector.js";

export function processStderrChunk(chunk: string, collector: DebugCollector): string {
  const lines = chunk.split("\n");
  const nonDebug: string[] = [];
  for (const line of lines) {
    if (line.startsWith("[DEBUG]")) {
      try { collector.push(JSON.parse(line.slice(7))); } catch { nonDebug.push(line); }
    } else if (line.trim()) {
      nonDebug.push(line);
    }
  }
  return nonDebug.join("\n");
}
