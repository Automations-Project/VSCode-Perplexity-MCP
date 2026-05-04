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

/**
 * Regression coverage for the login deadlock: a hung browser runner used to
 * pin the inflight lock forever, so the user got "Login already in progress
 * for X" on every retry until the extension was reloaded. The wall-clock
 * timeout + cancelLogin() API both have to clear the lock cleanly.
 */
describe("AuthManager.login deadlock recovery", () => {
  it("times out a hung runner via PERPLEXITY_LOGIN_TIMEOUT_MS and clears the inflight lock", async () => {
    // Fork a fresh module so the static class field re-reads the env var. The
    // module caches AuthManager.LOGIN_TIMEOUT_MS at import time.
    const previousTimeout = process.env.PERPLEXITY_LOGIN_TIMEOUT_MS;
    const previousRole = process.env.FAKE_ROLE;
    process.env.PERPLEXITY_LOGIN_TIMEOUT_MS = "300";
    process.env.FAKE_ROLE = "hang";
    try {
      vi.resetModules();
      const { AuthManager: FreshAuthManager } = await import("../src/mcp/auth-manager.js");
      const mgr = new FreshAuthManager({ extensionUri: fakeExtensionUri });
      const start = Date.now();
      const result = await mgr.login({
        profile: "default",
        mode: "manual",
        runnerPath: MANUAL,
      });
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(false);
      // Loose bounds: fired well before any human-scale "stuck" duration.
      expect(elapsed).toBeLessThan(3_000);
      expect(elapsed).toBeGreaterThanOrEqual(250);

      // Critical: lock is cleared so the next login attempt doesn't bounce
      // with "Login already in progress for 'default'".
      const followUp = mgr.login({
        profile: "default",
        mode: "manual",
        runnerPath: MANUAL,
      });
      // The follow-up will also hang+timeout, but it must not throw the
      // "already in progress" guard.
      await expect(followUp).resolves.toMatchObject({ ok: false });
    } finally {
      if (previousTimeout === undefined) delete process.env.PERPLEXITY_LOGIN_TIMEOUT_MS;
      else process.env.PERPLEXITY_LOGIN_TIMEOUT_MS = previousTimeout;
      if (previousRole === undefined) delete process.env.FAKE_ROLE;
      else process.env.FAKE_ROLE = previousRole;
      vi.resetModules();
    }
  }, 10_000);

  it("cancelLogin breaks a hung runner and releases the inflight lock immediately", async () => {
    const previousRole = process.env.FAKE_ROLE;
    process.env.FAKE_ROLE = "hang";
    try {
      const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
      const inflight = mgr.login({
        profile: "default",
        mode: "manual",
        runnerPath: MANUAL,
      });
      // Give the child a moment to fork before we cancel.
      await new Promise((r) => setTimeout(r, 50));
      const cancelled = await mgr.cancelLogin("default");
      expect(cancelled).toBe(true);

      const result = await inflight;
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/login_cancelled|cancel/i);

      // Subsequent login no longer bounces with "already in progress".
      const followUp = mgr.login({
        profile: "default",
        mode: "auto",
        email: "a@b.co",
        runnerPath: AUTO,
        onOtpPrompt: () => Promise.resolve("123456"),
      });
      await expect(followUp).resolves.toMatchObject({ ok: true });
    } finally {
      if (previousRole === undefined) delete process.env.FAKE_ROLE;
      else process.env.FAKE_ROLE = previousRole;
    }
  }, 15_000);

  it("cancelLogin returns false when no login is in flight", async () => {
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
    expect(await mgr.cancelLogin("default")).toBe(false);
  });
});
