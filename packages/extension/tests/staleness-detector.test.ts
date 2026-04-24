import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdeStatus } from "@perplexity-user-mcp/shared";

import { detectStaleConfigs } from "../src/webview/staleness-detector.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup; test isolation doesn't depend on it.
    }
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "perplexity-staleness-"));
  tempDirs.push(root);
  return root;
}

function writeJsonConfig(
  configPath: string,
  entry: { url?: string; headers?: Record<string, string>; command?: string; args?: string[] },
): void {
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { Perplexity: entry } }, null, 2),
    "utf8",
  );
}

function ideStatus(overrides: Partial<IdeStatus> & { path: string }): IdeStatus {
  return {
    detected: true,
    configured: true,
    health: "configured",
    displayName: "Cursor",
    autoConfigurable: true,
    configFormat: "json",
    ...overrides,
  };
}

describe("detectStaleConfigs", () => {
  it("empty ideStatus -> returns []", () => {
    expect(
      detectStaleConfigs({
        ideStatus: {},
        daemonPort: 49217,
        tunnelUrl: null,
        daemonBearer: "live-bearer",
      }),
    ).toEqual([]);
  });

  it("http-loopback config with current port AND current bearer -> NOT returned", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "http://127.0.0.1:49217/mcp",
      headers: { Authorization: "Bearer live-bearer" },
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([]);
  });

  it("http-loopback config with stale port -> returned with reason 'url'", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "http://127.0.0.1:55555/mcp",
      headers: { Authorization: "Bearer live-bearer" },
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([{ ideTag: "cursor", reason: "url" }]);
  });

  it("http-loopback config with current port but stale bearer -> returned with reason 'bearer'", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "http://127.0.0.1:49217/mcp",
      headers: { Authorization: "Bearer old-rotated-bearer" },
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([{ ideTag: "cursor", reason: "bearer" }]);
  });

  it("tunnel config with current tunnel URL -> NOT returned", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "https://mcp.example.com/mcp",
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: "https://mcp.example.com",
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([]);
  });

  it("tunnel config with outdated tunnel URL -> returned with reason 'url'", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "https://old-ephemeral.trycloudflare.com/mcp",
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: "https://new-ephemeral.trycloudflare.com",
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([{ ideTag: "cursor", reason: "url" }]);
  });

  it("stdio config (no URL) -> NEVER returned (nothing to compare)", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      command: "/usr/bin/node",
      args: ["/path/to/launcher.mjs"],
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([]);
  });

  it("unconfigured IDE -> skipped even if config file is stale on disk", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "http://127.0.0.1:55555/mcp",
    });

    const stale = detectStaleConfigs({
      ideStatus: {
        cursor: ideStatus({ path: configPath, configured: false, health: "missing" }),
      },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([]);
  });

  it("missing config file on disk -> skipped", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    // Intentionally NOT writing configPath.

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([]);
  });

  it("malformed JSON -> skipped; onSkip hook fires", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{ not-valid-json ", "utf8");

    const skipped: Array<{ ideTag: string; reason: string }> = [];
    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
      onSkip: (ideTag, reason) => {
        skipped.push({ ideTag, reason });
      },
    });

    expect(stale).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].ideTag).toBe("cursor");
  });

  it("daemon not running (daemonPort=null) -> loopback config flagged as stale url", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "http://127.0.0.1:49217/mcp",
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: null,
      tunnelUrl: null,
      daemonBearer: null,
    });

    expect(stale).toEqual([{ ideTag: "cursor", reason: "url" }]);
  });

  it("tunnel config when no tunnel is live -> flagged as stale url", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "https://mcp.example.com/mcp",
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([{ ideTag: "cursor", reason: "url" }]);
  });

  it("multiple IDEs -> only stale ones listed; ordering follows ideStatus iteration", () => {
    const root = makeTempRoot();
    const cursorPath = join(root, ".cursor", "mcp.json");
    const windsurfPath = join(root, ".codeium", "windsurf", "mcp_config.json");
    const clinePath = join(root, ".cline", "settings.json");

    writeJsonConfig(cursorPath, {
      url: "http://127.0.0.1:49217/mcp",
      headers: { Authorization: "Bearer live-bearer" },
    });
    writeJsonConfig(windsurfPath, {
      url: "http://127.0.0.1:55555/mcp", // stale port
    });
    writeJsonConfig(clinePath, {
      url: "http://127.0.0.1:49217/mcp",
      headers: { Authorization: "Bearer other-bearer" }, // stale bearer
    });

    const stale = detectStaleConfigs({
      ideStatus: {
        cursor: ideStatus({ path: cursorPath, displayName: "Cursor" }),
        windsurf: ideStatus({ path: windsurfPath, displayName: "Windsurf" }),
        cline: ideStatus({ path: clinePath, displayName: "Cline" }),
      },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    const byIde = new Map(stale.map((s) => [s.ideTag, s.reason] as const));
    expect(byIde.get("cursor")).toBeUndefined();
    expect(byIde.get("windsurf")).toBe("url");
    expect(byIde.get("cline")).toBe("bearer");
  });

  it("config with OAuth variant (URL but no bearer) and port matches -> NOT flagged", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    writeJsonConfig(configPath, {
      url: "http://127.0.0.1:49217/mcp",
    });

    const stale = detectStaleConfigs({
      ideStatus: { cursor: ideStatus({ path: configPath }) },
      daemonPort: 49217,
      tunnelUrl: null,
      daemonBearer: "live-bearer",
    });

    expect(stale).toEqual([]);
  });
});
