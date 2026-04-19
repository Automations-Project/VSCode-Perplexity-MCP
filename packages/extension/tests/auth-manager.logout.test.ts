import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    listeners: ((v: T) => void)[] = [];
    event = (l: (v: T) => void) => { this.listeners.push(l); return { dispose: () => {} }; };
    fire(v: T) { for (const l of this.listeners) l(v); }
    dispose() { this.listeners = []; }
  }
  return { EventEmitter };
});

vi.mock("perplexity-user-mcp/logout", () => ({
  softLogout: vi.fn(async () => {}),
  hardLogout: vi.fn(async () => {}),
}));

import { AuthManager } from "../src/mcp/auth-manager";
import * as logoutMod from "perplexity-user-mcp/logout";

describe("AuthManager.logout", () => {
  it("calls softLogout by default", async () => {
    const mgr = new AuthManager();
    await mgr.logout({ profile: "default" });
    expect(
      (logoutMod.softLogout as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    ).toBe("default");
  });

  it("calls hardLogout when purge=true", async () => {
    const mgr = new AuthManager();
    await mgr.logout({ profile: "default", purge: true });
    expect(
      (logoutMod.hardLogout as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
    ).toBeGreaterThan(0);
  });
});
