// Shebang is added by tsup banner for the built dist/cli.mjs so the bin entry
// works as a CLI. Kept out of source so vitest/esbuild can parse this file
// during tests.

import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

export function parseArgs(argv) {
  if (argv.length === 0) return { command: "server", flags: {} };
  const first = argv[0];
  if (first === "--version" || first === "-v") return { command: "version", flags: {} };
  if (first === "--help" || first === "-h") return { command: "help", flags: {} };
  if (first === "daemon") {
    const subcommand = argv[1] ?? "help";
    const flags = {};
    const positional = [];
    for (let i = 2; i < argv.length; i++) {
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
    return { command: `daemon:${subcommand}`, flags, positional };
  }

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
  "export", "open", "rebuild-history-index", "sync-cloud",
  "daemon:help", "daemon:start", "daemon:stop", "daemon:status", "daemon:attach",
  "daemon:rotate-token", "daemon:install-tunnel", "daemon:enable-tunnel", "daemon:disable-tunnel",
]);

function normalizeExportFormat(value) {
  if (value === "md") return "markdown";
  if (value === "markdown" || value === "pdf" || value === "docx") return value;
  return null;
}

async function openTarget(target) {
  if (process.platform === "win32") {
    const escaped = String(target).replace(/'/g, "''");
    await execFile("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath '${escaped}'`]);
    return;
  }
  if (process.platform === "darwin") {
    await execFile("open", [String(target)]);
    return;
  }
  await execFile("xdg-open", [String(target)]);
}

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
    const { main } = await import("./index.js");
    await main();
    return { code: 0, stdout: "", stderr: "" };
  }
  /* v8 ignore stop */

  if (command === "daemon:help") {
    return { code: 0, stdout: DAEMON_HELP_TEXT, stderr: "" };
  }

  if (command === "daemon:start") {
    const port = parseOptionalPort(flags.port);
    if (flags.port !== undefined && port === null) {
      return { code: 1, stdout: "", stderr: "daemon start requires --port to be a positive integer.\n" };
    }
    const { startDaemon } = await import("./daemon/launcher.js");
    const daemon = await startDaemon({
      configDir: process.env.PERPLEXITY_CONFIG_DIR,
      port: port ?? undefined,
      tunnel: !!flags.tunnel,
    });
    if (daemon.attached) {
      const body = flags.json
        ? JSON.stringify({ ok: true, attached: true, ...serializeDaemonConnection(daemon) })
        : `Attached to daemon pid=${daemon.pid} port=${daemon.port}`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    }

    await daemon.closed;
    return { code: 0, stdout: "", stderr: "" };
  }

  if (command === "daemon:status") {
    const { getDaemonStatus } = await import("./daemon/launcher.js");
    const status = await getDaemonStatus({
      configDir: process.env.PERPLEXITY_CONFIG_DIR,
      reclaimStale: true,
    });
    const body = flags.json
      ? JSON.stringify(serializeDaemonStatus(status))
      : formatDaemonStatus(status);
    return { code: 0, stdout: body + "\n", stderr: "" };
  }

  if (command === "daemon:stop") {
    const { stopDaemon } = await import("./daemon/launcher.js");
    const result = await stopDaemon({ configDir: process.env.PERPLEXITY_CONFIG_DIR });
    const body = flags.json
      ? JSON.stringify({ ok: true, ...result })
      : result.stopped
        ? `Stopped daemon pid=${result.pid ?? "unknown"}.`
        : "Daemon is not running.";
    return { code: 0, stdout: body + "\n", stderr: "" };
  }

  if (command === "daemon:rotate-token") {
    try {
      const { rotateDaemonToken } = await import("./daemon/launcher.js");
      const daemon = await rotateDaemonToken({ configDir: process.env.PERPLEXITY_CONFIG_DIR });
      const body = flags.json
        ? JSON.stringify({ ok: true, ...serializeDaemonConnection(daemon) })
        : `Rotated daemon token for pid=${daemon.pid} port=${daemon.port}.`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { code: 1, stdout: "", stderr: message + "\n" };
    }
  }

  if (command === "daemon:attach") {
    const { attachToDaemon } = await import("./daemon/attach.js");
    await attachToDaemon({
      configDir: process.env.PERPLEXITY_CONFIG_DIR,
      clientId: "daemon-attach-cli",
    });
    return { code: 0, stdout: "", stderr: "" };
  }

  if (
    command === "daemon:install-tunnel"
    || command === "daemon:enable-tunnel"
    || command === "daemon:disable-tunnel"
  ) {
    const message = flags.json
      ? JSON.stringify({ ok: false, error: "not-yet-implemented", command })
      : `'${command.replace("daemon:", "daemon ")}' is not yet implemented (arrives in Task 4).`;
    return { code: 0, stdout: message + "\n", stderr: "" };
  }

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

  if (command === "export") {
    const historyId = parsed.positional?.[0];
    if (!historyId) return { code: 1, stdout: "", stderr: "export requires a history id.\n" };

    const format = normalizeExportFormat(flags.format);
    if (!format) return { code: 1, stdout: "", stderr: "export requires --format pdf|md|markdown|docx.\n" };

    const { get } = await import("./history-store.js");
    const entry = get(historyId);
    if (!entry) return { code: 1, stdout: "", stderr: `History entry '${historyId}' not found.\n` };

    if (format === "markdown") {
      const targetPath = flags.out ? String(flags.out) : join(entry.attachmentsDir, entry.mdPath.split(/[\\/]/).pop() || `${entry.id}.md`);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, readFileSync(entry.mdPath, "utf8"), "utf8");
      const body = flags.json
        ? JSON.stringify({ ok: true, format, savedPath: targetPath, historyId })
        : `Saved markdown export to ${targetPath}`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    }

    if (!entry.threadSlug) {
      return { code: 1, stdout: "", stderr: "This entry cannot be exported natively because it has no Perplexity thread slug.\n" };
    }

    const { PerplexityClient } = await import("./client.js");
    const client = new PerplexityClient();
    try {
      await client.init();
      const exported = await client.exportThread({ threadSlug: entry.threadSlug, format });
      const targetPath = flags.out ? String(flags.out) : join(entry.attachmentsDir, exported.filename);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, exported.buffer);
      const body = flags.json
        ? JSON.stringify({ ok: true, format, savedPath: targetPath, bytes: exported.buffer.length, contentType: exported.contentType, historyId })
        : `Saved ${format} export to ${targetPath}`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  if (command === "sync-cloud") {
    const previousProfile = process.env.PERPLEXITY_PROFILE;
    try {
      if (flags.profile) process.env.PERPLEXITY_PROFILE = String(flags.profile);
      const { syncCloudHistory } = await import("./cloud-sync.js");
      const pageSize = flags["page-size"] !== undefined ? Number(flags["page-size"]) : undefined;
      const lines = [];
      const result = await syncCloudHistory({
        pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : undefined,
        onProgress: (evt) => {
          if (flags.verbose) lines.push(`[sync] ${evt.phase} fetched=${evt.fetched ?? 0} inserted=${evt.inserted ?? 0} updated=${evt.updated ?? 0} skipped=${evt.skipped ?? 0}`);
        },
      });
      const body = flags.json
        ? JSON.stringify(result)
        : `Cloud sync: fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`;
      return { code: 0, stdout: body + "\n", stderr: flags.verbose ? lines.join("\n") + "\n" : "" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { code: 10, stdout: "", stderr: `Cloud sync failed: ${message}\n` };
    } finally {
      if (flags.profile === undefined && previousProfile !== undefined) {
        process.env.PERPLEXITY_PROFILE = previousProfile;
      } else if (previousProfile === undefined) {
        delete process.env.PERPLEXITY_PROFILE;
      } else {
        process.env.PERPLEXITY_PROFILE = previousProfile;
      }
    }
  }

  if (command === "rebuild-history-index") {
    const previousProfile = process.env.PERPLEXITY_PROFILE;
    try {
      if (flags.profile) {
        process.env.PERPLEXITY_PROFILE = String(flags.profile);
      }
      const { rebuildIndex } = await import("./history-store.js");
      const result = rebuildIndex();
      const body = flags.json
        ? JSON.stringify(result)
        : `Rebuilt history index: scanned=${result.scanned} recovered=${result.recovered} skipped=${result.skipped}`;
      return { code: 0, stdout: body + "\n", stderr: "" };
    } finally {
      if (flags.profile === undefined && previousProfile !== undefined) {
        process.env.PERPLEXITY_PROFILE = previousProfile;
      } else if (previousProfile === undefined) {
        delete process.env.PERPLEXITY_PROFILE;
      } else {
        process.env.PERPLEXITY_PROFILE = previousProfile;
      }
    }
  }

  if (command === "open") {
    const historyId = parsed.positional?.[0];
    if (!historyId) return { code: 1, stdout: "", stderr: "open requires a history id.\n" };

    const { get } = await import("./history-store.js");
    const entry = get(historyId);
    if (!entry) return { code: 1, stdout: "", stderr: `History entry '${historyId}' not found.\n` };

    const viewerId = String(flags.viewer ?? "system");
    let target = entry.mdPath;

    if (viewerId !== "system") {
      const { buildViewerUrl, listViewers } = await import("./viewers.js");
      const viewer = listViewers().find((item) => item.id === viewerId);
      if (!viewer) {
        return { code: 1, stdout: "", stderr: `Unknown viewer '${viewerId}'.\n` };
      }
      target = buildViewerUrl({ viewer, mdPath: entry.mdPath });
    }

    await openTarget(target);
    const body = flags.json
      ? JSON.stringify({ ok: true, viewer: viewerId, target, historyId })
      : `Opened ${historyId} via ${viewerId}: ${target}`;
    return { code: 0, stdout: body + "\n", stderr: "" };
  }

  // Phase-1 stub: all real subcommands are placeholder until their phases land.
  const msg = flags.json
    ? JSON.stringify({ ok: false, error: "not-yet-implemented", command })
    : `'${command}' is not yet implemented (arrives in Phase ${phaseFor(command)}).`;
  return { code: 0, stdout: msg + "\n", stderr: "" };
}

function phaseFor(cmd) {
  if (cmd === "install-browser") return 3;
  if (cmd === "export" || cmd === "open" || cmd === "rebuild-history-index" || cmd === "sync-cloud") return 4;
  /* v8 ignore next -- fallback for unmapped commands that shouldn't exist */
  return "?";
}

function parseOptionalPort(value) {
  if (value === undefined || value === true) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function formatDaemonStatus(status) {
  if (!status.running || !status.record) {
    return "Daemon is not running.";
  }

  if (!status.healthy || !status.health) {
    return `Daemon lock exists for pid=${status.record.pid}, but the health probe is not ready.`;
  }

  const tunnelUrl = status.health.tunnel?.url ?? status.record.tunnelUrl ?? null;
  const parts = [
    `Daemon running pid=${status.record.pid} port=${status.record.port}`,
    `uptime=${formatDuration(status.health.uptimeMs)}`,
  ];
  if (tunnelUrl) {
    parts.push(`tunnel=${tunnelUrl}`);
  }
  return parts.join(" ");
}

function serializeDaemonStatus(status) {
  return {
    running: status.running,
    healthy: status.healthy,
    stale: status.stale,
    pid: status.record?.pid ?? null,
    uuid: status.record?.uuid ?? null,
    port: status.record?.port ?? null,
    version: status.record?.version ?? null,
    startedAt: status.record?.startedAt ?? null,
    tunnelUrl: status.health?.tunnel?.url ?? status.record?.tunnelUrl ?? null,
  };
}

function serializeDaemonConnection(daemon) {
  return {
    pid: daemon.pid,
    uuid: daemon.uuid,
    port: daemon.port,
    url: daemon.url,
    version: daemon.version,
    startedAt: daemon.startedAt,
    tunnelUrl: daemon.tunnelUrl ?? null,
  };
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

const HELP_TEXT = `perplexity-user-mcp

Usage:
  npx perplexity-user-mcp                      Start MCP stdio server
  npx perplexity-user-mcp daemon start [--port N] [--tunnel]
  npx perplexity-user-mcp daemon stop
  npx perplexity-user-mcp daemon status [--json]
  npx perplexity-user-mcp daemon attach
  npx perplexity-user-mcp daemon rotate-token
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
  npx perplexity-user-mcp sync-cloud [--profile X] [--page-size N] [--verbose]
  npx perplexity-user-mcp --version
  npx perplexity-user-mcp --help

Environment:
  PERPLEXITY_CONFIG_DIR         Override config dir (default: ~/.perplexity-mcp)
  PERPLEXITY_VAULT_PASSPHRASE   Env-var master-key fallback for headless Linux
  PERPLEXITY_MCP_STDIO=1        Forces stdio-server mode (no prompts)
`;

const DAEMON_HELP_TEXT = `perplexity-user-mcp daemon

Usage:
  npx perplexity-user-mcp daemon start [--port N] [--tunnel]
  npx perplexity-user-mcp daemon stop
  npx perplexity-user-mcp daemon status [--json]
  npx perplexity-user-mcp daemon attach
  npx perplexity-user-mcp daemon rotate-token
  npx perplexity-user-mcp daemon install-tunnel
  npx perplexity-user-mcp daemon enable-tunnel
  npx perplexity-user-mcp daemon disable-tunnel
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
