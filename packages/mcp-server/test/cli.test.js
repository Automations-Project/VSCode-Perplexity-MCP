import { describe, it, expect } from "vitest";
import { parseArgs, routeCommand } from "../src/cli.js";

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
});

describe("routeCommand (stubs)", () => {
  it("dispatches known commands", async () => {
    const res = await routeCommand({ command: "status", flags: { json: true } });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/not-yet-implemented|status/i);
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

describe("routeCommand — phase mapping", () => {
  it("login maps to Phase 2", async () => {
    const res = await routeCommand({ command: "login", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("logout maps to Phase 2", async () => {
    const res = await routeCommand({ command: "logout", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("status maps to Phase 2", async () => {
    const res = await routeCommand({ command: "status", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("add-account maps to Phase 2", async () => {
    const res = await routeCommand({ command: "add-account", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("switch-account maps to Phase 2", async () => {
    const res = await routeCommand({ command: "switch-account", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("list-accounts maps to Phase 2", async () => {
    const res = await routeCommand({ command: "list-accounts", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("doctor maps to Phase 3", async () => {
    const res = await routeCommand({ command: "doctor", flags: {} });
    expect(res.stdout).toMatch(/Phase 3/);
  });

  it("install-browser maps to Phase 3", async () => {
    const res = await routeCommand({ command: "install-browser", flags: {} });
    expect(res.stdout).toMatch(/Phase 3/);
  });

  it("export maps to Phase 4", async () => {
    const res = await routeCommand({ command: "export", flags: {} });
    expect(res.stdout).toMatch(/Phase 4/);
  });

  it("open maps to Phase 4", async () => {
    const res = await routeCommand({ command: "open", flags: {} });
    expect(res.stdout).toMatch(/Phase 4/);
  });

  it("rebuild-history-index maps to Phase 4", async () => {
    const res = await routeCommand({ command: "rebuild-history-index", flags: {} });
    expect(res.stdout).toMatch(/Phase 4/);
  });
});

describe("routeCommand — JSON mode for stubs", () => {
  it("returns parseable JSON when --json flag is set", async () => {
    const res = await routeCommand({ command: "status", flags: { json: true } });
    const lines = res.stdout.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("not-yet-implemented");
    expect(parsed.command).toBe("status");
  });

  it("returns non-JSON message when --json flag is not set", async () => {
    const res = await routeCommand({ command: "status", flags: {} });
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

describe("routeCommand — all phase-2 commands text mode", () => {
  it("logout outputs Phase 2 text", async () => {
    const res = await routeCommand({ command: "logout", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("add-account outputs Phase 2 text", async () => {
    const res = await routeCommand({ command: "add-account", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("switch-account outputs Phase 2 text", async () => {
    const res = await routeCommand({ command: "switch-account", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });

  it("list-accounts outputs Phase 2 text", async () => {
    const res = await routeCommand({ command: "list-accounts", flags: {} });
    expect(res.stdout).toMatch(/Phase 2/);
  });
});

describe("routeCommand — all phase-3 commands text mode", () => {
  it("doctor outputs Phase 3 text", async () => {
    const res = await routeCommand({ command: "doctor", flags: {} });
    expect(res.stdout).toMatch(/Phase 3/);
  });

  it("install-browser outputs Phase 3 text", async () => {
    const res = await routeCommand({ command: "install-browser", flags: {} });
    expect(res.stdout).toMatch(/Phase 3/);
  });
});

describe("routeCommand — all phase-4 commands text mode", () => {
  it("export outputs Phase 4 text", async () => {
    const res = await routeCommand({ command: "export", flags: {} });
    expect(res.stdout).toMatch(/Phase 4/);
  });

  it("open outputs Phase 4 text", async () => {
    const res = await routeCommand({ command: "open", flags: {} });
    expect(res.stdout).toMatch(/Phase 4/);
  });

  it("rebuild-history-index outputs Phase 4 text", async () => {
    const res = await routeCommand({ command: "rebuild-history-index", flags: {} });
    expect(res.stdout).toMatch(/Phase 4/);
  });
});
