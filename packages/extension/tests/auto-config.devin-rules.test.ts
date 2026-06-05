import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRulesStatuses,
  removeRulesForIde,
  syncRulesForIde,
} from "../src/auto-config/index.js";

/**
 * Windsurf was rebranded to "Devin Desktop" (2026-06-02). Workspace rules moved
 * to `.devin/rules/` while `.windsurf/rules/` is still read as a legacy fallback,
 * so we write/detect/remove BOTH. The `windsurf` target key is unchanged.
 */
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "perplexity-devin-rules-"));
  tempDirs.push(r);
  return r;
}

const DEVIN = ".devin/rules/perplexity-mcp.md";
const LEGACY = ".windsurf/rules/perplexity-mcp.md";
const norm = (p: string) => p.replace(/\\/g, "/");

describe("Windsurf → Devin Desktop rules (dual-write + legacy support)", () => {
  it("dual-writes the .devin primary and .windsurf legacy with identical content", () => {
    const root = freshRoot();
    const status = syncRulesForIde("windsurf", root);
    const devinPath = join(root, DEVIN);
    const legacyPath = join(root, LEGACY);
    expect(existsSync(devinPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(devinPath, "utf8")).toBe(readFileSync(legacyPath, "utf8"));
    expect(status.hasPerplexitySection).toBe(true);
    expect(norm(status.rulesPath)).toContain(".devin/rules/");
  });

  it("getRulesStatuses reports the .devin primary after sync", () => {
    const root = freshRoot();
    syncRulesForIde("windsurf", root);
    const ws = getRulesStatuses(root).find((s) => s.ide === "windsurf");
    expect(ws?.hasPerplexitySection).toBe(true);
    expect(norm(ws!.rulesPath)).toContain(".devin/rules/");
  });

  it("still detects an existing .windsurf legacy file when .devin is absent (pre-upgrade user)", () => {
    const root = freshRoot();
    syncRulesForIde("windsurf", root);
    rmSync(join(root, DEVIN), { force: true });
    const ws = getRulesStatuses(root).find((s) => s.ide === "windsurf");
    expect(ws?.hasPerplexitySection).toBe(true);
    expect(norm(ws!.rulesPath)).toContain(".windsurf/rules/");
  });

  it("removeRulesForIde cleans both the .devin and .windsurf files", () => {
    const root = freshRoot();
    syncRulesForIde("windsurf", root);
    removeRulesForIde("windsurf", root);
    expect(existsSync(join(root, DEVIN))).toBe(false);
    expect(existsSync(join(root, LEGACY))).toBe(false);
  });

  it("windsurfNext writes the same dual paths", () => {
    const root = freshRoot();
    syncRulesForIde("windsurfNext", root);
    expect(existsSync(join(root, DEVIN))).toBe(true);
    expect(existsSync(join(root, LEGACY))).toBe(true);
  });
});
