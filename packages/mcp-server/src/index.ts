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
import { getPackageVersion } from "./package-version.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vault.js is a plain JS module; types inferred at call-site.
import { getUnsealMaterial } from "./vault.js";

let client: PerplexityClient;
let clientInitPromise: Promise<void> | null = null;

async function getClient(): Promise<PerplexityClient> {
  if (!clientInitPromise) clientInitPromise = client.init();
  await clientInitPromise;
  return client;
}

// Pre-flight runs at most once per server lifecycle; gate ensures repeated
// startups in tests / hot-reload paths don't spam the warning.
let _vaultPreflightDone = false;

export function __resetVaultPreflightForTests(): void {
  _vaultPreflightDone = false;
}

/**
 * Probe the vault unseal chain at startup. If unsealing succeeds, the result
 * is cached inside `vault.js` for free — subsequent tool calls skip the
 * keychain hit. If it fails (e.g. headless Codex CLI: no keychain, no env var,
 * no TTY), emit a structured stderr warning so the user sees the actionable
 * setup hint in their IDE's MCP server-launch logs instead of waiting for the
 * first cookie-needing tool to fail with a deep-stack "Vault locked" trace.
 *
 * Never throws. The MCP server must continue to load and serve tools that
 * don't need cookies (perplexity_doctor, anonymous perplexity_search).
 */
export async function runVaultPreflight(
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  if (_vaultPreflightDone) return;
  _vaultPreflightDone = true;
  try {
    await getUnsealMaterial();
    // Success: cache primed, no output.
  } catch (err) {
    const summary = err instanceof Error ? err.message.split("\n")[0] : String(err);
    stderr.write(`[perplexity-mcp] WARN vault-locked: ${summary}\n`);
    stderr.write(`[perplexity-mcp]   Setup docs: docs/codex-cli-setup.md\n`);
    stderr.write(`[perplexity-mcp]   Tools that don't need cookies (perplexity_doctor, perplexity_search anonymous mode) will still work.\n`);
    stderr.write(`[perplexity-mcp]   Tools that need cookies (perplexity_research, perplexity_compute, perplexity_reason) will fail until the vault is unsealed.\n`);
  }
}

export async function waitForStdioInputClose(
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<void> {
  stdin.resume();
  await new Promise<void>((resolve) => {
    const done = () => {
      stdin.off("end", done);
      stdin.off("close", done);
      resolve();
    };
    stdin.once("end", done);
    stdin.once("close", done);
  });
}

export async function main() {
  client = new PerplexityClient();

  const server = new McpServer({
    name: "perplexity",
    version: getPackageVersion(),
  });

  const toolConfig = loadToolConfig();
  const enabledTools = getEnabledTools(toolConfig);

  registerResources(server);
  registerPrompts(server);
  registerTools(server, getClient, enabledTools);

  const profile = process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
  console.error(`[perplexity-mcp] Starting with profile: ${profile}`);

  // Pre-flight the vault unseal chain BEFORE the stdio transport connects, so
  // any "Vault locked" warning lands in the IDE's server-launch logs rather
  // than surfacing later as a cryptic deep-stack error on the first cookie
  // call. Never throws — the server still serves doctor + anonymous search.
  await runVaultPreflight();

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
  try {
    await waitForStdioInputClose();
  } finally {
    watcher.dispose();
    await client.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEntrypoint().catch(async (error) => {
    console.error("[perplexity-mcp] Fatal error:", error);
    await client?.shutdown?.().catch(() => undefined);
    process.exit(1);
  });
}

async function runEntrypoint() {
  if (process.argv.length > 2) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - cli.js is a plain JS module; types inferred at runtime.
    const { parseArgs, routeCommand } = await import("./cli.js");
    const result = await routeCommand(parseArgs(process.argv.slice(2)));
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.code;
    return;
  }

  await main();
}

// Re-export public API for library consumers
export { PerplexityClient } from "./client.js";
export { ensureDaemon, startDaemon } from "./daemon/launcher.js";
export { attachToDaemon } from "./daemon/attach.js";
export { registerTools } from "./tools.js";
export { registerPrompts } from "./prompts.js";
export { registerResources } from "./resources.js";
export { formatResponse, buildHistoryBody, buildHistoryEntry, buildStoredHistoryEntry, buildAnswerPreview } from "./format.js";
export {
  append as appendHistory,
  countAll as countAllHistory,
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
