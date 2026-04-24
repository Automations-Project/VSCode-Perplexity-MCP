import type { TransportBuilder, TransportBuildInput, McpServerEntry } from "./index.js";
import { StabilityGateError } from "./index.js";

/**
 * http-loopback transport — points the client at a running daemon on
 * 127.0.0.1:<daemonPort>/mcp. Two bearer modes:
 *
 *   - `bearerKind === "none"`: OAuth variant. No headers are written; the client
 *     performs OAuth discovery against the loopback daemon.
 *   - `bearerKind === "local"`: bearer fallback. A local token (minted upstream
 *     by `issueLocalToken` in `daemon/local-tokens.ts`) is embedded as the
 *     `Authorization: Bearer <token>` header.
 *
 * This transport only supports JSON config shapes — TOML clients like Codex CLI
 * don't ingest URL+headers entries. It ignores all tunnel / provider / launcher
 * inputs because it targets a daemon already running on the loopback interface.
 */
function build(input: TransportBuildInput): McpServerEntry {
  if (input.daemonPort === null || input.daemonPort <= 0) {
    throw new StabilityGateError(
      "http-loopback",
      "daemon port unavailable — start the daemon or pin Perplexity.daemonPort to a fixed port (1024–65535)",
    );
  }

  const url = `http://127.0.0.1:${input.daemonPort}/mcp`;

  if (input.bearerKind === "local") {
    if (!input.localToken) {
      throw new TypeError('bearerKind "local" requires localToken');
    }
    return {
      url,
      headers: {
        Authorization: `Bearer ${input.localToken}`,
      },
    };
  }

  // bearerKind === "none" — OAuth variant. Any stray localToken is ignored.
  return { url };
}

export const httpLoopbackBuilder: TransportBuilder = {
  id: "http-loopback",
  supportedFormats: ["json"] as const,
  build,
};
