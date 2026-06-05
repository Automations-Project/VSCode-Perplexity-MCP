import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPrompts } from "../src/prompts.js";
import { BUILTIN_PROMPTS, writePromptsConfig } from "../src/prompts-config.js";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perplexity-register-prompts-"));
  process.env.PERPLEXITY_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.PERPLEXITY_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal McpServer stand-in capturing registerPrompt(name, config, cb). */
function mockServer() {
  const calls = [];
  return { calls, registerPrompt: (name, config, cb) => calls.push({ name, config, cb }) };
}

describe("registerPrompts", () => {
  it("registers all built-ins by default", () => {
    const server = mockServer();
    registerPrompts(server);
    expect(server.calls.map((c) => c.name).sort()).toEqual(BUILTIN_PROMPTS.map((b) => b.name).sort());
  });

  it("builds an argsSchema keyed by declared argument names", () => {
    const server = mockServer();
    registerPrompts(server);
    const factCheck = server.calls.find((c) => c.name === "perplexity-fact-check");
    expect(Object.keys(factCheck.config.argsSchema)).toEqual(["claim"]);
  });

  it("renders a built-in template with argument substitution", () => {
    const server = mockServer();
    registerPrompts(server);
    const factCheck = server.calls.find((c) => c.name === "perplexity-fact-check");
    const result = factCheck.cb({ claim: "the sky is green" });
    expect(result.messages[0].content.text).toContain("the sky is green");
    expect(result.messages[0].role).toBe("user");
  });

  it("registers user-defined custom prompts from prompts.json", () => {
    writePromptsConfig(
      {
        overrides: {},
        custom: [
          { name: "my-cmd", description: "mine", arguments: [{ name: "q", description: "", required: true }], template: "Q: {q}" },
        ],
      },
      dir,
    );
    const server = mockServer();
    registerPrompts(server);
    const mine = server.calls.find((c) => c.name === "my-cmd");
    expect(mine).toBeDefined();
    expect(mine.cb({ q: "hello" }).messages[0].content.text).toBe("Q: hello");
  });

  it("applies a built-in override at registration time", () => {
    const name = BUILTIN_PROMPTS[0].name;
    writePromptsConfig(
      { overrides: { [name]: { name, description: "overridden", arguments: [], template: "OVERRIDDEN" } }, custom: [] },
      dir,
    );
    const server = mockServer();
    registerPrompts(server);
    const target = server.calls.find((c) => c.name === name);
    expect(target.config.description).toBe("overridden");
    expect(target.cb({}).messages[0].content.text).toBe("OVERRIDDEN");
  });

  it("skips duplicate names without throwing", () => {
    const server = {
      calls: [],
      registerPrompt(name, config, cb) {
        if (this.calls.some((c) => c.name === name)) throw new Error("duplicate registration");
        this.calls.push({ name, config, cb });
      },
    };
    expect(() => registerPrompts(server)).not.toThrow();
  });
});
