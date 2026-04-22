import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerplexityOAuthProvider } from "../../src/daemon/oauth-provider.ts";

function mockRes() {
  const res = {
    redirectedTo: null,
    req: { _pplx: {} },
    redirect(url) {
      this.redirectedTo = url;
    },
  };
  return res;
}

function makeClient(overrides = {}) {
  return {
    client_id: "client-cache-test",
    client_name: "Cache Test Client",
    redirect_uris: ["http://cb/a"],
    ...overrides,
  };
}

describe("oauth-provider authorize + consent cache", () => {
  let configDir;
  let provider;
  let requestConsentCalls;
  let cacheHitCalls;
  let consentApproves;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-provider-"));
    requestConsentCalls = 0;
    cacheHitCalls = [];
    consentApproves = true;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function buildProvider(ttlHours) {
    return new PerplexityOAuthProvider({
      configDir,
      getStaticBearer: () => "static",
      getConsentCacheTtlMs: () => Math.floor(ttlHours * 60 * 60_000),
      onConsentCacheHit: (info) => {
        cacheHitCalls.push({ clientId: info.clientId, redirectUri: info.redirectUri });
        info.res.req._pplx = info.res.req._pplx ?? {};
        info.res.req._pplx.authOverride = "oauth-cached";
      },
      requestConsent: async () => {
        requestConsentCalls += 1;
        return consentApproves;
      },
    });
  }

  async function register(provider, overrides) {
    const base = makeClient(overrides);
    const full = await provider.clientsStore.registerClient(base);
    return full;
  }

  it("fresh client: requestConsent is invoked, cache hit is NOT called, cache is written on approve", async () => {
    provider = buildProvider(24);
    const client = await register(provider);

    const res = mockRes();
    await provider.authorize(
      client,
      { redirectUri: "http://cb/a", codeChallenge: "abc", state: "s1" },
      res,
    );

    expect(requestConsentCalls).toBe(1);
    expect(cacheHitCalls).toEqual([]);
    expect(res.redirectedTo).toMatch(/code=/);
    expect(provider.listConsents().length).toBe(1);
    expect(provider.listConsents()[0]).toMatchObject({
      clientId: client.client_id,
      redirectUri: "http://cb/a",
    });
  });

  it("second authorize within TTL: cache hit fires, requestConsent is NOT invoked, code still issues", async () => {
    provider = buildProvider(24);
    const client = await register(provider);

    const res1 = mockRes();
    await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, res1);
    expect(requestConsentCalls).toBe(1);

    const res2 = mockRes();
    await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2" }, res2);

    expect(requestConsentCalls).toBe(1); // unchanged — cache hit
    expect(cacheHitCalls).toEqual([{ clientId: client.client_id, redirectUri: "http://cb/a" }]);
    expect(res2.redirectedTo).toMatch(/code=/);
    expect(res2.req._pplx.authOverride).toBe("oauth-cached");
  });

  it("TTL = 0 disables the cache: every call prompts consent", async () => {
    provider = buildProvider(0);
    const client = await register(provider);

    await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, mockRes());
    await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2" }, mockRes());

    expect(requestConsentCalls).toBe(2);
    expect(cacheHitCalls).toEqual([]);
    expect(provider.listConsents()).toEqual([]);
  });

  it("denial: cache is NOT written and the redirect carries access_denied", async () => {
    provider = buildProvider(24);
    const client = await register(provider);

    consentApproves = false;
    const res = mockRes();
    await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, res);

    expect(res.redirectedTo).toMatch(/error=access_denied/);
    expect(provider.listConsents()).toEqual([]);
  });

  it("revokeClient purges that client's cached consents", async () => {
    provider = buildProvider(24);
    const client = await register(provider);

    await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, mockRes());
    expect(provider.listConsents().length).toBe(1);

    provider.revokeClient(client.client_id);
    expect(provider.listConsents()).toEqual([]);
  });

  it("revokeConsent(clientId, redirectUri) removes only the matching pair", async () => {
    provider = buildProvider(24);
    const clientA = await register(provider, { client_name: "A" });
    const clientB = await register(provider, { client_name: "B" });

    await provider.authorize(clientA, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, mockRes());
    await provider.authorize(clientB, { redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2" }, mockRes());

    const removed = provider.revokeConsent(clientA.client_id, "http://cb/a");
    expect(removed).toBe(1);

    const remaining = provider.listConsents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].clientId).toBe(clientB.client_id);
  });
});

describe("oauth-provider authorize + consent cache — resource binding (H12 follow-up)", () => {
  let configDir;
  let provider;
  let requestConsentCalls;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-provider-resource-"));
    requestConsentCalls = [];
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function buildProvider() {
    return new PerplexityOAuthProvider({
      configDir,
      getStaticBearer: () => "static",
      getConsentCacheTtlMs: () => 24 * 60 * 60_000,
      requestConsent: async (info) => {
        requestConsentCalls.push({
          clientId: info.clientId,
          redirectUri: info.redirectUri,
          // `resource` is the specific field under test.
          resource: info.resource,
        });
        return true;
      },
    });
  }

  async function register(provider) {
    return provider.clientsStore.registerClient({
      client_id: "seed-only",
      client_name: "Resource Test Client",
      redirect_uris: ["http://cb/a"],
    });
  }

  it("consent approved for resource A does NOT auto-approve resource B (same client + redirect)", async () => {
    provider = buildProvider();
    const client = await register(provider);

    // First authorize for resource A — consent prompt fires, gets approved, cache records
    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, mockRes());
    expect(requestConsentCalls).toHaveLength(1);

    // Second authorize for resource B — MUST re-prompt (no cache hit)
    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2",
      resource: "https://tunnel-b.example/mcp",
    }, mockRes());
    expect(requestConsentCalls).toHaveLength(2);
    expect(requestConsentCalls[1].resource).toBe("https://tunnel-b.example/mcp");
  });

  it("consent approved for resource A DOES auto-approve resource A within TTL", async () => {
    provider = buildProvider();
    const client = await register(provider);

    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, mockRes());
    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2",
      resource: "https://tunnel-a.example/mcp",
    }, mockRes());
    // Second call is a cache hit — no second prompt
    expect(requestConsentCalls).toHaveLength(1);
  });

  it("unbound consent does NOT auto-approve a bound-resource consent request", async () => {
    provider = buildProvider();
    const client = await register(provider);

    // First: unbound authorize (legacy / loopback, no resource param)
    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
    }, mockRes());
    expect(requestConsentCalls).toHaveLength(1);
    expect(requestConsentCalls[0].resource).toBeUndefined();

    // Second: bound authorize — MUST re-prompt
    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2",
      resource: "https://tunnel-a.example/mcp",
    }, mockRes());
    expect(requestConsentCalls).toHaveLength(2);
    expect(requestConsentCalls[1].resource).toBe("https://tunnel-a.example/mcp");
  });

  it("bound consent does NOT auto-approve an unbound (legacy) authorize", async () => {
    provider = buildProvider();
    const client = await register(provider);

    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      resource: "https://tunnel-a.example/mcp",
    }, mockRes());
    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2",
    }, mockRes());
    expect(requestConsentCalls).toHaveLength(2);
    expect(requestConsentCalls[1].resource).toBeUndefined();
  });

  it("requestConsent receives the normalized resource string (not a URL object)", async () => {
    provider = buildProvider();
    const client = await register(provider);

    await provider.authorize(client, {
      redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
      // SDK may pass a URL — provider must normalize before invoking the callback
      resource: new URL("https://tunnel-c.example/mcp"),
    }, mockRes());
    expect(requestConsentCalls).toHaveLength(1);
    expect(typeof requestConsentCalls[0].resource).toBe("string");
    expect(requestConsentCalls[0].resource).toBe("https://tunnel-c.example/mcp");
  });

  it("cache-hit trace line includes resource context and no secrets", async () => {
    provider = buildProvider();
    const client = await register(provider);

    const traceLines = [];
    const origError = console.error;
    console.error = (...args) => { traceLines.push(args.join(" ")); };
    try {
      await provider.authorize(client, {
        redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1",
        resource: "https://tunnel-a.example/mcp",
      }, mockRes());
      await provider.authorize(client, {
        redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2",
        resource: "https://tunnel-a.example/mcp",
      }, mockRes());
    } finally {
      console.error = origError;
    }

    const cacheHitTrace = traceLines.find((l) => l.includes("oauth consent cache hit"));
    expect(cacheHitTrace).toBeDefined();
    expect(cacheHitTrace).toContain("https://tunnel-a.example/mcp");
    // Redaction sanity: the trace line must not carry any token-shaped strings.
    expect(cacheHitTrace).not.toMatch(/pplx_(at|rt|ac|local)_/);
    expect(cacheHitTrace).not.toMatch(/Bearer\s+\S+/);
    expect(cacheHitTrace).not.toContain("bearerToken");
  });

  it("unbound cache-hit trace line marks resource as <unbound>", async () => {
    provider = buildProvider();
    const client = await register(provider);

    const traceLines = [];
    const origError = console.error;
    console.error = (...args) => { traceLines.push(args.join(" ")); };
    try {
      await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c1", state: "s1" }, mockRes());
      await provider.authorize(client, { redirectUri: "http://cb/a", codeChallenge: "c2", state: "s2" }, mockRes());
    } finally {
      console.error = origError;
    }

    const cacheHitTrace = traceLines.find((l) => l.includes("oauth consent cache hit"));
    expect(cacheHitTrace).toBeDefined();
    expect(cacheHitTrace).toContain("resource=<unbound>");
  });
});
