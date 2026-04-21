import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get, getHistoryDir, list } from "./history-store.js";

export interface AccountSnapshotProvider {
  (): Record<string, unknown>;
}

export function registerResources(
  server: McpServer,
  getAccountSnapshot?: AccountSnapshotProvider,
): void {
  if (getAccountSnapshot) {
    server.registerResource(
      "perplexity.account",
      "perplexity://account/status",
      {
        title: "Perplexity Account Status",
        description: "Cached account metadata loaded from the shared Perplexity browser profile.",
        mimeType: "application/json"
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(getAccountSnapshot(), null, 2)
          }
        ]
      })
    );
  }

  server.registerResource(
    "perplexity.history",
    "perplexity://history/recent",
    {
      title: "Perplexity Query History",
      description: `Recent tool invocations recorded in ${getHistoryDir()}.`,
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(list(), null, 2)
        }
      ]
    })
  );

  server.registerResource(
    "perplexity.history.entry",
    new ResourceTemplate("perplexity://history/{id}.md", {
      list: async () => ({
        resources: list({ limit: Infinity }).map((item) => ({
          uri: `perplexity://history/${item.id}.md`,
          name: item.query.slice(0, 80) || item.id,
          description: item.tool,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Perplexity History Entry",
      description: "Raw markdown for a single saved history entry.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const entry = get(String(variables.id ?? ""));
      if (!entry) {
        return { contents: [] };
      }
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: entry.body,
          },
        ],
      };
    },
  );
}
