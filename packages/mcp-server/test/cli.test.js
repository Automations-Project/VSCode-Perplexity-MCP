import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, routeCommand } from "../src/cli.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon/launcher.ts";
import { __resetKeyCache } from "../src/vault.js";

function createMockClient() {
  return {
    authenticated: true,
    userId: "cli-daemon-test",
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

describe("parseArgs", () => {
  it("parses subcommand + flags", () => {
    const a = parseArgs(["login", "--profile", "work", "--mode", "auto"]);
    expect(a.command).toBe("login");
    expect(a.flags.profile).toBe("work");
    expect(a.flags.mode).toBe("auto");
  });
  it("parses --plain-cookies as boolean true", () => {
    const a = parseArgs(["login", "--plain-cookies"]);
    expect(a.flags["plain-cookies"]).toBe(true);
  });
  it("parses --json as boolean true", () => {
    expect(parseArgs(["status", "--json"]).flags.json).toBe(true);
  });
  it("returns command 'server' when no args", () => {
    expect(parseArgs([]).command).toBe("server");
  });
  it("handles --version and --help at top level", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["--help"]).command).toBe("help");
  });
  it("parses daemon subcommands as a grouped command", () => {
    const a = parseArgs(["daemon", "status", "--json"]);
    expect(a.command).toBe("daemon:status");
    expect(a.flags.json).toBe(true);
  });
});

describe("routeCommand (stubs)", () => {
  it("dispatches known stub commands", async () => {
    const res = await routeCommand({ command: "install-browser", flags: { json: true } });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/not-yet-implemented|install-browser/i);
  });
  it("unknown command exits 1", async () => {
    const res = await routeCommand({ command: "nope", flags: {} });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/unknown/i);
  });
});

describe("parseArgs — positional args", () => {
  it("captures positional args before flags", () => {
    const a = parseArgs(["export", "id123", "--format", "pdf"]);
    expect(a.command).toBe("export");
    expect(a.positional).toEqual(["id123"]);
    expect(a.flags.format).toBe("pdf");
  });

  it("captures multiple positional args", () => {
    const a = parseArgs(["open", "id1", "--viewer", "system"]);
    expect(a.positional).toEqual(["id1"]);
  });
});

describe("routeCommand — help and version", () => {
  it("help prints HELP_TEXT with usage lines", async () => {
    const res = await routeCommand({ command: "help", flags: {} });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/perplexity-user-mcp/);
    expect(res.stdout).toMatch(/Usage:/);
    expect(res.stdout).toMatch(/--version/);
  });

  it("version prints package version", async () => {
    const res = await routeCommand({ command: "version", flags: {} });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+\s*$/);
  });
});

describe("routeCommand — phase mapping (remaining stubs)", () => {
  it("install-browser maps to Phase 3", async () => {
    const res = await routeCommand({ command: "install-browser", flags: {} });
    expect(res.stdout).toMatch(/Phase 3/);
  });

  it("export maps to Phase 4", async () => {
    const res = await routeCommand({ command: "export", flags: {} });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/history id/i);
  });

  it("open maps to Phase 4", async () => {
    const res = await routeCommand({ command: "open", flags: {} });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/history id/i);
  });

  it("rebuild-history-index maps to Phase 4", async () => {
    const res = await routeCommand({ command: "rebuild-history-index", flags: {} });
    expect(res.stdout).toMatch(/Rebuilt history index/);
  });
});

describe("routeCommand — JSON mode for stubs", () => {
  it("returns parseable JSON when --json flag is set (install-browser stub)", async () => {
    const res = await routeCommand({ command: "install-browser", flags: { json: true } });
    const lines = res.stdout.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("not-yet-implemented");
    expect(parsed.command).toBe("install-browser");
  });

  it("returns non-JSON message when --json flag is not set (install-browser stub)", async () => {
    const res = await routeCommand({ command: "install-browser", flags: {} });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/not yet implemented/);
    expect(res.stdout).not.toMatch(/^{/);
  });
});

describe("parseArgs — edge cases", () => {
  it("handles flags without values at end of args", () => {
    const a = parseArgs(["status", "--all"]);
    expect(a.flags.all).toBe(true);
  });

  it("handles mixed positional and flags", () => {
    const a = parseArgs(["export", "id123", "--format", "pdf", "--verbose"]);
    expect(a.positional).toEqual(["id123"]);
    expect(a.flags.format).toBe("pdf");
    expect(a.flags.verbose).toBe(true);
  });

  it("flag value can be a number-like string", () => {
    const a = parseArgs(["status", "--count", "42"]);
    expect(a.flags.count).toBe("42");
  });
});

describe("routeCommand — all phase-3 commands text mode", () => {
  it("install-browser outputs Phase 3 text", async () => {
    const res = await routeCommand({ command: "install-browser", flags: {} });
    expect(res.stdout).toMatch(/Phase 3/);
  });
});

describe("routeCommand — all phase-4 commands text mode", () => {
  it("export outputs Phase 4 text", async () => {
    const res = await routeCommand({ command: "export", flags: {} });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/history id/i);
  });

  it("open outputs Phase 4 text", async () => {
    const res = await routeCommand({ command: "open", flags: {} });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/history id/i);
  });

  it("rebuild-history-index outputs Phase 4 text", async () => {
    const res = await routeCommand({ command: "rebuild-history-index", flags: {} });
    expect(res.stdout).toMatch(/Rebuilt history index/);
  });
});

describe("cli: account commands (stubs replaced)", () => {
  let configDir;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-cli-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "cli-pass";
    __resetKeyCache();
  });

  it("list-accounts --json on empty config returns []", async () => {
    const res = await routeCommand(parseArgs(["list-accounts", "--json"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ ok: true, active: null, profiles: [] });
  });

  it("add-account --name work --mode manual --json creates the profile", async () => {
    const res = await routeCommand(parseArgs(["add-account", "--name", "work", "--mode", "manual", "--json"]));
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.profile.name).toBe("work");
  });

  it("switch-account rejects an unknown profile", async () => {
    const res = await routeCommand(parseArgs(["switch-account", "nope"]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not found/i);
  });

  it("status --json with no cookies returns {valid:false, reason:'no_cookies'}", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "default", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "default"]));
    const res = await routeCommand(parseArgs(["status", "--json"]));
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toBe("no_cookies");
  });

  it("status (text mode) with no cookies hints to login", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "default", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "default"]));
    const res = await routeCommand(parseArgs(["status"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/No session/);
    expect(res.stdout).toMatch(/login/);
  });

  it("status --json with stored cookies returns {valid:true}", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "work", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "work"]));
    const { Vault } = await import("../src/vault.js");
    await new Vault().set("work", "cookies", JSON.stringify([{ name: "x", value: "y" }]));
    const res = await routeCommand(parseArgs(["status", "--json"]));
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.valid).toBe(true);
    expect(parsed.profile).toBe("work");
  });

  it("status (text mode) with stored cookies shows meta", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "w2", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "w2"]));
    const { Vault } = await import("../src/vault.js");
    await new Vault().set("w2", "cookies", JSON.stringify([{ name: "a", value: "b" }]));
    const res = await routeCommand(parseArgs(["status"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/has stored cookies/);
  });

  it("list-accounts (text mode, empty) hints to add-account", async () => {
    const res = await routeCommand(parseArgs(["list-accounts"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/No profiles yet/);
  });

  it("list-accounts (text mode, populated) shows active marker", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "a1", "--mode", "manual"]));
    await routeCommand(parseArgs(["add-account", "--name", "a2", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "a2"]));
    const res = await routeCommand(parseArgs(["list-accounts"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\* a2/);
    expect(res.stdout).toMatch(/  a1/);
  });

  it("add-account with no --name auto-picks account-1", async () => {
    const res = await routeCommand(parseArgs(["add-account", "--json"]));
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.profile.name).toMatch(/^account-\d+$/);
  });

  it("add-account (text mode) returns human message", async () => {
    const res = await routeCommand(parseArgs(["add-account", "--name", "hm", "--mode", "manual"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Created profile 'hm'/);
  });

  it("add-account duplicate name fails with JSON error", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "dup", "--mode", "manual"]));
    const res = await routeCommand(parseArgs(["add-account", "--name", "dup", "--mode", "manual", "--json"]));
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/already exists/);
  });

  it("add-account duplicate name (text mode) writes to stderr", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "dup2", "--mode", "manual"]));
    const res = await routeCommand(parseArgs(["add-account", "--name", "dup2", "--mode", "manual"]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/already exists/);
  });

  it("switch-account with no arg exits 1", async () => {
    const res = await routeCommand(parseArgs(["switch-account"]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/requires a profile name/);
  });

  it("switch-account (text mode) confirms switch", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "sw", "--mode", "manual"]));
    const res = await routeCommand(parseArgs(["switch-account", "sw"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Switched to 'sw'/);
  });

  it("switch-account --json confirms switch", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "sw2", "--mode", "manual"]));
    const res = await routeCommand(parseArgs(["switch-account", "sw2", "--json"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ ok: true, active: "sw2" });
  });

  it("logout (soft) --json on default profile", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "default", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "default"]));
    const res = await routeCommand(parseArgs(["logout", "--json"]));
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.purged).toBe(false);
    expect(parsed.profile).toBe("default");
  });

  it("logout (text mode) gives human confirmation", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "lo", "--mode", "manual"]));
    const res = await routeCommand(parseArgs(["logout", "--profile", "lo"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Logged out of 'lo'/);
  });

  it("logout --purge removes the profile directory", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "purgeme", "--mode", "manual"]));
    const res = await routeCommand(parseArgs(["logout", "--profile", "purgeme", "--purge", "--json"]));
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.purged).toBe(true);
  });

  it("rebuild-history-index --json reports scan counts", async () => {
    await routeCommand(parseArgs(["add-account", "--name", "default", "--mode", "manual"]));
    await routeCommand(parseArgs(["switch-account", "default"]));
    const { append } = await import("../src/history-store.js");
    append({
      tool: "perplexity_search",
      query: "hello",
      model: "pplx_pro",
      mode: "copilot",
      language: "en-US",
      body: "Hello world",
    });

    const res = await routeCommand(parseArgs(["rebuild-history-index", "--json"]));
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.scanned).toBe(1);
    expect(parsed.recovered).toBe(1);
    expect(parsed.skipped).toBe(0);
  });
});

describe("cli: daemon commands", () => {
  let configDir;
  let runtime;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-cli-daemon-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    await runtime?.close?.().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("daemon status --json reports no daemon when nothing is running", async () => {
    const res = await routeCommand(parseArgs(["daemon", "status", "--json"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toMatchObject({
      running: false,
      healthy: false,
    });
  });

  it("daemon status and stop operate against a running daemon", async () => {
    runtime = await startDaemon({
      configDir,
      createClient: createMockClient,
    });

    const statusRes = await routeCommand(parseArgs(["daemon", "status", "--json"]));
    expect(statusRes.code).toBe(0);
    expect(JSON.parse(statusRes.stdout.trim())).toMatchObject({
      running: true,
      healthy: true,
      pid: runtime.pid,
      port: runtime.port,
    });

    const stopRes = await routeCommand(parseArgs(["daemon", "stop", "--json"]));
    expect(stopRes.code).toBe(0);
    expect(JSON.parse(stopRes.stdout.trim())).toMatchObject({
      ok: true,
      stopped: true,
      pid: runtime.pid,
    });

    runtime = undefined;
  });
});

describe("doctor subcommand", () => {
  it("doctor --json emits one JSON line with overall status", async () => {
    const res = await routeCommand({ command: "doctor", flags: { json: true }, positional: [] });
    expect([0, 10]).toContain(res.code);
    const lines = res.stdout.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(["pass", "warn", "fail"]).toContain(last.overall);
    expect(last.byCategory).toBeDefined();
  });

  it("doctor (human) prints a report header", async () => {
    const res = await routeCommand({ command: "doctor", flags: {}, positional: [] });
    expect(res.stdout).toMatch(/Perplexity Doctor report/);
  });
});

// ---------------------------------------------------------------------------
// Task 8.3.2 — PERPLEXITY_NO_DAEMON opt-out for `daemon attach`.
// Hoisted mocks replace the dynamic imports inside cli.js' daemon:attach branch
// so we can verify: (a) opt-out calls main() from index.js, (b) opt-out never
// reaches attachToDaemon, (c) absent env var preserves the 8.3.1 attach path,
// (d) stdout stays empty (the warning lands on stderr only).
// ---------------------------------------------------------------------------
const mainSpy = vi.hoisted(() => vi.fn(async () => undefined));
const attachSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/index.js", () => ({ main: mainSpy }));
vi.mock("../src/daemon/attach.js", () => ({ attachToDaemon: attachSpy }));

describe("daemon:attach — PERPLEXITY_NO_DAEMON opt-out (Task 8.3.2)", () => {
  let savedEnv;
  let stdoutSpy;
  let stderrSpy;

  beforeEach(() => {
    savedEnv = process.env.PERPLEXITY_NO_DAEMON;
    delete process.env.PERPLEXITY_NO_DAEMON;
    mainSpy.mockClear();
    attachSpy.mockClear();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PERPLEXITY_NO_DAEMON;
    else process.env.PERPLEXITY_NO_DAEMON = savedEnv;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("(a) PERPLEXITY_NO_DAEMON=1 invokes in-process stdio main() exactly once", async () => {
    process.env.PERPLEXITY_NO_DAEMON = "1";
    const res = await routeCommand({ command: "daemon:attach", flags: {} });
    expect(mainSpy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("(b) PERPLEXITY_NO_DAEMON=1 never calls attachToDaemon (daemon layer stays cold)", async () => {
    process.env.PERPLEXITY_NO_DAEMON = "1";
    await routeCommand({ command: "daemon:attach", flags: {} });
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it("(c) env var absent → existing attach path is used (attachToDaemon called)", async () => {
    await routeCommand({ command: "daemon:attach", flags: {} });
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(mainSpy).not.toHaveBeenCalled();
  });

  it("(d) stdout stays clean on opt-out; warning lands on stderr only", async () => {
    process.env.PERPLEXITY_NO_DAEMON = "1";
    await routeCommand({ command: "daemon:attach", flags: {} });
    expect(stdoutSpy).not.toHaveBeenCalled();
    const stderrPayload = stderrSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : args[0]?.toString?.() ?? ""))
      .join("");
    expect(stderrPayload).toContain("PERPLEXITY_NO_DAEMON=1 set");
    expect(stderrPayload).toContain("daemon bypass");
  });

  it("accepts case-insensitive 'TRUE' as a truthy opt-out value", async () => {
    process.env.PERPLEXITY_NO_DAEMON = "TRUE";
    await routeCommand({ command: "daemon:attach", flags: {} });
    expect(mainSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).not.toHaveBeenCalled();
  });
});
