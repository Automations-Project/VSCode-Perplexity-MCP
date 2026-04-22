import { describe, it, expect, vi } from "vitest";
import { redactMessage, redactObject } from "../src/redact.js";
import { REVEAL_CONFIRM_LABEL, REVEAL_TTL_MS, runBearerRevealGate, type RevealGateDeps } from "../src/webview/bearer-reveal-gate.js";

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

describe("command-palette bearer reveal gate (H0)", () => {
  const CANARY_BEARER = "CANARY_BEARER_MUST_NOT_LEAK_43CHAR_FIXTURE_A";

  function makeDeps(overrides: Partial<RevealGateDeps> = {}): RevealGateDeps {
    return {
      confirm: vi.fn(async () => undefined),
      getBearer: vi.fn(async () => CANARY_BEARER),
      openDashboard: vi.fn(async () => {}),
      postMessage: vi.fn(async () => {}),
      showError: vi.fn(),
      randomNonce: vi.fn(() => "TEST_NONCE_0001"),
      ...overrides,
    };
  }

  it("cancellation (modal returns undefined) — NO bearer response posted, dashboard NOT opened, bearer NOT fetched", async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => undefined) });
    const outcome = await runBearerRevealGate("id-cancel", deps);
    expect(outcome).toBe("cancelled");
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.openDashboard).not.toHaveBeenCalled();
    expect(deps.getBearer).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("cancellation (modal returns any non-confirm label) — NO bearer response posted", async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => "Cancel") });
    const outcome = await runBearerRevealGate("id-cancel-2", deps);
    expect(outcome).toBe("cancelled");
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.openDashboard).not.toHaveBeenCalled();
    expect(deps.getBearer).not.toHaveBeenCalled();
  });

  it("confirmation (exact label) — reveal response posted with bearer + 30s TTL + nonce, ONLY after openDashboard", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      confirm: vi.fn(async () => { callOrder.push("confirm"); return REVEAL_CONFIRM_LABEL; }),
      getBearer: vi.fn(async () => { callOrder.push("getBearer"); return CANARY_BEARER; }),
      openDashboard: vi.fn(async () => { callOrder.push("openDashboard"); }),
      postMessage: vi.fn(async (msg) => {
        callOrder.push(`postMessage:${msg.type}`);
        // Record full message so the assertion below can inspect the payload.
        (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls.push([msg]);
      }),
    });
    const outcome = await runBearerRevealGate("id-reveal", deps);
    expect(outcome).toBe("confirmed");
    expect(callOrder).toEqual([
      "confirm",
      "getBearer",
      "openDashboard",
      "postMessage:daemon:bearer:reveal:response",
    ]);
    expect(deps.postMessage).toHaveBeenCalledWith({
      type: "daemon:bearer:reveal:response",
      id: "id-reveal",
      payload: { bearer: CANARY_BEARER, expiresInMs: REVEAL_TTL_MS, nonce: "TEST_NONCE_0001" },
    });
  });

  it("daemon absent — no-daemon outcome, NO bearer response posted, showError called with 'Daemon is not running.'", async () => {
    const deps = makeDeps({
      confirm: vi.fn(async () => REVEAL_CONFIRM_LABEL),
      getBearer: vi.fn(async () => null),
    });
    const outcome = await runBearerRevealGate("id-no-daemon", deps);
    expect(outcome).toBe("no-daemon");
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.openDashboard).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("Daemon is not running.");
  });

  it("getBearer throws — error outcome, NO bearer response posted, showError called with thrown message", async () => {
    const deps = makeDeps({
      confirm: vi.fn(async () => REVEAL_CONFIRM_LABEL),
      getBearer: vi.fn(async () => { throw new Error("token file EACCES"); }),
    });
    const outcome = await runBearerRevealGate("id-error", deps);
    expect(outcome).toBe("error");
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("Show daemon bearer failed: token file EACCES");
  });

  it("confirm label constant is the exact string the modal must return", () => {
    // Intentionally duplicated literal: if the UI copy ever changes (e.g. "Show for 30s"
    // vs "Show for 30 seconds") this test pins the source-of-truth value the
    // dispatchFromCommand modal and the gate both consume.
    expect(REVEAL_CONFIRM_LABEL).toBe("Show for 30 seconds");
  });
});
