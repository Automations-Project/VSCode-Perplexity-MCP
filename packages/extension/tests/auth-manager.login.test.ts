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

const fakeExtensionUri = { fsPath: "/tmp/ext" } as unknown as import("vscode").Uri;

const AUTO = join(__dirname, "fixtures", "fake-auto-runner.mjs");
const MANUAL = join(__dirname, "fixtures", "fake-runner.mjs");

describe("AuthManager.login (auto mode)", () => {
  it("transitions unknown -> logging-in -> awaiting_otp -> valid on correct OTP", async () => {
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
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
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
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
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
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

  it("reports awaiting_user progress for manual login", async () => {
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
    const previousRole = process.env.FAKE_ROLE;
    process.env.FAKE_ROLE = "awaiting_user_ok";
    try {
      const phases: string[] = [];
      const result = await mgr.login({
        profile: "default",
        mode: "manual",
        runnerPath: MANUAL,
        onProgress: (phase) => phases.push(phase),
      });
      expect(result.ok).toBe(true);
      expect(phases).toContain("awaiting_user");
      expect(mgr.state.status).toBe("valid");
    } finally {
      if (previousRole === undefined) delete process.env.FAKE_ROLE;
      else process.env.FAKE_ROLE = previousRole;
    }
  });
});
