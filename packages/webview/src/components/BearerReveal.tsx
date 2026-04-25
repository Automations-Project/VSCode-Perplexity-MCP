import { Copy } from "lucide-react";
import type { JSX } from "react";
import { DaemonActionButton } from "./DaemonActionButton";

/**
 * Bearer-reveal row. Extracted from DaemonStatus to keep the daemon panel
 * readable. Presentational: the parent owns the store, dispatches
 * `daemon:bearer:reveal` / `daemon:bearer:copy`, and supplies a tick (`now`).
 *
 * Reveal is considered live only while `revealed.expiresAt > now`. When the
 * TTL lapses the component reverts to the "hidden" state — the parent store
 * is responsible for clearing `revealed` once the countdown hits zero, but
 * this component tolerates a stale `revealed` gracefully (it simply renders
 * as not-live).
 */
export interface BearerRevealProps {
  /** Whether a daemon bearer is currently available. If false, the component renders nothing. */
  available: boolean;

  /**
   * The currently-revealed bearer + its expiration. null before any reveal
   * request; auto-cleared by the store when `expiresAt` elapses. When non-null
   * and live, the raw bearer is shown (the user just confirmed consent).
   */
  revealed: { bearer: string; expiresAt: number; nonce?: string } | null;

  /** Feedback flash (e.g. "Copy requested"). Renders next to the buttons. null = no flash. */
  feedback: string | null;

  /** Called when the user clicks Reveal. Parent sends the daemon:bearer:reveal message. */
  onReveal: () => void;

  /** Called when the user clicks Copy. Parent sends the daemon:bearer:copy message. */
  onCopy: () => void;

  /**
   * Current epoch ms. Passed by the parent so the countdown is driven by the
   * parent's shared 1Hz tick rather than a per-component timer.
   */
  now: number;
}

export function BearerReveal({
  available,
  revealed,
  feedback,
  onReveal,
  onCopy,
  now,
}: BearerRevealProps): JSX.Element | null {
  if (!available) return null;

  const remainingSec = revealed ? Math.max(0, Math.ceil((revealed.expiresAt - now) / 1000)) : 0;
  const isLive = Boolean(revealed) && remainingSec > 0;

  return (
    <div
      className="list-row bearer-reveal-row"
      data-testid="bearer-reveal-row"
    >
      <div className="bearer-reveal-body">
        <div className="bearer-reveal-title">
          Bearer token
          {isLive ? (
            <span
              className="bearer-reveal-countdown"
              data-testid="bearer-reveal-countdown"
            >
              clears in {remainingSec}s
            </span>
          ) : null}
        </div>
        <div
          className="bearer-reveal-value"
          data-testid="bearer-reveal-value"
        >
          {isLive && revealed ? (
            // Bearer is in webview state for ≤30s by explicit user consent.
            // Raw text on purpose — the user just clicked Reveal and
            // confirmed the modal to see this value; rendering a masked
            // string here would defeat the feature.
            <code>{revealed.bearer}</code>
          ) : (
            <>&lt;hidden — click Reveal or Copy&gt;</>
          )}
        </div>
        <div className="bearer-reveal-note">
          Required in an <code>Authorization: Bearer …</code> header for every MCP request (loopback or tunnel).
          Reveal / Copy opens a modal confirmation; reveal auto-clears after 30s.
        </div>
      </div>
      <div className="bearer-reveal-actions">
        <DaemonActionButton
          type="daemon:bearer:reveal"
          label="Reveal token"
          pendingLabel="Waiting…"
          onClick={onReveal}
        />
        <DaemonActionButton
          type="daemon:bearer:copy"
          label="Copy"
          pendingLabel="Waiting…"
          icon={<Copy size={11} />}
          onClick={onCopy}
        />
        {feedback ? (
          <span className="bearer-reveal-feedback">
            {feedback}
          </span>
        ) : null}
      </div>
    </div>
  );
}
