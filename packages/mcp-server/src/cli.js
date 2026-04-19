#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  if (argv.length === 0) return { command: "server", flags: {} };
  const first = argv[0];
  if (first === "--version" || first === "-v") return { command: "version", flags: {} };
  if (first === "--help" || first === "-h") return { command: "help", flags: {} };

  const command = first;
  const flags = {};
  let positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, flags, positional };
}

const KNOWN_COMMANDS = new Set([
  "server", "version", "help",
  "login", "logout", "status", "doctor", "install-browser",
  "add-account", "switch-account", "list-accounts",
  "export", "open", "rebuild-history-index",
]);

export async function routeCommand(parsed) {
  const { command, flags } = parsed;
  if (!KNOWN_COMMANDS.has(command)) {
    return { code: 1, stdout: "", stderr: `Unknown command: ${command}\nRun --help for usage.` };
  }
  if (command === "version") {
    /* v8 ignore start -- catch fallback fires only if package.json is missing at runtime */
    const pkg = await import("../package.json", { with: { type: "json" } })
      .catch(() => ({ default: { version: "0.0.0" } }));
    /* v8 ignore stop */
    return { code: 0, stdout: (pkg.default?.version ?? "0.0.0") + "\n", stderr: "" };
  }
  if (command === "help") {
    return { code: 0, stdout: HELP_TEXT, stderr: "" };
  }
  /* v8 ignore start -- starting the real MCP server is impractical in unit tests */
  if (command === "server") {
    // Start the MCP stdio server. Delegates to index.js's existing main().
    await import("./index.js");
    return { code: 0, stdout: "", stderr: "" };
  }
  /* v8 ignore stop */
  // Phase-1 stub: all real subcommands are placeholder until their phases land.
  const msg = flags.json
    ? JSON.stringify({ ok: false, error: "not-yet-implemented", command })
    : `'${command}' is not yet implemented (arrives in Phase ${phaseFor(command)}).`;
  return { code: 0, stdout: msg + "\n", stderr: "" };
}

function phaseFor(cmd) {
  if (["login", "logout", "status", "add-account", "switch-account", "list-accounts"].includes(cmd)) return 2;
  if (cmd === "doctor" || cmd === "install-browser") return 3;
  if (cmd === "export" || cmd === "open" || cmd === "rebuild-history-index") return 4;
  /* v8 ignore next -- fallback for unmapped commands that shouldn't exist */
  return "?";
}

const HELP_TEXT = `perplexity-user-mcp

Usage:
  npx perplexity-user-mcp                      Start MCP stdio server
  npx perplexity-user-mcp login [--profile X] [--mode auto|manual] [--plain-cookies]
  npx perplexity-user-mcp logout [--profile X] [--purge]
  npx perplexity-user-mcp status [--profile X] [--all]
  npx perplexity-user-mcp doctor [--profile X] [--probe] [--all] [--report]
  npx perplexity-user-mcp install-browser
  npx perplexity-user-mcp add-account [--name X] [--email Y] [--mode auto|manual] [--plain-cookies]
  npx perplexity-user-mcp switch-account <name>
  npx perplexity-user-mcp list-accounts
  npx perplexity-user-mcp export <id> --format pdf|md|docx [--out path]
  npx perplexity-user-mcp open <id> [--viewer obsidian|typora|logseq|system]
  npx perplexity-user-mcp rebuild-history-index [--profile X]
  npx perplexity-user-mcp --version
  npx perplexity-user-mcp --help

Phase-1 release: dispatcher + vault + profiles only. Subcommands land in
Phases 2-4.

Environment:
  PERPLEXITY_CONFIG_DIR         Override config dir (default: ~/.perplexity-mcp)
  PERPLEXITY_VAULT_PASSPHRASE   Env-var master-key fallback for headless Linux
  PERPLEXITY_MCP_STDIO=1        Forces stdio-server mode (no prompts)
`;

/* v8 ignore start -- only runs when cli.js is executed as a script */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseArgs(process.argv.slice(2));
  routeCommand(parsed).then((res) => {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.code);
  });
}
/* v8 ignore stop */
