import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private listeners: ((v: T) => void)[] = [];
    event = (l: (v: T) => void) => { this.listeners.push(l); return { dispose: () => {} }; };
    fire(v: T) { for (const l of this.listeners) l(v); }
    dispose() { this.listeners = []; }
  }
  return { EventEmitter };
});

import { AuthManager } from "../src/mcp/auth-manager";

const AUTO = join(__dirname, "fixtures", "fake-auto-runner.mjs");

describe("AuthManager.login (auto mode)", () => {
  it("transitions unknown -> logging-in -> awaiting_otp -> valid on correct OTP", async () => {
    const mgr = new AuthManager();
    const transitions: string[] = [];
    mgr.onDidChange((s) => transitions.push(s.status));
    const result = await mgr.login({
      profile: "default",
      mode: "auto",
      email: "a@b.co",
      runnerPath: AUTO,
      onOtpPrompt: () => Promise.resolve("123456"),
    });
    expect(result.ok).toBe(true);
    expect(transitions).toContain("logging-in");
    expect(transitions).toContain("awaiting_otp");
    expect(transitions).toContain("valid");
  });

  it("sets status=error on wrong OTP", async () => {
    const mgr = new AuthManager();
    const result = await mgr.login({
      profile: "default",
      mode: "auto",
      email: "a@b.co",
      runnerPath: AUTO,
      onOtpPrompt: () => Promise.resolve("000000"),
    });
    expect(result.ok).toBe(false);
    expect(mgr.state.status).toBe("error");
  });

  it("rejects re-entrant login for the same profile", async () => {
    const mgr = new AuthManager();
    const first = mgr.login({
      profile: "default",
      mode: "auto",
      email: "a@b.co",
      runnerPath: AUTO,
      onOtpPrompt: () => new Promise(() => {}),
    });
    await expect(
      mgr.login({
        profile: "default",
        mode: "auto",
        email: "a@b.co",
        runnerPath: AUTO,
        onOtpPrompt: () => Promise.resolve("123456"),
      })
    ).rejects.toThrow(/already/i);
    (first as Promise<unknown>).catch(() => {});
  });
});
