import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "../../src/daemon/server.ts";
import { record } from "../../src/daemon/oauth-consent-cache.ts";

function createMockClient() {
  return {
    authenticated: true,
    userId: "user-test",
    accountInfo: null,
    init: async () => undefined,
    shutdown: async () => undefined,
  };
}

describe("/daemon/oauth-consents admin endpoints", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-consents-http-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.7.3-test",
      bearerToken: "test-bearer-token",
      createClient: () => createMockClient(),
    });
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function adminFetch(method, body) {
    return fetch(`${daemon.url}/daemon/oauth-consents`, {
      method,
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("GET returns 401 without a bearer", async () => {
    const res = await fetch(`${daemon.url}/daemon/oauth-consents`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("DELETE returns 401 without a bearer", async () => {
    const res = await fetch(`${daemon.url}/daemon/oauth-consents`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("GET returns the live consents as {consents: [...]}", async () => {
    record("client-a", "http://cb/a", 60_000, {
      cachePath: join(configDir, "oauth-consent.json"),
    });
    record("client-b", "http://cb/b", 120_000, {
      cachePath: join(configDir, "oauth-consent.json"),
    });

    const res = await adminFetch("GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.consents)).toBe(true);
    expect(body.consents).toHaveLength(2);
    const ids = body.consents.map((c) => c.clientId).sort();
    expect(ids).toEqual(["client-a", "client-b"]);
  });

  it("DELETE with {clientId, redirectUri} revokes exactly that pair", async () => {
    const cachePath = join(configDir, "oauth-consent.json");
    record("client-a", "http://cb/a", 60_000, { cachePath });
    record("client-a", "http://cb/b", 60_000, { cachePath });
    record("client-b", "http://cb/a", 60_000, { cachePath });

    const res = await adminFetch("DELETE", { clientId: "client-a", redirectUri: "http://cb/a" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, removed: 1 });

    const listed = await (await adminFetch("GET")).json();
    const remaining = listed.consents.map((c) => `${c.clientId}|${c.redirectUri}`).sort();
    expect(remaining).toEqual(["client-a|http://cb/b", "client-b|http://cb/a"]);
  });

  it("DELETE with {clientId} only revokes everything for that client", async () => {
    const cachePath = join(configDir, "oauth-consent.json");
    record("client-a", "http://cb/a", 60_000, { cachePath });
    record("client-a", "http://cb/b", 60_000, { cachePath });
    record("client-b", "http://cb/a", 60_000, { cachePath });

    const res = await adminFetch("DELETE", { clientId: "client-a" });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(2);

    const listed = await (await adminFetch("GET")).json();
    expect(listed.consents.map((c) => c.clientId)).toEqual(["client-b"]);
  });

  it("DELETE with no body clears all entries (revoke-all)", async () => {
    const cachePath = join(configDir, "oauth-consent.json");
    record("client-a", "http://cb/a", 60_000, { cachePath });
    record("client-b", "http://cb/b", 60_000, { cachePath });

    const res = await adminFetch("DELETE");
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(2);

    const listed = await (await adminFetch("GET")).json();
    expect(listed.consents).toEqual([]);
  });
});
