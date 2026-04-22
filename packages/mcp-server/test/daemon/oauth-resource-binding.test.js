import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerplexityOAuthProvider } from "../../src/daemon/oauth-provider.ts";

function mockRes() {
  return { redirectedTo: null, req: { _pplx: {} }, redirect(url) { this.redirectedTo = url; } };
}

describe("H12 OAuth resource binding", () => {
  let configDir;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-resource-binding-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function buildProvider() {
    return new PerplexityOAuthProvider({
      configDir,
      getStaticBearer: () => "STATIC_BEARER_0123456789012345678901234",
      getConsentCacheTtlMs: () => 0,
      requestConsent: async () => true,
    });
  }

  it("captures `resource` at authorize and binds it to the auth code", async () => {
    const p = buildProvider();
    const client = await p.clientsStore.registerClient({
      client_id: "CL", client_name: "X", redirect_uris: ["http://cb/a"],
    });
    const res = mockRes();
    await p.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, res);
    const codeMatch = /code=([A-Za-z0-9_\-]+)/.exec(res.redirectedTo ?? "");
    expect(codeMatch).not.toBeNull();
    const tokens = await p.exchangeAuthorizationCode(
      client, codeMatch[1], undefined, "http://cb/a", "https://tunnel-a.example/mcp",
    );
    expect(tokens.access_token).toMatch(/^pplx_at_/);
  });

  it("exchange with mismatching resource is rejected", async () => {
    const p = buildProvider();
    const client = await p.clientsStore.registerClient({ client_id: "CL", redirect_uris: ["http://cb/a"] });
    const res = mockRes();
    await p.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, res);
    const code = /code=([A-Za-z0-9_\-]+)/.exec(res.redirectedTo ?? "")[1];
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, "http://cb/a", "https://tunnel-b.example/mcp"),
    ).rejects.toThrow(/resource/i);
  });

  it("refresh preserves the original resource binding", async () => {
    const p = buildProvider();
    const client = await p.clientsStore.registerClient({ client_id: "CL", redirect_uris: ["http://cb/a"] });
    const res = mockRes();
    await p.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, res);
    const code = /code=([A-Za-z0-9_\-]+)/.exec(res.redirectedTo ?? "")[1];
    const first = await p.exchangeAuthorizationCode(client, code, undefined, "http://cb/a", "https://tunnel-a.example/mcp");
    const refreshed = await p.exchangeRefreshToken(client, first.refresh_token, undefined, "https://tunnel-a.example/mcp");
    expect(refreshed.access_token).toMatch(/^pplx_at_/);
    await expect(
      p.exchangeRefreshToken(client, refreshed.refresh_token, undefined, "https://tunnel-b.example/mcp"),
    ).rejects.toThrow(/resource/i);
  });

  it("verifyAccessToken with matching expectedResource passes", async () => {
    const p = buildProvider();
    const client = await p.clientsStore.registerClient({ client_id: "CL", redirect_uris: ["http://cb/a"] });
    const res = mockRes();
    await p.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, res);
    const code = /code=([A-Za-z0-9_\-]+)/.exec(res.redirectedTo ?? "")[1];
    const { access_token } = await p.exchangeAuthorizationCode(client, code, undefined, "http://cb/a", "https://tunnel-a.example/mcp");
    await expect(
      p.verifyAccessToken(access_token, "tunnel", "https://tunnel-a.example/mcp"),
    ).resolves.toMatchObject({ clientId: client.client_id });
  });

  it("verifyAccessToken with mismatched expectedResource rejects on any source", async () => {
    const p = buildProvider();
    const client = await p.clientsStore.registerClient({ client_id: "CL", redirect_uris: ["http://cb/a"] });
    const res = mockRes();
    await p.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, res);
    const code = /code=([A-Za-z0-9_\-]+)/.exec(res.redirectedTo ?? "")[1];
    const { access_token } = await p.exchangeAuthorizationCode(client, code, undefined, "http://cb/a", "https://tunnel-a.example/mcp");
    await expect(
      p.verifyAccessToken(access_token, "tunnel", "https://tunnel-b.example/mcp"),
    ).rejects.toThrow(/resource/i);
    await expect(
      p.verifyAccessToken(access_token, "loopback", "https://tunnel-b.example/mcp"),
    ).rejects.toThrow(/resource/i);
  });

  it("unbound token is REJECTED on tunnel, ACCEPTED on loopback with flag", async () => {
    const p = buildProvider();
    const client = await p.clientsStore.registerClient({ client_id: "CL", redirect_uris: ["http://cb/a"] });
    const res = mockRes();
    await p.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, res);
    const code = /code=([A-Za-z0-9_\-]+)/.exec(res.redirectedTo ?? "")[1];
    const { access_token } = await p.exchangeAuthorizationCode(client, code, undefined, "http://cb/a");
    await expect(
      p.verifyAccessToken(access_token, "tunnel", "https://tunnel-a.example/mcp"),
    ).rejects.toThrow(/resource binding required over tunnel/i);
    const info = await p.verifyAccessToken(access_token, "loopback", "https://loopback.example/mcp");
    expect(info.extra?.unboundResource).toBe(true);
  });

  it("static daemon bearer rejected on tunnel, accepted on loopback", async () => {
    const p = buildProvider();
    await expect(
      p.verifyAccessToken("STATIC_BEARER_0123456789012345678901234", "tunnel", "https://tunnel-a.example/mcp"),
    ).rejects.toThrow(/static bearer not valid on tunnel/i);
    await expect(
      p.verifyAccessToken("STATIC_BEARER_0123456789012345678901234", "loopback", "https://loopback.example/mcp"),
    ).resolves.toMatchObject({ clientId: "local-static" });
  });
});
