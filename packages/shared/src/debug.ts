export interface DebugEvent {
  ts: string;
  source: "ext" | "mcp";
  category: "tool" | "auth" | "http" | "command" | "webview" | "config" | "error";
  event: string;
  duration_ms?: number;
  data: Record<string, unknown>;
  error?: string;
  repeated?: number;
}

export interface DebugState {
  enabled: boolean;
  sessionActive: boolean;
  eventCount: number;
  bufferCapacity: number;
}
