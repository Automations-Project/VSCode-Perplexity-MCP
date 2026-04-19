import * as vscode from "vscode";
import type { DebugCollector } from "./collector.js";

export function tracedCommand(collector: DebugCollector, commandId: string, callback: (...args: unknown[]) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async (...args) => {
    collector.trace("ext", "command", "command:execute", { command: commandId });
    const start = Date.now();
    try {
      const result = await callback(...args);
      collector.trace("ext", "command", "command:done", { command: commandId, duration_ms: Date.now() - start });
      return result;
    } catch (err) {
      collector.trace("ext", "error", "command:error", { command: commandId, duration_ms: Date.now() - start }, String(err));
      throw err;
    }
  });
}

export function traceConfigChanges(collector: DebugCollector): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("Perplexity")) {
      collector.trace("ext", "config", "config:settings_change", {});
    }
  });
}
