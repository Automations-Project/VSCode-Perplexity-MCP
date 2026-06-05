/**
 * User-defined MCP prompt ("custom command") contracts shared between the
 * webview Prompts tab, the extension host (DashboardProvider read/write), and
 * the MCP server (which registers them via `registerPrompts`).
 *
 * The persisted on-disk shape (`~/.perplexity-mcp/prompts.json`) lives in the
 * mcp-server (`prompts-config.ts`) as `StoredPrompt`/`PromptsConfig` and omits
 * the computed `isBuiltin`/`isModified` flags. `PromptDef` below is the
 * *merged* view the UI renders and the webview sends back on save.
 */

/** A single declared argument of a prompt template. */
export interface PromptArg {
  /** Identifier referenced in the template as `{name}`. Lowercase-leading. */
  name: string;
  /** Human-readable description surfaced to MCP clients. */
  description: string;
  /** When true the MCP client requires a value before invoking. */
  required: boolean;
}

/**
 * A prompt as rendered in the dashboard list/editor. `isBuiltin`/`isModified`
 * are computed by `mergePrompts` and ignored when the webview sends a save.
 */
export interface PromptDef {
  /** Slash-command name, e.g. `perplexity-fact-check`. Unique. */
  name: string;
  /** One-line description shown in the UI and to MCP clients. */
  description: string;
  /** Declared arguments, substituted into `template` as `{name}`. */
  arguments: PromptArg[];
  /** Prompt body with `{arg}` placeholders. */
  template: string;
  /** True for shipped built-in prompts (name not editable, cannot be deleted). */
  isBuiltin: boolean;
  /** True for a built-in that currently has a user override. */
  isModified: boolean;
}

/** The full merged prompt list pushed to the webview. */
export interface PromptsState {
  prompts: PromptDef[];
}
