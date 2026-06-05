/**
 * User-defined MCP prompts ("custom commands").
 *
 * Persists to `<configDir>/prompts.json` (global, not per-profile) as
 * `{ overrides, custom }` and merges that with the shipped `BUILTIN_PROMPTS`
 * into the flat `PromptDef[]` that both the dashboard renders and
 * `registerPrompts()` serves. Read synchronously, fresh per request — the file
 * is tiny.
 *
 * This module is the single source of truth: the extension imports it via the
 * `perplexity-user-mcp/prompts-config` subpath export to drive the Prompts tab,
 * and the MCP server imports it (through `prompts.ts`) to register the prompts.
 * Shared message/UI types in `@perplexity-user-mcp/shared` mirror these shapes
 * structurally; this package intentionally keeps its own copies so the
 * standalone npm package takes no dependency on the workspace `shared` package.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./profiles.js";
import { safeAtomicWriteFileSync } from "./safe-write.js";

/** A single declared argument of a prompt template. */
export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

/** A prompt as persisted on disk (no computed flags). */
export interface StoredPrompt {
  name: string;
  description: string;
  arguments: PromptArg[];
  template: string;
}

/** A merged prompt as rendered in the dashboard + registered with the server. */
export interface PromptDef extends StoredPrompt {
  isBuiltin: boolean;
  isModified: boolean;
}

/** On-disk shape of `prompts.json`. */
export interface PromptsConfig {
  /** Built-in name → user override of that built-in. */
  overrides: Record<string, StoredPrompt>;
  /** Fully user-defined prompts. */
  custom: StoredPrompt[];
}

/** Valid custom slash-command name: lowercase, digits, hyphens; leading letter. */
export const CUSTOM_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Placeholder pattern. Restricted to lowercase-leading identifiers so plain
 * prose braces (e.g. JSON examples in a template) are left untouched.
 */
const ARG_RE = /\{([a-z][a-zA-Z0-9]*)\}/g;

/**
 * Shipped prompts. Always present (unless overridden); cannot be deleted.
 * Names mix the original dotted built-ins (kept for back-compat) with the
 * hyphenated convention recommended for new custom prompts.
 */
export const BUILTIN_PROMPTS: StoredPrompt[] = [
  {
    name: "perplexity.researchPlan",
    description: "Deep research brief on a topic, routed to perplexity_research.",
    arguments: [{ name: "topic", description: "The subject to research", required: true }],
    template:
      'Use perplexity_research to produce a sourced research brief about "{topic}". Emphasize citations, key findings, and next questions.',
  },
  {
    name: "perplexity.reasoningPlan",
    description: "Step-by-step reasoning on a question, routed to perplexity_reason.",
    arguments: [{ name: "question", description: "The question to reason about", required: true }],
    template:
      "Use perplexity_reason on the following question and provide the reasoning trace plus a concise final answer: {question}",
  },
  {
    name: "perplexity-fact-check",
    description: "Verify a claim with cited primary sources via perplexity_search.",
    arguments: [{ name: "claim", description: "The statement to verify", required: true }],
    template:
      "Use perplexity_search to verify the following claim and cite primary sources. State clearly whether it is true, false, misleading, or unverifiable, and explain the evidence.\n\nClaim: {claim}",
  },
  {
    name: "perplexity-compare",
    description: "Compare two options with a sourced comparison table.",
    arguments: [
      { name: "optionA", description: "First option", required: true },
      { name: "optionB", description: "Second option", required: true },
    ],
    template:
      "Use perplexity_search to compare {optionA} and {optionB}. Produce a concise comparison table of the key differences, then a recommendation backed by cited sources.",
  },
  {
    name: "perplexity-latest",
    description: "Find the latest developments on a topic via perplexity_search.",
    arguments: [{ name: "topic", description: "The topic to track", required: true }],
    template:
      'Use perplexity_search to find the latest developments about "{topic}" from the past few weeks. Prioritize recent, credible sources and cite publication dates.',
  },
];

/** Absolute path to the prompts file. */
export function promptsConfigPath(configDir: string = getConfigDir()): string {
  return join(configDir, "prompts.json");
}

/** Coerce arbitrary JSON into a well-formed `PromptsConfig`. */
function normalizeConfig(raw: unknown): PromptsConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const overrides =
    obj.overrides && typeof obj.overrides === "object" && !Array.isArray(obj.overrides)
      ? (obj.overrides as Record<string, StoredPrompt>)
      : {};
  const custom = Array.isArray(obj.custom) ? (obj.custom as StoredPrompt[]) : [];
  return { overrides, custom };
}

/** Read + normalize `prompts.json`. Returns an empty config on miss/parse error. */
export function readPromptsConfig(configDir: string = getConfigDir()): PromptsConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(promptsConfigPath(configDir), "utf8")));
  } catch {
    return { overrides: {}, custom: [] };
  }
}

/** Atomically persist `prompts.json` (creates the config dir if needed). */
export function writePromptsConfig(config: PromptsConfig, configDir: string = getConfigDir()): void {
  const p = promptsConfigPath(configDir);
  mkdirSync(dirname(p), { recursive: true });
  safeAtomicWriteFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Strip computed/extra fields down to the persisted shape. */
function toStored(prompt: StoredPrompt): StoredPrompt {
  return {
    name: prompt.name,
    description: prompt.description,
    arguments: (prompt.arguments ?? []).map((a) => ({
      name: a.name,
      description: a.description,
      required: !!a.required,
    })),
    template: prompt.template,
  };
}

/**
 * Merge built-ins + overrides + custom into the flat list the UI/server use.
 * Built-ins come first (overridden in place), then custom prompts. A custom
 * prompt may not shadow a built-in name.
 */
export function mergePrompts(config: PromptsConfig): PromptDef[] {
  const builtinNames = new Set(BUILTIN_PROMPTS.map((b) => b.name));
  const builtins: PromptDef[] = BUILTIN_PROMPTS.map((b) => {
    const override = config.overrides[b.name];
    const base = override ?? b;
    return { ...toStored(base), name: b.name, isBuiltin: true, isModified: !!override };
  });
  const custom: PromptDef[] = config.custom
    .filter((c) => c && c.name && !builtinNames.has(c.name))
    .map((c) => ({ ...toStored(c), isBuiltin: false, isModified: false }));
  return [...builtins, ...custom];
}

/**
 * Upsert a prompt. A built-in name writes/updates an override; any other name
 * upserts the custom list. Returns a new config (pure).
 */
export function upsertPrompt(config: PromptsConfig, prompt: StoredPrompt): PromptsConfig {
  const stored = toStored(prompt);
  if (BUILTIN_PROMPTS.some((b) => b.name === stored.name)) {
    return { ...config, overrides: { ...config.overrides, [stored.name]: stored } };
  }
  const exists = config.custom.some((c) => c.name === stored.name);
  const custom = exists
    ? config.custom.map((c) => (c.name === stored.name ? stored : c))
    : [...config.custom, stored];
  return { ...config, custom };
}

/** Remove a custom prompt by name. Built-ins are unaffected. */
export function deleteCustomPrompt(config: PromptsConfig, name: string): PromptsConfig {
  return { ...config, custom: config.custom.filter((c) => c.name !== name) };
}

/** Clear a built-in's override, reverting it to the shipped default. */
export function resetBuiltin(config: PromptsConfig, name: string): PromptsConfig {
  if (!(name in config.overrides)) return config;
  const overrides = { ...config.overrides };
  delete overrides[name];
  return { ...config, overrides };
}

/** Replace `{arg}` placeholders with provided values (missing → empty string). */
export function substituteTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(ARG_RE, (_match, key: string) => {
    const value = args[key];
    return value == null ? "" : String(value);
  });
}
