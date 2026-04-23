/**
 * Task 8.4.4 — CLI tests for the cloudflared named-tunnel subcommands.
 *
 * Five logical ops, each routed through `daemon:<dashed>` subcommands:
 *   - daemon:cf-named-login
 *   - daemon:cf-named-list
 *   - daemon:cf-named-create
 *   - daemon:cf-named-bind
 *   - daemon:set-provider cf-named (stale-error-message update only)
 *
 * Hermetic strategy:
 *   - vi.mock("../src/daemon/tunnel-providers/index.js") fakes the helpers so
 *     we never spawn cloudflared. writeTunnelSettings / readTunnelSettings use
 *     the real impl — they just touch a temp file.
 *   - vi.mock("../src/tty-prompt.js") fakes the y/N confirmation. We arm it
 *     per-test to simulate 'y', 'n', or EOF.
 *   - set-provider tests use the real tunnel-providers module (no mock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Hoisted mocks. `vi.hoisted` is required so the fake functions exist before
// vi.mock hoists the factory calls above the imports of the unit-under-test.
const runCloudflaredLoginMock = vi.hoisted(() => vi.fn());
const listNamedTunnelsMock = vi.hoisted(() => vi.fn());
const createNamedTunnelMock = vi.hoisted(() => vi.fn());
const writeTunnelConfigMock = vi.hoisted(() => vi.fn());
const promptYesNoMock = vi.hoisted(() => vi.fn());

// tty-prompt: only promptYesNo is mocked. promptSecret is preserved (tests for
// login use that and we don't want to accidentally break it).
vi.mock("../src/tty-prompt.js", async () => {
  const actual = await vi.importActual("../src/tty-prompt.js");
  return { ...actual, promptYesNo: promptYesNoMock };
});

// tunnel-providers index: partial mock — only the cf-named helpers are faked.
// set-provider tests exercise the real writeTunnelSettings/readTunnelSettings.
vi.mock("../src/daemon/tunnel-providers/index.js", async () => {
  const actual = await vi.importActual("../src/daemon/tunnel-providers/index.js");
  return {
    ...actual,
    runCloudflaredLogin: runCloudflaredLoginMock,
    listNamedTunnels: listNamedTunnelsMock,
    createNamedTunnel: createNamedTunnelMock,
    writeTunnelConfig: writeTunnelConfigMock,
  };
});

// Imports AFTER vi.mock so cli.js picks up the mocked subpaths.
const { parseArgs, routeCommand } = await import("../src/cli.js");

describe("cli: cf-named commands", () => {
  let configDir;
  let fakeHome;
  let tempDirs;
  let savedHome;
  let savedUserProfile;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-cli-cfn-"));
    fakeHome = mkdtempSync(join(tmpdir(), "px-cli-cfn-home-"));
    tempDirs = [configDir, fakeHome];
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    // Redirect os.homedir() to a per-test temp dir so the bind tests' creds
    // files land in tmp, not the real ~/.cloudflared directory.
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    runCloudflaredLoginMock.mockReset();
    listNamedTunnelsMock.mockReset();
    createNamedTunnelMock.mockReset();
    writeTunnelConfigMock.mockReset();
    promptYesNoMock.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  // ─── Confirmation-cancel tests (all three destructive commands) ───

  it("daemon:cf-named-login: 'n' at prompt → exit 130, stderr 'Cancelled', helper not called", async () => {
    promptYesNoMock.mockResolvedValueOnce(false);
    const res = await routeCommand(parseArgs(["daemon", "cf-named-login"]));
    expect(res.code).toBe(130);
    expect(res.stderr).toMatch(/Cancelled/);
    expect(res.stdout).toBe("");
    expect(runCloudflaredLoginMock).not.toHaveBeenCalled();
  });

  it("daemon:cf-named-create: 'n' at prompt → exit 130, helper not called", async () => {
    promptYesNoMock.mockResolvedValueOnce(false);
    const res = await routeCommand(
      parseArgs(["daemon", "cf-named-create", "--name", "foo", "--hostname", "foo.example.com"]),
    );
    expect(res.code).toBe(130);
    expect(res.stderr).toMatch(/Cancelled/);
    expect(createNamedTunnelMock).not.toHaveBeenCalled();
    expect(writeTunnelConfigMock).not.toHaveBeenCalled();
  });

  it("daemon:cf-named-bind: 'n' at prompt → exit 130, helper not called (creds exist)", async () => {
    const uuid = "cafecafe-1111-2222-3333-444444444444";
    const credsDir = join(homedir(), ".cloudflared");
    mkdirSync(credsDir, { recursive: true });
    const credsPath = join(credsDir, `${uuid}.json`);
    writeFileSync(credsPath, "{}", "utf8");

    promptYesNoMock.mockResolvedValueOnce(false);
    const res = await routeCommand(
      parseArgs(["daemon", "cf-named-bind", "--uuid", uuid, "--hostname", "bind.example.com"]),
    );
    expect(res.code).toBe(130);
    expect(res.stderr).toMatch(/Cancelled/);
    expect(writeTunnelConfigMock).not.toHaveBeenCalled();
  });

  // ─── --yes skip tests ───

  it("daemon:cf-named-login --yes: prompt is skipped, helper called", async () => {
    runCloudflaredLoginMock.mockResolvedValueOnce({
      ok: true,
      certPath: "/tmp/cert.pem",
    });
    const res = await routeCommand(parseArgs(["daemon", "cf-named-login", "--yes"]));
    expect(res.code).toBe(0);
    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(runCloudflaredLoginMock).toHaveBeenCalledTimes(1);
    expect(res.stdout).toMatch(/login completed/i);
  });

  it("daemon:cf-named-create --yes: happy path — creates tunnel, writes managed config", async () => {
    const uuid = "deadbeef-1111-2222-3333-444444444444";
    const credentialsPath = join(homedir(), ".cloudflared", `${uuid}.json`);
    createNamedTunnelMock.mockResolvedValueOnce({
      uuid,
      name: "mcp-test",
      credentialsPath,
    });
    writeTunnelConfigMock.mockReturnValueOnce({
      uuid,
      hostname: "mcp.example.com",
      port: 1,
      configPath: join(configDir, "cloudflared-named.yml"),
      credentialsPath,
    });

    const res = await routeCommand(
      parseArgs([
        "daemon", "cf-named-create",
        "--name", "mcp-test",
        "--hostname", "mcp.example.com",
        "--yes", "--json",
      ]),
    );
    expect(res.code).toBe(0);
    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(createNamedTunnelMock).toHaveBeenCalledWith({
      configDir,
      name: "mcp-test",
      hostname: "mcp.example.com",
    });
    expect(writeTunnelConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configDir,
        uuid,
        hostname: "mcp.example.com",
        port: 1,
        credentialsPath,
      }),
    );
    const parsedOut = JSON.parse(res.stdout.trim());
    expect(parsedOut.ok).toBe(true);
    expect(parsedOut.uuid).toBe(uuid);
    expect(parsedOut.hostname).toBe("mcp.example.com");
  });

  it("daemon:cf-named-bind --yes: happy path — verifies creds, writes config with port=1", async () => {
    const uuid = "feedface-1111-2222-3333-444444444444";
    const credsDir = join(homedir(), ".cloudflared");
    mkdirSync(credsDir, { recursive: true });
    const credsPath = join(credsDir, `${uuid}.json`);
    writeFileSync(credsPath, "{}", "utf8");

    writeTunnelConfigMock.mockReturnValueOnce({
      uuid,
      hostname: "bind.example.com",
      port: 1,
      configPath: join(configDir, "cloudflared-named.yml"),
      credentialsPath: credsPath,
    });

    const res = await routeCommand(
      parseArgs([
        "daemon", "cf-named-bind",
        "--uuid", uuid,
        "--hostname", "bind.example.com",
        "--yes",
      ]),
    );
    expect(res.code).toBe(0);
    expect(promptYesNoMock).not.toHaveBeenCalled();
    // The "--yes" implementation skips the prompt; make sure we asserted on
    // the mock call AFTER that. Note: cf-named-create isn't invoked here.
    expect(createNamedTunnelMock).not.toHaveBeenCalled();
    expect(writeTunnelConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configDir,
        uuid,
        hostname: "bind.example.com",
        port: 1,
        credentialsPath: credsPath,
      }),
    );
    expect(res.stdout).toMatch(/Bound tunnel/);
  });

  // ─── bind missing creds ───

  it("daemon:cf-named-bind: missing credentials → non-zero exit, clear error, no prompt", async () => {
    const uuid = "no-such-uuid-1234-5678-abcdef012345";
    // homedir() resolves to our per-test fakeHome, which is empty, so the
    // creds file is guaranteed to not exist.
    const credsPath = join(homedir(), ".cloudflared", `${uuid}.json`);
    expect(existsSync(credsPath)).toBe(false);

    const res = await routeCommand(
      parseArgs(["daemon", "cf-named-bind", "--uuid", uuid, "--hostname", "bind.example.com"]),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/credentials file not found/i);
    expect(res.stderr).toContain(credsPath);
    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(writeTunnelConfigMock).not.toHaveBeenCalled();
  });

  // ─── list ───

  it("daemon:cf-named-list: formats tunnels as uuid  name  (N connections)", async () => {
    listNamedTunnelsMock.mockResolvedValueOnce([
      { uuid: "uuid-1", name: "alpha", connections: 2 },
      { uuid: "uuid-2", name: "beta", connections: 0 },
    ]);
    const res = await routeCommand(parseArgs(["daemon", "cf-named-list"]));
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("uuid-1  alpha  (2 connections)");
    expect(res.stdout).toContain("uuid-2  beta  (0 connections)");
  });

  it("daemon:cf-named-list --json: stdout is a single parseable JSON line", async () => {
    const tunnels = [
      { uuid: "uuid-1", name: "alpha", connections: 2 },
      { uuid: "uuid-2", name: "beta", connections: 0 },
    ];
    listNamedTunnelsMock.mockResolvedValueOnce(tunnels);
    const res = await routeCommand(parseArgs(["daemon", "cf-named-list", "--json"]));
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ tunnels });
  });

  it("daemon:cf-named-list: empty list shows 'No named tunnels.' in text mode", async () => {
    listNamedTunnelsMock.mockResolvedValueOnce([]);
    const res = await routeCommand(parseArgs(["daemon", "cf-named-list"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/No named tunnels/);
  });

  // ─── login missing binary ───

  it("daemon:cf-named-login --yes: binary missing → non-zero exit with install hint", async () => {
    runCloudflaredLoginMock.mockRejectedValueOnce(
      new Error('cloudflared not installed; run "daemon install-tunnel" first (expected at /tmp/cloudflared).'),
    );
    const res = await routeCommand(parseArgs(["daemon", "cf-named-login", "--yes"]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/cloudflared not installed/i);
    expect(res.stderr).toMatch(/install-tunnel/);
  });

  // ─── set-provider cf-named (round-trip) ───

  it("daemon:set-provider cf-named: persists via writeTunnelSettings; read-back matches", async () => {
    const setRes = await routeCommand(parseArgs(["daemon", "set-provider", "cf-named"]));
    expect(setRes.code).toBe(0);
    expect(setRes.stdout).toMatch(/cf-named/);

    // Round-trip — use the real readTunnelSettings (via vi.importActual).
    const actual = await vi.importActual("../src/daemon/tunnel-providers/index.js");
    const settings = actual.readTunnelSettings(configDir);
    expect(settings.activeProvider).toBe("cf-named");
  });

  it("daemon:set-provider with no argument: error message mentions cf-named", async () => {
    const res = await routeCommand(parseArgs(["daemon", "set-provider"]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/cf-quick/);
    expect(res.stderr).toMatch(/ngrok/);
    expect(res.stderr).toMatch(/cf-named/);
  });

  // ─── list-providers includes cf-named (REGISTRY wired by 8.4.2) ───

  it("daemon:list-providers: includes all three providers (cf-quick, ngrok, cf-named)", async () => {
    const res = await routeCommand(parseArgs(["daemon", "list-providers", "--json"]));
    expect(res.code).toBe(0);
    const parsedOut = JSON.parse(res.stdout.trim());
    const ids = parsedOut.providers.map((p) => p.id).sort();
    expect(ids).toEqual(["cf-named", "cf-quick", "ngrok"]);
  });

  // ─── missing required flags on create / bind (sanity) ───

  it("daemon:cf-named-create: missing --name → exit 1 with clear error, no prompt", async () => {
    const res = await routeCommand(
      parseArgs(["daemon", "cf-named-create", "--hostname", "foo.example.com"]),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/--name/);
    expect(promptYesNoMock).not.toHaveBeenCalled();
  });
});
