export const EXTENSION_ID = "Perplexity";
export const MCP_PROVIDER_ID = "Perplexity.server";
export const MCP_SERVER_LABEL = "Perplexity Internal MCP";

export const MCP_TOOL_NAMES = [
  "perplexity_search",
  "perplexity_reason",
  "perplexity_research",
  "perplexity_ask",
  "perplexity_models",
  "perplexity_compute",
  "perplexity_retrieve",
  "perplexity_list_researches",
  "perplexity_get_research",
  "perplexity_login",
] as const;

export const MCP_CONFIG_FILE_NAMES = {
  cursor: ".cursor/mcp.json",
  windsurf: ".codeium/windsurf/mcp_config.json",
} as const;

export const HISTORY_LIMIT = 50;

export const PERPLEXITY_RULES_SECTION_START = "<!-- PERPLEXITY-MCP-START -->";
export const PERPLEXITY_RULES_SECTION_END = "<!-- PERPLEXITY-MCP-END -->";
export const PERPLEXITY_MCP_SERVER_KEY = "Perplexity";

export interface IdeMeta {
  displayName: string;
  configFormat: "json" | "toml" | "yaml" | "ui-only";
  autoConfigurable: boolean;
  rulesFormat?: "mdc" | "md" | "md-section" | "yaml" | "toml" | "none";
  rulesPath?: string;
}

export const IDE_METADATA: Record<string, IdeMeta> = {
  cursor: {
    displayName: "Cursor",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "mdc",
    rulesPath: ".cursor/rules/perplexity-mcp.mdc",
  },
  windsurf: {
    displayName: "Windsurf",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".windsurf/rules/perplexity-mcp.md",
  },
  windsurfNext: {
    displayName: "Windsurf Next",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".windsurf/rules/perplexity-mcp.md",
  },
  claudeDesktop: {
    displayName: "Claude Desktop",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "none",
  },
  claudeCode: {
    displayName: "Claude Code",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "CLAUDE.md",
  },
  cline: {
    displayName: "Cline",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".clinerules/perplexity-mcp.md",
  },
  amp: {
    displayName: "Amp (Sourcegraph)",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
  },
  rooCode: {
    displayName: "Roo Code",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".roo/rules/perplexity-mcp.md",
  },
  codexCli: {
    displayName: "Codex CLI",
    configFormat: "toml",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
  },
  continueDev: {
    displayName: "Continue.dev",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "yaml",
  },
  copilot: {
    displayName: "GitHub Copilot",
    configFormat: "ui-only",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".github/instructions/perplexity-mcp.instructions.md",
  },
  zed: {
    displayName: "Zed",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: ".rules",
  },
  geminiCli: {
    displayName: "Gemini CLI",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: "GEMINI.md",
  },
  aider: {
    displayName: "Aider",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "none",
  },
  augment: {
    displayName: "Augment Code",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".augment/rules/perplexity-mcp.md",
  },
};
