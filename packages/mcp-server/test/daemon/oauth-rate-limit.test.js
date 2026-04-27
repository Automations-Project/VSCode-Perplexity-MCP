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

// /authorize is the lightest OAuth endpoint to flood — the daemon's per-IP
// limiter (30/60s) trips at hit #31, well below the SDK's per-handler ceiling
// (100/15min for /authorize). The handler responds 4xx for the malformed
// params we pass; we never inspect anything but the status code + headers.
async function hitAuthorize(daemonUrl, xff) {
  const headers = xff
    ? {
        "X-Forwarded-For": xff,
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "tunnel-rl.example",
      }
    : {};
  return fetch(
    `${daemonUrl}/authorize?response_type=code&client_id=x&redirect_uri=http://cb`,
    { method: "GET", headers, redirect: "manual" },
  );
}

describe("oauthRateLimit middleware (30/60s sliding window per IP)", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-oauth-ratelimit-"));
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

  it("31st tunnel hit on /authorize from one IP returns 429 with Retry-After: 60", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 30; i += 1) {
      const r = await hitAuthorize(daemon.url, ip);
      expect(r.status, `hit #${i + 1} should not be 429`).not.toBe(429);
    }
    const blocked = await hitAuthorize(daemon.url, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    const body = await blocked.json();
    // Daemon's limiter shape (NOT the SDK's TooManyRequestsError shape) —
    // ensures we tripped OUR limiter, not the SDK's stricter per-handler one.
    expect(body.error).toBe("Too Many Requests");
  });

  it("loopback callers (no XFF / no CF-IP) are exempt — fires 35 hits without 429", async () => {
    for (let i = 0; i < 35; i += 1) {
      const r = await hitAuthorize(daemon.url, null);
      expect(r.status, `loopback hit #${i + 1} should not be 429`).not.toBe(429);
    }
  });

  it("two distinct tunnel IPs each get their own 30-request budget", async () => {
    const ipA = "203.0.113.60";
    const ipB = "203.0.113.61";
    // Burn ipA's budget to 30/30 (still allowed).
    for (let i = 0; i < 30; i += 1) {
      const r = await hitAuthorize(daemon.url, ipA);
      expect(r.status).not.toBe(429);
    }
    // ipB on its first hit must NOT be 429 — its bucket is independent.
    const firstB = await hitAuthorize(daemon.url, ipB);
    expect(firstB.status).not.toBe(429);
    // ipA's 31st IS 429 — confirms per-IP isolation didn't accidentally share.
    const overA = await hitAuthorize(daemon.url, ipA);
    expect(overA.status).toBe(429);
  });

  it("limit only applies to oauth paths — /mcp does NOT count toward the 30-budget", async () => {
    const ip = "203.0.113.70";
    // 35 tunnel /mcp requests — none should 429 from oauthRateLimit. /mcp on
    // tunnel without a valid OAuth token returns 401, never 429 from us.
    for (let i = 0; i < 35; i += 1) {
      const r = await fetch(`${daemon.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": ip,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "tunnel-rl.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status, `/mcp hit #${i + 1} should not be 429`).not.toBe(429);
    }
    // Even after 35 /mcp hits, the same IP can still spend its full /authorize
    // budget (proves /mcp didn't share the bucket).
    const firstOauth = await hitAuthorize(daemon.url, ip);
    expect(firstOauth.status).not.toBe(429);
  }, 15000);
});
