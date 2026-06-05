import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mergePrompts,
  readPromptsConfig,
  substituteTemplate,
  type PromptArg,
  type PromptDef,
} from "./prompts-config.js";

/** Build a Zod raw shape from a prompt's declared arguments. */
function buildArgsSchema(args: PromptArg[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of args) {
    if (!arg?.name) continue;
    let field: z.ZodString = z.string();
    if (arg.description) field = field.describe(arg.description);
    shape[arg.name] = arg.required ? field : field.optional();
  }
  return shape;
}

/**
 * Register all prompts — shipped built-ins (merged with any user overrides)
 * plus user-defined custom prompts from `<configDir>/prompts.json`. Called by
 * the stdio entrypoint once at startup and by the daemon per HTTP request
 * (which is why daemon clients pick up edits on their next connection).
 *
 * Reads the config synchronously; never throws. A single malformed prompt is
 * logged and skipped rather than failing the whole registration.
 */
export function registerPrompts(server: McpServer): void {
  const prompts: PromptDef[] = mergePrompts(readPromptsConfig());
  const seen = new Set<string>();

  for (const prompt of prompts) {
    if (!prompt.name || seen.has(prompt.name)) continue;
    seen.add(prompt.name);

    const render = (args: Record<string, unknown> = {}) => ({
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: substituteTemplate(prompt.template, args) },
        },
      ],
    });

    try {
      server.registerPrompt(
        prompt.name,
        {
          title: prompt.name,
          description: prompt.description,
          argsSchema: buildArgsSchema(prompt.arguments),
        },
        (args) => render(args as Record<string, unknown>),
      );
    } catch (err) {
      console.error(`[perplexity-mcp] failed to register prompt '${prompt.name}':`, err);
    }
  }
}
