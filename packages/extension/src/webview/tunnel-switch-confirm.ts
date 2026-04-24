import type * as vscode from "vscode";
import type { TunnelProviderId } from "perplexity-user-mcp/daemon/tunnel-providers";

/**
 * v0.8.5: Before `daemon:set-tunnel-provider` takes effect, show a modal
 * warning so the user acknowledges that any MCP client connected through the
 * active tunnel URL will be disconnected and any IDE configured for
 * `http-tunnel` transport will need to be regenerated against the new URL.
 *
 * This helper is intentionally pure: the caller injects the showWarningMessage
 * shim and the current state, which keeps unit tests free of a vscode mock.
 */
export interface TunnelSwitchConfirmDeps {
  /**
   * vscode.window.showWarningMessage shim. Returns the clicked button label,
   * or `undefined` if the user cancelled / dismissed the modal. The VS Code
   * native Cancel always resolves to undefined.
   */
  showWarningMessage: typeof vscode.window.showWarningMessage;
  /**
   * Currently-active tunnel provider as reported by the daemon runtime
   * (readTunnelSettings → activeProvider). `null` is allowed for forward-
   * compatibility with states where no provider is selected yet.
   */
  currentProvider: TunnelProviderId | null;
  /**
   * Whether a tunnel is actually live right now (health.tunnel.url present or
   * record.tunnelUrl present). When false, there is nothing to disrupt, so no
   * confirmation is needed.
   */
  currentTunnelEnabled: boolean;
}

export interface TunnelSwitchConfirmInput {
  nextProvider: TunnelProviderId;
  deps: TunnelSwitchConfirmDeps;
}

const CONTINUE_LABEL = "Continue switching";
const CANCEL_LABEL = "Cancel";

const PROVIDER_LABELS: Record<TunnelProviderId, string> = {
  "cf-quick": "Cloudflare Quick",
  ngrok: "ngrok",
  "cf-named": "Cloudflare Named Tunnel",
};

function labelFor(id: TunnelProviderId | null): string {
  if (!id) return "current provider";
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * Returns `true` if the switch should proceed. Returns `false` if the user
 * cancelled.
 *
 * Short-circuit branches (no modal shown):
 *  - `currentTunnelEnabled === false` → no live tunnel to disrupt.
 *  - `currentProvider === nextProvider` → idempotent re-select; nothing changes.
 *
 * Otherwise a VS Code modal is shown. The helper resolves to `true` iff the
 * user clicks the primary `"Continue switching"` button. Anything else
 * (clicking Cancel, pressing Escape, or closing the modal) resolves to
 * `false`.
 */
export async function confirmTunnelSwitch(
  input: TunnelSwitchConfirmInput,
): Promise<boolean> {
  const { nextProvider, deps } = input;

  if (!deps.currentTunnelEnabled) return true;
  if (deps.currentProvider === nextProvider) return true;

  const currentLabel = labelFor(deps.currentProvider);
  const nextLabel = labelFor(nextProvider);

  const detail =
    `${currentLabel} is currently enabled. Switching to ${nextLabel} will ` +
    "disable the current tunnel. Any MCP client connected through the current " +
    "tunnel URL will be disconnected. Any IDE configured for http-tunnel will " +
    "need to be regenerated against the new URL.\n\n" +
    "http-loopback and stdio IDEs are unaffected.\n\n" +
    "Continue switching?";

  const choice = await deps.showWarningMessage(
    "Switch tunnel provider?",
    { modal: true, detail },
    CONTINUE_LABEL,
    CANCEL_LABEL,
  );

  return choice === CONTINUE_LABEL;
}
