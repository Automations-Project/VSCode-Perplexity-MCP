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
          className="daemon-inset-panel ngrok-setup-panel"
        >
          <div className="daemon-row-title">
            ngrok setup
          </div>
          <div className="daemon-row-detail">
            Paste the authtoken from{" "}
            <a
              href="https://dashboard.ngrok.com/get-started/your-authtoken"
              target="_blank"
              rel="noreferrer"
              className="daemon-accent-link"
            >
              dashboard.ngrok.com
            </a>
            . Required once per machine.
          </div>
          <div className="daemon-button-row daemon-button-row-compact">
            <input
              type="password"
              autoComplete="off"
              placeholder="2a1b3c4d…ngrokAuthToken"
              value={authtokenInput}
              onChange={(event) => setAuthtokenInput(event.target.value)}
              className="daemon-compact-input daemon-input-md"
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
        <div className="list-row ngrok-domain-row">
          <div className="daemon-row-main">
            <div className="daemon-row-title">
              ngrok reserved domain <span className="text-[var(--text-muted)]">(optional)</span>
            </div>
            <div className="daemon-row-detail">
              Without a reserved domain ngrok gives you a new random hostname each run. Reserve one free{" "}
              <a
                href="https://dashboard.ngrok.com/domains"
                target="_blank"
                rel="noreferrer"
                className="daemon-accent-link"
              >
                here
              </a>
              .
            </div>
          </div>
          <div className="daemon-button-row daemon-actions-end daemon-action-fill-lg">
            <input
              type="text"
              autoComplete="off"
              placeholder={domain ?? "yourname.ngrok-free.app"}
              value={domainInput}
              onChange={(event) => setDomainInput(event.target.value)}
              className="daemon-compact-input daemon-input-md"
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
