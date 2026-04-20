import * as vscode from "vscode";
import type { DebugCollector } from "./collector.js";
import type { DebugEvent } from "@perplexity-user-mcp/shared";

const REDACT_KEYS = ["cookie", "csrf", "token", "password", "secret", "otp", "session", "email", "authorization"];

function redactEvent(event: DebugEvent): DebugEvent {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    const lower = key.toLowerCase();
    if (typeof value === "string" && REDACT_KEYS.some((k) => lower.includes(k))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.includes("@") && value.includes(".")) {
      redacted[key] = "[REDACTED_EMAIL]";
    } else {
      redacted[key] = value;
    }
  }
  return { ...event, data: redacted };
}

export async function exportDebugLog(collector: DebugCollector, sessionOnly: boolean, extensionVersion: string): Promise<void> {
  const { events, dropped } = collector.getEvents(sessionOnly);
  const result = {
    meta: {
      generator: "perplexity-vscode",
      format_version: "1.0" as const,
      exported_at: new Date().toISOString(),
      extension_version: extensionVersion,
      platform: process.platform,
      vscode_version: vscode.version,
      node_version: process.version,
      event_count: events.length,
      buffer_capacity: collector.bufferCapacity,
      events_dropped: dropped,
    },
    events: events.map(redactEvent),
  };

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`perplexity-debug-${Date.now()}.json`),
    filters: { "JSON files": ["json"] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(result, null, 2)));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}
