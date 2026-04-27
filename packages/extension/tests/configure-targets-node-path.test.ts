import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted state lets the `node:os` mock factory read a per-test home override
// while keeping the rest of `os` (notably `tmpdir`) wired to the real module.
const mocks = vi.hoisted(() => ({
  homeOverride: { value: undefined as string | undefined },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mocks.homeOverride.value ?? actual.homedir(),
  };
});

// `tmpdir` resolves through the spread above to the real implementation.
import { tmpdir } from "node:os";
import {
  configureTargets,
  type ApplyIdeConfigDeps,
} from "../src/auto-config/index.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  mocks.homeOverride.value = undefined;
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "perplexity-configure-targets-"));
  tempDirs.push(root);
  return root;
}

function makeDeps(homeRoot: string): ApplyIdeConfigDeps {
  return {
    confirmTransport: async () => true,
    warnSyncFolder: async () => "cancel",
    nudgePortPin: () => {},
    auditGenerated: () => {},
    getDaemonPort: () => 12345,
    getActiveTunnel: () => null,
    syncFolderPatterns: [],
    homeDir: () => homeRoot,
    isGitTracked: () => false,
  };
}

describe("configureTargets — Node path defaulting", () => {
  it("resolves a real Node binary instead of leaking process.execPath into stdio config", async () => {
    const root = makeTempRoot();
    mocks.homeOverride.value = root;

    // resolveNodePath() in auto-config/index.ts checks PERPLEXITY_NODE_PATH
    // first (with existsSync). Point it at a deterministic file so the test
    // doesn't depend on which `/usr/local/bin/node`-style path the host has.
    const fakeNode = join(root, "fake-node-binary");
    writeFileSync(fakeNode, "// fake\n", { mode: 0o755 });

    const origEnv = process.env.PERPLEXITY_NODE_PATH;
    process.env.PERPLEXITY_NODE_PATH = fakeNode;

    try {
      const outcome = await configureTargets(
        "claudeCode",
        "/bundle/server.mjs",
        undefined,
        { deps: makeDeps(root) },
      );

      const claudeResult = outcome.results.find(
        (r) => r.target === "claudeCode",
      );
      expect(claudeResult?.result.ok).toBe(true);

      const configPath = join(root, ".claude.json");
      expect(existsSync(configPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcpServers?: { Perplexity?: { command?: string } };
      };
      const command = parsed.mcpServers?.Perplexity?.command;

      // The fix: configureTargets must resolve through resolveNodePath() and
      // pass the result as `nodePath` to applyIdeConfig, so the stdio builder
      // sees a real Node binary instead of falling back to `process.execPath`
      // (which inside the VS Code extension host is the Electron binary).
      expect(command).toBe(fakeNode);
      expect(command).not.toBe(process.execPath);
    } finally {
      if (origEnv === undefined) {
        delete process.env.PERPLEXITY_NODE_PATH;
      } else {
        process.env.PERPLEXITY_NODE_PATH = origEnv;
      }
    }
  });

  it("honors an explicit options.nodePath over the resolved default", async () => {
    const root = makeTempRoot();
    mocks.homeOverride.value = root;

    // The default would resolve to this path via PERPLEXITY_NODE_PATH...
    const defaultNode = join(root, "default-node");
    writeFileSync(defaultNode, "// fake\n", { mode: 0o755 });
    // ...but the caller's explicit override must win.
    const explicitNode = join(root, "explicit-node");
    writeFileSync(explicitNode, "// fake\n", { mode: 0o755 });

    const origEnv = process.env.PERPLEXITY_NODE_PATH;
    process.env.PERPLEXITY_NODE_PATH = defaultNode;

    try {
      const outcome = await configureTargets(
        "claudeCode",
        "/bundle/server.mjs",
        undefined,
        { deps: makeDeps(root), nodePath: explicitNode },
      );

      const claudeResult = outcome.results.find(
        (r) => r.target === "claudeCode",
      );
      expect(claudeResult?.result.ok).toBe(true);

      const parsed = JSON.parse(
        readFileSync(join(root, ".claude.json"), "utf8"),
      ) as { mcpServers?: { Perplexity?: { command?: string } } };
      const command = parsed.mcpServers?.Perplexity?.command;

      expect(command).toBe(explicitNode);
      expect(command).not.toBe(defaultNode);
    } finally {
      if (origEnv === undefined) {
        delete process.env.PERPLEXITY_NODE_PATH;
      } else {
        process.env.PERPLEXITY_NODE_PATH = origEnv;
      }
    }
  });
});
