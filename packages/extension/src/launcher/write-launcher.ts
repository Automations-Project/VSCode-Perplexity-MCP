import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";

const CONFIG_DIR = join(homedir(), ".perplexity-mcp");
const LAUNCHER_PATH = join(CONFIG_DIR, "start.mjs");
const BUNDLED_PATH_FILE = join(CONFIG_DIR, "bundled-path.json");

const LAUNCHER_CONTENT = `#!/usr/bin/env node
// Stable launcher -- never moves. Reads actual server path dynamically.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "bundled-path.json"), "utf8"));
await import(config.serverPath);
`;

export function ensureLauncher(serverPath: string): { launcherPath: string; configDir: string } {
  mkdirSync(CONFIG_DIR, { recursive: true });

  const serverUrl = pathToFileURL(serverPath).href;
  writeFileSync(BUNDLED_PATH_FILE, JSON.stringify({
    serverPath: serverUrl,
    fsPath: serverPath,
    updatedAt: new Date().toISOString(),
  }, null, 2));

  if (!existsSync(LAUNCHER_PATH)) {
    writeFileSync(LAUNCHER_PATH, LAUNCHER_CONTENT, { mode: 0o755 });
  }

  return { launcherPath: LAUNCHER_PATH, configDir: CONFIG_DIR };
}

export function checkLauncherHealth(configuredArgs: string[]): "configured" | "stale" {
  if (!configuredArgs.length) return "stale";
  const serverRef = configuredArgs[0];
  if (serverRef === LAUNCHER_PATH) return "configured";
  if (existsSync(serverRef)) return "configured";
  return "stale";
}

export { LAUNCHER_PATH, CONFIG_DIR as LAUNCHER_CONFIG_DIR };
