#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PerplexityClient } from "./client.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { loadToolConfig, getEnabledTools } from "./tool-config.js";

let client: PerplexityClient;
let clientReady = false;
let clientInitPromise: Promise<void> | null = null;

async function getClient(): Promise<PerplexityClient> {
  if (clientReady) return client;
  if (!clientInitPromise) {
    clientInitPromise = client.init().then(() => {
      clientReady = true;
      console.error("[perplexity-mcp] Client initialized (lazy).");
    });
  }
  await clientInitPromise;
  return client;
}

async function main() {
  client = new PerplexityClient();

  const server = new McpServer({
    name: "perplexity",
    version: "0.1.0",
  });

  const toolConfig = loadToolConfig();
  const enabledTools = getEnabledTools(toolConfig);

  registerResources(server);
  registerPrompts(server);
  registerTools(server, getClient, enabledTools);

  process.on("SIGINT", async () => {
    await client.shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await client.shutdown();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(async (error) => {
  console.error("[perplexity-mcp] Fatal error:", error);
  await client?.shutdown?.().catch(() => undefined);
  process.exit(1);
});

// Re-export public API for library consumers
export { PerplexityClient } from "./client.js";
export { registerTools } from "./tools.js";
export { registerPrompts } from "./prompts.js";
export { registerResources } from "./resources.js";
export { formatResponse, buildHistoryEntry, buildAnswerPreview } from "./format.js";
export { appendHistory, readHistory, getHistoryPath } from "./history.js";
export type { HistoryEntry } from "./format.js";
export type { HistoryItem } from "./history.js";
export { loadToolConfig, getEnabledTools, saveToolConfig, watchToolConfig } from "./tool-config.js";
export type { ToolProfile } from "./tool-config.js";
export { findBrowser } from "./config.js";
export type { BrowserInfo } from "./config.js";
export { refreshAccountInfo, getModelsCacheInfo, isImpitAvailable, getImpitRuntimeDir } from "./refresh.js";
export type { RefreshResult, RefreshTier, RefreshOptions } from "./refresh.js";
