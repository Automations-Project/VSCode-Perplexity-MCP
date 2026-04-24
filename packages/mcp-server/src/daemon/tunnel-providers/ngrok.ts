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
 *
 * NOTE ON LAZY NATIVE LOADING (0.8.6):
 * `@ngrok/ngrok` ships platform-specific NAPI subpackages
 * (`@ngrok/ngrok-linux-x64-gnu`, `@ngrok/ngrok-win32-x64-msvc`, …) that are
 * resolved at module-load time. If the VSIX was packaged on a different OS
 * than the one activating the extension, the required subpackage may be
 * missing and `require("@ngrok/ngrok")` throws MODULE_NOT_FOUND. That used to
 * crash extension activation because the provider registry statically
 * imported this file. We now defer loading the NAPI binding until a caller
 * actually needs it (start / kill), and surface a domain-specific
 * `NgrokNativeMissingError` so the dashboard can show a useful message.
 */

import type { StartedTunnel, TunnelState } from "../tunnel.js";
import { readNgrokSettings } from "./ngrok-config.js";
import type { SetupCheck, TunnelProvider, TunnelProviderStartOptions } from "./types.js";

const DASHBOARD_AUTHTOKEN_URL = "https://dashboard.ngrok.com/get-started/your-authtoken";

/**
 * Error thrown when the `@ngrok/ngrok` native subpackage for the current
 * platform/arch isn't installed. Callers (dashboard / CLI) should surface the
 * message to the user instead of letting a raw MODULE_NOT_FOUND propagate.
 */
export class NgrokNativeMissingError extends Error {
  public readonly platform: string;
  public readonly arch: string;
  public readonly cause?: unknown;

  constructor(cause: unknown) {
    const platform = process.platform;
    const arch = process.arch;
    const message =
      `@ngrok/ngrok native binding for ${platform}-${arch} is not available in this VSIX. ` +
      `Reinstall the extension (or install @ngrok/ngrok manually) to use the ngrok provider, ` +
      `or switch to the cloudflared provider in the dashboard.`;
    super(message);
    this.name = "NgrokNativeMissingError";
    this.platform = platform;
    this.arch = arch;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// Minimal structural type for the bits of @ngrok/ngrok we touch. We avoid
// importing the package's types at the top level because that would force TS
// to resolve the module; the `import ngrok from "@ngrok/ngrok"` line was what
// crashed activation in the first place.
interface NgrokModule {
  forward: (options: Record<string, unknown>) => Promise<NgrokListener>;
  kill?: () => Promise<void> | void;
}

interface NgrokListener {
  url: () => string | undefined | null;
  close: () => Promise<void> | void;
}

let cachedNgrok: NgrokModule | null = null;

/**
 * Return true if the underlying require chain failure was specifically the
 * native subpackage missing (vs. a programming error in @ngrok/ngrok itself).
 * We match both MODULE_NOT_FOUND and the message pattern because electron/tsup
 * can sometimes mangle err.code but preserve the message.
 */
function isNativeMissingError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return true;
  const message = err instanceof Error ? err.message : String(err);
  // e.g. "Cannot find module '@ngrok/ngrok-linux-x64-gnu'"
  return /Cannot find module ['"]@ngrok\/ngrok[-/]/i.test(message);
}

/**
 * Lazily import `@ngrok/ngrok`. Cached on first success. On
 * MODULE_NOT_FOUND for either the umbrella package or its platform subpackage,
 * throws `NgrokNativeMissingError`; every other error propagates as-is so we
 * don't swallow genuine bugs.
 */
export async function loadNgrokNative(): Promise<NgrokModule> {
  if (cachedNgrok) return cachedNgrok;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — dynamic import; the package's own types conflict across
    // node versions. We only consume forward / Listener which are stable.
    const mod = await import("@ngrok/ngrok");
    // CJS/ESM interop: when tsup bundles us as ESM consuming a CJS package,
    // the default export may be nested under `.default`.
    const resolved = ((mod as { default?: NgrokModule }).default ?? mod) as NgrokModule;
    if (typeof resolved?.forward !== "function") {
      throw new Error("@ngrok/ngrok module did not expose forward(); API changed?");
    }
    cachedNgrok = resolved;
    return resolved;
  } catch (err) {
    if (isNativeMissingError(err)) {
      throw new NgrokNativeMissingError(err);
    }
    throw err;
  }
}

/**
 * Probe whether the native binding would load on this platform, without
 * actually keeping it cached. Used by `listTunnelProviderStatuses` so we can
 * surface a `native-missing` setup reason without crashing.
 */
export async function isNgrokNativeAvailable(): Promise<{ available: true } | { available: false; error: NgrokNativeMissingError }> {
  try {
    await loadNgrokNative();
    return { available: true };
  } catch (err) {
    if (err instanceof NgrokNativeMissingError) {
      return { available: false, error: err };
    }
    // Anything else is a real bug — propagate.
    throw err;
  }
}

export const ngrokProvider: TunnelProvider = {
  id: "ngrok",
  displayName: "ngrok",
  description: "Persistent URL via ngrok. Requires a free ngrok account authtoken.",

  async isSetupComplete(configDir): Promise<SetupCheck> {
    // Step 1: check the native binding. If it's missing we cannot start a
    // tunnel regardless of authtoken state, so report that first with a
    // clearer message than a later start() failure would give.
    const probe = await isNgrokNativeAvailable();
    if (!probe.available) {
      return {
        ready: false,
        reason: probe.error.message,
      };
    }

    // Step 2: synchronous token presence check — unchanged from pre-0.8.6.
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

    // Load the native binding lazily — this is the first place that actually
    // needs it. If the platform subpackage is missing, surface it as
    // NgrokNativeMissingError instead of a raw MODULE_NOT_FOUND.
    const ngrok = await loadNgrokNative();

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

    let listener: NgrokListener | null = null;
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

/**
 * Test-only hook to reset the lazy cache between vitest runs. Exported so the
 * unit tests can reset state without touching module internals via
 * reflection. NOT part of the public runtime API.
 */
export function __resetNgrokNativeCacheForTests(): void {
  cachedNgrok = null;
}

async function safeClose(listener: NgrokListener | null): Promise<void> {
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
