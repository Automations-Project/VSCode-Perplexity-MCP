import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  cloudflaredNamedProvider,
  createCloudflaredNamedProvider,
} from "../../src/daemon/tunnel-providers/cloudflared-named.ts";
import {
  getTunnelProvider,
  listTunnelProviders,
  listTunnelProviderStatuses,
  readTunnelSettings,
  writeTunnelSettings,
} from "../../src/daemon/tunnel-providers/index.ts";
import {
  getNamedTunnelConfigPath,
  writeTunnelConfig,
  readNamedTunnelConfig,
} from "../../src/daemon/tunnel-providers/cloudflared-named-setup.ts";

// Keep a type-level assertion that "cf-named" is part of TunnelProviderId.
// Pure JS file — we exercise this at runtime via getTunnelProvider("cf-named").

/**
 * Build a fake ChildProcess driven by scripted events. Mirrors the fake used
 * in cloudflared-named-setup.test.js so tests read identically.
 */
function makeFakeChild() {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null,
    pid: 7777,
    killed: false,
    exitCode: null,
    killCalls: [],
    kill(signal) {
      child.killCalls.push(signal ?? "SIGTERM");
      if (child.killed) return true;
      child.killed = true;
      return true;
    },
  });
  return child;
}

function installFakeBinary(configDir) {
  const binDir = join(configDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function installFakeCert(homeDir) {
  const certDir = join(homeDir, ".cloudflared");
  mkdirSync(certDir, { recursive: true });
  const certPath = join(certDir, "cert.pem");
  writeFileSync(certPath, "fake-cert", "utf8");
  return certPath;
}

function installFakeCredentials(homeDir, uuid = "11111111-2222-3333-4444-555555555555") {
  const credDir = join(homeDir, ".cloudflared");
  mkdirSync(credDir, { recursive: true });
  const credentialsPath = join(credDir, `${uuid}.json`);
  writeFileSync(credentialsPath, JSON.stringify({ AccountTag: "fake" }), "utf8");
  return credentialsPath;
}

/** Build a spawn recorder that returns a controllable child on each call. */
function makeSpawnRecorder() {
  const calls = [];
  let current = null;
  const spawnImpl = (command, args, options) => {
    const child = makeFakeChild();
    calls.push({ command, args: Array.from(args ?? []), options, child });
    current = child;
    return child;
  };
  return {
    spawnImpl,
    calls,
    get lastChild() {
      return current;
    },
  };
}

let configDir;
let homeDir;
const tempDirs = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "pplx-cfnamed-prov-"));
  homeDir = mkdtempSync(join(tmpdir(), "pplx-cfnamed-home-"));
  tempDirs.push(configDir, homeDir);
});

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cf-named registration", () => {
  it("is available via getTunnelProvider(\"cf-named\") and listTunnelProviders()", () => {
    const provider = getTunnelProvider("cf-named");
    expect(provider.id).toBe("cf-named");
    expect(provider.displayName).toMatch(/cloudflare/i);
    expect(listTunnelProviders().some((p) => p.id === "cf-named")).toBe(true);
  });

  it("listTunnelProviderStatuses includes cf-named with isActive reflecting tunnel-settings.json", async () => {
    writeTunnelSettings(configDir, { activeProvider: "cf-named" });
    const statuses = await listTunnelProviderStatuses(configDir);
    const cfNamed = statuses.find((s) => s.id === "cf-named");
    expect(cfNamed).toBeDefined();
    expect(cfNamed.isActive).toBe(true);
    expect(cfNamed.setup.ready).toBe(false); // binary not installed in tmp configDir
  });

  it("writeTunnelSettings({ activeProvider: 'cf-named' }) persists and reads back", () => {
    writeTunnelSettings(configDir, { activeProvider: "cf-named" });
    const read = readTunnelSettings(configDir);
    expect(read.activeProvider).toBe("cf-named");
  });
});

describe("isSetupComplete", () => {
  it("returns not-ready with install-binary action when cloudflared is missing", async () => {
    const provider = createCloudflaredNamedProvider({
      dependencies: { homedir: () => homeDir },
    });
    const result = await provider.isSetupComplete(configDir);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not installed/i);
    expect(result.action).toEqual({ label: expect.any(String), kind: "install-binary" });
  });

  it("returns not-ready with a login hint when cert.pem is absent", async () => {
    installFakeBinary(configDir);
    // homeDir has no .cloudflared/cert.pem
    const provider = createCloudflaredNamedProvider({
      dependencies: { homedir: () => homeDir },
    });
    const result = await provider.isSetupComplete(configDir);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/cloudflared login/i);
    expect(result.action?.label).toMatch(/Run cloudflared login/i);
  });

  it("returns not-ready when the managed config is missing", async () => {
    installFakeBinary(configDir);
    installFakeCert(homeDir);
    const provider = createCloudflaredNamedProvider({
      dependencies: { homedir: () => homeDir },
    });
    const result = await provider.isSetupComplete(configDir);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/named tunnel not configured/i);
  });

  it("returns not-ready when credentials file is missing", async () => {
    installFakeBinary(configDir);
    installFakeCert(homeDir);
    writeTunnelConfig({
      configDir,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      hostname: "mcp.example.com",
      port: 5000,
      credentialsPath: join(homeDir, ".cloudflared", "missing-creds.json"),
    });
    const provider = createCloudflaredNamedProvider({
      dependencies: { homedir: () => homeDir },
    });
    const result = await provider.isSetupComplete(configDir);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/credentials file not found/i);
  });

  it("returns ready when binary + cert + managed config + credentials all exist", async () => {
    installFakeBinary(configDir);
    installFakeCert(homeDir);
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const credentialsPath = installFakeCredentials(homeDir, uuid);
    writeTunnelConfig({
      configDir,
      uuid,
      hostname: "mcp.example.com",
      port: 5000,
      credentialsPath,
    });
    const provider = createCloudflaredNamedProvider({
      dependencies: { homedir: () => homeDir },
    });
    const result = await provider.isSetupComplete(configDir);
    expect(result).toEqual({ ready: true });
  });
});

describe("start()", () => {
  async function seedReadySetup({ port = 5000, uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", hostname = "mcp.example.com" } = {}) {
    const binaryPath = installFakeBinary(configDir);
    installFakeCert(homeDir);
    const credentialsPath = installFakeCredentials(homeDir, uuid);
    writeTunnelConfig({ configDir, uuid, hostname, port, credentialsPath });
    return { binaryPath, uuid, hostname, credentialsPath };
  }

  it("spawns the pinned binary with `tunnel --no-autoupdate --config <managed-yml> run` (no shell)", async () => {
    const { binaryPath, hostname } = await seedReadySetup();
    const recorder = makeSpawnRecorder();

    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    const transitions = [];
    const startedPromise = provider.start({
      port: 9999,
      configDir,
      onStateChange: (state) => transitions.push({ ...state }),
    });

    // Emit the ready line so waitUntilReady resolves and we can inspect args
    // without leaving a pending promise.
    setTimeout(() => {
      recorder.lastChild.stderr.write(`2026-04-23T00:00:00Z INF Registered tunnel connection connIndex=0\n`);
    }, 10);

    const started = await startedPromise;
    const url = await started.waitUntilReady;
    expect(url).toBe(`https://${hostname}`);

    expect(recorder.calls.length).toBe(1);
    const [call] = recorder.calls;
    expect(call.command).toBe(binaryPath); // NOT "cloudflared" bare, NOT a shell
    expect(call.command).not.toMatch(/\b(?:sh|bash|cmd|powershell|pwsh)\b/i);
    expect(call.options?.shell).not.toBe(true);
    expect(call.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--config",
      getNamedTunnelConfigPath(configDir),
      "run",
    ]);

    // Clean up the fake child so the test harness doesn't hang.
    recorder.lastChild.exitCode = 0;
    recorder.lastChild.emit("exit", 0, null);
    await started.stop();
  });

  it("rewrites the managed YAML with the current port on every start (port-drift)", async () => {
    // Seed the managed config at an OLD port (5000). The daemon restarts on a
    // different OS-assigned port (9999). The provider MUST rewrite the YAML
    // with 9999 before spawning cloudflared — otherwise cloudflared routes
    // traffic to a dead port.
    const { hostname } = await seedReadySetup({ port: 5000 });

    // Sanity-check the seed landed at port 5000.
    const beforeStart = readNamedTunnelConfig(configDir);
    expect(beforeStart.port).toBe(5000);

    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    const startedPromise = provider.start({
      port: 9999, // NEW port
      configDir,
      onStateChange: () => {},
    });

    setTimeout(() => {
      recorder.lastChild.stderr.write(
        `INF Registered tunnel connection connIndex=0\n`,
      );
    }, 10);
    const started = await startedPromise;
    await started.waitUntilReady;

    // 1. On-disk YAML must now reflect the NEW port.
    const afterStart = readNamedTunnelConfig(configDir);
    expect(afterStart.port).toBe(9999);
    expect(afterStart.hostname).toBe(hostname);

    // 2. Spawn's --config arg must point at the managed YAML (not some
    // orphan temp path), and reading it back must show port 9999.
    const configArgIdx = recorder.calls[0].args.indexOf("--config");
    expect(configArgIdx).toBeGreaterThan(-1);
    const spawnConfigPath = recorder.calls[0].args[configArgIdx + 1];
    expect(spawnConfigPath).toBe(getNamedTunnelConfigPath(configDir));
    const raw = readFileSync(spawnConfigPath, "utf8");
    expect(raw).toContain("service: http://127.0.0.1:9999");
    expect(raw).not.toContain("service: http://127.0.0.1:5000");

    recorder.lastChild.exitCode = 0;
    recorder.lastChild.emit("exit", 0, null);
    await started.stop();
  });

  it("waitUntilReady resolves with https://<hostname> when 'Registered tunnel connection' appears on stderr", async () => {
    const { hostname } = await seedReadySetup();
    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    const transitions = [];
    const startedPromise = provider.start({
      port: 9999,
      configDir,
      onStateChange: (state) => transitions.push({ ...state }),
    });

    setTimeout(() => {
      recorder.lastChild.stderr.write("2026-04-23T00:00:00Z INF Starting tunnel tunnelID=abc\n");
      recorder.lastChild.stderr.write("2026-04-23T00:00:01Z INF Registered tunnel connection connIndex=0 ip=10.0.0.1\n");
    }, 10);

    const started = await startedPromise;
    const url = await started.waitUntilReady;
    expect(url).toBe(`https://${hostname}`);
    expect(started.getState().status).toBe("enabled");
    expect(started.getState().url).toBe(`https://${hostname}`);
    expect(transitions.some((s) => s.status === "enabled")).toBe(true);

    recorder.lastChild.exitCode = 0;
    recorder.lastChild.emit("exit", 0, null);
    await started.stop();
  });

  it("waitUntilReady rejects and state becomes 'crashed' when cloudflared exits before ready", async () => {
    await seedReadySetup();
    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    const transitions = [];
    const startedPromise = provider.start({
      port: 9999,
      configDir,
      onStateChange: (state) => transitions.push({ ...state }),
    });

    // Exit with code 1 before emitting any ready line.
    setTimeout(() => {
      recorder.lastChild.exitCode = 1;
      recorder.lastChild.emit("exit", 1, null);
    }, 10);

    const started = await startedPromise;
    await expect(started.waitUntilReady).rejects.toThrow(/exited before.*came online/i);
    expect(started.getState().status).toBe("crashed");
    expect(transitions.some((s) => s.status === "crashed")).toBe(true);
  });

  it("throws immediately when setup is incomplete (no managed config)", async () => {
    installFakeBinary(configDir);
    installFakeCert(homeDir);
    // no writeTunnelConfig call — managed config absent
    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });
    await expect(
      provider.start({ port: 9999, configDir, onStateChange: () => {} }),
    ).rejects.toThrow(/not configured/i);
    expect(recorder.calls.length).toBe(0);
  });
});

describe("stop()", () => {
  async function seedReadySetup() {
    installFakeBinary(configDir);
    installFakeCert(homeDir);
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const credentialsPath = installFakeCredentials(homeDir, uuid);
    writeTunnelConfig({
      configDir,
      uuid,
      hostname: "mcp.example.com",
      port: 5000,
      credentialsPath,
    });
    return { uuid };
  }

  it("SIGTERM first; if the process doesn't exit within the grace window, escalate to SIGKILL (POSIX)", async () => {
    if (process.platform === "win32") return; // win32 path uses taskkill — covered separately
    await seedReadySetup();
    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    // Start + become ready.
    const startedPromise = provider.start({
      port: 9999,
      configDir,
      onStateChange: () => {},
    });
    setTimeout(() => {
      recorder.lastChild.stderr.write("INF Registered tunnel connection connIndex=0\n");
    }, 10);
    const started = await startedPromise;
    await started.waitUntilReady;

    // Trigger stop; child stays alive past the grace window so we can assert
    // the SIGKILL escalation. Use fake timers to avoid real 3s wait.
    const child = recorder.lastChild;
    child.killed = false; // reset so kill() records signals

    const stopPromise = started.stop();
    // Allow microtasks to fire the SIGTERM.
    await Promise.resolve();
    expect(child.killCalls).toContain("SIGTERM");
    expect(child.killCalls).not.toContain("SIGKILL");

    // Fast-forward the real timer by just running wall-clock (3s + slop).
    // We instead simulate the "didn't exit" branch by marking kill() to
    // allow a second call and waiting for the escalation timer.
    // Use real time: the provider sets STOP_GRACE_MS = 3000. Speed this up
    // by letting the escalation fire, then signal exit.
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(child.killCalls).toContain("SIGKILL");

    // Finish the stop by emitting exit.
    child.exitCode = 137;
    child.emit("exit", null, "SIGKILL");
    await stopPromise;
  }, 10_000);

  it("SIGTERM and graceful exit within the grace window: SIGKILL is NEVER called (POSIX)", async () => {
    if (process.platform === "win32") return;
    await seedReadySetup();
    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    const startedPromise = provider.start({
      port: 9999,
      configDir,
      onStateChange: () => {},
    });
    setTimeout(() => {
      recorder.lastChild.stderr.write("INF Registered tunnel connection connIndex=0\n");
    }, 10);
    const started = await startedPromise;
    await started.waitUntilReady;

    const child = recorder.lastChild;
    child.killed = false;

    const stopPromise = started.stop();
    await Promise.resolve();
    expect(child.killCalls).toContain("SIGTERM");

    // Simulate graceful exit well before the 3s grace window.
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("exit", 0, "SIGTERM");
    }, 50);

    await stopPromise;
    expect(child.killCalls).not.toContain("SIGKILL");
    expect(started.getState().status).toBe("disabled");
  }, 8_000);
});

describe("stop() — cross-platform short-circuits", () => {
  async function seedReadySetup() {
    installFakeBinary(configDir);
    installFakeCert(homeDir);
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const credentialsPath = installFakeCredentials(homeDir, uuid);
    writeTunnelConfig({
      configDir,
      uuid,
      hostname: "mcp.example.com",
      port: 5000,
      credentialsPath,
    });
    return { uuid };
  }

  it("stop() on an already-exited child resolves to 'disabled' without calling kill/taskkill", async () => {
    await seedReadySetup();
    const recorder = makeSpawnRecorder();
    const provider = createCloudflaredNamedProvider({
      dependencies: { spawn: recorder.spawnImpl, homedir: () => homeDir },
    });

    const startedPromise = provider.start({
      port: 9999,
      configDir,
      onStateChange: () => {},
    });
    setTimeout(() => {
      recorder.lastChild.stderr.write("INF Registered tunnel connection connIndex=0\n");
    }, 10);
    const started = await startedPromise;
    await started.waitUntilReady;

    const child = recorder.lastChild;
    // Simulate the child already having exited BEFORE stop() is called.
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.killCalls.length = 0; // clear any ready-related kill bookkeeping
    child.killed = false;

    await started.stop();
    expect(child.killCalls).toEqual([]);
    expect(started.getState().status).toBe("disabled");
  });
});

describe("exported singleton", () => {
  it("cloudflaredNamedProvider has the TunnelProvider shape with id cf-named", () => {
    expect(cloudflaredNamedProvider.id).toBe("cf-named");
    expect(typeof cloudflaredNamedProvider.isSetupComplete).toBe("function");
    expect(typeof cloudflaredNamedProvider.start).toBe("function");
  });
});
