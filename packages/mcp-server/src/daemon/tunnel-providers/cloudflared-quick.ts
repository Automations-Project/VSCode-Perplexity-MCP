/**
 * Cloudflare Quick Tunnel provider — wraps the existing binary-based flow.
 *
 * Ephemeral subdomain on *.trycloudflare.com. Zero configuration required
 * beyond installing the binary (handled via `daemon install-tunnel`).
 */

import { existsSync } from "node:fs";
import { startTunnel } from "../tunnel.js";
import { getTunnelBinaryPath } from "../install-tunnel.js";
import type { SetupCheck, TunnelProvider, TunnelProviderStartOptions } from "./types.js";

export const cloudflaredQuickProvider: TunnelProvider = {
  id: "cf-quick",
  displayName: "Cloudflare Quick Tunnel",
  description: "Zero-setup ephemeral *.trycloudflare.com URL. Changes on every restart.",

  async isSetupComplete(configDir): Promise<SetupCheck> {
    const binaryPath = getTunnelBinaryPath(configDir);
    if (!existsSync(binaryPath)) {
      return {
        ready: false,
        reason: "cloudflared binary not installed.",
        action: { label: "Install cloudflared", kind: "install-binary" },
      };
    }
    return { ready: true };
  },

  async start(options: TunnelProviderStartOptions) {
    const binaryPath = getTunnelBinaryPath(options.configDir);
    if (!existsSync(binaryPath)) {
      throw new Error(
        "cloudflared is not installed. Run `npx perplexity-user-mcp daemon install-tunnel` first.",
      );
    }
    return startTunnel({
      command: binaryPath,
      port: options.port,
      onStateChange: options.onStateChange,
    });
  },
};
