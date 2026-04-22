/**
 * Security-critical: command-palette reveal gate for the daemon bearer.
 *
 * Phase 8.2 H0 rule: every reveal path must be explicit and modal-confirmed
 * BEFORE the bearer leaves the extension host. This helper centralizes the
 * gate so the webview-button path in DashboardProvider and the command-palette
 * path in `dispatchFromCommand` both route through the same check.
 *
 * The helper is dependency-injected so tests can prove the non-leak invariant
 * (modal dismissed → no reveal response posted) without standing up the full
 * DashboardProvider + vscode mock tree.
 */

export interface RevealGateDeps {
  /**
   * Shows the confirmation modal. Must return exactly the button label the
   * user clicked, or `undefined` when the user cancelled (closed the modal,
   * hit Escape, clicked outside, etc.). Any value other than the expected
   * confirm label is treated as cancellation.
   */
  confirm: () => Promise<string | undefined>;
  /**
   * Fetches the current daemon bearer. Returns `null` when the daemon is not
   * running / the token file is missing.
   */
  getBearer: () => Promise<string | null>;
  /** Opens + refreshes the dashboard. Only called AFTER confirmation AND a live bearer. */
  openDashboard: () => Promise<void>;
  /** Posts a message to the webview. Only called AFTER confirmation AND a live bearer. */
  postMessage: (message: BearerRevealResponse) => Promise<void>;
  /** Surfaces a human-readable error (no-daemon / thrown) to the user via the extension host UI. */
  showError: (msg: string) => void;
  /** Nonce generator, injected so tests can assert a stable value. */
  randomNonce: () => string;
}

export interface BearerRevealResponse {
  type: "daemon:bearer:reveal:response";
  id: string;
  payload: { bearer: string; expiresInMs: number; nonce: string };
}

/** Exact label the modal must return for the gate to release. */
export const REVEAL_CONFIRM_LABEL = "Show for 30 seconds";

/** TTL the webview uses to auto-clear the revealed bearer. */
export const REVEAL_TTL_MS = 30_000;

export type RevealGateOutcome = "confirmed" | "cancelled" | "no-daemon" | "error";

/**
 * Runs the gate. Guarantees:
 *   - `postMessage` is NEVER called when the user cancels the modal.
 *   - `openDashboard` is NEVER called when the user cancels or the daemon is absent.
 *   - `getBearer` is NEVER called when the user cancels.
 *   - The only message ever posted is the `daemon:bearer:reveal:response` shape;
 *     no leakage via other message types.
 */
export async function runBearerRevealGate(id: string, deps: RevealGateDeps): Promise<RevealGateOutcome> {
  const picked = await deps.confirm();
  if (picked !== REVEAL_CONFIRM_LABEL) return "cancelled";
  try {
    const bearer = await deps.getBearer();
    if (!bearer) {
      deps.showError("Daemon is not running.");
      return "no-daemon";
    }
    await deps.openDashboard();
    await deps.postMessage({
      type: "daemon:bearer:reveal:response",
      id,
      payload: { bearer, expiresInMs: REVEAL_TTL_MS, nonce: deps.randomNonce() },
    });
    return "confirmed";
  } catch (err) {
    deps.showError(`Show daemon bearer failed: ${err instanceof Error ? err.message : String(err)}`);
    return "error";
  }
}
