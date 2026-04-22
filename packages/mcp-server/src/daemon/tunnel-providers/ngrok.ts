/**
 * ngrok tunnel provider.
 *
 * Uses the official `@ngrok/ngrok` NAPI binding — the tunnel runs in-process
 * so there's no binary to download and no child process to manage. The ngrok
 * account authtoken and (optional) reserved domain live in <configDir>/ngrok.json.
 *
 * Free-tier ngrok includes one reserved static domain (yourname.ngrok-free.app)
 * which persists across daemon restarts; callers who leave `domain` unset get
 * an ephemeral URL that changes on each start.
 */

import type { StartedTunnel, TunnelState } from "../tunnel.js";
import { readNgrokSettings } from "./ngrok-config.js";
import type { SetupCheck, TunnelProvider, TunnelProviderStartOptions } from "./types.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — NAPI binding has its own types that conflict across node versions;
// we only need `forward` + `Listener.url()/close()` which are stable.
import ngrok from "@ngrok/ngrok";

const DASHBOARD_AUTHTOKEN_URL = "https://dashboard.ngrok.com/get-started/your-authtoken";

export const ngrokProvider: TunnelProvider = {
  id: "ngrok",
  displayName: "ngrok",
  description: "Persistent URL via ngrok. Requires a free ngrok account authtoken.",

  async isSetupComplete(configDir): Promise<SetupCheck> {
    const settings = readNgrokSettings(configDir);
    if (!settings?.authtoken) {
      return {
        ready: false,
        reason: "ngrok authtoken not set.",
        action: {
          label: "Get authtoken",
          kind: "open-url",
          url: DASHBOARD_AUTHTOKEN_URL,
        },
      };
    }
    return { ready: true };
  },

  async start(options: TunnelProviderStartOptions): Promise<StartedTunnel> {
    const settings = readNgrokSettings(options.configDir);
    if (!settings?.authtoken) {
      throw new Error(
        `ngrok authtoken not configured. Paste your authtoken from ${DASHBOARD_AUTHTOKEN_URL} into the dashboard, or run \`perplexity-user-mcp daemon set-ngrok-authtoken <token>\`.`,
      );
    }

    let state: TunnelState = { status: "starting", url: null, pid: null, error: null };
    const updateState = (next: TunnelState) => {
      state = next;
      options.onStateChange(state);
    };
    updateState(state);

    let listener: any | null = null;
    let resolveExited: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    try {
      listener = await ngrok.forward({
        addr: options.port,
        authtoken: settings.authtoken,
        ...(settings.domain ? { domain: settings.domain } : {}),
        // Human-readable label in the ngrok dashboard.
        forwards_to: `perplexity-mcp (port ${options.port})`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateState({ status: "crashed", url: null, pid: null, error: `ngrok: ${message}` });
      throw new Error(`ngrok forward failed: ${message}`);
    }

    const url = typeof listener?.url === "function" ? listener.url() : null;
    if (!url) {
      await safeClose(listener);
      updateState({ status: "crashed", url: null, pid: null, error: "ngrok returned no URL" });
      throw new Error("ngrok did not publish a URL.");
    }

    updateState({ status: "enabled", url, pid: null, error: null });

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await safeClose(listener);
      listener = null;
      updateState({ status: "disabled", url: null, pid: null, error: null });
      resolveExited();
    };

    return {
      pid: 0,
      waitUntilReady: Promise.resolve(url),
      stop,
      getState: () => state,
    };
  },
};

async function safeClose(listener: any): Promise<void> {
  if (!listener) return;
  try {
    if (typeof listener.close === "function") {
      await listener.close();
    }
  } catch {
    // best-effort
  }
}
