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
