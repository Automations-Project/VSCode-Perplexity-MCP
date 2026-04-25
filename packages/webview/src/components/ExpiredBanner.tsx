import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useDashboardStore } from "../store";
import type { SendFn } from "../views";
import { PromptModal } from "./PromptModal";

export function ExpiredBanner({ send }: { send: SendFn }) {
  const auth = useDashboardStore((s) => s.authState);
  const dismissedUntil = useDashboardStore((s) => s.expiredDismissedUntil);
  const dismiss = useDashboardStore((s) => s.dismissExpiredForMs);
  const active = useDashboardStore((s) => s.activeProfile);
  const [promptOpen, setPromptOpen] = useState(false);

  if (auth?.status !== "expired") return null;
  if (dismissedUntil && Date.now() < dismissedUntil) return null;

  return (
    <>
      <div className="expired-banner" role="alert">
        <AlertTriangle size={16} />
        <span>Your Perplexity session for <b>{active}</b> has expired.</span>
        <button onClick={() => send({ type: "auth:login" })}>Re-login</button>
        <button onClick={() => setPromptOpen(true)}>Switch account</button>
        <button onClick={() => { dismiss(60 * 60 * 1000); send({ type: "auth:dismiss-expired", payload: { profile: active ?? "default", bumpHours: 1 } }); }}>Dismiss 1h</button>
      </div>
      <PromptModal
        open={promptOpen}
        title="Switch account"
        description="Enter the name of the profile to switch to."
        placeholder="Profile name"
        confirmLabel="Switch"
        onConfirm={(name) => {
          setPromptOpen(false);
          if (name) send({ type: "profile:switch", id: crypto.randomUUID(), payload: { name } });
        }}
        onCancel={() => setPromptOpen(false)}
      />
    </>
  );
}
