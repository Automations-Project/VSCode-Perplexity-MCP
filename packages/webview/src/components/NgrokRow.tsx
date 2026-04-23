import { useState } from "react";
import type { WebviewMessage } from "@perplexity-user-mcp/shared";
import { DaemonActionButton } from "./DaemonActionButton";

type SendFn = (message: WebviewMessage | Omit<Extract<WebviewMessage, { id: string }>, "id">) => void;

export function NgrokRow({
  active,
  configured,
  domain,
  setupReady,
  send,
}: {
  active: boolean;
  configured: boolean;
  domain?: string;
  setupReady?: boolean;
  send: SendFn;
}) {
  const [authtokenInput, setAuthtokenInput] = useState("");
  const [domainInput, setDomainInput] = useState("");

  if (!active) return null;

  return (
    <>
      {!setupReady ? (
        <div
          className="daemon-inset-panel"
          style={{ marginTop: 10, borderColor: "rgba(255, 180, 80, 0.3)" }}
        >
          <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
            ngrok setup
          </div>
          <div style={{ fontSize: "0.66rem", marginTop: 3 }} className="text-[var(--text-muted)]">
            Paste the authtoken from{" "}
            <a
              href="https://dashboard.ngrok.com/get-started/your-authtoken"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text-accent)" }}
            >
              dashboard.ngrok.com
            </a>
            . Required once per machine.
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ marginTop: 6 }}>
            <input
              type="password"
              autoComplete="off"
              placeholder="2a1b3c4d…ngrokAuthToken"
              value={authtokenInput}
              onChange={(event) => setAuthtokenInput(event.target.value)}
              style={{ flex: 1, minWidth: 180, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
            />
            <DaemonActionButton
              type="daemon:set-ngrok-authtoken"
              label="Save authtoken"
              pendingLabel="Saving…"
              className="primary-button btn-sm"
              disabled={authtokenInput.trim().length < 10}
              onClick={() => {
                send({ type: "daemon:set-ngrok-authtoken", payload: { authtoken: authtokenInput.trim() } });
                setAuthtokenInput("");
              }}
            />
          </div>
        </div>
      ) : null}

      {configured ? (
        <div className="list-row" style={{ marginTop: 8, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 600 }} className="text-[var(--text-primary)]">
              ngrok reserved domain <span className="text-[var(--text-muted)]">(optional)</span>
            </div>
            <div style={{ fontSize: "0.66rem", marginTop: 3 }} className="text-[var(--text-muted)]">
              Without a reserved domain ngrok gives you a new random hostname each run. Reserve one free{" "}
              <a
                href="https://dashboard.ngrok.com/domains"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--text-accent)" }}
              >
                here
              </a>
              .
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap" style={{ justifyContent: "flex-end" }}>
            <input
              type="text"
              autoComplete="off"
              placeholder={domain ?? "yourname.ngrok-free.app"}
              value={domainInput}
              onChange={(event) => setDomainInput(event.target.value)}
              style={{ width: 220, fontSize: "0.7rem", padding: "4px 8px", borderRadius: 4 }}
            />
            <DaemonActionButton
              type="daemon:set-ngrok-domain"
              label="Save"
              pendingLabel="Saving…"
              onClick={() => {
                send({ type: "daemon:set-ngrok-domain", payload: { domain: domainInput.trim() || null } });
                setDomainInput("");
              }}
            />
            <DaemonActionButton
              type="daemon:clear-ngrok-settings"
              label="Delete local settings"
              pendingLabel="Clearing…"
              onClick={() => send({ type: "daemon:clear-ngrok-settings" })}
            />
            <a
              className="ghost-button btn-sm"
              href="https://dashboard.ngrok.com/endpoints"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none" }}
              title="Remote ngrok endpoint/domain cleanup stays in ngrok unless a future API-key flow is added."
            >
              Open dashboard
            </a>
          </div>
        </div>
      ) : null}
    </>
  );
}
