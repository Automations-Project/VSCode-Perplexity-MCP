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

    // Preemptively nuke any in-process ngrok session from a prior enable that
    // may not have been cleaned up cleanly (e.g. hard daemon kill). This
    // avoids ERR_NGROK_334 "endpoint already online" when the same domain
    // gets re-bound in the same process. Does nothing for server-side state
    // left behind by a previous process — only ngrok's own grace period can
    // clear that.
    try {
      if (typeof ngrok.kill === "function") {
        await ngrok.kill();
      }
    } catch {
      // best-effort
    }

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
      const raw = err instanceof Error ? err.message : String(err);
      const friendly = translateNgrokError(raw, settings.domain);
      updateState({ status: "crashed", url: null, pid: null, error: friendly });
      throw new Error(friendly);
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

function translateNgrokError(raw: string, domain?: string): string {
  // ERR_NGROK_334 — the reserved domain already has a live endpoint bound to
  // it on ngrok's servers (usually from a prior session that didn't release
  // cleanly). Ngrok eventually reclaims the endpoint (~60s), but until then
  // new binds are rejected.
  if (/ERR_NGROK_334/i.test(raw) || /already online/i.test(raw)) {
    const which = domain ? ` for "${domain}"` : "";
    return (
      `ngrok refused the bind${which}: the reserved domain is still registered from a previous session. ` +
      `Wait ~60 seconds for ngrok's server to release it, then click Enable again. ` +
      `Or: use the Kill daemon button to force-cleanup, then try a different domain (or leave the domain blank for an ephemeral URL). ` +
      `Upstream code: ERR_NGROK_334.`
    );
  }
  if (/ERR_NGROK_105/i.test(raw) || /authentication failed/i.test(raw) || /authtoken/i.test(raw)) {
    return (
      `ngrok rejected the authtoken. Check it at ${DASHBOARD_AUTHTOKEN_URL} and paste it into the dashboard, then try Enable again.`
    );
  }
  if (/ERR_NGROK_108/i.test(raw) || /limited to 1 simultaneous/i.test(raw)) {
    return (
      `ngrok free tier allows one session per account. Another device or app is already using this authtoken — stop it in the ngrok dashboard (Cloud Edge → Tunnels), then click Enable.`
    );
  }
  return `ngrok forward failed: ${raw}`;
}
