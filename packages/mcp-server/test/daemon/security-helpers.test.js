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

// pickClientIp + isLoopbackRequest are module-private in security.ts. Their
// behavior is observed indirectly through the daemon's per-IP OAuth rate
// limiter (server.ts ~L401), which keys its bucket on req._pplx.ip — the
// value pickClientIp returned. Whether two requests share a bucket reveals
// what pickClientIp considered "the same IP".
//
// What this verifies via rate-limit isolation:
//   * XFF first-segment is the bucket key (different XFF -> independent buckets)
//   * CF-Connecting-IP is the bucket key when XFF is absent
//   * XFF wins over CF-Connecting-IP when both are present
//   * loopback (req.ip = 127.0.0.1, no XFF/CF-IP) -> bypass entirely
//
// The connection?.remoteAddress / socket?.remoteAddress fallbacks in
// pickClientIp are defensive vestigial code unreachable through a real HTTP
// socket (express always populates req.ip from the connection). Exercising
// them would require exporting pickClientIp; intentionally out of scope per
// the test-only contract.
async function hitAuthorize(daemonUrl, headers = {}) {
  return fetch(
    `${daemonUrl}/authorize?response_type=code&client_id=x&redirect_uri=http://cb`,
    { method: "GET", headers, redirect: "manual" },
  );
}

describe("pickClientIp priority chain (observed via OAuth rate-limit bucket)", () => {
  let configDir;
  let daemon;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "pplx-pickclientip-"));
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

  it("XFF first-segment is the bucket key — distinct XFFs have independent buckets", async () => {
    // Burn one bucket to its limit.
    for (let i = 0; i < 30; i += 1) {
      const r = await hitAuthorize(daemon.url, {
        "X-Forwarded-For": "198.51.100.5, 10.0.0.1, 127.0.0.1",
        "X-Forwarded-Proto": "https",
      });
      expect(r.status).not.toBe(429);
    }
    // 31st hit on the SAME XFF first-segment trips. (Verifies first-segment
    // is what pickClientIp keyed on.)
    const same = await hitAuthorize(daemon.url, {
      "X-Forwarded-For": "198.51.100.5, OTHER-MIDDLE, 127.0.0.1",
      "X-Forwarded-Proto": "https",
    });
    expect(same.status).toBe(429);
    // Different first-segment -> fresh bucket -> not 429.
    const diff = await hitAuthorize(daemon.url, {
      "X-Forwarded-For": "198.51.100.99",
      "X-Forwarded-Proto": "https",
    });
    expect(diff.status).not.toBe(429);
  });

  it("CF-Connecting-IP is the bucket key when XFF is absent", async () => {
    for (let i = 0; i < 30; i += 1) {
      const r = await hitAuthorize(daemon.url, { "CF-Connecting-IP": "203.0.113.42" });
      expect(r.status).not.toBe(429);
    }
    // Same CF-IP -> same bucket -> 429.
    const same = await hitAuthorize(daemon.url, { "CF-Connecting-IP": "203.0.113.42" });
    expect(same.status).toBe(429);
    // Different CF-IP -> fresh bucket.
    const diff = await hitAuthorize(daemon.url, { "CF-Connecting-IP": "203.0.113.99" });
    expect(diff.status).not.toBe(429);
  });

  it("XFF wins over CF-Connecting-IP when both are present", async () => {
    // Burn bucket keyed on XFF=A while sending CF-IP=B alongside.
    for (let i = 0; i < 30; i += 1) {
      const r = await hitAuthorize(daemon.url, {
        "X-Forwarded-For": "198.51.100.10",
        "CF-Connecting-IP": "203.0.113.50",
        "X-Forwarded-Proto": "https",
      });
      expect(r.status).not.toBe(429);
    }
    // Flip CF-IP but keep XFF=A -> should still hit the same bucket (pickClientIp
    // chose XFF over CF-IP) -> 429.
    const sameXff = await hitAuthorize(daemon.url, {
      "X-Forwarded-For": "198.51.100.10",
      "CF-Connecting-IP": "203.0.113.999-different",
      "X-Forwarded-Proto": "https",
    });
    expect(sameXff.status).toBe(429);
    // Flip XFF (keep same CF-IP) -> should be a fresh bucket. If pickClientIp
    // had wrongly prioritized CF-IP, this would still be 429.
    const diffXff = await hitAuthorize(daemon.url, {
      "X-Forwarded-For": "198.51.100.250",
      "CF-Connecting-IP": "203.0.113.50",
      "X-Forwarded-Proto": "https",
    });
    expect(diffXff.status).not.toBe(429);
  });

  it("loopback requests (no XFF, no CF-IP) bypass the limiter — 35 hits, no 429", async () => {
    // No tunnel headers -> attachRequestSource stamps source=loopback ->
    // oauthRateLimit returns next() before keying any bucket. pickClientIp
    // still runs (security.middleware) but its result is unused.
    for (let i = 0; i < 35; i += 1) {
      const r = await hitAuthorize(daemon.url, {});
      expect(r.status).not.toBe(429);
    }
  });
});
