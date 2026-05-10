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

describe("cli: vault-unseal preflight", () => {
  // The preflight has to fire BEFORE we touch the profile dir or spawn the
  // login runner — otherwise users on a fresh box see a deep "Vault locked"
  // stack trace at the end of an otherwise successful login flow. These
  // tests pin the contract: no unseal path → exit 1 with an actionable
  // setup hint, and at least one unseal path → carry on as normal.
  let configDir;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-cli-preflight-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    vi.doUnmock("keytar");
    vi.resetModules();
  });

  it("add-account fails fast with a setup hint when keychain + env var + TTY are all unavailable", async () => {
    // Force keytar to "unavailable" and clear the passphrase. process.stdin
    // has no isTTY in vitest workers, so the TTY path is also closed.
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");

    const res = await rc(pa(["add-account", "--name", "fresh", "--mode", "manual", "--json"]));
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("no_unseal_material");
    // Hint must reference at least one actionable knob — either the env var,
    // the keychain story, libsecret on Linux, or the new setup-vault command.
    expect(parsed.hint).toMatch(/PERPLEXITY_VAULT_PASSPHRASE|keychain|keytar|libsecret|setup-vault|passphrase/i);
    // Profile must NOT have been created — the preflight runs before
    // createProfile so a partially-set-up profile dir doesn't linger.
    const { listProfiles } = await import("../src/profiles.js");
    expect(listProfiles()).toEqual([]);
  });

  it("add-account proceeds when PERPLEXITY_VAULT_PASSPHRASE is set", async () => {
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "set";
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["add-account", "--name", "ok", "--mode", "manual", "--json"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim()).ok).toBe(true);
  });

  it("--skip-vault-check bypasses the preflight (useful when daemon owns the vault)", async () => {
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["add-account", "--name", "bypass", "--mode", "manual", "--skip-vault-check", "--json"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim()).ok).toBe(true);
  });
});

describe("cli: setup-vault command", () => {
  let configDir;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "px-cli-setup-vault-"));
    process.env.PERPLEXITY_CONFIG_DIR = configDir;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    __resetKeyCache();
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.PERPLEXITY_CONFIG_DIR;
    delete process.env.PERPLEXITY_VAULT_PASSPHRASE;
    vi.doUnmock("keytar");
    vi.resetModules();
  });

  it("reports OK when keychain has a master key persisted", async () => {
    vi.doMock("keytar", () => ({
      default: {
        getPassword: async () => "ab".repeat(32),
        setPassword: async () => undefined,
      },
    }));
    vi.resetModules();
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["setup-vault", "--json"]));
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.state.keychainAvailable).toBe(true);
    expect(out.state.keychainHasKey).toBe(true);
    expect(out.recommendation.status).toBe("ok_keychain");
    expect(out.passphrase).toBeNull();
    expect(out.snippets).toEqual([]);
  });

  it("reports OK with env var when keychain is unavailable but PERPLEXITY_VAULT_PASSPHRASE is set", async () => {
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "user-supplied-passphrase";
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["setup-vault", "--json"]));
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.recommendation.status).toBe("ok_envvar");
    expect(out.passphrase).toBeNull();
  });

  it("generates a passphrase + cross-platform persistence snippets when no unseal path is configured", async () => {
    // The exact failure mode this command is designed for: fresh box with
    // no keychain (broken keytar binding) and no env var. The runner would
    // throw "Vault locked"; setup-vault gives the user something concrete
    // to do BEFORE that happens.
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["setup-vault", "--json"]));
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.recommendation.status).toBe("setup_needed");
    expect(out.passphrase).toBeTruthy();
    // base64url shape: A-Z a-z 0-9 - _ only, no padding.
    expect(out.passphrase).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes encoded as base64url = ~43 chars.
    expect(out.passphrase.length).toBeGreaterThanOrEqual(40);
    expect(out.snippets.length).toBeGreaterThanOrEqual(3);
    // Every snippet must reference the generated passphrase so users can
    // copy-paste verbatim without further substitution.
    for (const s of out.snippets) {
      expect(s.code).toContain(out.passphrase);
      expect(s.title).toBeTruthy();
    }
    // The first snippet is always the cross-platform MCP-client env block.
    expect(out.snippets[0].title).toMatch(/MCP client env block/);
    // At least one platform-specific snippet is included.
    const platformTitles = out.snippets.slice(1).map((s) => s.title.toLowerCase());
    if (process.platform === "win32") {
      expect(platformTitles.some((t) => t.includes("powershell") || t.includes("cmd"))).toBe(true);
    } else if (process.platform === "darwin") {
      expect(platformTitles.some((t) => t.includes("zsh") || t.includes("bash"))).toBe(true);
    } else {
      expect(platformTitles.some((t) => t.includes("bash") || t.includes("zsh") || t.includes("systemd"))).toBe(true);
    }
  });

  it("--probe-only never generates a passphrase even when one would otherwise be recommended", async () => {
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["setup-vault", "--probe-only", "--json"]));
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.recommendation.status).toBe("setup_needed");
    expect(out.passphrase).toBeNull();
    expect(out.snippets).toEqual([]);
  });

  it("flags the broken-decrypt case when a vault.enc exists but no material can decrypt it", async () => {
    // Write a vault under one passphrase, then probe with a different one
    // and no keychain. The recommendation must point at logout --purge
    // rather than 'setup needed' — the user has credentials, they just
    // don't match the on-disk blob.
    vi.doMock("keytar", () => ({ default: undefined }));
    vi.resetModules();
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "original";
    const writeMod = await import("../src/vault.js");
    writeMod.__resetKeyCache();
    const { createProfile: cp } = await import("../src/profiles.js");
    cp("work");
    await new writeMod.Vault().set("work", "cookies", "[]");
    // Switch to a different passphrase the blob wasn't encrypted with.
    process.env.PERPLEXITY_VAULT_PASSPHRASE = "rotated";
    vi.resetModules();
    const { routeCommand: rc, parseArgs: pa } = await import("../src/cli.js");
    const res = await rc(pa(["setup-vault", "--profile", "work", "--probe-only", "--json"]));
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout.trim());
    expect(out.state.vaultExists).toBe(true);
    expect(out.state.vaultDecryptsOk).toBe(false);
    expect(out.recommendation.status).toBe("decrypt_broken");
    expect(out.recommendation.message).toMatch(/logout --purge/);
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

// ---------------------------------------------------------------------------
// Task 2.4 — daemon:attach catches DaemonAttachError and emits the bullet
// remediation on stderr only, returning exit code 2. Mirrors the launcher
// contract from Task 2.3 (write-launcher.ts) so the CLI subcommand and the
// generated launcher script behave identically when the daemon is unreachable.
// ---------------------------------------------------------------------------
describe("daemon:attach — DaemonAttachError contract (Task 2.4)", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.PERPLEXITY_NO_DAEMON;
    delete process.env.PERPLEXITY_NO_DAEMON;
    attachSpy.mockReset();
    mainSpy.mockReset();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PERPLEXITY_NO_DAEMON;
    else process.env.PERPLEXITY_NO_DAEMON = savedEnv;
  });

  function makeAttachError({ withCause = true } = {}) {
    const err = new Error("Cannot reach the extension-managed daemon: spawn ENOENT");
    err.name = "DaemonAttachError";
    err.code = "DAEMON_UNREACHABLE";
    err.remediation = [
      "Reload the VS Code window so the extension restarts the daemon.",
      "In the VS Code Perplexity dashboard, switch this client's transport to http-loopback.",
      "(Advanced) Set PERPLEXITY_NO_DAEMON=1 in this client's MCP env block, then run `npx perplexity-user-mcp setup-vault` once.",
    ];
    if (withCause) err.cause = new Error("spawn ENOENT");
    return err;
  }

  it("returns code 2 with bullet remediation on stderr when DAEMON_UNREACHABLE", async () => {
    attachSpy.mockRejectedValueOnce(makeAttachError());
    const res = await routeCommand({ command: "daemon:attach", flags: {} });
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("cannot reach the extension-managed daemon");
    expect(res.stderr).toContain("• Reload the VS Code window");
    expect(res.stderr).toContain("• In the VS Code Perplexity dashboard");
    expect(res.stderr).toContain("PERPLEXITY_NO_DAEMON=1");
  });

  it("appends underlying-error line when err.cause has a message", async () => {
    attachSpy.mockRejectedValueOnce(makeAttachError({ withCause: true }));
    const res = await routeCommand({ command: "daemon:attach", flags: {} });
    expect(res.stderr).toContain("Underlying error: spawn ENOENT");
  });

  it("omits underlying-error line when err.cause is missing", async () => {
    attachSpy.mockRejectedValueOnce(makeAttachError({ withCause: false }));
    const res = await routeCommand({ command: "daemon:attach", flags: {} });
    expect(res.stderr).not.toContain("Underlying error:");
  });

  it("rethrows non-DAEMON_UNREACHABLE errors unchanged", async () => {
    const other = new Error("boom");
    attachSpy.mockRejectedValueOnce(other);
    await expect(routeCommand({ command: "daemon:attach", flags: {} })).rejects.toThrow("boom");
  });

  it("tolerates a missing remediation array (no crash, just header line)", async () => {
    const err = new Error("daemon down");
    err.code = "DAEMON_UNREACHABLE";
    // Intentionally no err.remediation
    attachSpy.mockRejectedValueOnce(err);
    const res = await routeCommand({ command: "daemon:attach", flags: {} });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("cannot reach the extension-managed daemon");
  });
});
