import type { McpServerEntry, TransportBuildInput, TransportBuilder } from "./index.js";

/**
 * `stdio-daemon-proxy` — the DEFAULT MCP transport for "just works" installs.
 *
 * Identical to `stdio-in-process` except for the absence of
 * `PERPLEXITY_NO_DAEMON`: post-8.3 the launcher calls `ensureDaemon()` and the
 * resulting child multiplexes onto the shared daemon + Chromium instead of
 * spawning its own. The shared browser keeps per-IDE memory flat.
 */
export const stdioDaemonProxyBuilder: TransportBuilder = {
  id: "stdio-daemon-proxy",
  supportedFormats: ["json", "toml"] as const,
  build(input: TransportBuildInput): McpServerEntry {
    if (!input.launcherPath) {
      throw new TypeError("launcherPath is required");
    }

    const env: Record<string, string> = {
      PERPLEXITY_HEADLESS_ONLY: "1",
      // NOTE: no PERPLEXITY_NO_DAEMON — launcher multiplexes onto the shared daemon.
    };

    if (input.chromePath) {
      env.PERPLEXITY_CHROME_PATH = input.chromePath;
    }

    return {
      command: input.nodePath ?? process.execPath,
      args: [input.launcherPath],
      env,
    };
  },
};
