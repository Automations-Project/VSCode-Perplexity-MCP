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

describe("/daemon/oauth-clients admin endpoints", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-clients-http-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.7.4-test",
      bearerToken: "test-bearer-token",
      createClient: () => createMockClient(),
    });
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function adminFetch(method, { body, query } = {}) {
    const qs = query ? `?${query}` : "";
    return fetch(`${daemon.url}/daemon/oauth-clients${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function registerClient(clientName) {
    const res = await fetch(`${daemon.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: ["http://127.0.0.1/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(res.status, `register ${clientName}`).toBeGreaterThanOrEqual(200);
    expect(res.status, `register ${clientName}`).toBeLessThan(300);
    return res.json();
  }

  it("GET returns 401 without a bearer", async () => {
    const res = await fetch(`${daemon.url}/daemon/oauth-clients`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("DELETE returns 401 without a bearer", async () => {
    const res = await fetch(`${daemon.url}/daemon/oauth-clients`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("GET returns {clients: []} when none registered", async () => {
    const res = await adminFetch("GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ clients: [] });
  });

  it("GET returns clients after /register (using server-provided listClients)", async () => {
    const a = await registerClient("client-alpha");
    const b = await registerClient("client-beta");
    expect(typeof a.client_id).toBe("string");
    expect(typeof b.client_id).toBe("string");

    const res = await adminFetch("GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.clients)).toBe(true);
    expect(body.clients).toHaveLength(2);
    const names = body.clients.map((c) => c.clientName).sort();
    expect(names).toEqual(["client-alpha", "client-beta"]);
    for (const c of body.clients) {
      expect(typeof c.clientId).toBe("string");
      expect(typeof c.registeredAt).toBe("number");
      expect(c.activeTokens).toBe(0);
    }
  });

  it("DELETE with clientId in body revokes exactly that client", async () => {
    const a = await registerClient("client-alpha");
    const b = await registerClient("client-beta");

    const res = await adminFetch("DELETE", { body: { clientId: a.client_id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, removed: 1 });

    const listed = await (await adminFetch("GET")).json();
    const remainingIds = listed.clients.map((c) => c.clientId);
    expect(remainingIds).toEqual([b.client_id]);
  });

  it("DELETE with clientId in query string revokes exactly that client", async () => {
    const a = await registerClient("client-alpha");
    const b = await registerClient("client-beta");

    const res = await adminFetch("DELETE", {
      query: `clientId=${encodeURIComponent(a.client_id)}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 1 });

    const listed = await (await adminFetch("GET")).json();
    expect(listed.clients.map((c) => c.clientId)).toEqual([b.client_id]);
  });

  it("DELETE with unknown clientId returns ok:false removed:0", async () => {
    await registerClient("client-alpha");
    const res = await adminFetch("DELETE", { body: { clientId: "pplx-does-not-exist" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, removed: 0 });
  });

  it("DELETE with no body clears every registered client (revoke-all)", async () => {
    await registerClient("client-alpha");
    await registerClient("client-beta");
    await registerClient("client-gamma");

    const res = await adminFetch("DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 3 });

    const listed = await (await adminFetch("GET")).json();
    expect(listed.clients).toEqual([]);
  });

  it("revoke-all on empty registry returns removed:0", async () => {
    const res = await adminFetch("DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 0 });
  });
});
