import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectIdeStatus } from "../src/auto-config/index.js";

// `detectIdeStatus` accepts a `configPath` override, so we don't need to
// stub `os.homedir()` — we hand it a tempfile per test and assert the
// classification of the embedded `command` field.

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "perplexity-detect-ide-cmd-"));
  tempDirs.push(root);
  return root;
}

describe("detectIdeStatus — command-field validation", () => {
  it("flags a JSON config where command points at the VS Code Electron host", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    // A real-bug-report shape: extension host wrote `process.execPath` into
    // the config, which inside VS Code is `Code.exe`/`code` — not Node.
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            Perplexity: {
              command: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
              args: ["C:\\nonexistent\\server.mjs"],
            },
          },
        },
        null,
        2,
      ),
    );

    const status = detectIdeStatus("cursor", { configPath });
    expect(status.configured).toBe(true);
    expect(status.command).toBe(
      "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    );
    expect(status.commandHealth).toBe("wrong-runtime");
  });

  it("flags a JSON config where command path no longer exists on disk", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    const stalePath =
      process.platform === "win32"
        ? "C:\\nonexistent\\node-stale.exe"
        : "/nonexistent/node-stale";
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            Perplexity: {
              command: stalePath,
              args: ["/some/server.mjs"],
            },
          },
        },
        null,
        2,
      ),
    );

    const status = detectIdeStatus("cursor", { configPath });
    expect(status.configured).toBe(true);
    expect(status.command).toBe(stalePath);
    expect(status.commandHealth).toBe("missing");
  });

  it("classifies an existing absolute node binary as ok", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    // Point at a real existing node binary in the test root so existsSync()
    // returns true and the basename starts with "node".
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const fakeNode = join(root, nodeName);
    writeFileSync(fakeNode, "// fake\n", { mode: 0o755 });

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            Perplexity: {
              command: fakeNode,
              args: [join(root, "server.mjs")],
            },
          },
        },
        null,
        2,
      ),
    );

    const status = detectIdeStatus("cursor", { configPath });
    expect(status.configured).toBe(true);
    expect(status.commandHealth).toBe("ok");
  });

  it("extracts command from a TOML config (Codex CLI shape) and flags wrong-runtime", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    // Real TOML shape produced by `buildTomlMcpBlock` in auto-config/index.ts.
    const toml = [
      `[mcp_servers.Perplexity]`,
      `command = "C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe"`,
      `args = ["C:\\\\bundle\\\\server.mjs"]`,
      `enabled = true`,
      ``,
    ].join("\n");
    writeFileSync(configPath, toml);

    const status = detectIdeStatus("codexCli", { configPath });
    expect(status.configured).toBe(true);
    // The TOML extractor unescapes JSON-style escapes before classification.
    expect(status.command).toBe(
      "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    );
    expect(status.commandHealth).toBe("wrong-runtime");
  });

  it("treats a TOML URL config as configured without reading another server's command", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    const toml = [
      `[mcp_servers.other]`,
      `command = "C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Programs\\\\Windsurf Next\\\\Windsurf - Next.exe"`,
      `args = ["C:\\\\other\\\\server.mjs"]`,
      ``,
      `[mcp_servers.Perplexity]`,
      `url = "http://127.0.0.1:12177/mcp"`,
      `bearer_token_env_var = "PERPLEXITY_MCP_BEARER"`,
      ``,
      `[mcp_servers.Perplexity.env_http_headers]`,
      `PERPLEXITY_MCP_BEARER = "daemon-static-bearer-uuid-v4"`,
      ``,
    ].join("\n");
    writeFileSync(configPath, toml);

    const status = detectIdeStatus("codexCli", { configPath });
    expect(status.configured).toBe(true);
    expect(status.health).toBe("configured");
    expect(status.command).toBeUndefined();
    expect(status.commandHealth).toBeUndefined();
  });

  it("returns commandHealth=undefined when the config is not configured", () => {
    const root = makeTempRoot();
    const configPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    // Empty config (no Perplexity entry) — `configured: false`, no command
    // health to report.
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    const status = detectIdeStatus("cursor", { configPath });
    expect(status.configured).toBe(false);
    expect(status.commandHealth).toBeUndefined();
    expect(status.command).toBeUndefined();
  });
});
