import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERPLEXITY_RULES_SECTION_END,
  PERPLEXITY_RULES_SECTION_START,
} from "@perplexity-user-mcp/shared";
import {
  PERPLEXITY_TOOL_CATALOG,
  getPerplexityRulesContent,
} from "../src/auto-config/index.js";

/**
 * Source-of-truth path. The MCP server registers tools via guarded blocks like
 *
 *   if (!enabledTools || enabledTools.has("perplexity_<name>")) {
 *
 * — extracting the names with this regex matches the actual runtime registry
 * without forcing this test to import the runtime (which pulls in the SDK and
 * heavy native deps that aren't part of the extension package's typecheck path).
 */
const TOOLS_TS_PATH = join(
  __dirname,
  "..",
  "..",
  "mcp-server",
  "src",
  "tools.ts",
);
const TOOL_GUARD_RE = /enabledTools\.has\("(perplexity_[a-z_]+)"\)/g;

function readRegisteredToolNames(): string[] {
  const source = readFileSync(TOOLS_TS_PATH, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(TOOL_GUARD_RE)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

describe("auto-config rules block tool catalog", () => {
  const registered = readRegisteredToolNames();

  it("source-of-truth has at least the audited count (sanity check)", () => {
    // Audit at the time of writing said 14 tools registered. If this drops,
    // the regex above probably broke; if it grows, that's expected — fix the
    // catalog list and re-run.
    expect(registered.length).toBeGreaterThanOrEqual(14);
  });

  it("every registered tool appears in PERPLEXITY_TOOL_CATALOG", () => {
    const cataloged = new Set(PERPLEXITY_TOOL_CATALOG.map((t) => t.name));
    const missing = registered.filter((name) => !cataloged.has(name));
    expect(missing, `tools.ts registers these but the catalog omits them — update PERPLEXITY_TOOL_CATALOG: ${missing.join(", ")}`).toEqual([]);
  });

  it("catalog has no entries that aren't registered (no phantom tools)", () => {
    const registeredSet = new Set(registered);
    const phantom = PERPLEXITY_TOOL_CATALOG
      .map((t) => t.name)
      .filter((name) => !registeredSet.has(name));
    expect(phantom, `catalog lists tools not registered in tools.ts — remove them: ${phantom.join(", ")}`).toEqual([]);
  });

  it("catalog has no duplicate tool names", () => {
    const names = PERPLEXITY_TOOL_CATALOG.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("rendered rules block contains every registered tool name", () => {
    const rendered = getPerplexityRulesContent();
    for (const name of registered) {
      expect(rendered, `expected rules block to mention "${name}"`).toContain(name);
    }
  });

  it("rendered rules block is wrapped in the marker pair", () => {
    const rendered = getPerplexityRulesContent();
    expect(rendered.startsWith(PERPLEXITY_RULES_SECTION_START)).toBe(true);
    expect(rendered.endsWith(PERPLEXITY_RULES_SECTION_END)).toBe(true);
  });

  it("each catalog entry has a non-empty summary", () => {
    for (const entry of PERPLEXITY_TOOL_CATALOG) {
      expect(entry.summary, `tool ${entry.name} missing summary`).toBeTruthy();
      expect(entry.summary.length, `tool ${entry.name} summary too short`).toBeGreaterThan(10);
    }
  });
});
