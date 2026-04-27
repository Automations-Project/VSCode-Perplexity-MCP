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

// Phase 8.6: per-IDE MCP transport picker. The picker UI (8.6.5) and config
// generators (8.6.3, 8.6.4) consume these; 8.6.2 lands the shape only.
export type McpTransportId =
  | "stdio-in-process"
  | "stdio-daemon-proxy"
  | "http-loopback"
  | "http-tunnel";

export const MCP_TRANSPORT_DEFAULT: McpTransportId = "stdio-daemon-proxy";

export const MCP_TRANSPORT_IDS: ReadonlyArray<McpTransportId> = [
  "stdio-in-process",
  "stdio-daemon-proxy",
  "http-loopback",
  "http-tunnel",
] as const;

export interface IdeCapabilities {
  stdio: boolean;
  httpBearerLoopback: boolean;
  httpOAuthLoopback: boolean;
  httpOAuthTunnel: boolean;
  /** Required when any non-stdio capability is true. Values are URL paths to primary-source docs OR relative paths to smoke-evidence files. */
  evidence?: Partial<Record<Exclude<keyof IdeCapabilities, "stdio" | "evidence">, string>>;
}

export interface IdeMeta {
  displayName: string;
  configFormat: "json" | "toml" | "yaml" | "ui-only";
  autoConfigurable: boolean;
  rulesFormat?: "mdc" | "md" | "md-section" | "yaml" | "toml" | "none";
  rulesPath?: string;
  capabilities: IdeCapabilities;
}

// HTTP caps start `false` everywhere: they are evidence-gated and only flip
// to `true` in follow-up commits accompanied by dated docs/smoke-evidence/*.md
// files. `stdio` is `false` for `ui-only` clients (they don't ingest mcp.json).
export const IDE_METADATA: Record<string, IdeMeta> = {
  cursor: {
    displayName: "Cursor",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "mdc",
    rulesPath: ".cursor/rules/perplexity-mcp.mdc",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  windsurf: {
    displayName: "Windsurf",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".windsurf/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  windsurfNext: {
    displayName: "Windsurf Next",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".windsurf/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  claudeDesktop: {
    displayName: "Claude Desktop",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  claudeCode: {
    displayName: "Claude Code",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "CLAUDE.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  cline: {
    displayName: "Cline",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md",
    rulesPath: ".clinerules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  amp: {
    displayName: "Amp (Sourcegraph)",
    configFormat: "json",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  rooCode: {
    displayName: "Roo Code",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".roo/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  codexCli: {
    displayName: "Codex CLI",
    configFormat: "toml",
    autoConfigurable: true,
    rulesFormat: "md-section",
    rulesPath: "AGENTS.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  continueDev: {
    displayName: "Continue.dev",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "yaml",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  copilot: {
    displayName: "GitHub Copilot",
    configFormat: "ui-only",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".github/instructions/perplexity-mcp.instructions.md",
    capabilities: {
      // ui-only: client doesn't ingest mcp.json, so stdio is N/A.
      stdio: false,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  zed: {
    displayName: "Zed",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: ".rules",
    capabilities: {
      stdio: true,
      httpBearerLoopback: true,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
      evidence: {
        httpBearerLoopback: "docs/smoke-evidence/2026-04-24-http-loopback-static-bearer.md",
      },
    },
  },
  geminiCli: {
    displayName: "Gemini CLI",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md-section",
    rulesPath: "GEMINI.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  aider: {
    displayName: "Aider",
    configFormat: "yaml",
    autoConfigurable: false,
    rulesFormat: "none",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
  augment: {
    displayName: "Augment Code",
    configFormat: "json",
    autoConfigurable: false,
    rulesFormat: "md",
    rulesPath: ".augment/rules/perplexity-mcp.md",
    capabilities: {
      stdio: true,
      httpBearerLoopback: false,
      httpOAuthLoopback: false,
      httpOAuthTunnel: false,
    },
  },
};
