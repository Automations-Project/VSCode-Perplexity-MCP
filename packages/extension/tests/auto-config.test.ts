import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
