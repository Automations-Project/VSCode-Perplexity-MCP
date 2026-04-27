import type { TransportBuilder, TransportBuildInput, McpServerEntry } from "./index.js";

/**
 * Phase 8.6.3 — "stdio-in-process" transport builder.
 *
 * The legacy stdio path. The IDE spawns a Node process that runs the MCP server
 * in-process, with no daemon round-trip. Chosen by users on airgapped systems
 * or who deliberately don't want the long-lived daemon.
 *
 * `PERPLEXITY_NO_DAEMON=1` tells the launcher to skip daemon lookup;
 * `PERPLEXITY_HEADLESS_ONLY=1` forces the client into its non-UI code path
 * (no dashboard pings, no login prompts — the extension host handles those).
 *
 * Bearer tokens are ignored here: stdio MCP has no auth surface, so even when
 * `applyIdeConfig` passes `bearerKind: "local"` + a token (because some IDE
 * capability matrix said it was allowed), this builder drops them. Auth is the
 * HTTP transports' concern.
 *
 * Node path defaulting — the user of this builder (`applyIdeConfig` in 8.6.4)
 * is expected to populate `input.nodePath` from native-deps detection.
 * `process.execPath` is a last-resort fallback; on a VS Code extension host
 * that's Electron with `ELECTRON_RUN_AS_NODE=1`, which won't work as a child
 * stdio server. Surface that caveat to the caller, not here.
 */
export const stdioInProcessBuilder: TransportBuilder = {
  id: "stdio-in-process",
  supportedFormats: ["json", "toml"] as const,
  build(input: TransportBuildInput): McpServerEntry {
    if (!input.launcherPath) {
      throw new TypeError("launcherPath is required");
    }

    const env: Record<string, string> = {
      PERPLEXITY_HEADLESS_ONLY: "1",
      PERPLEXITY_NO_DAEMON: "1",
    };

    if (typeof input.chromePath === "string" && input.chromePath.length > 0) {
      env.PERPLEXITY_CHROME_PATH = input.chromePath;
    }

    return {
      // Use a bare Node fallback instead of process.execPath: extension hosts
      // often set execPath to the IDE/Electron binary, not a child-safe Node.
      command: input.nodePath || "node",
      args: [input.launcherPath],
      env,
    };
  },
};
