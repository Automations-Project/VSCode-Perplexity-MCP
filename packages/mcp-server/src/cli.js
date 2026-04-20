// Shebang is added by tsup banner for the built dist/cli.mjs so the bin entry
// works as a CLI. Kept out of source so vitest/esbuild can parse this file
// during tests.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    let version = "0.0.0";
    try {
      const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
      version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
    } catch {
      // fall through with default
    }
    /* v8 ignore stop */
    return { code: 0, stdout: version + "\n", stderr: "" };
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

  if (command === "list-accounts") {
    const { listProfiles, getActiveName } = await import("./profiles.js");
    const profiles = listProfiles();
    const active = getActiveName();
    const body = flags.json
      ? JSON.stringify({ ok: true, active, profiles })
      : profiles.length === 0
        ? "No profiles yet. Run `add-account` to create one."
        : profiles.map((p) => `${p.name === active ? "* " : "  "}${p.name}  [${p.tier ?? "?"}]  mode=${p.loginMode ?? "?"}  lastLogin=${p.lastLogin ?? "never"}`).join("\n");
    return { code: 0, stdout: body + "\n", stderr: "" };
  }

  if (command === "add-account") {
    const name = flags.name ?? (await import("./profiles.js")).suggestNextDefaultName();
    const mode = flags.mode ?? "manual";
    try {
      const { createProfile } = await import("./profiles.js");
      const profile = createProfile(name, { loginMode: mode });
      const body = flags.json ? JSON.stringify({ ok: true, profile }) : `Created profile '${name}'.`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { code: 1, stdout: flags.json ? JSON.stringify({ ok: false, error: msg }) + "\n" : "", stderr: msg + "\n" };
    }
  }

  if (command === "switch-account") {
    const target = parsed.positional?.[0];
    if (!target) return { code: 1, stdout: "", stderr: "switch-account requires a profile name.\n" };
    try {
      const { setActive } = await import("./profiles.js");
      setActive(target);
      const body = flags.json ? JSON.stringify({ ok: true, active: target }) : `Switched to '${target}'.`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    } catch (err) {
      return { code: 1, stdout: "", stderr: `${err.message}\n` };
    }
  }

  if (command === "logout") {
    const { softLogout, hardLogout } = await import("./logout.js");
    const name = flags.profile ?? (await import("./profiles.js")).getActiveName() ?? "default";
    if (flags.purge) await hardLogout(name); else await softLogout(name);
    const body = flags.json ? JSON.stringify({ ok: true, purged: !!flags.purge, profile: name }) : `Logged out of '${name}'.`;
    return { code: 0, stdout: body + "\n", stderr: "" };
  }

  if (command === "status") {
    const name = flags.profile ?? (await import("./profiles.js")).getActiveName() ?? "default";
    const { Vault } = await import("./vault.js");
    /* v8 ignore next -- defensive catch for unreadable vault (malformed blob, wrong key) */
    const cookies = await new Vault().get(name, "cookies").catch(() => null);
    if (!cookies) {
      const body = flags.json ? JSON.stringify({ valid: false, reason: "no_cookies", profile: name }) : `No session for '${name}'. Run login first.`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    }
    const { getProfile } = await import("./profiles.js");
    const meta = getProfile(name);
    const body = flags.json
      ? JSON.stringify({ valid: true, profile: name, tier: meta?.tier, lastLogin: meta?.lastLogin })
      : `Profile '${name}' has stored cookies. Tier=${meta?.tier ?? "?"} lastLogin=${meta?.lastLogin ?? "?"}`;
    return { code: 0, stdout: body + "\n", stderr: "" };
  }

  /* v8 ignore start -- login spawns a long-lived fork with a real browser; covered by integration suites */
  if (command === "login") {
    const { fork } = await import("node:child_process");
    const mode = flags.mode ?? "manual";
    const profile = flags.profile ?? (await import("./profiles.js")).getActiveName() ?? "default";
    const runner = fileURLToPath(new URL(
      mode === "auto" ? "./login-runner.mjs" : "./manual-login-runner.mjs",
      import.meta.url
    ));
    const env = { ...process.env, PERPLEXITY_PROFILE: profile };
    if (mode === "auto") {
      if (!flags.email) return { code: 1, stdout: "", stderr: "`--email` required for --mode auto.\n" };
      env.PERPLEXITY_EMAIL = String(flags.email);
    }
    return new Promise((resolve) => {
      const child = fork(runner, [], { env, stdio: ["inherit", "pipe", "inherit", "ipc"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); process.stderr.write(d); });
      child.on("message", async (m) => {
        if (m?.phase === "awaiting_otp") {
          const { promptSecret } = await import("./tty-prompt.js");
          const otp = await promptSecret({ prompt: "Enter OTP from your email: " });
          child.send({ otp });
        }
      });
      child.on("close", (code) => {
        const lines = out.trim().split("\n").filter(Boolean);
        const last = lines[lines.length - 1];
        resolve({ code: code ?? 0, stdout: (flags.json ? last : `login finished (${code})`) + "\n", stderr: "" });
      });
    });
  }
  /* v8 ignore stop */

  if (command === "doctor") {
    const { runAll, exitCodeFor, formatReportMarkdown } = await import("./doctor.js");
    const report = await runAll({
      profile: flags.profile,
      probe: !!flags.probe,
      allProfiles: !!flags.all,
    });
    const exit = exitCodeFor(report);
    if (flags.json) {
      return { code: exit, stdout: JSON.stringify(report) + "\n", stderr: "" };
    }
    return { code: exit, stdout: formatReportMarkdown(report) + "\n", stderr: "" };
  }

  // Phase-1 stub: all real subcommands are placeholder until their phases land.
  const msg = flags.json
    ? JSON.stringify({ ok: false, error: "not-yet-implemented", command })
    : `'${command}' is not yet implemented (arrives in Phase ${phaseFor(command)}).`;
  return { code: 0, stdout: msg + "\n", stderr: "" };
}

function phaseFor(cmd) {
  if (cmd === "install-browser") return 3;
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
