import { describe, it, expect, vi } from "vitest";

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

describe("AuthManager.defaultRunnerPath (Phase 3.1 fix)", () => {
  it("derives runner paths from extensionUri.fsPath, no globalThis.require needed", () => {
    const fakeExtensionUri = { fsPath: "/x/extensions/perplexity-vscode-0.4.1" } as unknown as import("vscode").Uri;
    const mgr = new AuthManager({ extensionUri: fakeExtensionUri });

    // @ts-expect-error -- probe the private helper via cast for test purposes.
    const manualPath = mgr.defaultRunnerPath("manual");
    // @ts-expect-error
    const autoPath = mgr.defaultRunnerPath("auto");
    // @ts-expect-error
    const healthPath = mgr.defaultRunnerPath("health");

    expect(manualPath.replace(/\\/g, "/")).toBe("/x/extensions/perplexity-vscode-0.4.1/dist/mcp/manual-login-runner.mjs");
    expect(autoPath.replace(/\\/g, "/")).toBe("/x/extensions/perplexity-vscode-0.4.1/dist/mcp/login-runner.mjs");
    expect(healthPath.replace(/\\/g, "/")).toBe("/x/extensions/perplexity-vscode-0.4.1/dist/mcp/health-check.mjs");
  });
});
