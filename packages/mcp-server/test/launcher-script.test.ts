import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Synthesize the launcher's runtime contract and run it as a sub-process.
 * The stub server.mjs throws a DaemonAttachError shape; we assert the
 * launcher catches it, writes the bullet remediation to stderr, exits 2,
 * and leaves stdout untouched.
 */
function buildFakeWorkspace(): { launcherPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "perp-launcher-"));
  const serverPath = join(dir, "server.mjs");
  writeFileSync(
    serverPath,
    `
export class DaemonAttachError extends Error {
  constructor(message, remediation, cause) {
    super(message);
    this.name = "DaemonAttachError";
    this.code = "DAEMON_UNREACHABLE";
    this.remediation = remediation;
    if (cause !== undefined) this.cause = cause;
  }
}
export async function attachToDaemon() {
  throw new DaemonAttachError("nope", [
    "Reload the VS Code window so the extension restarts the daemon.",
    "In the VS Code Perplexity dashboard, switch this client's transport to http-loopback.",
    "(Advanced) Set PERPLEXITY_NO_DAEMON=1 in this client's MCP env block, then run \\\`npx perplexity-user-mcp setup-vault\\\` once.",
  ], new Error("ECONNREFUSED 127.0.0.1:9999"));
}
export async function main() { /* would run in-process stdio if PERPLEXITY_NO_DAEMON=1 */ }
`,
    "utf8",
  );
  writeFileSync(
    join(dir, "bundled-path.json"),
    JSON.stringify({ serverPath: pathToFileURL(serverPath).href }),
    "utf8",
  );

  // Synthesize the launcher script — a copy of LAUNCHER_CONTENT from
  // packages/extension/src/launcher/write-launcher.ts. KEEP IN SYNC:
  // if this test starts failing because the launcher template diverged,
  // copy the latest LAUNCHER_CONTENT here verbatim.
  const launcherPath = join(dir, "start.mjs");
  writeFileSync(
    launcherPath,
    `
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "bundled-path.json"), "utf8"));
const server = await import(config.serverPath);
const noDaemonRaw = (process.env.PERPLEXITY_NO_DAEMON ?? "").trim();
if (/^(1|true)$/i.test(noDaemonRaw)) {
  process.stderr.write("[perplexity-mcp] PERPLEXITY_NO_DAEMON=1 set; running in-process stdio (advanced)\\n");
  await server.main();
} else {
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
    throw err;
  }
}
`,
    "utf8",
  );

  return { launcherPath };
}

function runLauncher(launcherPath: string, env: Record<string, string> = {}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcherPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("generated launcher script — refuses silent fallback", () => {
  it("exits 2 with structured stderr when daemon is unreachable", async () => {
    const { launcherPath } = buildFakeWorkspace();
    const result = await runLauncher(launcherPath);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/cannot reach the extension-managed daemon/);
    expect(result.stderr).toMatch(/Reload the VS Code window/);
    expect(result.stderr).toMatch(/http-loopback/);
    expect(result.stderr).toMatch(/PERPLEXITY_NO_DAEMON=1/);
    expect(result.stderr).toMatch(/Underlying error: ECONNREFUSED/);
  });
});
