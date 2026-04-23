import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createNamedTunnel,
  clearNamedTunnelConfig,
  deleteNamedTunnel,
  getNamedTunnelConfigPath,
  isActiveConnectionDeleteFailure,
  listNamedTunnels,
  readNamedTunnelConfig,
  runCloudflaredLogin,
  writeTunnelConfig,
} from "../../src/daemon/tunnel-providers/cloudflared-named-setup.ts";

/**
 * Build a fake ChildProcess driven by scripted events. Gives tests fine
 * control over stdout, stderr, and exit timing without spawning a real
 * binary.
 */
function makeFakeChild() {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: null,
    pid: 4242,
    killed: false,
    exitCode: null,
    kill(signal) {
      if (child.killed) return true;
      child.killed = true;
      child.lastSignal = signal;
      return true;
    },
    lastSignal: null,
  });
  return child;
}

/**
 * Create an installed "cloudflared" binary inside `configDir/bin/` so that
 * `existsSync(getTunnelBinaryPath(configDir))` returns true. Contents are
 * irrelevant — the helpers never execute it in tests (fake spawn does).
 */
function installFakeBinary(configDir) {
  const binDir = join(configDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
  return binaryPath;
}

let configDir;
let homeDir;
const tempDirs = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "pplx-cf-named-"));
  homeDir = mkdtempSync(join(tmpdir(), "pplx-cf-home-"));
  tempDirs.push(configDir, homeDir);
});

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCloudflaredLogin", () => {
  it("resolves ok when cert.pem is written during the flow (absent at entry)", async () => {
    installFakeBinary(configDir);
    const certDir = join(homeDir, ".cloudflared");
    mkdirSync(certDir, { recursive: true });
    const certPath = join(certDir, "cert.pem");
    // Cert MUST be absent at entry — that's the precondition for a real
    // login flow. The fake cloudflared emits a URL and only later writes
    // the cert, matching the real-world sequence.

    const child = makeFakeChild();
    let spawnCalls = 0;
    const fakeSpawn = () => {
      spawnCalls++;
      setTimeout(() => child.stderr.write("Please visit https://dash.cloudflare.com/argotunnel?...\n"), 10);
      setTimeout(() => {
        writeFileSync(certPath, "fake-cert", "utf8");
      }, 50);
      return child;
    };

    const result = await runCloudflaredLogin({
      configDir,
      certPath,
      timeoutMs: 2_000,
      dependencies: { spawn: fakeSpawn },
    });
    expect(spawnCalls).toBe(1); // child was actually spawned (not short-circuited)
    expect(result.ok).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.stderr).toContain("argotunnel");
    expect(child.killed).toBe(true);
  });

  it("rejects when cert.pem already exists at entry, without spawning", async () => {
    installFakeBinary(configDir);
    const certDir = join(homeDir, ".cloudflared");
    mkdirSync(certDir, { recursive: true });
    const certPath = join(certDir, "cert.pem");
    writeFileSync(certPath, "pre-existing-cert", "utf8");

    let spawnCalls = 0;
    const fakeSpawn = () => {
      spawnCalls++;
      return makeFakeChild();
    };

    await expect(
      runCloudflaredLogin({
        configDir,
        certPath,
        timeoutMs: 500,
        dependencies: { spawn: fakeSpawn },
      }),
    ).rejects.toThrow(/cert already exists at .*cert\.pem; rename or delete it to re-run login/);
    expect(spawnCalls).toBe(0); // critical: no cloudflared spawn when cert pre-exists
  });

  it("forwardOutput: true pipes child stderr and stdout to parent stderr", async () => {
    installFakeBinary(configDir);
    const certDir = join(homeDir, ".cloudflared");
    mkdirSync(certDir, { recursive: true });
    const certPath = join(certDir, "cert.pem");

    const writes = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    };

    try {
      const child = makeFakeChild();
      const fakeSpawn = () => {
        setTimeout(() => child.stderr.write("URL-from-stderr: https://dash.cloudflare.com/argotunnel?A\n"), 5);
        setTimeout(() => child.stdout.write("URL-from-stdout: https://dash.cloudflare.com/argotunnel?B\n"), 10);
        setTimeout(() => writeFileSync(certPath, "fake-cert", "utf8"), 40);
        return child;
      };

      await runCloudflaredLogin({
        configDir,
        certPath,
        timeoutMs: 2_000,
        forwardOutput: true,
        dependencies: { spawn: fakeSpawn },
      });
    } finally {
      process.stderr.write = origWrite;
    }

    const combined = writes.join("");
    expect(combined).toContain("URL-from-stderr");
    expect(combined).toContain("URL-from-stdout");
  });

  it("rejects on timeout and kills the child", async () => {
    installFakeBinary(configDir);
    const certPath = join(homeDir, ".cloudflared", "cert.pem");
    const child = makeFakeChild();
    const fakeSpawn = () => child;

    await expect(
      runCloudflaredLogin({
        configDir,
        certPath,
        timeoutMs: 400,
        dependencies: { spawn: fakeSpawn },
      }),
    ).rejects.toThrow(/timed out/i);
    expect(child.killed).toBe(true);
    expect(child.lastSignal).toBe("SIGTERM");
  });

  it("rejects when signal aborts and kills the child", async () => {
    installFakeBinary(configDir);
    const certPath = join(homeDir, ".cloudflared", "cert.pem");
    const child = makeFakeChild();
    const fakeSpawn = () => child;

    const ac = new AbortController();
    const p = runCloudflaredLogin({
      configDir,
      certPath,
      timeoutMs: 10_000,
      signal: ac.signal,
      dependencies: { spawn: fakeSpawn },
    });
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow(/aborted/i);
    expect(child.killed).toBe(true);
  });

  it("throws when the binary is missing", async () => {
    const certPath = join(homeDir, ".cloudflared", "cert.pem");
    await expect(
      runCloudflaredLogin({
        configDir, // no bin/cloudflared installed
        certPath,
        timeoutMs: 500,
        dependencies: { spawn: () => makeFakeChild() },
      }),
    ).rejects.toThrow(/cloudflared not installed/i);
  });
});

describe("listNamedTunnels", () => {
  it("parses a valid JSON list into summaries", async () => {
    installFakeBinary(configDir);
    const payload = JSON.stringify([
      {
        id: "11111111-2222-3333-4444-555555555555",
        name: "alpha",
        created_at: "2026-04-01T00:00:00Z",
        connections: [{ id: "c1" }, { id: "c2" }],
      },
      { id: "99999999-aaaa-bbbb-cccc-dddddddddddd", name: "beta", connections: [] },
    ]);
    const child = makeFakeChild();
    const fakeSpawn = () => {
      queueMicrotask(() => {
        child.stdout.write(payload);
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };

    const result = await listNamedTunnels({ configDir, dependencies: { spawn: fakeSpawn } });
    expect(result).toEqual([
      {
        uuid: "11111111-2222-3333-4444-555555555555",
        name: "alpha",
        createdAt: "2026-04-01T00:00:00Z",
        connections: 2,
      },
      {
        uuid: "99999999-aaaa-bbbb-cccc-dddddddddddd",
        name: "beta",
        createdAt: undefined,
        connections: 0,
      },
    ]);
  });

  it("returns [] for an empty JSON array", async () => {
    installFakeBinary(configDir);
    const child = makeFakeChild();
    const fakeSpawn = () => {
      queueMicrotask(() => {
        child.stdout.write("[]");
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };
    const result = await listNamedTunnels({ configDir, dependencies: { spawn: fakeSpawn } });
    expect(result).toEqual([]);
  });

  it("throws with 'not parseable' snippet when stdout is malformed", async () => {
    installFakeBinary(configDir);
    const junk = "not-json-at-all ".repeat(20);
    const child = makeFakeChild();
    const fakeSpawn = () => {
      queueMicrotask(() => {
        child.stdout.write(junk);
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };
    await expect(
      listNamedTunnels({ configDir, dependencies: { spawn: fakeSpawn } }),
    ).rejects.toThrow(/not parseable/i);
  });

  it("surfaces stderr on non-zero exit", async () => {
    installFakeBinary(configDir);
    const child = makeFakeChild();
    const fakeSpawn = () => {
      queueMicrotask(() => {
        child.stderr.write("You need to login first.");
        child.stderr.end();
        child.emit("exit", 1, null);
      });
      return child;
    };
    await expect(
      listNamedTunnels({ configDir, dependencies: { spawn: fakeSpawn } }),
    ).rejects.toThrow(/login first/);
  });
});

describe("createNamedTunnel", () => {
  it("parses uuid + credentials and returns a CreatedTunnel", async () => {
    installFakeBinary(configDir);
    const name = "perplexity-mcp-abc";
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const credentialsPath = join(homeDir, ".cloudflared", `${uuid}.json`);
    let call = 0;
    const fakeSpawn = (_cmd, args) => {
      call += 1;
      const child = makeFakeChild();
      queueMicrotask(() => {
        if (args.includes("create")) {
          // Real cloudflared emits these two lines (order varies by version):
          // "Tunnel credentials written to <path>. cloudflared chose this file ..."
          // "Created tunnel <name> with id <uuid>"
          child.stdout.write(
            `Tunnel credentials written to ${credentialsPath}.\n` +
              `Created tunnel ${name} with id ${uuid}\n`,
          );
        } else {
          // tunnel route dns
          child.stdout.write(`Added CNAME mcp.example.com -> ${uuid}.cfargotunnel.com\n`);
        }
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };

    const result = await createNamedTunnel({
      configDir,
      name,
      hostname: "mcp.example.com",
      dependencies: { spawn: fakeSpawn },
    });

    expect(call).toBe(2); // create + route dns
    expect(result).toEqual({ uuid, name, credentialsPath });
  });

  it("captures credentials path cleanly when cloudflared advisory prose follows on the same line (regression)", async () => {
    // Real cloudflared on Windows was observed emitting the advisory text on
    // the SAME line as the credentials-written line, e.g.
    //   "Tunnel credentials written to C:\...\<uuid>.json. cloudflared chose
    //    this file based on where your origin certificate was found. Keep this
    //    file secret. To revoke these credentials, delete the tunnel"
    // The previous regex /to\s+(.+?)\.?(?:\r?\n|$)/ kept extending the capture
    // until it hit a newline (or EOS) and dragged the full advisory into the
    // credentials-file value written to the managed YAML. The path-boundary
    // fix anchors on the `.json` extension.
    installFakeBinary(configDir);
    const name = "mcp-smoke";
    const uuid = "c4175c8c-9ad7-4ccd-9d51-16d6d2b42c2e";
    const credentialsPath = join(homeDir, ".cloudflared", `${uuid}.json`);
    const fakeSpawn = (_cmd, args) => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        if (args.includes("create")) {
          // All on ONE LINE — no newline between the path and the advisory.
          child.stdout.write(
            `Tunnel credentials written to ${credentialsPath}. cloudflared chose this file based on where your origin certificate was found. Keep this file secret. To revoke these credentials, delete the tunnel\n` +
              `Created tunnel ${name} with id ${uuid}\n`,
          );
        } else {
          child.stdout.write(`Added CNAME\n`);
        }
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };

    const result = await createNamedTunnel({
      configDir,
      name,
      hostname: "mcp.example.com",
      dependencies: { spawn: fakeSpawn },
    });

    expect(result.credentialsPath).toBe(credentialsPath);
    expect(result.credentialsPath).not.toMatch(/cloudflared chose/);
    expect(result.credentialsPath).not.toMatch(/revoke these credentials/);
    expect(result.credentialsPath.endsWith(".json")).toBe(true);
  });

  it("throws when the credentials-path line is missing", async () => {
    installFakeBinary(configDir);
    const fakeSpawn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.write("Created tunnel foo with id 12345678-1111-2222-3333-444444444444\n");
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };
    await expect(
      createNamedTunnel({
        configDir,
        name: "foo",
        hostname: "foo.example.com",
        dependencies: { spawn: fakeSpawn },
      }),
    ).rejects.toThrow(/missing credentials path/i);
  });

  it("throws with stderr surfaced on non-zero exit", async () => {
    installFakeBinary(configDir);
    const fakeSpawn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stderr.write("tunnel name already in use");
        child.stderr.end();
        child.emit("exit", 1, null);
      });
      return child;
    };
    await expect(
      createNamedTunnel({
        configDir,
        name: "dup",
        hostname: "dup.example.com",
        dependencies: { spawn: fakeSpawn },
      }),
    ).rejects.toThrow(/already in use/i);
  });
});

describe("deleteNamedTunnel", () => {
  it("spawns cloudflared tunnel delete --force <uuid>", async () => {
    installFakeBinary(configDir);
    const uuid = "11111111-2222-3333-4444-555555555555";
    const calls = [];
    const fakeSpawn = (_cmd, args) => {
      calls.push(args);
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.write(`Deleted tunnel ${uuid}\n`);
        child.stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };

    await expect(
      deleteNamedTunnel({ configDir, uuid, dependencies: { spawn: fakeSpawn } }),
    ).resolves.toEqual({ uuid });
    expect(calls).toEqual([["tunnel", "delete", "--force", uuid]]);
  });

  it("maps active-connection delete failures to a targeted error", async () => {
    installFakeBinary(configDir);
    const fakeSpawn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stderr.write("Cannot delete tunnel because it has active connections");
        child.stderr.end();
        child.emit("exit", 1, null);
      });
      return child;
    };

    await expect(
      deleteNamedTunnel({
        configDir,
        uuid: "11111111-2222-3333-4444-555555555555",
        dependencies: { spawn: fakeSpawn },
      }),
    ).rejects.toMatchObject({
      reason: "active-connections",
      message: expect.stringMatching(/Remove the DNS route\/CNAME/i),
    });
  });

  it("surfaces unknown non-zero stderr", async () => {
    installFakeBinary(configDir);
    const fakeSpawn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stderr.write("tunnel not found");
        child.stderr.end();
        child.emit("exit", 1, null);
      });
      return child;
    };

    await expect(
      deleteNamedTunnel({
        configDir,
        uuid: "11111111-2222-3333-4444-555555555555",
        dependencies: { spawn: fakeSpawn },
      }),
    ).rejects.toMatchObject({
      reason: "unknown",
      message: expect.stringMatching(/tunnel not found/i),
    });
  });

  it("detects active-connection output variants", () => {
    expect(isActiveConnectionDeleteFailure("Tunnel still has connections")).toBe(true);
    expect(isActiveConnectionDeleteFailure("unrelated failure")).toBe(false);
  });
});

describe("writeTunnelConfig + readNamedTunnelConfig", () => {
  it("writes a YAML config with expected keys and mode 0600 on POSIX", () => {
    const result = writeTunnelConfig({
      configDir,
      uuid: "11111111-2222-3333-4444-555555555555",
      hostname: "mcp.example.com",
      port: 42400,
      credentialsPath: join(homeDir, ".cloudflared", "creds.json"),
    });

    expect(result.configPath).toBe(getNamedTunnelConfigPath(configDir));
    expect(existsSync(result.configPath)).toBe(true);
    const raw = readFileSync(result.configPath, "utf8");
    expect(raw).toContain(`tunnel: 11111111-2222-3333-4444-555555555555`);
    expect(raw).toContain(`credentials-file:`);
    expect(raw).toContain(`- hostname: mcp.example.com`);
    expect(raw).toContain(`service: http://127.0.0.1:42400`);
    expect(raw).toContain(`service: http_status:404`);

    if (process.platform !== "win32") {
      const mode = statSync(result.configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("atomic-rewrites: second write replaces first content with no .tmp left behind", () => {
    writeTunnelConfig({
      configDir,
      uuid: "uuid-1",
      hostname: "first.example.com",
      port: 11111,
      credentialsPath: "/tmp/one.json",
    });
    const second = writeTunnelConfig({
      configDir,
      uuid: "uuid-2",
      hostname: "second.example.com",
      port: 22222,
      credentialsPath: "/tmp/two.json",
    });
    const raw = readFileSync(second.configPath, "utf8");
    expect(raw).toContain("uuid-2");
    expect(raw).toContain("second.example.com");
    expect(raw).toContain("22222");
    expect(raw).not.toContain("uuid-1");
    expect(raw).not.toContain("first.example.com");
    expect(existsSync(`${second.configPath}.tmp`)).toBe(false);
  });

  it("returns NamedTunnelConfig with absolute paths", () => {
    const result = writeTunnelConfig({
      configDir,
      uuid: "u",
      hostname: "h.example.com",
      port: 33333,
      credentialsPath: "/abs/path/creds with space.json",
    });
    expect(result.uuid).toBe("u");
    expect(result.hostname).toBe("h.example.com");
    expect(result.port).toBe(33333);
    expect(result.credentialsPath).toBe("/abs/path/creds with space.json");
    // path with space got quoted in YAML
    const raw = readFileSync(result.configPath, "utf8");
    expect(raw).toContain(`credentials-file: "/abs/path/creds with space.json"`);
  });

  it("readNamedTunnelConfig returns null when the file is absent", () => {
    expect(readNamedTunnelConfig(configDir)).toBeNull();
  });

  it("readNamedTunnelConfig round-trips its own output", () => {
    writeTunnelConfig({
      configDir,
      uuid: "round-trip-uuid",
      hostname: "rt.example.com",
      port: 55555,
      credentialsPath: "/data/creds.json",
    });
    const parsed = readNamedTunnelConfig(configDir);
    expect(parsed).not.toBeNull();
    expect(parsed.uuid).toBe("round-trip-uuid");
    expect(parsed.hostname).toBe("rt.example.com");
    expect(parsed.port).toBe(55555);
    expect(parsed.credentialsPath).toBe("/data/creds.json");
    expect(parsed.configPath).toBe(getNamedTunnelConfigPath(configDir));
  });

  it("readNamedTunnelConfig returns null for malformed YAML", () => {
    const path = getNamedTunnelConfigPath(configDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, "this is not a tunnel config\njust garbage\n", "utf8");
    expect(readNamedTunnelConfig(configDir)).toBeNull();
  });

  it("getNamedTunnelConfigPath returns <configDir>/cloudflared-named.yml", () => {
    expect(getNamedTunnelConfigPath(configDir)).toBe(join(configDir, "cloudflared-named.yml"));
  });

  it("clearNamedTunnelConfig removes only the managed config", () => {
    const written = writeTunnelConfig({
      configDir,
      uuid: "clear-uuid",
      hostname: "clear.example.com",
      port: 55555,
      credentialsPath: "/data/creds.json",
    });
    expect(clearNamedTunnelConfig(configDir)).toBe(true);
    expect(existsSync(written.configPath)).toBe(false);
    expect(clearNamedTunnelConfig(configDir)).toBe(false);
  });
});
