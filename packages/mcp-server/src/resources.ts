import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getHistoryPath, readHistory } from "./history.js";

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
      description: `Recent tool invocations recorded in ${getHistoryPath()}.`,
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(readHistory(), null, 2)
        }
      ]
    })
  );
}
