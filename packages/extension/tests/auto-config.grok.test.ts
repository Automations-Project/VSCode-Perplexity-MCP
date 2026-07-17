import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IDE_METADATA } from "@perplexity-user-mcp/shared";
import { applyIdeConfig, getIdeConfigPath, detectIdeStatus } from "../src/auto-config/index.js";

// xAI Grok (Grok Build) auto-config. Grok reads ~/.grok/config.toml with the
// same [mcp_servers.<name>] TOML shape as Codex CLI, so this mirrors the Codex
// target: user-scoped config.toml, AGENTS.md rules, stdio transport.

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Grok metadata", () => {
  it("is registered as a TOML, user-scoped, auto-configurable target", () => {
    const meta = IDE_METADATA.grok;
    expect(meta).toBeTruthy();
    expect(meta.configFormat).toBe("toml");
    expect(meta.configScope).toBe("user");
    expect(meta.autoConfigurable).toBe(true);
    expect(meta.rulesFormat).toBe("md-section");
    expect(meta.rulesPath).toBe("AGENTS.md");
    expect(meta.capabilities.stdio).toBe(true);
    // HTTP caps stay evidence-gated until a dated smoke record exists.
    expect(meta.capabilities.httpBearerLoopback).toBe(false);
  });

  it("resolves to ~/.grok/config.toml (user-scoped, independent of workspace)", () => {
    const p = getIdeConfigPath("grok", { homeDir: "/home/u", workspaceRoot: "/work/x" });
    expect(p).toBe(join("/home/u", ".grok", "config.toml"));
  });
});

describe("Grok config write", () => {
  it("writes a [mcp_servers.Perplexity] block with command/args and enabled=true", async () => {
    const root = mkdtempSync(join(tmpdir(), "pplx-grok-"));
    tempDirs.push(root);
    const configPath = join(root, ".grok", "config.toml");

    const result = await applyIdeConfig({
      target: "grok",
      serverPath: "C:/Users/admin/.perplexity-mcp/start.mjs",
      nodePath: "C:/Program Files/nodejs/node.exe",
      configPath,
    });

    expect(result.ok).toBe(true);
    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain("[mcp_servers.Perplexity]");
    expect(toml).toContain('command = "C:/Program Files/nodejs/node.exe"');
    expect(toml).toContain("C:/Users/admin/.perplexity-mcp/start.mjs");
    expect(toml).toContain("enabled = true");
  });

  it("preserves other servers and non-mcp sections already in the file", async () => {
    // Grok's real config carries [cli], [ui], [marketplace] and other
    // [mcp_servers.*] entries — the upsert must touch only our block.
    const root = mkdtempSync(join(tmpdir(), "pplx-grok-merge-"));
    tempDirs.push(root);
    const configPath = join(root, ".grok", "config.toml");
    mkdirSync(join(root, ".grok"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "[cli]",
        'installer = "npm"',
        "",
        "[mcp_servers.github]",
        'command = "go"',
        "enabled = true",
        "",
        "  [mcp_servers.github.env]",
        '  GITHUB_TOOLSETS = "all"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await applyIdeConfig({
      target: "grok",
      serverPath: "/home/u/.perplexity-mcp/start.mjs",
      nodePath: "/usr/bin/node",
      configPath,
    });

    expect(result.ok).toBe(true);
    const toml = readFileSync(configPath, "utf8");
    // Untouched sections survive.
    expect(toml).toContain("[cli]");
    expect(toml).toContain("[mcp_servers.github]");
    expect(toml).toContain('GITHUB_TOOLSETS = "all"');
    // Ours was added.
    expect(toml).toContain("[mcp_servers.Perplexity]");
    expect(toml).toContain("/home/u/.perplexity-mcp/start.mjs");
  });

  it("is idempotent — re-applying does not duplicate the Perplexity block", async () => {
    const root = mkdtempSync(join(tmpdir(), "pplx-grok-idem-"));
    tempDirs.push(root);
    const configPath = join(root, ".grok", "config.toml");
    const opts = {
      target: "grok" as const,
      serverPath: "/home/u/.perplexity-mcp/start.mjs",
      nodePath: "/usr/bin/node",
      configPath,
    };
    await applyIdeConfig(opts);
    await applyIdeConfig(opts);
    const toml = readFileSync(configPath, "utf8");
    const occurrences = toml.split("[mcp_servers.Perplexity]").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("Grok detection", () => {
  it("detects Grok when its config dir exists", () => {
    const home = mkdtempSync(join(tmpdir(), "pplx-grok-home-"));
    tempDirs.push(home);
    const configPath = join(home, ".grok", "config.toml");
    mkdirSync(join(home, ".grok"), { recursive: true }); // dir present, file absent
    const status = detectIdeStatus("grok", { configPath });
    expect(status.detected).toBe(true);
    expect(status.configFormat).toBe("toml");
  });

  it("reports not-found when the config dir is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "pplx-grok-nohome-"));
    tempDirs.push(home);
    const configPath = join(home, ".grok", "config.toml"); // parent never created
    const status = detectIdeStatus("grok", { configPath });
    expect(status.detected).toBe(false);
  });
});
