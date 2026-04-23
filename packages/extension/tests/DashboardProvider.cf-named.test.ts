import { describe, it, expect, vi } from "vitest";
import type { ExtensionMessage } from "@perplexity-user-mcp/shared";

import {
  handleCfNamedCreate,
  handleCfNamedDeleteRemote,
  handleCfNamedList,
  handleCfNamedLogin,
  handleCfNamedUnbindLocal,
  type CfNamedDeps,
} from "../src/webview/cf-named-handlers.js";

/**
 * Build a CfNamedDeps with sensible defaults; tests override just the
 * dependencies they care about. showWarningMessage defaults to "Cancel"
 * (undefined return) so tests have to opt-in to confirm flows.
 */
function makeDeps(overrides: Partial<CfNamedDeps> = {}): CfNamedDeps & {
  posted: ExtensionMessage[];
} {
  const posted: ExtensionMessage[] = [];
  const deps: CfNamedDeps = {
    runCfNamedLogin: vi.fn(async () => ({ ok: true, certPath: "/home/user/.cloudflared/cert.pem" })),
    createCfNamedTunnel: vi.fn(async () => ({
      uuid: "11111111-2222-3333-4444-555555555555",
      name: "perplexity-mcp",
      credentialsPath: "/home/user/.cloudflared/11111111-2222-3333-4444-555555555555.json",
    })),
    listCfNamedTunnels: vi.fn(async () => [
      { uuid: "aaa-1", name: "perplexity-mcp", connections: 2 },
      { uuid: "bbb-2", name: "other" },
    ]),
    clearCfNamedConfig: vi.fn(async () => true),
    deleteCfNamedTunnel: vi.fn(async (uuid) => ({ uuid })),
    disableActiveTunnelIfNeeded: vi.fn(async () => undefined),
    readCfNamedConfig: vi.fn(async () => ({
      uuid: "11111111-2222-3333-4444-555555555555",
      hostname: "mcp.example.com",
      configPath: "/home/user/.perplexity-mcp/cloudflared-named.yml",
    })),
    showWarningMessage: vi.fn(async () => undefined),
    post: (msg) => {
      posted.push(msg);
    },
    ...overrides,
  };
  return Object.assign(deps, { posted });
}

describe("daemon:cf-named-login handler", () => {
  it("modal Cancel (undefined) short-circuits → result=cancelled, runtime NOT called, NO login response with ok=true", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => undefined) });
    const outcome = await handleCfNamedLogin("req-1", deps);
    expect(outcome).toBe("cancelled");
    expect(deps.runCfNamedLogin).not.toHaveBeenCalled();
    expect(deps.posted).toHaveLength(1);
    expect(deps.posted[0]).toEqual({
      type: "daemon:cf-named-login:result",
      id: "req-1",
      payload: { ok: false, error: "cancelled" },
    });
  });

  it("modal wrong-label (e.g. user clicks Cancel) → runtime NOT called", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => "Cancel") });
    const outcome = await handleCfNamedLogin("req-2", deps);
    expect(outcome).toBe("cancelled");
    expect(deps.runCfNamedLogin).not.toHaveBeenCalled();
  });

  it("modal Continue → runtime called → ok result posted with certPath", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => "Continue") });
    const outcome = await handleCfNamedLogin("req-3", deps);
    expect(outcome).toBe("ok");
    expect(deps.runCfNamedLogin).toHaveBeenCalledOnce();
    expect(deps.posted).toEqual([
      {
        type: "daemon:cf-named-login:result",
        id: "req-3",
        payload: { ok: true, certPath: "/home/user/.cloudflared/cert.pem" },
      },
    ]);
  });

  it("runtime throws → error result posted with truncated message; error state returned", async () => {
    const longMessage = "x".repeat(500);
    const deps = makeDeps({
      showWarningMessage: vi.fn(async () => "Continue"),
      runCfNamedLogin: vi.fn(async () => {
        throw new Error(longMessage);
      }),
    });
    const outcome = await handleCfNamedLogin("req-err", deps);
    expect(outcome).toBe("error");
    expect(deps.posted).toHaveLength(1);
    const first = deps.posted[0];
    expect(first.type).toBe("daemon:cf-named-login:result");
    if (first.type === "daemon:cf-named-login:result") {
      expect(first.payload.ok).toBe(false);
      if (!first.payload.ok) {
        expect(first.payload.error.length).toBeLessThanOrEqual(200);
        expect(first.payload.error.endsWith("…")).toBe(true);
      }
    }
  });

  it("modal copy mentions the browser side-effect so the user understands what Continue will do", async () => {
    const showSpy: CfNamedDeps["showWarningMessage"] = vi.fn(async () => undefined);
    const deps = makeDeps({ showWarningMessage: showSpy });
    await handleCfNamedLogin("req-copy", deps);
    const mock = (showSpy as unknown as { mock: { calls: Array<[string, { modal?: boolean; detail?: string }, ...string[]]> } }).mock;
    expect(mock.calls).toHaveLength(1);
    const [title, options] = mock.calls[0];
    expect(title).toMatch(/cloudflared login/i);
    expect(options?.modal).toBe(true);
    expect(options?.detail ?? "").toMatch(/browser/i);
    expect(options?.detail ?? "").toMatch(/Continue/);
  });
});

describe("daemon:cf-named-create handler", () => {
  it("modal Cancel (undefined) in create mode → runtime NOT called", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => undefined) });
    const outcome = await handleCfNamedCreate(
      "req-c1",
      { mode: "create", name: "perplexity-mcp", hostname: "mcp.example.com" },
      deps,
    );
    expect(outcome).toBe("cancelled");
    expect(deps.createCfNamedTunnel).not.toHaveBeenCalled();
    expect(deps.posted[0]).toEqual({
      type: "daemon:cf-named-create:result",
      id: "req-c1",
      payload: { ok: false, error: "cancelled" },
    });
  });

  it("modal confirm (create mode) → createCfNamedTunnel called with matching params; ok result posted with uuid + configPath", async () => {
    const deps = makeDeps({
      showWarningMessage: vi.fn(async (_msg, _opts, confirmLabel) =>
        confirmLabel === "Create tunnel" ? "Create tunnel" : undefined,
      ),
    });
    const outcome = await handleCfNamedCreate(
      "req-c2",
      { mode: "create", name: "perplexity-mcp", hostname: "mcp.example.com" },
      deps,
    );
    expect(outcome).toBe("ok");
    expect(deps.createCfNamedTunnel).toHaveBeenCalledWith({
      mode: "create",
      name: "perplexity-mcp",
      hostname: "mcp.example.com",
    });
    const first = deps.posted[0];
    expect(first.type).toBe("daemon:cf-named-create:result");
    if (first.type === "daemon:cf-named-create:result" && first.payload.ok) {
      expect(first.payload.hostname).toBe("mcp.example.com");
      expect(first.payload.uuid).toBe("11111111-2222-3333-4444-555555555555");
      expect(first.payload.configPath).toBe("/home/user/.perplexity-mcp/cloudflared-named.yml");
    }
  });

  it("modal confirm (bind-existing) → createCfNamedTunnel called in bind-existing mode; no DNS side-effect implied in copy", async () => {
    const showSpy: CfNamedDeps["showWarningMessage"] = vi.fn(async (_msg, _opts, confirmLabel) =>
      confirmLabel === "Bind tunnel" ? "Bind tunnel" : undefined,
    );
    const deps = makeDeps({ showWarningMessage: showSpy });
    const outcome = await handleCfNamedCreate(
      "req-c3",
      {
        mode: "bind-existing",
        uuid: "11111111-2222-3333-4444-555555555555",
        hostname: "mcp.example.com",
      },
      deps,
    );
    expect(outcome).toBe("ok");
    expect(deps.createCfNamedTunnel).toHaveBeenCalledWith({
      mode: "bind-existing",
      uuid: "11111111-2222-3333-4444-555555555555",
      hostname: "mcp.example.com",
    });
    const mock = (showSpy as unknown as { mock: { calls: Array<[string, { modal?: boolean; detail?: string }, ...string[]]> } }).mock;
    expect(mock.calls).toHaveLength(1);
    const [title, options] = mock.calls[0];
    expect(title).toMatch(/Bind existing/i);
    expect(options?.detail ?? "").toMatch(/11111111-2222-3333-4444-555555555555/);
  });

  it("create-mode confirm copy mentions both the tunnel name and DNS so the user understands side-effects", async () => {
    const showSpy: CfNamedDeps["showWarningMessage"] = vi.fn(async () => undefined);
    const deps = makeDeps({ showWarningMessage: showSpy });
    await handleCfNamedCreate(
      "req-c4",
      { mode: "create", name: "perplexity-mcp", hostname: "mcp.example.com" },
      deps,
    );
    const mock = (showSpy as unknown as { mock: { calls: Array<[string, { modal?: boolean; detail?: string }, ...string[]]> } }).mock;
    expect(mock.calls).toHaveLength(1);
    const [title, options] = mock.calls[0];
    expect(title).toMatch(/Create a new/);
    expect(options?.detail ?? "").toMatch(/perplexity-mcp/);
    expect(options?.detail ?? "").toMatch(/mcp\.example\.com/);
    expect(options?.detail ?? "").toMatch(/DNS/);
  });

  it("runtime throws → error posted with truncated message", async () => {
    const deps = makeDeps({
      showWarningMessage: vi.fn(async () => "Create tunnel"),
      createCfNamedTunnel: vi.fn(async () => {
        throw new Error("cloudflared tunnel create exited with code 1: name conflict");
      }),
    });
    const outcome = await handleCfNamedCreate(
      "req-err",
      { mode: "create", name: "perplexity-mcp", hostname: "mcp.example.com" },
      deps,
    );
    expect(outcome).toBe("error");
    const first = deps.posted[0];
    if (first.type === "daemon:cf-named-create:result" && !first.payload.ok) {
      expect(first.payload.error).toMatch(/name conflict/);
    }
  });
});

describe("daemon:cf-named-list handler", () => {
  it("no modal — runtime is always called; ok result posted with tunnels array", async () => {
    const deps = makeDeps();
    const outcome = await handleCfNamedList("req-l1", deps);
    expect(outcome).toBe("ok");
    expect(deps.showWarningMessage).not.toHaveBeenCalled();
    expect(deps.listCfNamedTunnels).toHaveBeenCalledOnce();
    expect(deps.posted).toHaveLength(1);
    const first = deps.posted[0];
    expect(first.type).toBe("daemon:cf-named-list:result");
    if (first.type === "daemon:cf-named-list:result" && first.payload.ok) {
      expect(first.payload.tunnels).toEqual([
        { uuid: "aaa-1", name: "perplexity-mcp", connections: 2 },
        { uuid: "bbb-2", name: "other" },
      ]);
    }
  });

  it("runtime throws → error posted, no crash, showWarningMessage still never called", async () => {
    const deps = makeDeps({
      listCfNamedTunnels: vi.fn(async () => {
        throw new Error("cloudflared tunnel list exited with code 1: no cert");
      }),
    });
    const outcome = await handleCfNamedList("req-l2", deps);
    expect(outcome).toBe("error");
    expect(deps.showWarningMessage).not.toHaveBeenCalled();
    const first = deps.posted[0];
    if (first.type === "daemon:cf-named-list:result" && !first.payload.ok) {
      expect(first.payload.error).toMatch(/no cert/);
    }
  });
});

describe("daemon:cf-named-unbind-local handler", () => {
  it("cancel short-circuits without disabling or clearing config", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => undefined) });
    const outcome = await handleCfNamedUnbindLocal(
      "req-u1",
      { uuid: "11111111-2222-3333-4444-555555555555" },
      deps,
    );
    expect(outcome).toBe("cancelled");
    expect(deps.disableActiveTunnelIfNeeded).not.toHaveBeenCalled();
    expect(deps.clearCfNamedConfig).not.toHaveBeenCalled();
  });

  it("confirm disables first, clears local config, and posts result", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => "Unbind local config") });
    const outcome = await handleCfNamedUnbindLocal(
      "req-u2",
      { uuid: "11111111-2222-3333-4444-555555555555" },
      deps,
    );
    expect(outcome).toBe("ok");
    expect(
      (deps.disableActiveTunnelIfNeeded as any).mock.invocationCallOrder[0],
    ).toBeLessThan((deps.clearCfNamedConfig as any).mock.invocationCallOrder[0]);
    expect(deps.posted[0]).toEqual({
      type: "daemon:cf-named-unbind-local:result",
      id: "req-u2",
      payload: { ok: true, uuid: "11111111-2222-3333-4444-555555555555", configCleared: true },
    });
  });
});

describe("daemon:cf-named-delete-remote handler", () => {
  it("confirm disables before delete, clears matching local config, and posts DNS cleanup URL", async () => {
    const deps = makeDeps({ showWarningMessage: vi.fn(async () => "Delete remote tunnel") });
    const outcome = await handleCfNamedDeleteRemote(
      "req-d1",
      {
        uuid: "11111111-2222-3333-4444-555555555555",
        name: "perplexity-mcp",
        hostname: "mcp.example.com",
      },
      deps,
    );
    expect(outcome).toBe("ok");
    expect(
      (deps.disableActiveTunnelIfNeeded as any).mock.invocationCallOrder[0],
    ).toBeLessThan((deps.deleteCfNamedTunnel as any).mock.invocationCallOrder[0]);
    expect(deps.deleteCfNamedTunnel).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");
    expect(deps.clearCfNamedConfig).toHaveBeenCalledOnce();
    expect(deps.posted[0]).toEqual({
      type: "daemon:cf-named-delete-remote:result",
      id: "req-d1",
      payload: {
        ok: true,
        uuid: "11111111-2222-3333-4444-555555555555",
        hostname: "mcp.example.com",
        localConfigCleared: true,
        dnsCleanupUrl: "https://dash.cloudflare.com/?to=/:account/:zone/dns",
      },
    });
  });

  it("remote delete failure keeps tunnel disabled and returns active-connections reason", async () => {
    const err = Object.assign(new Error("remove DNS first"), { reason: "active-connections" as const });
    const deps = makeDeps({
      showWarningMessage: vi.fn(async () => "Delete remote tunnel"),
      deleteCfNamedTunnel: vi.fn(async () => {
        throw err;
      }),
    });
    const outcome = await handleCfNamedDeleteRemote(
      "req-d2",
      {
        uuid: "11111111-2222-3333-4444-555555555555",
        name: "perplexity-mcp",
        hostname: "mcp.example.com",
      },
      deps,
    );
    expect(outcome).toBe("error");
    expect(deps.disableActiveTunnelIfNeeded).toHaveBeenCalledOnce();
    expect(deps.clearCfNamedConfig).not.toHaveBeenCalled();
    expect(deps.posted[0]).toEqual({
      type: "daemon:cf-named-delete-remote:result",
      id: "req-d2",
      payload: { ok: false, error: "remove DNS first", reason: "active-connections" },
    });
  });
});
