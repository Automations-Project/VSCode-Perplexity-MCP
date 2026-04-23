import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";

const CONFIG_DIR = join(homedir(), ".perplexity-mcp");
const LAUNCHER_PATH = join(CONFIG_DIR, "start.mjs");
const BUNDLED_PATH_FILE = join(CONFIG_DIR, "bundled-path.json");

// Stdio launcher: multiplexes onto the shared daemon (one daemon + one
// Chromium across all configured stdio clients). Respect
// PERPLEXITY_NO_DAEMON=1 to bypass the daemon and run an in-process stdio
// server instead (same contract as cli.js, Task 8.3.2).
const LAUNCHER_CONTENT = `#!/usr/bin/env node
// Stable launcher -- never moves. Reads actual server path dynamically.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "bundled-path.json"), "utf8"));
const server = await import(config.serverPath);

const noDaemonRaw = (process.env.PERPLEXITY_NO_DAEMON ?? "").trim();
if (/^(1|true)$/i.test(noDaemonRaw)) {
  // Opt-out: run in-process stdio server. Warning to stderr only — stdout is
  // the JSON-RPC framing channel.
  process.stderr.write("[perplexity-mcp] PERPLEXITY_NO_DAEMON=1 set; running in-process stdio (daemon bypass)\\n");
  await server.main();
} else {
  // Default: multiplex onto the shared daemon. If the daemon is unreachable
  // attach.ts falls back to runStdioMain (the DI shim below) so the client
  // still gets a working server. The shim is mandatory because in the
  // bundled extension layout (dist/mcp/server.mjs) attach.ts's default
  // \`import("../index.js")\` resolves to a nonexistent sibling file.
  await server.attachToDaemon({
    configDir: process.env.PERPLEXITY_CONFIG_DIR,
    clientId: \`perplexity-launcher-\${process.pid}\`,
    fallbackStdio: true,
    dependencies: { runStdioMain: () => server.main() },
  });
}
`;

export function ensureLauncher(serverPath: string): { launcherPath: string; configDir: string } {
  mkdirSync(CONFIG_DIR, { recursive: true });

  const serverUrl = pathToFileURL(serverPath).href;
  writeFileSync(BUNDLED_PATH_FILE, JSON.stringify({
    serverPath: serverUrl,
    fsPath: serverPath,
    updatedAt: new Date().toISOString(),
  }, null, 2));

  // Write when the file is absent OR when its content differs. Byte-for-byte
  // comparison forces the 0.7.x in-process launcher to migrate to the
  // daemon-proxy launcher on upgrade, while avoiding unnecessary disk writes
  // (and mtime churn) when the content already matches.
  let needsWrite = true;
  if (existsSync(LAUNCHER_PATH)) {
    try {
      const current = readFileSync(LAUNCHER_PATH, "utf8");
      if (current === LAUNCHER_CONTENT) {
        needsWrite = false;
      }
    } catch {
      // Unreadable — rewrite defensively.
      needsWrite = true;
    }
  }
  if (needsWrite) {
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
