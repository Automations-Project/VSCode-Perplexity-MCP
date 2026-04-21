#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PerplexityClient } from "./client.js";
import { ensureDaemon, startDaemon } from "./daemon/launcher.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { loadToolConfig, getEnabledTools } from "./tool-config.js";
import { watchReinit } from "./reinit-watcher.js";
import { getActiveName } from "./profiles.js";

let client: PerplexityClient;
let clientInitPromise: Promise<void> | null = null;

async function getClient(): Promise<PerplexityClient> {
  if (!clientInitPromise) clientInitPromise = client.init();
  await clientInitPromise;
  return client;
}

export async function main() {
  client = new PerplexityClient();

  const server = new McpServer({
    name: "perplexity",
    version: "0.5.0",
  });

  const toolConfig = loadToolConfig();
  const enabledTools = getEnabledTools(toolConfig);

  registerResources(server);
  registerPrompts(server);
  registerTools(server, getClient, enabledTools);

  const profile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
  console.error(`[perplexity-mcp] Starting with profile: ${profile}`);

  const watcher = watchReinit(profile, async () => {
    console.error("[perplexity-mcp] .reinit sentinel fired — reloading client.");
    try {
      clientInitPromise = client.reinit();
      await clientInitPromise;
    } catch (err) {
      console.error("[perplexity-mcp] reinit failed:", err);
    }
  });

  process.on("SIGINT", async () => {
    watcher.dispose();
    await client.shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    watcher.dispose();
    await client.shutdown();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    console.error("[perplexity-mcp] Fatal error:", error);
    await client?.shutdown?.().catch(() => undefined);
    process.exit(1);
  });
}

// Re-export public API for library consumers
export { PerplexityClient } from "./client.js";
export { ensureDaemon, startDaemon } from "./daemon/launcher.js";
export { registerTools } from "./tools.js";
export { registerPrompts } from "./prompts.js";
export { registerResources } from "./resources.js";
export { formatResponse, buildHistoryBody, buildHistoryEntry, buildStoredHistoryEntry, buildAnswerPreview } from "./format.js";
export {
  append as appendHistory,
  deleteEntry,
  findPendingByThread,
  get,
  getAttachmentsDir,
  getAttachmentsRoot,
  getHistoryDir,
  getIndexPath as getHistoryPath,
  getMdPath,
  list as readHistory,
  pin,
  rebuildIndex,
  tag,
  update,
  findByBackendUuid,
  upsertFromCloud,
  hydrateCloudEntry,
} from "./history-store.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – cloud-sync.js is a plain JS module; types inferred at call-site
export { syncCloudHistory, hydrateCloudHistoryEntry } from "./cloud-sync.js";
export { exportThread } from "./export.js";
export type { HistoryEntry } from "./format.js";
export type { HistoryItem } from "@perplexity-user-mcp/shared";
export { loadToolConfig, getEnabledTools, saveToolConfig, watchToolConfig } from "./tool-config.js";
export type { ToolProfile } from "./tool-config.js";
export { findBrowser } from "./config.js";
export type { BrowserInfo } from "./config.js";
export { refreshAccountInfo, getModelsCacheInfo, isImpitAvailable, getImpitRuntimeDir } from "./refresh.js";
export type { RefreshResult, RefreshTier, RefreshOptions } from "./refresh.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – doctor.js is a plain JS module; types inferred at call-site
export { runAll as runDoctor, formatReportMarkdown, CATEGORIES as DOCTOR_CATEGORIES } from "./doctor.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – doctor-report.js is a plain JS module; types inferred at call-site
export { buildIssueBody, redactIssueBody, buildIssueUrl, decideTransport } from "./doctor-report.js";
