export function trace(category: string, event: string, data: Record<string, unknown> = {}, error?: unknown): void {
  if (process.env.PERPLEXITY_DEBUG !== "1") return;
  if (category === "http" && process.env.PERPLEXITY_DEBUG_VERBOSE !== "1") return;
  const entry = { ts: new Date().toISOString(), source: "mcp" as const, category, event, data, ...(error ? { error: String(error) } : {}) };
  try { process.stderr.write("[DEBUG]" + JSON.stringify(entry) + "\n"); } catch {}
}

export function traceToolHandler<TArgs, TResult>(toolName: string, handler: (args: TArgs) => Promise<TResult>): (args: TArgs) => Promise<TResult> {
  return async (args) => {
    trace("tool", "tool:call", { tool: toolName, args: Object.keys(args as object) });
    const start = Date.now();
    try {
      const result = await handler(args);
      trace("tool", "tool:result", { tool: toolName, duration_ms: Date.now() - start });
      return result;
    } catch (err) {
      trace("tool", "tool:error", { tool: toolName, duration_ms: Date.now() - start }, err);
      throw err;
    }
  };
}
