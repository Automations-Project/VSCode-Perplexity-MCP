import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "../../src/daemon/server.ts";

function createMockClient() {
  return {
    authenticated: true,
    userId: "user-test",
    accountInfo: null,
    init: async () => undefined,
    shutdown: async () => undefined,
  };
}

describe("H11 tunnel admin allowlist", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-tunnel-allowlist-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.7.4-test",
      bearerToken: "TEST_STATIC_BEARER_0123456789012345678901234",
      createClient: () => createMockClient(),
    });
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  const tunnelHeaders = {
    "X-Forwarded-For": "203.0.113.5, 127.0.0.1",
    "X-Forwarded-Proto": "https",
    Host: "test-tunnel.example",
  };

  async function request(path, { method = "GET", tunnel = false, withBearer = true, accept, contentType, body } = {}) {
    const headers = {};
    if (withBearer) headers.Authorization = `Bearer ${daemon.bearerToken}`;
    if (tunnel) Object.assign(headers, tunnelHeaders);
    if (accept) headers.Accept = accept;
    if (contentType) headers["Content-Type"] = contentType;
    return fetch(`${daemon.url}${path}`, { method, headers, body });
  }

  const DAEMON_PATHS = [
    { method: "GET",  path: "/daemon/health" },
    { method: "GET",  path: "/daemon/events" },
    { method: "POST", path: "/daemon/heartbeat",     body: JSON.stringify({}),                   contentType: "application/json" },
    { method: "POST", path: "/daemon/rotate-token",  body: "" },
    { method: "POST", path: "/daemon/shutdown",      body: "" },
    { method: "POST", path: "/daemon/enable-tunnel", body: "" },
    { method: "POST", path: "/daemon/disable-tunnel", body: "" },
    { method: "POST", path: "/daemon/oauth-consent", body: JSON.stringify({ consentId: "x", approved: true }), contentType: "application/json" },
    { method: "GET",  path: "/daemon/oauth-consents" },
    { method: "DELETE", path: "/daemon/oauth-consents", body: JSON.stringify({}),                contentType: "application/json" },
    { method: "GET",  path: "/daemon/oauth-clients" },
    { method: "DELETE", path: "/daemon/oauth-clients",  body: JSON.stringify({}),                contentType: "application/json" },
  ];

  for (const { method, path, body, contentType } of DAEMON_PATHS) {
    it(`tunnel ${method} ${path} with valid static bearer returns 404`, async () => {
      const res = await request(path, { method, tunnel: true, body, contentType });
      expect(res.status).toBe(404);
    });

    it(`loopback ${method} ${path} with valid static bearer reaches handler (not 404)`, async () => {
      const res = await request(path, { method, tunnel: false, body, contentType });
      expect(res.status).not.toBe(404);
    });
  }

  it("tunnel POST /mcp with static bearer reaches auth middleware (not 404)", async () => {
    const res = await request("/mcp", {
      method: "POST", tunnel: true,
      accept: "application/json, text/event-stream", contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).not.toBe(404);
  });

  it("tunnel POST / (root MCP shim) reaches MCP auth path (not 404)", async () => {
    const res = await request("/", {
      method: "POST", tunnel: true,
      accept: "application/json, text/event-stream", contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).not.toBe(404);
  });

  it("browser-like GET / with Accept: text/html returns homepage (200)", async () => {
    const res = await request("/", { method: "GET", tunnel: true, withBearer: false, accept: "text/html" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<html");
  });

  it("tunnel GET /.well-known/oauth-protected-resource reaches handler (200)", async () => {
    const res = await request("/.well-known/oauth-protected-resource", { method: "GET", tunnel: true, withBearer: false });
    expect(res.status).toBe(200);
  });

  it("x-perplexity-source header does NOT influence allowlist", async () => {
    const res = await fetch(`${daemon.url}/daemon/health`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "X-Perplexity-Source": "loopback",
        "X-Forwarded-For": "203.0.113.5, 127.0.0.1",
      },
    });
    expect(res.status).toBe(404);
  });

  it("cf-connecting-ip alone is enough to flag tunnel", async () => {
    const res = await fetch(`${daemon.url}/daemon/health`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "cf-connecting-ip": "198.51.100.10",
      },
    });
    expect(res.status).toBe(404);
  });
});
