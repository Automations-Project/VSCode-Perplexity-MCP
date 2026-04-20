import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CATEGORY = "mcp";
const KNOWN_PROFILES = new Set(["read-only", "full", "custom"]);

export async function run(opts = {}) {
  const results = [];
  const dir = opts.configDir;
  const toolCfgPath = join(dir, "tools-config.json");

  if (!existsSync(toolCfgPath)) {
    results.push({
      category: CATEGORY,
      name: "tool-config",
      status: "skip",
      message: "no tools-config.json (default: full)",
    });
    results.push({
      category: CATEGORY,
      name: "enabled-tools",
      status: "pass",
      message: "default profile 'full'",
    });
    return results;
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(toolCfgPath, "utf8"));
  } catch (err) {
    results.push({
      category: CATEGORY,
      name: "tool-config",
      status: "fail",
      message: `tools-config.json malformed: ${err.message}`,
      hint: "Delete the file to restore defaults.",
    });
    return results;
  }

  if (!KNOWN_PROFILES.has(cfg.profile)) {
    results.push({
      category: CATEGORY,
      name: "tool-config",
      status: "warn",
      message: `unknown profile '${cfg.profile}' — falling back to 'full'`,
    });
  } else {
    results.push({ category: CATEGORY, name: "tool-config", status: "pass", message: `profile=${cfg.profile}` });
  }
  const count = cfg.profile === "custom"
    ? (cfg.customEnabled?.length ?? 0)
    : cfg.profile === "read-only"
      ? 9
      : 11;
  results.push({ category: CATEGORY, name: "enabled-tools", status: "pass", message: `${count} tools enabled` });

  return results;
}
