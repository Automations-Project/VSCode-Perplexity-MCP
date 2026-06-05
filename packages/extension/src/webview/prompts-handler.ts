/**
 * Pure handlers for the Prompts tab messages (prompts:save / delete / reset),
 * extracted from DashboardProvider so the validation + mutation decisions stay
 * testable without a full vscode shim. The provider injects real
 * read/write deps (readPromptsConfig/writePromptsConfig) and handles the
 * postActionResult + postPromptsState wiring around the returned outcome.
 *
 * The merge/read/write/upsert primitives themselves live in (and are tested by)
 * the mcp-server `prompts-config` module — this layer is just the extension-side
 * validation and dispatch.
 */
import {
  BUILTIN_PROMPTS,
  CUSTOM_NAME_RE,
  deleteCustomPrompt,
  resetBuiltin,
  upsertPrompt,
  type PromptsConfig,
  type StoredPrompt,
} from "perplexity-user-mcp/prompts-config";

export interface PromptsHandlerDeps {
  read: () => PromptsConfig;
  write: (config: PromptsConfig) => void;
}

export type PromptsOutcome = { ok: true } | { ok: false; error: string };

/** Shape the webview sends (defensively typed — it crosses the message boundary). */
export interface IncomingPrompt {
  name?: string;
  description?: string;
  arguments?: Array<{ name?: string; description?: string; required?: boolean }>;
  template?: string;
}

/** True when `name` matches a shipped built-in (override target, not deletable). */
export function isBuiltinName(name: string): boolean {
  return BUILTIN_PROMPTS.some((b) => b.name === name);
}

/**
 * Validate + persist a saved prompt. A built-in name writes an override; any
 * other name must satisfy CUSTOM_NAME_RE. The template must be non-empty.
 */
export function savePromptHandler(incoming: IncomingPrompt | undefined, deps: PromptsHandlerDeps): PromptsOutcome {
  const name = (incoming?.name ?? "").trim();
  if (!name || (!isBuiltinName(name) && !CUSTOM_NAME_RE.test(name))) {
    return { ok: false, error: "Invalid command name — use lowercase letters, digits, and hyphens (must start with a letter)." };
  }
  if (!String(incoming?.template ?? "").trim()) {
    return { ok: false, error: "Template cannot be empty." };
  }
  const args = Array.isArray(incoming?.arguments) ? incoming!.arguments : [];
  const stored: StoredPrompt = {
    name,
    description: incoming?.description ?? "",
    arguments: args
      .filter((a) => a && typeof a.name === "string" && a.name.length > 0)
      .map((a) => ({ name: a.name as string, description: a.description ?? "", required: !!a.required })),
    template: String(incoming?.template ?? ""),
  };
  deps.write(upsertPrompt(deps.read(), stored));
  return { ok: true };
}

/** Remove a custom prompt by name (built-ins are unaffected). */
export function deletePromptHandler(name: string, deps: PromptsHandlerDeps): PromptsOutcome {
  if (!name) return { ok: false, error: "Missing prompt name." };
  deps.write(deleteCustomPrompt(deps.read(), name));
  return { ok: true };
}

/** Clear a built-in's override, reverting it to the shipped default. */
export function resetPromptHandler(name: string, deps: PromptsHandlerDeps): PromptsOutcome {
  if (!name) return { ok: false, error: "Missing prompt name." };
  deps.write(resetBuiltin(deps.read(), name));
  return { ok: true };
}
