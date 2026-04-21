import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PERPLEXITY_CONFIG_DIR;
  delete process.env.PERPLEXITY_PROFILE;

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), "perplexity-viewers-"));
  tempDirs.push(dir);
  process.env.PERPLEXITY_CONFIG_DIR = dir;
  process.env.PERPLEXITY_PROFILE = "default";
  return dir;
}

describe("viewers", () => {
  it("persists viewer overrides into config.json", async () => {
    const configDir = makeTempConfigDir();
    const { loadViewerConfig, saveViewerConfig } = await import("../src/viewers.js");

    saveViewerConfig({
      id: "obsidian",
      label: "Obsidian",
      urlTemplate: "obsidian://open?vault={vaultName}&file={relPath}",
      needsVaultBridge: true,
      vaultPath: join(configDir, "vault"),
      vaultName: "Knowledge",
      detected: true,
      enabled: true,
    });

    const loaded = loadViewerConfig();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].vaultName).toBe("Knowledge");
    expect(readFileSync(join(configDir, "config.json"), "utf8")).toContain("\"mdViewers\"");
  });

  it("encodes variables when substituting viewer templates", async () => {
    makeTempConfigDir();
    const { substituteViewerTemplate } = await import("../src/viewers.js");

    const rendered = substituteViewerTemplate(
      { urlTemplate: "obsidian://open?vault={vaultName}&file={relPath}" },
      { vaultName: "My Vault", relPath: "Perplexity/default/hello world.md" },
    );

    expect(rendered).toBe("obsidian://open?vault=My%20Vault&file=Perplexity%2Fdefault%2Fhello%20world.md");
  });

  it("copies markdown files into the Obsidian bridge path", async () => {
    const configDir = makeTempConfigDir();
    const historyDir = join(configDir, "profiles", "default", "history");
    const vaultDir = join(configDir, "vault");
    const mdPath = join(historyDir, "2026-04-21-example.md");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(mdPath, "# Hello\n", "utf8");

    const { ensureObsidianBridge } = await import("../src/viewers.js");
    const bridgePath = ensureObsidianBridge({
      mdPath,
      viewer: {
        id: "obsidian",
        label: "Obsidian",
        urlTemplate: "obsidian://open?vault={vaultName}&file={relPath}",
        needsVaultBridge: true,
        vaultPath: vaultDir,
        vaultName: "Vault",
        detected: true,
        enabled: true,
      },
    });

    expect(bridgePath).toContain(join("Perplexity", "default"));
    expect(readFileSync(bridgePath, "utf8")).toContain("# Hello");
  });

  it("refuses to bridge files outside the profile history directory", async () => {
    const configDir = makeTempConfigDir();
    const outsidePath = join(configDir, "outside.md");
    writeFileSync(outsidePath, "nope", "utf8");

    const { ensureObsidianBridge } = await import("../src/viewers.js");
    expect(() => ensureObsidianBridge({
      mdPath: outsidePath,
      viewer: {
        id: "obsidian",
        label: "Obsidian",
        urlTemplate: "obsidian://open?vault={vaultName}&file={relPath}",
        needsVaultBridge: true,
        vaultPath: join(configDir, "vault"),
        vaultName: "Vault",
        detected: true,
        enabled: true,
      },
    })).toThrow(/outside the profile history directory/i);
  });

  it("builds viewer URLs from builtin metadata", async () => {
    const configDir = makeTempConfigDir();
    const historyDir = join(configDir, "profiles", "default", "history");
    const mdPath = join(historyDir, "entry.md");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(mdPath, "# Entry\n", "utf8");

    const { buildViewerUrl } = await import("../src/viewers.js");
    const url = buildViewerUrl({
      viewer: {
        id: "typora",
        label: "Typora",
        urlTemplate: "typora://{absPath}",
        needsVaultBridge: false,
        detected: true,
        enabled: true,
      },
      mdPath,
    });

    expect(url).toContain("typora://");
    expect(decodeURIComponent(url)).toContain("entry.md");
  });
});
