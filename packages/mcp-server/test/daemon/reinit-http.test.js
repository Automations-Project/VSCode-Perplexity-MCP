import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "../../src/daemon/server.ts";

function createMockClient(calls) {
  return {
    authenticated: false,
    userId: null,
    accountInfo: null,
    init: async () => undefined,
    shutdown: async () => undefined,
    reinit: async (opts) => { calls.push(opts ?? {}); },
  };
}

describe("/daemon/reinit endpoint", () => {
  let configDir;
  let daemon;
  let calls;

  beforeEach(async () => {
    calls = [];
    configDir = mkdtempSync(join(tmpdir(), "pplx-reinit-http-"));
    daemon = await startDaemonServer({
      configDir,
      version: "0.0.0-test",
      bearerToken: "test-bearer-token",
      createClient: () => createMockClient(calls),
    });
  });

  afterEach(async () => {
    await daemon?.close?.();
    rmSync(configDir, { recursive: true, force: true });
  });

  function reinitFetch(body, withBearer = true) {
    return fetch(`${daemon.url}/daemon/reinit`, {
      method: "POST",
      headers: {
        ...(withBearer ? { Authorization: `Bearer ${daemon.bearerToken}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  it("returns 401 and does not reinit without a bearer", async () => {
    const res = await reinitFetch({ passphrase: "secret" }, false);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("re-supplies the passphrase to the client on a loopback request", async () => {
    const res = await reinitFetch({ passphrase: "hunter2" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(calls).toEqual([{ passphrase: "hunter2" }]);
  });

  it("reinits without a passphrase opt when none is supplied", async () => {
    const res = await reinitFetch({});
    expect(res.status).toBe(200);
    expect(calls).toEqual([{}]);
  });

  it("ignores a non-string / empty passphrase (reinits without one)", async () => {
    const res = await reinitFetch({ passphrase: "" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{}]);
  });
});
