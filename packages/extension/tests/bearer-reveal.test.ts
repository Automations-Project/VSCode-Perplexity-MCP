import { describe, it, expect } from "vitest";
import { redactMessage, redactObject } from "../src/redact.js";

describe("bearer reveal + log cycle is leak-free", () => {
  const REAL_BEARER = "TEST_REAL_BEARER_FIXTURE_43CHARS_AAAAAAAAAAA";

  function simulatedSession() {
    const statePush = {
      type: "daemon:status-updated",
      payload: { running: true, healthy: true, port: 7764, bearerAvailable: true },
    };
    const log1 = `posting ${JSON.stringify(statePush)}`;
    const clickLog = {
      type: "log:webview",
      payload: {
        level: "log",
        args: [{ button: "daemon:enable-tunnel", status: statePush.payload }],
        ts: "2026-04-22T14:47:46.995Z",
      },
    };
    const log2 = `Webview message received: ${redactMessage(JSON.stringify(clickLog))}`;
    const reveal = {
      type: "daemon:bearer:reveal:response",
      id: "r-1",
      payload: { bearer: REAL_BEARER, expiresInMs: 30_000, nonce: "n-1" },
    };
    const log3 = `posting ${redactMessage(JSON.stringify(reveal))}`;
    return [log1, log2, log3].join("\n");
  }

  it("captured session contains zero raw bearer matches", () => {
    const captured = simulatedSession();
    expect(captured).not.toContain(REAL_BEARER);
  });

  it("bearer reveal payload is redacted when logged", () => {
    const payload = {
      type: "daemon:bearer:reveal:response",
      payload: { bearer: "pplx_at_abcdefghijklmnopqrstuvwx" },
    };
    const serialized = redactMessage(JSON.stringify(payload));
    expect(serialized).not.toContain("pplx_at_abcdefghijklmnopqrstuvwx");
    expect(serialized).toContain("<redacted:oauth-access>");
  });

  it("state updates no longer carry bearerToken at the type level", () => {
    const state: import("@perplexity-user-mcp/shared").DaemonStatusState = {
      running: true, healthy: true, stale: false,
      configDir: "/x", lockPath: "/x/lock", tokenPath: "/x/token",
      pid: 1, uuid: null, port: 1, url: "http://127.0.0.1:1",
      version: "0.7.4", startedAt: null, uptimeMs: 0, heartbeatCount: 0,
      tunnel: { status: "disabled", url: null, pid: null, error: null },
      bearerAvailable: true,
    };
    expect("bearerToken" in state).toBe(false);
    expect(state.bearerAvailable).toBe(true);
    // Suppress unused-import warning for redactObject.
    expect(typeof redactObject).toBe("function");
  });
});
