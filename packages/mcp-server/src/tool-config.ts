import { readFileSync, writeFileSync, existsSync, mkdirSync, watchFile } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = process.env.PERPLEXITY_CONFIG_DIR || join(homedir(), ".perplexity-mcp");
const TOOL_CONFIG_PATH = join(CONFIG_DIR, "tools-config.json");

export type ToolProfile = "read-only" | "full" | "custom";

interface ToolConfig {
  profile: ToolProfile;
  customEnabled?: string[];
}

const CATEGORIES: Record<string, string[]> = {
  read: [
    "perplexity_search", "perplexity_reason", "perplexity_research",
    "perplexity_ask", "perplexity_models", "perplexity_retrieve",
    "perplexity_list_researches", "perplexity_get_research",
  ],
  write: ["perplexity_compute", "perplexity_login"],
};

const PROFILES: Record<string, string[]> = {
  "read-only": ["read"],
  full: ["read", "write"],
};

export function loadToolConfig(): ToolConfig {
  if (!existsSync(TOOL_CONFIG_PATH)) return { profile: "full" };
  try { return JSON.parse(readFileSync(TOOL_CONFIG_PATH, "utf-8")); }
  catch { return { profile: "full" }; }
}

export function getEnabledTools(config: ToolConfig): Set<string> {
  if (config.profile === "custom" && config.customEnabled) return new Set(config.customEnabled);
  const cats = PROFILES[config.profile] ?? PROFILES.full;
  const enabled = new Set<string>();
  for (const cat of cats) for (const tool of CATEGORIES[cat] ?? []) enabled.add(tool);
  return enabled;
}

export function saveToolConfig(config: ToolConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOOL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function watchToolConfig(onChange: (config: ToolConfig) => void): void {
  if (!existsSync(TOOL_CONFIG_PATH)) return;
  watchFile(TOOL_CONFIG_PATH, { interval: 2000 }, () => onChange(loadToolConfig()));
}
