import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyIdeConfig, buildServerConfig, mergeMcpConfig } from "../src/auto-config/index.js";

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

  it("writes a backup before replacing an existing config file", () => {
    const root = mkdtempSync(join(tmpdir(), "perplexity-auto-config-"));
    tempDirs.push(root);

    const configPath = join(root, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { existing: { command: "node", args: ["existing.js"] } } }, null, 2)
    );

    applyIdeConfig({
      target: "cursor",
      serverPath: "C:/bundle/server.mjs",
      nodePath: "C:/node.exe",
      configPath
    });

    const backupPath = `${configPath}.bak`;
    const nextConfig = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    const backupConfig = JSON.parse(readFileSync(backupPath, "utf8")) as { mcpServers: Record<string, unknown> };

    expect(nextConfig.mcpServers.Perplexity).toBeTruthy();
    expect(backupConfig.mcpServers.existing).toBeTruthy();
  });
});
