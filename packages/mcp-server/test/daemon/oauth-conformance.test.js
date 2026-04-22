import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { startDaemonServer } from "../../src/daemon/server.ts";

function createMockClient() {
  return { authenticated: true, userId: "u", accountInfo: null, init: async () => undefined, shutdown: async () => undefined };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("H12 OAuth conformance suite", () => {
  let configDir;
  let daemon;
  const STATIC = "STATIC_BEARER_0123456789012345678901234";

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-conformance-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.7.4-test",
      bearerToken: STATIC,
      createClient: () => createMockClient(),
      // Auto-approve consent for deterministic HTTP flows — without a
      // handler the authorize endpoint would block for the 2min consent
      // timeout. We resolve approved=true on the next tick via the
      // returned handle's resolveOAuthConsent.
      onOAuthConsentRequest: ({ consentId }) => {
        setImmediate(() => {
          try { daemon?.resolveOAuthConsent(consentId, true); } catch { /* best-effort */ }
        });
      },
    });
  });
  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("1. GET /.well-known/oauth-protected-resource is host-aware", async () => {
    const res = await fetch(`${daemon.url}/.well-known/oauth-protected-resource`, {
      headers: { "X-Forwarded-Host": "tunnel-a.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://tunnel-a.example/mcp");
    expect(body.authorization_servers[0]).toContain("tunnel-a.example");
    expect(body.scopes_supported).toContain("mcp");
    expect(body.resource_name).toBe("Perplexity MCP");
  });

  it("2. unauthenticated POST /mcp returns 401 with WWW-Authenticate + host-aware resource_metadata", async () => {
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: { "X-Forwarded-Host": "tunnel-a.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.1", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toMatch(/Bearer/i);
    expect(wwwAuth).toMatch(/error="invalid_token"/);
    expect(wwwAuth).toMatch(/resource_metadata="https:\/\/tunnel-a\.example\/\.well-known\/oauth-protected-resource"/);
  });

  async function registerAndAuthorize({ resource, redirectUri = "http://cb/a" } = {}) {
    const reg = await fetch(`${daemon.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // token_endpoint_auth_method: "none" registers as a PUBLIC client
      // (no client_secret). SDK's authenticateClient middleware skips the
      // secret check for public clients — which is what MCP clients use.
      body: JSON.stringify({
        client_name: "T",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const { verifier, challenge } = pkce();
    const authorizeUrl = new URL("/authorize", daemon.url);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (resource) authorizeUrl.searchParams.set("resource", resource);
    authorizeUrl.searchParams.set("state", "s1");
    const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: "manual" });
    expect([200, 302]).toContain(authorizeRes.status);
    const location = authorizeRes.headers.get("location");
    const code = new URL(location ?? redirectUri).searchParams.get("code");
    expect(code).toBeTruthy();
    return { client_id, code, verifier, redirectUri };
  }

  async function exchangeCode({ client_id, code, verifier, redirectUri, resource }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code, client_id, code_verifier: verifier, redirect_uri: redirectUri,
    });
    if (resource) body.set("resource", resource);
    return fetch(`${daemon.url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  it("3. /token exchange without code_verifier fails (PKCE required)", async () => {
    const { client_id, code, redirectUri } = await registerAndAuthorize();
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirectUri });
    const res = await fetch(`${daemon.url}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    expect(res.status).toBe(400);
  });

  it("4. /authorize with unregistered redirect_uri fails pre-consent", async () => {
    const reg = await fetch(`${daemon.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "T",
        redirect_uris: ["http://cb/registered"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = await reg.json();
    const { challenge } = pkce();
    const url = new URL("/authorize", daemon.url);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client_id);
    url.searchParams.set("redirect_uri", "http://cb/NOT-registered");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "s1");
    const res = await fetch(url.toString(), { redirect: "manual" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("5. resource-bound token rejected at mismatched resource over tunnel", async () => {
    const flow = await registerAndAuthorize({ resource: "https://tunnel-a.example/mcp" });
    const tokenRes = await exchangeCode({ ...flow, resource: "https://tunnel-a.example/mcp" });
    expect(tokenRes.status).toBe(200);
    const { access_token } = await tokenRes.json();
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Forwarded-Host": "tunnel-b.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(/resource/i);
  });

  it("6. tunnel POST /mcp with static daemon bearer returns 401", async () => {
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "X-Forwarded-Host": "tunnel-a.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("7. tunnel POST /mcp with local-shaped bearer returns 401 (8.6 primitive; placeholder rejection)", async () => {
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer pplx_local_claudedesktop_NONEXISTENT_TOKEN_VALUE`,
        "X-Forwarded-Host": "tunnel-a.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.4",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("8. loopback accepts static bearer + oauth access token (positive path)", async () => {
    const staticRes = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(staticRes.status).toBe(200);
    const flow = await registerAndAuthorize({ resource: `${daemon.url}/mcp` });
    const tokenRes = await exchangeCode({ ...flow, resource: `${daemon.url}/mcp` });
    const { access_token } = await tokenRes.json();
    const oauthRes = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(oauthRes.status).toBe(200);
  });

  it("9. tunnel rejects OAuth access token with no bound resource", async () => {
    const flow = await registerAndAuthorize();
    const tokenRes = await exchangeCode(flow);
    expect(tokenRes.status).toBe(200);
    const { access_token } = await tokenRes.json();
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "X-Forwarded-Host": "tunnel-a.example", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.5",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(/resource binding required/i);
  });

  // Prerequisite regression (source-of-truth fix): security.middleware must
  // NOT overwrite the H11-stamped source. A tunnel caller who forges
  // `X-Perplexity-Source: loopback` must NOT downgrade the source to
  // loopback and thereby satisfy H12's loopback-only static bearer check.
  it("10. forged X-Perplexity-Source: loopback on tunnel with static bearer still 401", async () => {
    const res = await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "X-Forwarded-Host": "tunnel-a.example",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.6",
        "X-Perplexity-Source": "loopback",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  // Direct assertion on the middleware pipeline: even when a tunnel caller
  // forges the X-Perplexity-Source header, the final req._pplx.source
  // (stamped by attachRequestSource, preserved by security.middleware) must
  // still report "tunnel". We observe this indirectly through the audit
  // log since it's the only place the final ctx.source is surfaced.
  it("11. audit source field reflects computed source despite X-Perplexity-Source forgery", async () => {
    await fetch(`${daemon.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daemon.bearerToken}`,
        "X-Forwarded-Host": "tunnel-a.example",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.7",
        "X-Perplexity-Source": "loopback",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // Give the async audit append a tick to flush.
    await new Promise((r) => setTimeout(r, 50));
    const entries = daemon.readAuditTail(50);
    const mcpEntry = entries.find((e) => typeof e.path === "string" && e.path.startsWith("/mcp"));
    expect(mcpEntry).toBeDefined();
    expect(mcpEntry.source).toBe("tunnel");
  });
});
