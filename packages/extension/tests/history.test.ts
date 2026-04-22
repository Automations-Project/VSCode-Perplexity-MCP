import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  delete process.env.PERPLEXITY_CONFIG_DIR;

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("history store", () => {
  it("prepends new history items and enforces the configured cap", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "perplexity-history-"));
    tempDirs.push(configDir);
    process.env.PERPLEXITY_CONFIG_DIR = configDir;

    // Import from the `history-store` subpath (not the root package) so we
    // don't pull in the PerplexityClient / daemon / OAuth / patchright
    // transitive tree. Under full-suite load the root-package import can
    // exceed the 5s per-test timeout; the subpath is the same underlying
    // module and re-exports `appendHistory` / `readHistory` under the same
    // names.
    const { appendHistory, readHistory } = await import("perplexity-user-mcp/history-store");

    for (let index = 0; index < 55; index += 1) {
      appendHistory({
        tool: "perplexity_search",
        query: `query-${index}`,
        model: "pplx_pro",
        mode: "copilot",
        language: "en-US",
        answerPreview: `preview-${index}`,
        sourceCount: index
      });
    }

    const items = readHistory();
    expect(items).toHaveLength(50);
    expect(items[0]?.query).toBe("query-54");
    expect(items.at(-1)?.query).toBe("query-5");
  });
});
