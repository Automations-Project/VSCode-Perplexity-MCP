import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    listeners: ((v: T) => void)[] = [];
    event = (l: (v: T) => void) => { this.listeners.push(l); return { dispose: () => {} }; };
    fire(v: T) { for (const l of this.listeners) l(v); }
    dispose() { this.listeners = []; }
  }
  return { EventEmitter };
});

import { AuthManager } from "../src/mcp/auth-manager";

const fakeExtensionUri = { fsPath: "/tmp/ext" } as unknown as import("vscode").Uri;
const FAKE = join(__dirname, "fixtures", "fake-runner.mjs"); // existing Phase-1 fixture

describe("AuthManager.checkSession", () => {
  it("reaches a terminal state (valid/unknown/expired/error)", async () => {
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
    (mgr as unknown as { defaultRunnerPath: (m: string) => string }).defaultRunnerPath = () => FAKE;
    process.env.FAKE_ROLE = "ok";
    const res = await mgr.checkSession({ profile: "default" });
    expect(["valid", "unknown", "expired", "error"]).toContain(res.status);
  });

  it("re-entrant checkSession returns the same promise", async () => {
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });
    (mgr as unknown as { defaultRunnerPath: (m: string) => string }).defaultRunnerPath = () => FAKE;
    const a = mgr.checkSession({ profile: "default" });
    const b = mgr.checkSession({ profile: "default" });
    expect(a).toBe(b);
    await Promise.all([a, b]);
  });
});
