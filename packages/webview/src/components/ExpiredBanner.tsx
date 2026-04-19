import { AlertTriangle } from "lucide-react";
import { useDashboardStore } from "../store";
import type { SendFn } from "../views";

export function ExpiredBanner({ send }: { send: SendFn }) {
  const auth = useDashboardStore((s) => s.authState);
  const dismissedUntil = useDashboardStore((s) => s.expiredDismissedUntil);
  const dismiss = useDashboardStore((s) => s.dismissExpiredForMs);
  const active = useDashboardStore((s) => s.activeProfile);
  if (auth?.status !== "expired") return null;
  if (dismissedUntil && Date.now() < dismissedUntil) return null;

  return (
    <div className="expired-banner">
      <AlertTriangle size={16} />
      <span>Your Perplexity session for <b>{active}</b> has expired.</span>
      <button onClick={() => send({ type: "auth:login-start", id: crypto.randomUUID(), payload: { profile: active ?? "default", mode: "manual" } })}>Re-login</button>
      <button onClick={() => {
        const name = prompt("Switch to which profile?");
        if (name) send({ type: "profile:switch", id: crypto.randomUUID(), payload: { name } });
      }}>Switch account</button>
      <button onClick={() => { dismiss(60 * 60 * 1000); send({ type: "auth:dismiss-expired", payload: { profile: active ?? "default", bumpHours: 1 } }); }}>Dismiss 1h</button>
    </div>
  );
}
