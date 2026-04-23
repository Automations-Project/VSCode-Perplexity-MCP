import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, getLockfilePath } from "../../src/daemon/lockfile.ts";
import { ensureDaemon, getDaemonStatus, startDaemon } from "../../src/daemon/launcher.ts";

function createMockClient() {
  return {
    authenticated: true,
    userId: "launcher-test",
    accountInfo: {
      isMax: false,
      isPro: true,
      isEnterprise: false,
      canUseComputer: false,
      modelsConfig: null,
      rateLimits: null,
    },
    init: async () => undefined,
    reinit: async () => undefined,
    shutdown: async () => undefined,
  };
}

function readPackageVersion() {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
}

describe("daemon launcher", () => {
  const runtimes = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      const runtime = runtimes.pop();
      await runtime?.close?.().catch(() => undefined);
      if (runtime?.configDir) {
        rmSync(runtime.configDir, { recursive: true, force: true });
      }
    }
  });

  it("10 parallel ensureDaemon calls converge on exactly one daemon", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-launcher-"));
    let winners = 0;

    const spawnDaemon = async () => {
      const runtime = await startDaemon({
        configDir,
        createClient: createMockClient,
      });
      if (!runtime.attached) {
        winners += 1;
        runtimes.push({ ...runtime, configDir });
      }
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ensureDaemon({
          configDir,
          spawnDaemon,
          pollIntervalMs: 50,
          startTimeoutMs: 5_000,
        }),
      ),
    );

    expect(winners).toBe(1);
    expect(new Set(results.map((item) => item.pid))).toEqual(new Set([results[0].pid]));
    expect(new Set(results.map((item) => item.port))).toEqual(new Set([results[0].port]));

    const status = await getDaemonStatus({ configDir, reclaimStale: false });
    expect(status.running).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.record?.pid).toBe(results[0].pid);
    expect(results[0].version).toBe(readPackageVersion());
  });

  it("reclaims a stale lockfile before starting a new daemon", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "pplx-daemon-stale-"));
    const lockPath = getLockfilePath(configDir);

    expect(
      acquire(
        {
          pid: 999999,
          uuid: "stale-daemon",
          port: 43001,
          bearerToken: "stale-token",
          version: "0.5.0",
          startedAt: new Date().toISOString(),
        },
        { lockPath },
      ),
    ).toBe(true);

    const runtime = await startDaemon({
      configDir,
      createClient: createMockClient,
    });

    expect(runtime.attached).toBe(false);
    expect(runtime.uuid).not.toBe("stale-daemon");
    runtimes.push({ ...runtime, configDir });
  });
});
