import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PROMPTS,
  CUSTOM_NAME_RE,
  deleteCustomPrompt,
  mergePrompts,
  promptsConfigPath,
  readPromptsConfig,
  resetBuiltin,
  substituteTemplate,
  upsertPrompt,
  writePromptsConfig,
} from "../src/prompts-config.js";

const tmpDirs = [];
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "perplexity-prompts-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PERPLEXITY_CONFIG_DIR;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sample = (name = "my-cmd") => ({
  name,
  description: "desc",
  arguments: [{ name: "x", description: "the x", required: true }],
  template: "value: {x}",
});

describe("substituteTemplate", () => {
  it("replaces a single placeholder", () => {
    expect(substituteTemplate("hi {topic}", { topic: "AI" })).toBe("hi AI");
  });

  it("replaces multiple placeholders", () => {
    expect(substituteTemplate("{a} vs {b}", { a: "x", b: "y" })).toBe("x vs y");
  });

  it("substitutes a missing arg with an empty string", () => {
    expect(substituteTemplate("hi {topic}!", {})).toBe("hi !");
  });

  it("coerces non-string values", () => {
    expect(substituteTemplate("n={count}", { count: 3 })).toBe("n=3");
  });

  it("leaves non-arg braces untouched (uppercase-leading / spaces)", () => {
    expect(substituteTemplate("{Field Name} and {SUM}", { Field: "x" })).toBe("{Field Name} and {SUM}");
  });
});

describe("CUSTOM_NAME_RE", () => {
  it("accepts lowercase, digits, hyphens with a leading letter", () => {
    expect(CUSTOM_NAME_RE.test("my-prompt-2")).toBe(true);
  });
  it("rejects leading digit, uppercase, spaces, and empty", () => {
    for (const bad of ["2cmd", "Cmd", "my cmd", "", "_x", "my_cmd"]) {
      expect(CUSTOM_NAME_RE.test(bad)).toBe(false);
    }
  });
});

describe("mergePrompts", () => {
  it("returns built-ins flagged isBuiltin, not modified, by default", () => {
    const merged = mergePrompts({ overrides: {}, custom: [] });
    expect(merged).toHaveLength(BUILTIN_PROMPTS.length);
    expect(merged.every((p) => p.isBuiltin && !p.isModified)).toBe(true);
    expect(merged.map((p) => p.name)).toEqual(BUILTIN_PROMPTS.map((b) => b.name));
  });

  it("applies an override: keeps the built-in name, marks modified, uses override content", () => {
    const name = BUILTIN_PROMPTS[0].name;
    const merged = mergePrompts({
      overrides: { [name]: { name, description: "new", arguments: [], template: "T" } },
      custom: [],
    });
    const target = merged.find((p) => p.name === name);
    expect(target).toMatchObject({ name, description: "new", template: "T", isBuiltin: true, isModified: true });
  });

  it("appends custom prompts after built-ins, flagged not-builtin", () => {
    const merged = mergePrompts({ overrides: {}, custom: [sample("zed-cmd")] });
    const custom = merged.find((p) => p.name === "zed-cmd");
    expect(custom).toMatchObject({ isBuiltin: false, isModified: false });
    expect(merged[merged.length - 1].name).toBe("zed-cmd");
  });

  it("filters a custom prompt that shadows a built-in name", () => {
    const name = BUILTIN_PROMPTS[0].name;
    const merged = mergePrompts({ overrides: {}, custom: [{ ...sample(), name }] });
    expect(merged.filter((p) => p.name === name)).toHaveLength(1);
    expect(merged.find((p) => p.name === name)?.isBuiltin).toBe(true);
  });
});

describe("upsert / delete / reset (pure)", () => {
  it("upsert of a built-in name writes an override, not a custom entry", () => {
    const name = BUILTIN_PROMPTS[0].name;
    const next = upsertPrompt({ overrides: {}, custom: [] }, { ...sample(), name });
    expect(next.overrides[name]).toBeDefined();
    expect(next.custom).toHaveLength(0);
  });

  it("upsert of a new name appends to custom", () => {
    const next = upsertPrompt({ overrides: {}, custom: [] }, sample("new-one"));
    expect(next.custom.map((c) => c.name)).toEqual(["new-one"]);
  });

  it("upsert of an existing custom name replaces it in place", () => {
    const base = { overrides: {}, custom: [sample("dup")] };
    const next = upsertPrompt(base, { ...sample("dup"), description: "changed" });
    expect(next.custom).toHaveLength(1);
    expect(next.custom[0].description).toBe("changed");
  });

  it("upsert strips unknown fields down to the stored shape", () => {
    const next = upsertPrompt({ overrides: {}, custom: [] }, {
      ...sample("clean"),
      isBuiltin: true,
      isModified: true,
      junk: 1,
    });
    expect(Object.keys(next.custom[0]).sort()).toEqual(["arguments", "description", "name", "template"]);
  });

  it("deleteCustomPrompt removes only the named custom prompt", () => {
    const base = { overrides: {}, custom: [sample("a"), sample("b")] };
    expect(deleteCustomPrompt(base, "a").custom.map((c) => c.name)).toEqual(["b"]);
  });

  it("resetBuiltin clears an override and is a no-op when absent", () => {
    const name = BUILTIN_PROMPTS[0].name;
    const withOverride = { overrides: { [name]: sample(name) }, custom: [] };
    expect(resetBuiltin(withOverride, name).overrides[name]).toBeUndefined();
    const empty = { overrides: {}, custom: [] };
    expect(resetBuiltin(empty, name)).toEqual(empty);
  });
});

describe("read / write round-trip", () => {
  it("writes atomically and reads back", () => {
    const dir = freshDir();
    const config = upsertPrompt({ overrides: {}, custom: [] }, sample("round-trip"));
    writePromptsConfig(config, dir);
    expect(readPromptsConfig(dir)).toEqual(config);
    // trailing newline + pretty-printed
    expect(readFileSync(promptsConfigPath(dir), "utf8").endsWith("\n")).toBe(true);
  });

  it("returns an empty config when the file is missing", () => {
    expect(readPromptsConfig(freshDir())).toEqual({ overrides: {}, custom: [] });
  });

  it("returns an empty config on malformed JSON", () => {
    const dir = freshDir();
    writeFileSync(promptsConfigPath(dir), "{ not json", "utf8");
    expect(readPromptsConfig(dir)).toEqual({ overrides: {}, custom: [] });
  });

  it("normalizes a config with wrong-typed fields", () => {
    const dir = freshDir();
    writeFileSync(promptsConfigPath(dir), JSON.stringify({ overrides: [], custom: "nope" }), "utf8");
    expect(readPromptsConfig(dir)).toEqual({ overrides: {}, custom: [] });
  });

  it("honors PERPLEXITY_CONFIG_DIR as the default location", () => {
    const dir = freshDir();
    process.env.PERPLEXITY_CONFIG_DIR = dir;
    const config = upsertPrompt({ overrides: {}, custom: [] }, sample("env-default"));
    writePromptsConfig(config);
    expect(promptsConfigPath()).toBe(join(dir, "prompts.json"));
    expect(readPromptsConfig()).toEqual(config);
  });
});
