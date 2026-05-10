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
// Stable launcher — never moves. Reads actual server path dynamically.
//
// Default behavior: multiplex onto the shared daemon spawned by the VS Code
// extension. If the daemon is unreachable, FAIL LOUDLY with a structured
// stderr remediation and exit code 2 — do NOT silently fall back to an
// in-process stdio server in the client's runtime, because that path tries
// to read the vault under the client's Node, which on many setups (Claude
// Code's bundled Node, Antigravity, mismatched ABI) cannot load keytar.
//
// Exit codes:
//   0 = clean shutdown
//   1 = generic crash (Node default error handler)
//   2 = operator-actionable misconfiguration (daemon unreachable)
//
// Opt-out: set PERPLEXITY_NO_DAEMON=1 to bypass the daemon and run an
// in-process stdio server directly. ADVANCED: the vault must be unsealable
// in this client's runtime (working keychain or PERPLEXITY_VAULT_PASSPHRASE
// in this client's env block). Run \`npx perplexity-user-mcp setup-vault\`
// once if you need help. See docs/troubleshooting/external-mcp-clients.md.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "bundled-path.json"), "utf8"));
const server = await import(config.serverPath);

const noDaemonRaw = (process.env.PERPLEXITY_NO_DAEMON ?? "").trim();
if (/^(1|true)$/i.test(noDaemonRaw)) {
  // Opt-out: in-process stdio. stderr only — stdout is the JSON-RPC channel.
  process.stderr.write("[perplexity-mcp] PERPLEXITY_NO_DAEMON=1 set; running in-process stdio (advanced)\\n");
  await server.main();
} else {
  // Default: attach to the shared daemon. No silent fallback.
  try {
    await server.attachToDaemon({
      configDir: process.env.PERPLEXITY_CONFIG_DIR,
      clientId: \`perplexity-launcher-\${process.pid}\`,
      fallbackStdio: false,
    });
  } catch (err) {
    if (err && err.code === "DAEMON_UNREACHABLE") {
      process.stderr.write("Perplexity MCP: cannot reach the extension-managed daemon.\\n");
      for (const line of err.remediation ?? []) {
        process.stderr.write("  • " + line + "\\n");
      }
      if (err.cause && err.cause.message) {
        process.stderr.write("Underlying error: " + err.cause.message + "\\n");
      }
      process.exit(2);
    }
    // Anything else: let Node's default error handler fire (exit 1, stack on stderr).
    throw err;
  }
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
