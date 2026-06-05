import { describe, expect, it } from "vitest";
import { BUILTIN_PROMPTS, type PromptsConfig } from "perplexity-user-mcp/prompts-config";
import {
  deletePromptHandler,
  resetPromptHandler,
  savePromptHandler,
} from "../src/webview/prompts-handler.js";

/**
 * Pure handlers for prompts:save / delete / reset, extracted from
 * DashboardProvider. The merge/upsert/read/write primitives are covered by the
 * mcp-server prompts-config tests; here we verify the extension-side validation
 * and dispatch. The postActionResult/postPromptsState wiring is exercised by the
 * smoke checklist in docs/smoke-tests.md.
 */
function makeDeps(initial: PromptsConfig = { overrides: {}, custom: [] }) {
  let config: PromptsConfig = initial;
  let writes = 0;
  return {
    deps: {
      read: () => config,
      write: (c: PromptsConfig) => {
        config = c;
        writes += 1;
      },
    },
    current: () => config,
    writeCount: () => writes,
  };
}

const validCustom = {
  name: "my-cmd",
  description: "mine",
  arguments: [{ name: "q", description: "the query", required: true }],
  template: "Search: {q}",
};

describe("savePromptHandler", () => {
  it("persists a valid custom prompt", () => {
    const h = makeDeps();
    const out = savePromptHandler(validCustom, h.deps);
    expect(out.ok).toBe(true);
    expect(h.current().custom.map((c) => c.name)).toEqual(["my-cmd"]);
  });

  it("rejects an invalid name without writing", () => {
    const h = makeDeps();
    const out = savePromptHandler({ ...validCustom, name: "Bad Name" }, h.deps);
    expect(out).toEqual({ ok: false, error: expect.stringContaining("Invalid command name") });
    expect(h.writeCount()).toBe(0);
  });

  it("rejects an empty template without writing", () => {
    const h = makeDeps();
    const out = savePromptHandler({ ...validCustom, template: "   " }, h.deps);
    expect(out).toEqual({ ok: false, error: expect.stringContaining("Template cannot be empty") });
    expect(h.writeCount()).toBe(0);
  });

  it("writes an override (not a custom entry) for a built-in name", () => {
    const builtin = BUILTIN_PROMPTS[0].name;
    const h = makeDeps();
    const out = savePromptHandler({ ...validCustom, name: builtin }, h.deps);
    expect(out.ok).toBe(true);
    expect(h.current().overrides[builtin]).toBeDefined();
    expect(h.current().custom).toHaveLength(0);
  });

  it("drops arguments without names and coerces required", () => {
    const h = makeDeps();
    savePromptHandler(
      {
        name: "argy",
        description: "",
        arguments: [
          { name: "keep", description: "", required: 1 as unknown as boolean },
          { name: "", description: "nameless", required: true },
        ],
        template: "{keep}",
      },
      h.deps,
    );
    const saved = h.current().custom[0];
    expect(saved.arguments).toEqual([{ name: "keep", description: "", required: true }]);
  });

  it("rejects a missing payload", () => {
    const h = makeDeps();
    expect(savePromptHandler(undefined, h.deps).ok).toBe(false);
    expect(h.writeCount()).toBe(0);
  });
});

describe("deletePromptHandler", () => {
  it("removes the named custom prompt", () => {
    const h = makeDeps({ overrides: {}, custom: [{ name: "a", description: "", arguments: [], template: "x" }] });
    const out = deletePromptHandler("a", h.deps);
    expect(out.ok).toBe(true);
    expect(h.current().custom).toHaveLength(0);
  });

  it("rejects an empty name", () => {
    const h = makeDeps();
    expect(deletePromptHandler("", h.deps).ok).toBe(false);
    expect(h.writeCount()).toBe(0);
  });
});

describe("resetPromptHandler", () => {
  it("clears a built-in override", () => {
    const builtin = BUILTIN_PROMPTS[0].name;
    const h = makeDeps({ overrides: { [builtin]: { name: builtin, description: "x", arguments: [], template: "y" } }, custom: [] });
    const out = resetPromptHandler(builtin, h.deps);
    expect(out.ok).toBe(true);
    expect(h.current().overrides[builtin]).toBeUndefined();
  });

  it("is a no-op (still ok) when there is no override", () => {
    const h = makeDeps();
    expect(resetPromptHandler(BUILTIN_PROMPTS[0].name, h.deps).ok).toBe(true);
  });
});
