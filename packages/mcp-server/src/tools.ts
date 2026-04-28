import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import type { PerplexityClient } from "./client.js";
import { exportThreadViaImpit, readCachedAccountInfoFromDisk, retrieveThreadViaImpit } from "./client.js";
import type { AccountInfo, SearchResult } from "./config.js";
import { hydrateCloudHistoryEntry, syncCloudHistory } from "./cloud-sync.js";
import { buildStoredHistoryEntry, formatResponse } from "./format.js";
import {
  append,
  findPendingByThread,
  get,
  getAttachmentsDir,
  list,
  update,
} from "./history-store.js";

type GetClient = () => Promise<PerplexityClient>;

export interface ToolAuditEvent {
  tool: string;
  clientId: string;
  source: "loopback" | "tunnel";
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ToolProgressEvent {
  tool: string;
  clientId: string;
  source: "loopback" | "tunnel";
  progress: Record<string, unknown>;
}

export interface ToolHooks {
  onToolSettled?: (event: ToolAuditEvent) => void;
  onToolProgress?: (event: ToolProgressEvent) => void;
}

function success(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function getClientTier(client: PerplexityClient): "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous" {
  return client.accountInfo.isMax
    ? "Max"
    : client.accountInfo.isPro
      ? "Pro"
      : client.accountInfo.isEnterprise
        ? "Enterprise"
        : client.authenticated
          ? "Authenticated"
          : "Anonymous";
}

function recordToolRun(options: {
  tool: string;
  query: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  tier?: "Max" | "Pro" | "Enterprise" | "Authenticated" | "Anonymous";
  status?: "completed" | "pending" | "failed";
  result?: SearchResult;
  error?: string;
}) {
  try {
    append(buildStoredHistoryEntry(options));
  } catch {
    // History persistence must never break the MCP response path.
  }
}

function isResearchTool(tool: string): boolean {
  return tool === "perplexity_compute" || tool === "perplexity_research";
}

function buildModelsResponseFromAccountInfo(
  info: AccountInfo,
  userId: string | null,
  authenticated: boolean,
): string {
  const tier = info.isMax
    ? "Max"
    : info.isPro
      ? "Pro"
      : info.isEnterprise
        ? "Enterprise"
        : authenticated
          ? "Authenticated"
          : "Anonymous";

  const lines: string[] = [
    `**Account tier:** ${tier}`,
    `**User ID:** ${userId || "anonymous"}`,
    `**Computer mode:** ${info.canUseComputer ? "Available" : "Not available"}`,
  ];

  if (info.modelsConfig) {
    const groups: Record<string, typeof info.modelsConfig.config> = {};
    for (const entry of info.modelsConfig.config) {
      const mode =
        info.modelsConfig.models[entry.non_reasoning_model || entry.reasoning_model || ""]?.mode || "other";
      if (!groups[mode]) {
        groups[mode] = [];
      }
      groups[mode].push(entry);
    }

    for (const [mode, entries] of Object.entries(groups)) {
      lines.push("");
      lines.push(`## ${mode}`);
      for (const entry of entries) {
        const tierBadge =
          entry.subscription_tier === "max"
            ? " [MAX]"
            : entry.subscription_tier === "pro"
              ? " [PRO]"
              : "";
        const models = [entry.non_reasoning_model, entry.reasoning_model]
          .filter(Boolean)
          .map((value) => `\`${value}\``)
          .join(", ");
        lines.push(`- **${entry.label}**${tierBadge}: ${models}`);
        lines.push(`  ${entry.description}`);
      }
    }

    lines.push("");
    lines.push("## Default Models");
    for (const [mode, modelId] of Object.entries(info.modelsConfig.default_models)) {
      lines.push(`- **${mode}**: \`${modelId}\``);
    }
  }

  if (info.rateLimits) {
    lines.push("");
    lines.push("## Rate Limits");
    for (const [mode, state] of Object.entries(info.rateLimits.modes)) {
      const remaining =
        state.remaining_detail.kind === "exact" && typeof state.remaining_detail.remaining === "number"
          ? ` (${state.remaining_detail.remaining} remaining)`
          : "";
      lines.push(`- **${mode}**: ${state.available ? "available" : "unavailable"}${remaining}`);
    }
  }

  return lines.join("\n");
}

function buildModelsResponse(client: PerplexityClient): string {
  return buildModelsResponseFromAccountInfo(client.accountInfo, client.userId, client.authenticated);
}

export function registerTools(
  server: McpServer,
  getClient: GetClient,
  enabledTools?: Set<string>,
  hooks: ToolHooks = {},
): void {
  type ToolConfigBase = {
    title?: string;
    description?: string;
    annotations?: Record<string, unknown>;
    outputSchema?: ZodRawShapeCompat | AnySchema;
    _meta?: Record<string, unknown>;
  };

  type ToolConfigWithInput<InputArgs extends ZodRawShapeCompat | AnySchema> = ToolConfigBase & {
    inputSchema: InputArgs;
  };

  type ToolConfigWithoutInput = ToolConfigBase & {
    inputSchema?: undefined;
  };

  function registerDaemonTool<InputArgs extends ZodRawShapeCompat | AnySchema>(
    name: string,
    config: ToolConfigWithInput<InputArgs>,
    handler: (args: any, extra: any) => Promise<any>,
  ): void;
  function registerDaemonTool(
    name: string,
    config: ToolConfigWithoutInput,
    handler: (extra: any) => Promise<any>,
  ): void;
  function registerDaemonTool(
    name: string,
    config: ToolConfigWithInput<ZodRawShapeCompat | AnySchema> | ToolConfigWithoutInput,
    handler: ((args: any, extra: any) => Promise<any>) | ((extra: any) => Promise<any>),
  ): void {
    const runWithAudit = async (extra: any, invoke: () => Promise<any>) => {
      const startedAt = Date.now();
      try {
        const result = await invoke();
        hooks.onToolSettled?.({
          tool: name,
          clientId: getClientId(extra),
          source: getRequestSource(extra),
          durationMs: Date.now() - startedAt,
          ok: !Boolean(result?.isError),
          ...(result?.isError ? { error: extractToolError(result) } : {}),
        });
        return result;
      } catch (error) {
        hooks.onToolSettled?.({
          tool: name,
          clientId: getClientId(extra),
          source: getRequestSource(extra),
          durationMs: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    if (config.inputSchema) {
      server.registerTool(name, config, async (args: any, extra: any) =>
        runWithAudit(extra, () => (handler as (args: any, extra: any) => Promise<any>)(args, extra)),
      );
      return;
    }

    server.registerTool(name, config, async (extra: any) =>
      runWithAudit(extra, () => (handler as (extra: any) => Promise<any>)(extra)),
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_search")) {
    registerDaemonTool(
      "perplexity_search",
      {
        title: "Perplexity Search",
        description: "Search the web using Perplexity AI with automatic anonymous or authenticated defaults.",
        inputSchema: {
          query: z.string().describe("The search query or question to ask."),
          sources: z.array(z.enum(["web", "scholar", "social"])).optional(),
          language: z.string().optional(),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ query, sources, language }) => {
        try {
          const client = await getClient();
          const model = process.env.PERPLEXITY_SEARCH_MODEL || (client.authenticated ? "pplx_pro" : "turbo");
          const mode = client.authenticated ? "copilot" : "concise";
          const result = await client.search({
            query,
            modelPreference: model,
            mode,
            sources: sources ?? ["web"],
            language: language ?? "en-US",
          });

          recordToolRun({
            tool: "perplexity_search",
            query,
            model,
            mode,
            language: language ?? "en-US",
            tier: getClientTier(client),
            result,
          });
          return success(formatResponse(result));
        } catch (error) {
          const message = (error as Error).message;
          recordToolRun({
            tool: "perplexity_search",
            query,
            model: process.env.PERPLEXITY_SEARCH_MODEL || null,
            mode: null,
            language: language ?? "en-US",
            status: "failed",
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_reason")) {
    registerDaemonTool(
      "perplexity_reason",
      {
        title: "Perplexity Reason",
        description: "Use a reasoning model for multi-step analysis and explanation.",
        inputSchema: {
          query: z.string(),
          sources: z.array(z.enum(["web", "scholar", "social"])).optional(),
          language: z.string().optional(),
          model: z.string().optional(),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ query, sources, language, model }) => {
        const client = await getClient();
        if (!client.authenticated) {
          return failure("perplexity_reason requires an authenticated Pro account.");
        }

        try {
          const resolvedModel = model || process.env.PERPLEXITY_REASON_MODEL || "claude46sonnetthinking";
          const result = await client.search({
            query,
            modelPreference: resolvedModel,
            mode: "copilot",
            sources: sources ?? ["web"],
            language: language ?? "en-US",
          });

          recordToolRun({
            tool: "perplexity_reason",
            query,
            model: resolvedModel,
            mode: "copilot",
            language: language ?? "en-US",
            tier: getClientTier(client),
            result,
          });
          return success(formatResponse(result));
        } catch (error) {
          const message = (error as Error).message;
          recordToolRun({
            tool: "perplexity_reason",
            query,
            model: model ?? process.env.PERPLEXITY_REASON_MODEL ?? null,
            mode: "copilot",
            language: language ?? "en-US",
            tier: getClientTier(client),
            status: "failed",
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_research")) {
    registerDaemonTool(
      "perplexity_research",
      {
        title: "Perplexity Research",
        description: "Run a deep research task with the long-form research model.",
        inputSchema: {
          query: z.string(),
          sources: z.array(z.enum(["web", "scholar", "social"])).optional(),
          language: z.string().optional(),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ query, sources, language }) => {
        const client = await getClient();
        if (!client.authenticated) {
          return failure("perplexity_research requires an authenticated Pro account.");
        }

        try {
          const model = process.env.PERPLEXITY_RESEARCH_MODEL || "pplx_alpha";
          console.error("[perplexity-mcp] Starting deep research...");
          const result = await client.search({
            query,
            modelPreference: model,
            mode: "copilot",
            sources: sources ?? ["web"],
            language: language ?? "en-US",
          });
          console.error("[perplexity-mcp] Research complete.");

          recordToolRun({
            tool: "perplexity_research",
            query,
            model,
            mode: "copilot",
            language: language ?? "en-US",
            tier: getClientTier(client),
            result,
          });
          return success(formatResponse(result));
        } catch (error) {
          const message = (error as Error).message;
          recordToolRun({
            tool: "perplexity_research",
            query,
            model: process.env.PERPLEXITY_RESEARCH_MODEL ?? "pplx_alpha",
            mode: "copilot",
            language: language ?? "en-US",
            tier: getClientTier(client),
            status: "failed",
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_ask")) {
    registerDaemonTool(
      "perplexity_ask",
      {
        title: "Perplexity Ask",
        description: "Query Perplexity with explicit control over model, mode, and follow-up context.",
        inputSchema: {
          query: z.string(),
          model: z.string().optional(),
          mode: z.enum(["concise", "copilot"]).optional(),
          sources: z.array(z.enum(["web", "scholar", "social"])).optional(),
          language: z.string().optional(),
          follow_up_context: z.string().optional(),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ query, model, mode, sources, language, follow_up_context }) => {
        const client = await getClient();
        let followUp: { backendUuid: string; readWriteToken?: string | null } | undefined;

        if (follow_up_context) {
          try {
            followUp = JSON.parse(follow_up_context) as { backendUuid: string; readWriteToken?: string | null };
          } catch {
            return failure("follow_up_context must be valid JSON.");
          }
        }

        try {
          const resolvedModel = model ?? process.env.PERPLEXITY_SEARCH_MODEL ?? "pplx_pro";
          const resolvedMode = mode ?? "copilot";
          const result = await client.search({
            query,
            modelPreference: resolvedModel,
            mode: resolvedMode,
            sources: sources ?? ["web"],
            language: language ?? "en-US",
            followUp,
          });

          recordToolRun({
            tool: "perplexity_ask",
            query,
            model: resolvedModel,
            mode: resolvedMode,
            language: language ?? "en-US",
            tier: getClientTier(client),
            result,
          });

          let response = formatResponse(result);
          if (result.followUp) {
            response += `\n\n---\n**Follow-up context:**\n\`\`\`json\n${JSON.stringify(result.followUp, null, 2)}\n\`\`\``;
          }
          return success(response);
        } catch (error) {
          const message = (error as Error).message;
          recordToolRun({
            tool: "perplexity_ask",
            query,
            model: model ?? process.env.PERPLEXITY_SEARCH_MODEL ?? null,
            mode: mode ?? "copilot",
            language: language ?? "en-US",
            tier: getClientTier(client),
            status: "failed",
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_models")) {
    registerDaemonTool(
      "perplexity_models",
      {
        title: "Perplexity Models",
        description: "List available models and current account capabilities.",
        annotations: {
          readOnlyHint: true,
        },
      },
      async () => {
        // Cache-first path: read the on-disk AccountInfo cache (written by
        // refresh.ts on every successful tier-fetch and by login-runner
        // after a fresh login). Skips the browser launch entirely on warm
        // runs. Falls back to the lazy getClient() → init() live fetch
        // when the cache is missing or empty (modelsConfig === null).
        // userId is not currently persisted to the cache file — pass null
        // and let the response render `User ID: anonymous`. authenticated
        // is true iff modelsConfig is populated (matches today's behavior:
        // anonymous accounts have a minimal models config).
        // TODO: background refresh on stale cache
        const cached = readCachedAccountInfoFromDisk();
        if (cached?.modelsConfig) {
          return success(buildModelsResponseFromAccountInfo(cached, null, true));
        }
        const client = await getClient();
        return success(buildModelsResponse(client));
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_compute")) {
    registerDaemonTool(
      "perplexity_compute",
      {
        title: "Perplexity Compute",
        description: "Run a task using Perplexity Computer mode (ASI).",
        inputSchema: {
          query: z.string(),
          model: z.string().optional(),
          language: z.string().optional(),
        },
      },
      async ({ query, model, language }) => {
        const client = await getClient();
        if (!client.authenticated) {
          return failure("perplexity_compute requires an authenticated account.");
        }

        if (!client.accountInfo.canUseComputer) {
          return failure("Computer mode is not available on this account.");
        }

        try {
          const defaultModel = client.accountInfo.modelsConfig?.default_models?.asi || "pplx_asi";
          const resolvedModel = model || process.env.PERPLEXITY_COMPUTE_MODEL || defaultModel;
          console.error("[perplexity-mcp] Starting ASI compute task...");
          const result = await client.computeASI({
            query,
            modelPreference: resolvedModel,
            language: language ?? "en-US",
          });
          console.error("[perplexity-mcp] Compute task complete.");

          // Auto-save research
          const isTimeout = result.answer.startsWith("ASI task timed out");
          const saved = append(buildStoredHistoryEntry({
            query,
            tool: "perplexity_compute",
            model: resolvedModel,
            mode: "asi",
            language: language ?? "en-US",
            tier: getClientTier(client),
            result,
            status: isTimeout ? "pending" : "completed",
            ...(isTimeout ? { error: result.answer } : {}),
          }));

          let response = formatResponse(result);
          if (isTimeout) {
            response += `\n\n---\n**Research saved** (id: \`${saved.id}\`). Use \`perplexity_retrieve\` with this id to fetch results once complete.`;
          } else {
            response += `\n\n---\n**Research saved** (id: \`${saved.id}\`).`;
          }
          return success(response);
        } catch (error) {
          const message = (error as Error).message;
          recordToolRun({
            tool: "perplexity_compute",
            query,
            model: model ?? process.env.PERPLEXITY_COMPUTE_MODEL ?? null,
            mode: "asi",
            language: language ?? "en-US",
            tier: getClientTier(client),
            status: "failed",
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_retrieve")) {
    registerDaemonTool(
      "perplexity_retrieve",
      {
        title: "Perplexity Retrieve",
        description: "Retrieve results from a previously timed-out or pending research/compute task.",
        inputSchema: {
          research_id: z.string().optional().describe("ID of a saved research"),
          thread_slug: z.string().optional().describe("Perplexity thread slug from the URL"),
        },
      },
      async ({ research_id, thread_slug }) => {
        let threadSlug = thread_slug ?? null;
        let backendUuid: string | null = null;
        let readWriteToken: string | null = null;
        let savedId: string | null = null;

        if (research_id) {
          const saved = get(research_id);
          if (!saved) return failure(`Research '${research_id}' not found.`);
          threadSlug = saved.threadSlug ?? null;
          backendUuid = saved.backendUuid ?? null;
          readWriteToken = saved.readWriteToken ?? null;
          savedId = saved.id;
        } else if (thread_slug) {
          const pending = findPendingByThread(thread_slug);
          if (pending) {
            backendUuid = pending.backendUuid ?? null;
            readWriteToken = pending.readWriteToken ?? null;
            savedId = pending.id;
          }
        }

        if (!threadSlug && !backendUuid) {
          return failure("Provide either research_id or thread_slug.");
        }

        // Try the impit fast path before forcing a browser launch. The
        // standalone helper returns null on any failure (no impit, no
        // session cookie, has files, "still running", parse error), in
        // which case we fall through to the browser path.
        try {
          const fast = await retrieveThreadViaImpit({
            threadSlug: threadSlug ?? "",
            backendUuid,
            readWriteToken,
          });
          if (fast) {
            if (savedId) {
              const isStillRunning = fast.answer.includes("still running");
              const existing = get(savedId);
              if (existing) {
                update(savedId, buildStoredHistoryEntry({
                  tool: existing.tool,
                  query: existing.query,
                  model: existing.model,
                  mode: existing.mode,
                  language: existing.language,
                  tier: existing.tier,
                  createdAt: existing.createdAt,
                  status: isStillRunning ? "pending" : "completed",
                  completedAt: isStillRunning ? existing.completedAt : new Date().toISOString(),
                  result: fast,
                  ...(isStillRunning ? { error: fast.answer } : {}),
                }));
              }
            }
            return success(formatResponse(fast));
          }
        } catch (err) {
          console.error(`[perplexity-mcp] retrieve impit fast path threw: ${(err as Error).message}; falling back to browser.`);
        }

        const client = await getClient();
        try {
          const result = await client.retrieveThread({
            threadSlug: threadSlug!,
            backendUuid,
            readWriteToken,
          });

          if (savedId) {
            const isStillRunning = result.answer.includes("still running");
            const existing = get(savedId);
            if (existing) {
              update(savedId, buildStoredHistoryEntry({
                tool: existing.tool,
                query: existing.query,
                model: existing.model,
                mode: existing.mode,
                language: existing.language,
                tier: existing.tier,
                createdAt: existing.createdAt,
                status: isStillRunning ? "pending" : "completed",
                completedAt: isStillRunning ? existing.completedAt : new Date().toISOString(),
                result,
                ...(isStillRunning ? { error: result.answer } : {}),
              }));
            }
          }

          return success(formatResponse(result));
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_export")) {
    registerDaemonTool(
      "perplexity_export",
      {
        title: "Perplexity Export",
        description: "Export a saved history entry using Perplexity's native export endpoint when available, with local markdown fallback.",
        inputSchema: {
          history_id: z.string().describe("Saved history entry id"),
          format: z.enum(["pdf", "markdown", "docx"]).describe("Export format"),
        },
      },
      async ({ history_id, format }) => {
        const entry = get(history_id);
        if (!entry) {
          return failure(`History entry '${history_id}' not found.`);
        }

        const attachmentsDir = getAttachmentsDir(history_id) ?? entry.attachmentsDir;
        mkdirSync(attachmentsDir, { recursive: true });

        if (format === "markdown") {
          const savedPath = join(attachmentsDir, entry.mdPath.split(/[\\/]/).pop() || `${entry.id}.md`);
          writeFileSync(savedPath, readFileSync(entry.mdPath, "utf8"), "utf8");
          return success(`Saved markdown export to \`${savedPath}\`.`);
        }

        if (!entry.threadSlug) {
          return failure("This entry cannot be exported natively because it has no Perplexity thread slug.");
        }

        // Try the impit fast path before forcing a browser launch. The
        // standalone helper returns null on any failure (no impit, no
        // session cookie, can't resolve entry UUID, non-200), in which
        // case we fall through to the lazy getClient() path below.
        try {
          const fast = await exportThreadViaImpit({ threadSlug: entry.threadSlug, format });
          if (fast) {
            const savedPath = join(attachmentsDir, fast.filename);
            mkdirSync(dirname(savedPath), { recursive: true });
            writeFileSync(savedPath, fast.buffer);
            return success(`Saved ${format} export to \`${savedPath}\` (${fast.buffer.length} bytes).`);
          }
        } catch (err) {
          console.error(`[perplexity-mcp] export impit fast path threw: ${(err as Error).message}; falling back to browser.`);
        }

        const client = await getClient();
        const exported = await client.exportThread({ threadSlug: entry.threadSlug, format });
        const savedPath = join(attachmentsDir, exported.filename);
        mkdirSync(dirname(savedPath), { recursive: true });
        writeFileSync(savedPath, exported.buffer);
        return success(`Saved ${format} export to \`${savedPath}\` (${exported.buffer.length} bytes).`);
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_sync_cloud")) {
    registerDaemonTool(
      "perplexity_sync_cloud",
      {
        title: "Perplexity Sync Cloud",
        description: "Sync Perplexity cloud history into the local history store using the daemon singleton client.",
        inputSchema: {
          page_size: z.number().int().positive().optional().describe("Optional page size for cloud thread pagination."),
        },
      },
      async ({ page_size }, extra) => {
        const clientId = getClientId(extra);
        const source = getRequestSource(extra);
        // Pass `getClient` instead of `client` so cloud-sync can take the
        // impit fast path (no browser) when Speed Boost is installed. The
        // browser is only spawned if impit misses on a page.
        const result = await syncCloudHistory({
          getClient,
          pageSize: page_size,
          onProgress: (progress) => {
            hooks.onToolProgress?.({
              tool: "perplexity_sync_cloud",
              clientId,
              source,
              progress: { ...progress },
            });
          },
        });
        return success(
          `Cloud sync complete: fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`,
        );
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_hydrate_cloud_entry")) {
    registerDaemonTool(
      "perplexity_hydrate_cloud_entry",
      {
        title: "Perplexity Hydrate Cloud Entry",
        description: "Hydrate a single cloud-backed history entry using the daemon singleton client.",
        inputSchema: {
          history_id: z.string().describe("Cloud-backed history entry id to hydrate."),
        },
      },
      async ({ history_id }) => {
        // Pass `getClient` (lazy) instead of `client` (eager) so the impit
        // fast path inside hydrateCloudHistoryEntry can serve the request
        // without spawning a browser when Speed Boost is installed.
        const result = await hydrateCloudHistoryEntry(history_id, { getClient });
        return success(`Cloud hydrate ${result.action}: ${result.id ?? history_id}`);
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_list_researches")) {
    registerDaemonTool(
      "perplexity_list_researches",
      {
        title: "Perplexity List Researches",
        description: "List saved researches with their status. Pending ones can be retrieved with perplexity_retrieve.",
        inputSchema: {
          status: z.enum(["completed", "pending", "failed"]).optional(),
          limit: z.number().optional().describe("Max results (default 20)"),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ status, limit }) => {
        const researches = list({
          status,
          limit: limit ?? 20,
          tools: ["perplexity_compute", "perplexity_research"],
        }).filter((entry) => isResearchTool(entry.tool));

        if (researches.length === 0) {
          return success("No saved researches found.");
        }

        const lines: string[] = [`**Saved Researches** (${researches.length}):\n`];
        for (const r of researches) {
          const statusIcon = r.status === "completed" ? "\u2705" : r.status === "pending" ? "\u23F3" : "\u274C";
          const preview = r.answerPreview || r.error || "(no content)";
          lines.push(`${statusIcon} **${r.query.slice(0, 80)}**`);
          lines.push(`   ID: \`${r.id}\` | Tool: ${r.tool} | ${r.createdAt}`);
          lines.push(`   ${preview}`);
          if (r.threadUrl) lines.push(`   Thread: ${r.threadUrl}`);
          lines.push("");
        }

        return success(lines.join("\n"));
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_get_research")) {
    registerDaemonTool(
      "perplexity_get_research",
      {
        title: "Perplexity Get Research",
        description: "Get the full content of a saved research by ID, including answer, sources, and files.",
        inputSchema: {
          research_id: z.string().describe("ID of the saved research"),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ research_id }) => {
        const research = get(research_id);
        if (!research) return failure(`Research '${research_id}' not found.`);

        const parts: string[] = [
          `# Research: ${research.query}`,
          `**Status:** ${research.status || "completed"} | **Tool:** ${research.tool} | **Model:** ${research.model || "default"}`,
          `**Created:** ${research.createdAt}${research.completedAt ? ` | **Completed:** ${research.completedAt}` : ""}`,
        ];

        if (research.threadUrl) parts.push(`**Thread:** ${research.threadUrl}`);
        if (research.body) parts.push("", "---", "", research.body);

        if (research.sources?.length) {
          parts.push("", "**Sources:**");
          for (const [i, s] of research.sources.slice(0, 15).entries()) {
            parts.push(`${i + 1}. [${s.title}](${s.url})`);
          }
        }

        if (research.attachments?.length) {
          parts.push("", "**Files:**");
          for (const file of research.attachments) {
            parts.push(`- **${file.filename}** -> \`${file.relPath}\``);
          }
        }

        if (research.error) parts.push("", `**Error:** ${research.error}`);

        if (research.status === "pending") {
          parts.push("", `---\n*This research is still pending. Use \`perplexity_retrieve\` with id \`${research.id}\` to fetch updated results.*`);
        }

        return success(parts.join("\n"));
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_login")) {
    registerDaemonTool(
      "perplexity_login",
      {
        title: "Perplexity Login",
        description: "Returns instructions for completing Perplexity login. Login is interactive (email + OTP) and must be initiated from the IDE extension dashboard or the CLI — an MCP tool call cannot prompt for the OTP.",
      },
      async () => {
        // Login is interactive and an MCP tool call has no surface to prompt
        // for the email + OTP. We return a clear, non-error message pointing
        // the user at the supported entry points instead of throwing — which
        // previously surfaced as a misleading "unexpected nil response"
        // transport error in MCP clients.
        const message = [
          "**Perplexity login is interactive — run it from the dashboard or CLI:**",
          "",
          "1. **IDE / Extension:** open the Perplexity dashboard and click *Login*. Enter your email; the OTP prompt appears in the dashboard.",
          "2. **CLI:** `npx perplexity-user-mcp login --mode auto --email YOUR_EMAIL@example.com` — the OTP is read from your terminal.",
          "",
          "Both paths share the same vault, so once you're logged in via either, all MCP tools (search, reason, research, sync, hydrate, etc.) work immediately. Speed Boost (impit) is used automatically when installed.",
        ].join("\n");
        return {
          content: [{ type: "text" as const, text: message }],
          isError: false,
        };
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_doctor")) {
    registerDaemonTool(
      "perplexity_doctor",
      {
        title: "Perplexity Doctor",
        description: "Run diagnostic checks against your Perplexity MCP install. Returns a Markdown report across ten categories; pass probe:true for a live search probe.",
        inputSchema: {
          probe: z.boolean().optional(),
          profile: z.string().optional(),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ probe, profile }) => {
        const { runAll, formatReportMarkdown } = await import("./doctor.js");
        const report = await runAll({ probe: !!probe, profile });
        return success(formatReportMarkdown(report));
      },
    );
  }
}

function getClientId(extra: any): string {
  return typeof extra?.authInfo?.clientId === "string" && extra.authInfo.clientId.length > 0
    ? extra.authInfo.clientId
    : "daemon-client";
}

function getRequestSource(extra: any): "loopback" | "tunnel" {
  return extra?.authInfo?.extra?.source === "tunnel" ? "tunnel" : "loopback";
}

function extractToolError(result: any): string {
  const firstText = result?.content?.find?.((item: any) => item?.type === "text" && typeof item.text === "string");
  return typeof firstText?.text === "string" ? firstText.text : "Tool returned an error result.";
}
