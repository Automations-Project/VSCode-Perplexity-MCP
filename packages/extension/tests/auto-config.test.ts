import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyIdeConfig,
  buildServerConfig,
  getIdeConfigPath,
  mergeMcpConfig,
  syncRulesForIde,
} from "../src/auto-config/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("auto-config helpers", () => {
  it("preserves unrelated MCP servers when injecting Perplexity", () => {
    const merged = mergeMcpConfig(
      {
        mcpServers: {
          existing: {
            command: "node",
            args: ["existing.js"]
          }
        }
      },
      "Perplexity",
      buildServerConfig("C:/bundle/server.mjs", { nodePath: "C:/node.exe" })
    );

    expect(merged.mcpServers).toMatchObject({
      existing: {
        command: "node",
        args: ["existing.js"]
      },
      Perplexity: {
        command: "C:/node.exe",
        args: ["C:/bundle/server.mjs"]
      }
    });
  });

  it("supports VS Code-style top-level servers configs", () => {
    const merged = mergeMcpConfig(
      {
        servers: {
          existing: {
            type: "stdio",
            command: "node",
            args: ["existing.js"],
          },
        },
      },
      "Perplexity",
      {
        type: "stdio",
        ...buildServerConfig("C:/bundle/server.mjs", { nodePath: "C:/node.exe" }),
      },
      "servers"
    );

    expect(merged.servers).toMatchObject({
      existing: {
        type: "stdio",
        command: "node",
        args: ["existing.js"],
      },
      Perplexity: {
        type: "stdio",
        command: "C:/node.exe",
        args: ["C:/bundle/server.mjs"],
      },
    });
    expect(merged.mcpServers).toBeUndefined();
  });

  it("atomically merges a new server entry while preserving existing ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "perplexity-auto-config-"));
    tempDirs.push(root);

    const configPath = join(root, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { existing: { command: "node", args: ["existing.js"] } } }, null, 2)
    );

    const result = await applyIdeConfig({
      target: "cursor",
      serverPath: "C:/bundle/server.mjs",
      nodePath: "C:/node.exe",
      configPath,
      // stdio-daemon-proxy is the default; Cursor capability stdio=true.
    });

    expect(result.ok).toBe(true);
    const nextConfig = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(nextConfig.mcpServers.Perplexity).toBeTruthy();
    expect(nextConfig.mcpServers.existing).toBeTruthy();
    // H3 spec: .bak is cleaned up on successful write.
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  it("writes VS Code workspace MCP config using servers root and stdio type", async () => {
    const root = mkdtempSync(join(tmpdir(), "perplexity-auto-config-vscode-"));
    tempDirs.push(root);

    const configPath = join(root, ".vscode", "mcp.json");

    const result = await applyIdeConfig({
      target: "vscode",
      serverPath: "C:/bundle/server.mjs",
      nodePath: "C:/node.exe",
      configPath,
    });

    expect(result.ok).toBe(true);
    const nextConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      servers?: Record<string, { type?: string; command?: string; args?: string[] }>;
      mcpServers?: Record<string, unknown>;
    };
    expect(nextConfig.mcpServers).toBeUndefined();
    expect(nextConfig.servers?.Perplexity).toMatchObject({
      type: "stdio",
      command: "C:/node.exe",
      args: ["C:/bundle/server.mjs"],
    });
  });
});

describe("2026-05 IDE expansion", () => {
  // Reference paths come from primary-source docs. Failing these means upstream
  // changed location → either the doc moved (verify and update) or our entry
  // was wrong from the start.
  it("resolves Visual Studio 2022 to workspace .mcp.json when workspace given", () => {
    const path = getIdeConfigPath("vs2022", { homeDir: "/home/u", workspaceRoot: "/work/sln" });
    expect(path.replace(/\\/g, "/")).toBe("/work/sln/.mcp.json");
  });

  it("falls back to ~/.mcp.json when no workspace is open for VS 2022", () => {
    const path = getIdeConfigPath("vs2022", { homeDir: "/home/u" });
    expect(path.replace(/\\/g, "/")).toBe("/home/u/.mcp.json");
  });

  it("resolves OpenCode user config under ~/.config/opencode/", () => {
    const path = getIdeConfigPath("openCode", { homeDir: "/home/u" });
    expect(path.replace(/\\/g, "/")).toBe("/home/u/.config/opencode/opencode.json");
  });

  it("resolves Factory Droid to ~/.factory/mcp.json", () => {
    const path = getIdeConfigPath("factoryDroid", { homeDir: "/home/u" });
    expect(path.replace(/\\/g, "/")).toBe("/home/u/.factory/mcp.json");
  });

  it("resolves Qwen Code to ~/.qwen/settings.json", () => {
    const path = getIdeConfigPath("qwenCode", { homeDir: "/home/u" });
    expect(path.replace(/\\/g, "/")).toBe("/home/u/.qwen/settings.json");
  });

  it("resolves GitHub Copilot CLI to ~/.copilot/mcp-config.json", () => {
    const path = getIdeConfigPath("copilotCli", { homeDir: "/home/u" });
    expect(path.replace(/\\/g, "/")).toBe("/home/u/.copilot/mcp-config.json");
  });

  it("writes OpenCode config under the `mcp` root key using OpenCode's local server shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "perplexity-auto-config-opencode-"));
    tempDirs.push(root);

    const configPath = join(root, "opencode.json");

    const result = await applyIdeConfig({
      target: "openCode",
      serverPath: "C:/bundle/server.mjs",
      nodePath: "C:/node.exe",
      configPath,
    });

    expect(result.ok).toBe(true);
    const nextConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcp?: Record<string, { type?: string; command?: string[]; args?: string[]; env?: Record<string, string>; environment?: Record<string, string>; enabled?: boolean }>;
      mcpServers?: Record<string, unknown>;
      servers?: Record<string, unknown>;
    };
    expect(nextConfig.mcpServers).toBeUndefined();
    expect(nextConfig.servers).toBeUndefined();
    expect(nextConfig.mcp?.Perplexity).toMatchObject({
      type: "local",
      command: ["C:/node.exe", "C:/bundle/server.mjs"],
      enabled: true,
      environment: {},
    });
    expect(nextConfig.mcp?.Perplexity.args).toBeUndefined();
    expect(nextConfig.mcp?.Perplexity.env).toBeUndefined();
  });

  it("syncs OpenCode rules into the project AGENTS.md section", () => {
    const root = mkdtempSync(join(tmpdir(), "perplexity-rules-opencode-"));
    tempDirs.push(root);

    const status = syncRulesForIde("openCode", root);
    const agentsPath = join(root, "AGENTS.md");

    expect(status.hasPerplexitySection).toBe(true);
    expect(status.rulesPath.replace(/\\/g, "/")).toBe(agentsPath.replace(/\\/g, "/"));
    const content = readFileSync(agentsPath, "utf8");
    expect(content).toContain("<!-- PERPLEXITY-MCP-START -->");
    expect(content).toContain("perplexity_search");
    expect(content).toContain("<!-- PERPLEXITY-MCP-END -->");
  });

  it("writes VS 2022 config under `servers` root with stdio type field", async () => {
    const root = mkdtempSync(join(tmpdir(), "perplexity-auto-config-vs2022-"));
    tempDirs.push(root);

    const configPath = join(root, ".mcp.json");

    const result = await applyIdeConfig({
      target: "vs2022",
      serverPath: "C:/bundle/server.mjs",
      nodePath: "C:/node.exe",
      configPath,
    });

    expect(result.ok).toBe(true);
    const nextConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      servers?: Record<string, { type?: string; command?: string }>;
      mcpServers?: Record<string, unknown>;
    };
    expect(nextConfig.mcpServers).toBeUndefined();
    expect(nextConfig.servers?.Perplexity).toMatchObject({
      type: "stdio",
      command: "C:/node.exe",
    });
  });
});
