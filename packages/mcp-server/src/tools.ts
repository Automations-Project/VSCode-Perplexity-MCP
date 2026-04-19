import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PerplexityClient } from "./client.js";
import type { SearchResult } from "./config.js";
import { formatResponse, buildHistoryEntry } from "./format.js";
import { appendHistory } from "./history.js";
import {
  saveResearch,
  listResearches,
  getResearch,
  updateResearch,
} from "./research-store.js";

type GetClient = () => Promise<PerplexityClient>;

function success(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function recordToolRun(options: {
  tool: string;
  query: string;
  model: string | null;
  mode: string | null;
  language: string | null;
  result?: SearchResult;
  error?: string;
}) {
  appendHistory(buildHistoryEntry(options));
}

function buildModelsResponse(client: PerplexityClient): string {
  const info = client.accountInfo;
  const tier = info.isMax
    ? "Max"
    : info.isPro
      ? "Pro"
      : info.isEnterprise
        ? "Enterprise"
        : client.authenticated
          ? "Authenticated"
          : "Anonymous";

  const lines: string[] = [
    `**Account tier:** ${tier}`,
    `**User ID:** ${client.userId || "anonymous"}`,
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

export function registerTools(
  server: McpServer,
  getClient: GetClient,
  enabledTools?: Set<string>,
): void {
  if (!enabledTools || enabledTools.has("perplexity_search")) {
    server.registerTool(
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
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_reason")) {
    server.registerTool(
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
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_research")) {
    server.registerTool(
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
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_ask")) {
    server.registerTool(
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
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_models")) {
    server.registerTool(
      "perplexity_models",
      {
        title: "Perplexity Models",
        description: "List available models and current account capabilities.",
        annotations: {
          readOnlyHint: true,
        },
      },
      async () => {
        const client = await getClient();
        return success(buildModelsResponse(client));
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_compute")) {
    server.registerTool(
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

          recordToolRun({
            tool: "perplexity_compute",
            query,
            model: resolvedModel,
            mode: "asi",
            language: language ?? "en-US",
            result,
          });

          // Auto-save research
          const isTimeout = result.answer.startsWith("ASI task timed out");
          const saved = saveResearch({
            query,
            tool: "perplexity_compute",
            model: resolvedModel,
            mode: "asi",
            language: language ?? "en-US",
            threadSlug: result.followUp?.threadUrlSlug ?? result.threadUrl?.split("/search/")[1] ?? null,
            backendUuid: result.followUp?.backendUuid ?? null,
            readWriteToken: result.followUp?.readWriteToken,
            result: isTimeout ? undefined : result,
            error: isTimeout ? result.answer : undefined,
          });

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
            error: message,
          });
          return failure(message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_retrieve")) {
    server.registerTool(
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
        const client = await getClient();

        let threadSlug = thread_slug ?? null;
        let backendUuid: string | null = null;
        let readWriteToken: string | null = null;
        let savedId: string | null = null;

        if (research_id) {
          const saved = getResearch(research_id);
          if (!saved) return failure(`Research '${research_id}' not found.`);
          threadSlug = saved.threadSlug;
          backendUuid = saved.backendUuid;
          readWriteToken = saved.readWriteToken ?? null;
          savedId = saved.id;
        }

        if (!threadSlug && !backendUuid) {
          return failure("Provide either research_id or thread_slug.");
        }

        try {
          const result = await client.retrieveThread({
            threadSlug: threadSlug!,
            backendUuid,
            readWriteToken,
          });

          if (savedId) {
            const isStillRunning = result.answer.includes("still running");
            if (!isStillRunning) {
              updateResearch(savedId, {
                status: "completed",
                completedAt: new Date().toISOString(),
                answer: result.answer,
                reasoning: result.reasoning,
                sources: result.sources,
                media: result.media,
                files: result.files,
                suggestedFollowups: result.suggestedFollowups,
                threadUrl: result.threadUrl,
                error: undefined,
              });
            }
          }

          return success(formatResponse(result));
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    );
  }

  if (!enabledTools || enabledTools.has("perplexity_list_researches")) {
    server.registerTool(
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
        const researches = listResearches({ status, limit: limit ?? 20 });

        if (researches.length === 0) {
          return success("No saved researches found.");
        }

        const lines: string[] = [`**Saved Researches** (${researches.length}):\n`];
        for (const r of researches) {
          const statusIcon = r.status === "completed" ? "\u2705" : r.status === "pending" ? "\u23F3" : "\u274C";
          const preview = r.answer ? r.answer.replace(/\s+/g, " ").slice(0, 120) + "..." : r.error || "(no content)";
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
    server.registerTool(
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
        const research = getResearch(research_id);
        if (!research) return failure(`Research '${research_id}' not found.`);

        const parts: string[] = [
          `# Research: ${research.query}`,
          `**Status:** ${research.status} | **Tool:** ${research.tool} | **Model:** ${research.model || "default"}`,
          `**Created:** ${research.createdAt}${research.completedAt ? ` | **Completed:** ${research.completedAt}` : ""}`,
        ];

        if (research.threadUrl) parts.push(`**Thread:** ${research.threadUrl}`);
        if (research.answer) parts.push("", "---", "", research.answer);
        if (research.reasoning) parts.push("", "---", "**Reasoning:**", research.reasoning);

        if (research.sources?.length) {
          parts.push("", "**Sources:**");
          for (const [i, s] of research.sources.slice(0, 15).entries()) {
            parts.push(`${i + 1}. [${s.title}](${s.url})`);
          }
        }

        if (research.files?.length) {
          parts.push("", "**Files:**");
          for (const f of research.files) {
            if (f.localPath) {
              parts.push(`- **${f.filename}** (${f.assetType}) -> \`${f.localPath}\``);
            } else if (f.url) {
              parts.push(`- **${f.filename}** (${f.assetType}) -> [Download](${f.url})`);
            }
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
    server.registerTool(
      "perplexity_login",
      {
        title: "Perplexity Login",
        description: "Open a browser window, complete Perplexity login, and persist the shared browser profile.",
      },
      async () => {
        try {
          const client = await getClient();
          const result = await client.loginViaBrowser();
          return {
            content: [{ type: "text" as const, text: result.message }],
            isError: !result.success,
          };
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    );
  }
}
