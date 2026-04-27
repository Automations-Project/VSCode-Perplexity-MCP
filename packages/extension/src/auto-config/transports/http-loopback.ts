import type { TransportBuilder, TransportBuildInput, McpServerEntry } from "./index.js";
import { StabilityGateError } from "./index.js";

/**
 * http-loopback transport — points the client at a running daemon on
 * 127.0.0.1:<daemonPort>/mcp. Three bearer modes:
 *
 *   - `bearerKind === "none"`: OAuth variant. No headers are written; the client
 *     performs OAuth discovery against the loopback daemon.
 *   - `bearerKind === "static"`: pragmatic default — embeds the daemon's shared
 *     static bearer as `Authorization: Bearer <staticBearer>`. The daemon's
 *     source-aware `verifyAccessToken` accepts the static bearer on loopback
 *     (v0.8.4 baseline — see docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md).
 *   - `bearerKind === "local"`: per-IDE scoped token (minted upstream by
 *     `issueLocalToken` in `daemon/local-tokens.ts`). Primitives stay for a
 *     future evidence-gated flip; not the default in v0.8.4.
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

  if (input.bearerKind === "static") {
    if (!input.staticBearer) {
      throw new TypeError('bearerKind "static" requires staticBearer');
    }
    return {
      url,
      headers: {
        Authorization: `Bearer ${input.staticBearer}`,
      },
    };
  }

  // bearerKind === "none" — OAuth variant. Any stray localToken / staticBearer ignored.
  return { url };
}

export const httpLoopbackBuilder: TransportBuilder = {
  id: "http-loopback",
  supportedFormats: ["json", "toml"] as const,
  build,
};
