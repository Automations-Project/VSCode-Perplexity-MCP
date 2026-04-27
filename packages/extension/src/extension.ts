import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { MCP_PROVIDER_ID, MCP_SERVER_LABEL, type ExportFormat, type IdeTarget, type McpTransportId } from "@perplexity-user-mcp/shared";
import { getActiveName, getProfile, listProfiles, setActive, createProfile } from "perplexity-user-mcp/profiles";
import { createExtensionAwareRunDoctor } from "./diagnostics/doctor-runner.js";
import { peekStoredVaultPassphrase } from "./auth/vault-passphrase.js";
import { redactMessage } from "./redact.js";
import { OutputRingBuffer } from "./diagnostics/output-buffer.js";
import { captureDiagnostics } from "./diagnostics/capture.js";
import { runDiagnosticsCaptureFlow } from "./diagnostics/flow.js";
import { applyIdeConfig, configureTargets, getIdeStatuses, resolveNodePath, type ApplyIdeConfigDeps } from "./auto-config/index.js";
import { wrapDepsForAutoRegen } from "./webview/staleness-auto-regen.js";
import { spawnSync } from "node:child_process";
import { hasStoredLogin } from "./auth/session.js";
import { ensureVaultPassphrase } from "./auth/vault-passphrase.js";
import { getSettingsSnapshot } from "./settings.js";
import { DashboardProvider } from "./webview/DashboardProvider.js";
import { migrateEnableTunnelsOnce } from "./webview/tunnel-settings-migration.js";
import { ensureLauncher } from "./launcher/write-launcher.js";
import {
  configureDaemonRuntime,
  disableBundledDaemonTunnel,
  ensureBundledDaemon,
  getBundledActiveTunnelProvider,
  getBundledDaemonConfigDir,
  getBundledDaemonStatus,
  getBundledNgrokSettings,
  rotateBundledDaemonToken,
} from "./daemon/runtime.js";
import { listHistoryEntries, rebuildHistoryEntries, runCloudSync, runExport } from "./history/open-handlers.js";

let outputChannel: vscode.OutputChannel;
let debugEnabled = false;
// Mirror of `outputChannel` content so diagnostics capture can read back the
// last ~5000 lines (VS Code does not expose a read API for OutputChannel).
// Initialised in activate(); `?.` guards in log()/debug() make pre-activation
// calls no-op-safe.
let outputBuffer: OutputRingBuffer | undefined;

export function getOutputRingBuffer(): OutputRingBuffer | undefined {
  return outputBuffer;
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${redactMessage(message)}`;
  outputChannel?.appendLine(line);
  outputBuffer?.append(line);
}

export function debug(message: string): void {
  if (debugEnabled) {
    const line = `[${new Date().toISOString()}] [DEBUG] ${redactMessage(message)}`;
    outputChannel?.appendLine(line);
    outputBuffer?.append(line);
  }
}

function createStdioDefinition(
  label: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  version: string
): unknown {
  const ctor = (vscode as unknown as { McpStdioServerDefinition?: new (...args: unknown[]) => unknown })
    .McpStdioServerDefinition;

  if (!ctor) {
    throw new Error("VS Code does not expose McpStdioServerDefinition in this build.");
  }

  // VSCode 1.109 uses positional args; future versions may accept an options object
  try {
    return new ctor(label, command, args, env, version);
  } catch {
    return new ctor({ label, command, args, env, version });
  }
}

function createHttpDefinition(
  label: string,
  uri: vscode.Uri,
  headers: Record<string, string>,
  version: string
): unknown {
  const ctor = (vscode as unknown as { McpHttpServerDefinition?: new (...args: unknown[]) => unknown })
    .McpHttpServerDefinition;

  if (!ctor) {
    throw new Error("VS Code does not expose McpHttpServerDefinition in this build.");
  }

  try {
    return new ctor(label, uri, headers, version);
  } catch {
    return new ctor({ label, uri, headers, version });
  }
}

function getBundledServerPath(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.extensionUri, "dist", "mcp", "server.mjs").fsPath;
}

function getServerEnvironment(settings: ReturnType<typeof getSettingsSnapshot>, configDir: string): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
    PERPLEXITY_CONFIG_DIR: configDir,
    PERPLEXITY_HEADLESS_ONLY: "1"
  };

  if (settings.chromePath) {
    env.PERPLEXITY_CHROME_PATH = settings.chromePath;
  }

  if (settings.defaultSearchModel) {
    env.PERPLEXITY_SEARCH_MODEL = settings.defaultSearchModel;
  }

  if (settings.reasonModel) {
    env.PERPLEXITY_REASON_MODEL = settings.reasonModel;
  }

  if (settings.researchModel) {
    env.PERPLEXITY_RESEARCH_MODEL = settings.researchModel;
  }

  if (settings.computeModel) {
    env.PERPLEXITY_COMPUTE_MODEL = settings.computeModel;
  }

  if (settings.debugMode) {
    env.PERPLEXITY_DEBUG = "1";
  }

  if (settings.debugVerboseHttp) {
    env.PERPLEXITY_DEBUG_VERBOSE = "1";
  }

  return env;
}

const TRANSPORT_CONFIRM_STATE_KEY = "mcpTransportConfirmed";
// Per-session "we already nudged you about port pinning" guard. Reset on each
// extension activation — the idea is one nudge per user-visible session, not
// one nudge forever (users may decide to pin after ignoring the first prompt).
let portPinNudgedThisSession = false;

/**
 * Build deps with an async-sourced live daemon snapshot. `getDaemonPort` and
 * `getActiveTunnel` must return synchronously (builders don't await), so the
 * caller awaits the daemon status once, then closes over it. This is the sole
 * ApplyIdeConfigDeps factory — the previous two-tier (base + Live) split left
 * `getDaemonPort` returning `null` in the base, which would silently fail the
 * stability gate for any caller that forgot to use the Live variant. Single
 * factory keeps that footgun out of the codebase.
 */
async function buildApplyIdeConfigDepsLive(
  context: vscode.ExtensionContext
): Promise<ApplyIdeConfigDeps> {
  const settings = getSettingsSnapshot();

  let daemonPort: number | null = null;
  let activeTunnel: {
    providerId: "cf-quick" | "ngrok" | "cf-named";
    url: string;
    reservedDomain: boolean;
  } | null = null;

  try {
    const status = await getBundledDaemonStatus();
    daemonPort = status.health?.port ?? status.record?.port ?? null;
    const tunnelUrl = status.health?.tunnel?.url ?? status.record?.tunnelUrl ?? null;
    const tunnelStatus = status.health?.tunnel?.status ?? null;
    if (tunnelUrl && tunnelStatus === "enabled") {
      const providerId = getBundledActiveTunnelProvider();
      const ngrok = getBundledNgrokSettings();
      const reservedDomain = providerId === "ngrok" && Boolean(ngrok.domain);
      activeTunnel = {
        providerId,
        url: tunnelUrl,
        reservedDomain,
      };
    }
  } catch {
    // Leave port/tunnel at null — builders will throw StabilityGateError on
    // the relevant transports, which applyIdeConfig maps to "tunnel-unstable".
  }

  // Resolve the local-token issuer up front. `perplexity-user-mcp/daemon`
  // is import-only; doing the dynamic import at deps-build time lets the
  // returned synchronous closure satisfy the builder's sync contract.
  let issueLocalTokenFn:
    | ((input: { ideTag: string; label: string }) => { token: string; metadata: { id: string } })
    | null = null;
  try {
    const mod = (await import("perplexity-user-mcp/daemon")) as unknown as {
      issueLocalToken?: (args: { ideTag: string; label: string }) => {
        token: string;
        metadata: { id: string };
      };
    };
    if (typeof mod.issueLocalToken === "function") {
      issueLocalTokenFn = mod.issueLocalToken;
    }
  } catch (err) {
    // Local tokens are only needed for the http-loopback bearer fallback
    // branch, which no current IDE capability flag enables. A missing helper
    // is fine until 8.6.5 lights up that path on a smoke-verified IDE.
    debug(`issueLocalToken dynamic import skipped: ${(err as Error).message}`);
  }

  const deps: ApplyIdeConfigDeps = {
    confirmTransport: async ({ ideTag, transportId, configPath }) => {
      const stored = context.workspaceState.get<Record<string, boolean>>(
        TRANSPORT_CONFIRM_STATE_KEY,
        {}
      );
      const pairKey = `${ideTag}:${transportId}`;
      if (stored[pairKey]) return true;

      const choice = await vscode.window.showWarningMessage(
        `Configure ${ideTag} to use the "${transportId}" MCP transport?`,
        {
          modal: true,
          detail: `Config file: ${configPath}`,
        },
        "Configure",
        "Cancel"
      );
      if (choice !== "Configure") return false;

      const next = { ...stored, [pairKey]: true };
      await context.workspaceState.update(TRANSPORT_CONFIRM_STATE_KEY, next);
      return true;
    },

    warnSyncFolder: async ({ configPath, matchedPattern }) => {
      const choice = await vscode.window.showWarningMessage(
        `Perplexity config path appears to be in a sync folder (${matchedPattern}).`,
        {
          modal: true,
          detail:
            `Writing a secret here will propagate to every device on the sync account. ` +
            `Path: ${configPath}`,
        },
        "Override at my own risk",
        "Cancel"
      );
      return choice === "Override at my own risk" ? "override" : "cancel";
    },

    nudgePortPin: ({ ideTag }) => {
      if (portPinNudgedThisSession) return;
      portPinNudgedThisSession = true;
      void vscode.window
        .showInformationMessage(
          `http-loopback configs embed the port; this config for ${ideTag} will break when the daemon restarts on a new port. Pin Perplexity.daemonPort?`,
          "Pin a port now"
        )
        .then((choice) => {
          if (choice !== "Pin a port now") return;
          void vscode.workspace
            .getConfiguration("Perplexity")
            .update("daemonPort", 49217, vscode.ConfigurationTarget.Global);
        });
    },

    auditGenerated: (entry) => {
      log(
        `[auto-config:audit] ide=${entry.ideTag} transport=${entry.transportId} ` +
          `bearer=${entry.bearerKind} result=${entry.resultCode} path=${entry.configPath}`
      );
    },

    getDaemonPort: () => daemonPort,
    getActiveTunnel: () => activeTunnel,

    // v0.8.4 — http-loopback static-bearer baseline. Reads the bundled daemon's
    // shared bearer token from the live status. Loopback-only use; builders for
    // tunnel transports never receive this value.
    getDaemonBearer: async () => {
      const status = await getBundledDaemonStatus();
      return status.record?.bearerToken ?? null;
    },

    syncFolderPatterns: settings.syncFolderPatterns,

    homeDir: () => os.homedir(),

    isGitTracked: (dir: string) => {
      try {
        const result = spawnSync(
          "git",
          ["-C", dir, "rev-parse", "--show-toplevel"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 500,
            windowsHide: true,
          }
        );
        return (
          result.status === 0 &&
          typeof result.stdout === "string" &&
          result.stdout.trim().length > 0
        );
      } catch {
        return false;
      }
    },

    ...(issueLocalTokenFn ? { issueLocalToken: issueLocalTokenFn } : {}),
  };

  return deps;
}

async function maybePromptAutoConfiguration(
  context: vscode.ExtensionContext,
  dashboard: DashboardProvider,
  launcherPath: string
): Promise<void> {
  const settings = getSettingsSnapshot();
  const statuses = getIdeStatuses(launcherPath, settings.chromePath);
  const missing: string[] = [];

  const autoChecks: Array<{ key: string; setting: boolean; label: string }> = [
    { key: "cursor", setting: settings.autoConfigureCursor, label: "Cursor" },
    { key: "windsurf", setting: settings.autoConfigureWindsurf, label: "Windsurf" },
    { key: "windsurfNext", setting: settings.autoConfigureWindsurfNext, label: "Windsurf Next" },
    { key: "claudeDesktop", setting: settings.autoConfigureClaudeDesktop, label: "Claude Desktop" },
    { key: "claudeCode", setting: settings.autoConfigureClaudeCode, label: "Claude Code" },
    { key: "cline", setting: settings.autoConfigureCline, label: "Cline" },
    { key: "amp", setting: settings.autoConfigureAmp, label: "Amp" },
    { key: "codexCli", setting: settings.autoConfigureCodexCli, label: "Codex CLI" },
  ];

  for (const { key, setting, label } of autoChecks) {
    const s = statuses[key];
    if (setting && s?.detected && !s.configured) {
      missing.push(label);
    }
  }

  if (missing.length === 0) {
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    `Perplexity MCP can configure ${missing.join(", ")} automatically.`,
    "Configure",
    "Later"
  );

  if (answer !== "Configure") {
    return;
  }

  const deps = await buildApplyIdeConfigDepsLive(context);
  const outcome = await configureTargets("all", launcherPath, settings.chromePath, {
    transportByIde: settings.mcpTransportByIde as Partial<Record<IdeTarget, McpTransportId>>,
    deps,
  });
  for (const { target, result } of outcome.results) {
    if (!result.ok) {
      log(`[auto-config] ${target}: ${result.reason} — ${result.message}`);
    }
  }
  await dashboard.refresh();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Perplexity Internal MCP");
  outputBuffer = new OutputRingBuffer(5000);
  context.subscriptions.push(outputChannel);
  // v0.8.5: one-time migration. Users with a pre-existing tunnel-settings.json
  // opted in by configuring a provider in a prior release; flip enableTunnels
  // on for them so the loopback-default posture doesn't hide UI they were
  // already using. Runs before any getSettingsSnapshot() call so the first
  // read reflects the migrated value.
  const migrationConfigDir =
    process.env.PERPLEXITY_CONFIG_DIR ?? path.join(os.homedir(), ".perplexity-mcp");
  try {
    await migrateEnableTunnelsOnce(context, { configDir: migrationConfigDir });
  } catch (err) {
    // Migration failure is non-fatal: user keeps loopback-default posture
    // and can flip the setting manually from the dashboard.
    outputChannel.appendLine(
      `[enableTunnels-migration] skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const settings = getSettingsSnapshot();
  debugEnabled = settings.debugMode;
  log("Activating extension...");
  log(`Extension URI: ${context.extensionUri.toString()}`);
  if (debugEnabled) {
    log("Debug mode is ON — verbose logging enabled.");
    debug(`Settings snapshot: ${JSON.stringify(settings, null, 2)}`);
  }

  try {
    return await activateInner(context);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    log(`FATAL activation error: ${msg}`);
    outputChannel.show(true);
    void vscode.window.showErrorMessage(`Perplexity extension failed to activate: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function activateInner(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettingsSnapshot();
  const MANUAL_LOGIN_NOTICE = "Manual login opened in Chrome. Finish sign-in there; if it is behind other windows, bring Chrome to the front.";

  const dashboard = new DashboardProvider(context);
  const { AuthManager } = await import("./mcp/auth-manager.js");
  const authManager = new AuthManager({ extensionUri: context.extensionUri });
  // v0.8.6: surface login-runner diagnostics (reason + error + detail) into
  // the Perplexity output channel. Previously only the reason enum was logged,
  // which hid the real error ("Vault locked: ...") on headless Linux.
  authManager.setLogger((line) => log(line));

  // Attach the browser-download manager so the user can pull patchright's
  // bundled Chromium when no system browser is installed. Optional — the
  // extension works unchanged when nothing is attached.
  //
  // (v0.8.5 also briefly attached an ObscuraManager for the h4ckf0r0day/obscura
  // CDP server; removed because Obscura's CDP implementation lacked the
  // Target.createTarget / frame-attachment domains Patchright requires.)
  const { BrowserDownloadManager } = await import("./browser/browser-download.js");
  const browserDownloadManager = new BrowserDownloadManager(context, context.extensionPath);
  context.subscriptions.push(browserDownloadManager);
  authManager.attachDownloadManager(browserDownloadManager);
  // Replay the persisted browserChoice from VS Code settings BEFORE the
  // initial probe so the user's last selection is honored across restarts.
  // Reading from `settings` (already loaded above) avoids a second configuration
  // read and keeps the flow: settings → AuthManager state → re-probe.
  let persistedBrowserChoice = settings.browserChoice;
  // v0.8.5 cleanup: users who experimented with the (removed) Obscura channel
  // would have `browserChoice.channel === "obscura"` saved in their settings.
  // Silently downgrade to mode:"auto" so they don't boot into a no-op state
  // where every login routes through a fallback. Persist the rewrite back
  // so the bad value is gone for good.
  if ((persistedBrowserChoice as { channel?: string } | undefined)?.channel === "obscura") {
    log("[browser] migrating stale browserChoice=obscura → auto (Obscura support removed)");
    persistedBrowserChoice = { mode: "auto" };
    // VS Code returns Thenable, not Promise — wrap so we can swallow rejections
    // when the user has no Global-scope setting to clear.
    Promise.resolve(
      vscode.workspace
        .getConfiguration("Perplexity")
        .update("browserChoice", undefined, vscode.ConfigurationTarget.Global),
    ).catch(() => { /* nothing to clear */ });
  }
  if (persistedBrowserChoice) {
    authManager.setBrowserChoice(persistedBrowserChoice);
  }
  // Seed the initial browser probe so availableBrowsers is populated before
  // the webview mounts — otherwise the dashboard shows "no browser" for a
  // split second until the first health-check fires. This is idempotent when
  // setBrowserChoice already fired a refresh above.
  authManager.refreshBrowserDetection();

  context.subscriptions.push(authManager);
  dashboard.setAuthManager(authManager);
  authManager.onDidChange(async (s) => { await dashboard.postAuthState(s); });
  const serverDefinitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(serverDefinitionsChanged);
  dashboard.setOnMcpServerDefinitionsChanged(() => { serverDefinitionsChanged.fire(); });

  // v0.8.5: wire the auto-regen helper so postStaleness can refresh any
  // drifted IDE configs without routing through the "Regenerate all" button.
  // confirmTransport-always-true + nudgePortPin-noop are centralized in the
  // wrapDepsForAutoRegen helper so tests can assert the override invariants.
  dashboard.setAutoRegenDeps({
    buildDeps: async () => {
      const liveDeps = await buildApplyIdeConfigDepsLive(context);
      return wrapDepsForAutoRegen(liveDeps, (line) => log(line));
    },
    applyIdeConfig,
    resolveNodePath,
    debug: (line) => debug(line),
    refresh: async () => { await dashboard.refresh(); },
  });

  const bundledServerPath = getBundledServerPath(context);
  const { launcherPath, configDir } = ensureLauncher(bundledServerPath);
  const bundledVersion = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");
  configureDaemonRuntime({ serverPath: bundledServerPath, configDir, bundledVersion, log });
  log("Stable launcher: " + launcherPath);

  async function promptEmailForAutoLogin(profile: string): Promise<string | undefined> {
    const email = await vscode.window.showInputBox({
      prompt: `Email for '${profile}' auto login`,
      placeHolder: "you@example.com",
      ignoreFocusOut: true,
    });
    return email?.trim() ? email.trim() : undefined;
  }

  function normalizeLoginMode(value: string | undefined): "auto" | "manual" {
    return value === "auto" ? "auto" : "manual";
  }

  async function runLoginForProfile(profile: string, mode: "auto" | "manual", email?: string): Promise<boolean> {
    if (mode === "auto" && !email) {
      await dashboard.postNotice("warning", `Auto login for '${profile}' needs an email address.`);
      return false;
    }

    let manualNoticeShown = false;
    const onProgress = (phase: string) => {
      log(`[login:${profile}] ${phase}`);
      if (phase !== "awaiting_user" || mode !== "manual" || manualNoticeShown) return;
      manualNoticeShown = true;
      void vscode.window.showInformationMessage(MANUAL_LOGIN_NOTICE);
      void dashboard.postNotice("info", MANUAL_LOGIN_NOTICE);
    };

    try {
      const result = await authManager.login({
        profile,
        mode,
        ...(mode === "auto" && email ? { email } : {}),
        onOtpPrompt: async () => (await vscode.window.showInputBox({ prompt: "Perplexity OTP", ignoreFocusOut: true })) ?? null,
        onProgress,
        // v0.8.6: Linux-viable unseal path. On machines where keytar loads we
        // return early with source="keytar" and no env var is injected; on
        // headless Linux we prompt for a passphrase once and persist it in
        // SecretStorage so subsequent logins are silent.
        passphraseProvider: () => ensureVaultPassphrase(context),
      });

      if (!result.ok && result.reason === "auto_unsupported" && mode === "auto") {
        log(`[login:${profile}] auto_unsupported — falling back to manual`);
        await dashboard.postNotice("info", "Auto login could not continue with the current site response — opening manual login instead.");
        return runLoginForProfile(profile, "manual");
      }

      if (!result.ok) {
        // v0.8.6: surface the runner's `error` string (and `detail` when it
        // adds signal) instead of just the `reason` enum. Users were seeing
        // "Login failed: crash" with no way to know about missing libsecret.
        const reason = result.reason ?? "unknown";
        const errorText = result.error && result.error !== reason ? result.error : "";
        const logLine = `[login:${profile}] Failed: ${reason}${errorText ? ` — ${errorText}` : ""}${result.detail && result.detail !== errorText ? ` (detail: ${result.detail})` : ""}`;
        log(logLine);
        const uiLine = errorText
          ? `Login failed for '${profile}' (${reason}): ${errorText}`
          : `Login failed for '${profile}': ${reason}`;
        await dashboard.postNotice("error", uiLine);
        return false;
      }

      serverDefinitionsChanged.fire();
      await dashboard.refresh();
      await dashboard.postNotice("info", `Perplexity login completed for '${profile}'. MCP server definitions refreshed.`);
      void dashboard.refreshModels();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[login:${profile}] Failed: ${msg}`);
      await dashboard.postNotice("error", `Login failed for '${profile}': ${msg}`);
      return false;
    }
  }

  async function promptNewProfileConfig(): Promise<{ name: string; mode: "auto" | "manual"; email?: string } | null> {
    const name = await vscode.window.showInputBox({
      prompt: "Profile name (a-z, 0-9, _, -; max 32)",
      placeHolder: "e.g. work, personal",
      ignoreFocusOut: true,
      validateInput: (value) => /^[a-z0-9_-]{1,32}$/.test(value) ? null : "Lowercase letters, digits, _ or -; 1–32 chars.",
    });
    if (!name) return null;

    const modePick = await vscode.window.showQuickPick(
      [
        { label: "Manual (recommended)", detail: "Opens Chrome so you can sign in directly on perplexity.ai.", value: "manual" as const },
        { label: "Auto (email + OTP) — experimental", detail: "Prompts for your email and OTP, then falls back to manual if the site refuses auto mode.", value: "auto" as const },
      ],
      { placeHolder: "Login mode for this profile", ignoreFocusOut: true },
    );
    if (!modePick) return null;

    let email: string | undefined;
    if (modePick.value === "auto") {
      email = await promptEmailForAutoLogin(name);
      if (!email) return null;
    }

    return { name, mode: modePick.value, ...(email ? { email } : {}) };
  }

  async function pickHistoryEntryId(placeHolder: string): Promise<string | undefined> {
    const items = listHistoryEntries(100);
    if (!items.length) {
      void vscode.window.showInformationMessage("No history entries found.");
      return undefined;
    }

    const pick = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.query,
        description: item.tool,
        detail: `${item.createdAt} · ${item.status ?? "completed"}${item.model ? ` · ${item.model}` : ""}`,
        id: item.id,
      })),
      { placeHolder, ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true },
    );
    return pick?.id;
  }

  async function pickExportFormat(initial?: ExportFormat): Promise<ExportFormat | undefined> {
    if (initial) {
      return initial;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Markdown", value: "markdown" as const, detail: "Local markdown copy; always available." },
        { label: "PDF", value: "pdf" as const, detail: "Perplexity-native export for authenticated entries." },
        { label: "DOCX", value: "docx" as const, detail: "Perplexity-native export for authenticated entries." },
      ],
      { placeHolder: "Choose export format", ignoreFocusOut: true },
    );
    return pick?.value;
  }

  log("Registering webview provider...");

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("Perplexity.dashboard", dashboard, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.openDashboard", async () => {
      await dashboard.reveal();
      await dashboard.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.refreshDashboard", async () => {
      await dashboard.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.openRichView", async (historyId?: string) => {
      const id = historyId ?? await pickHistoryEntryId("Choose a history entry to open in Rich View");
      if (!id) return false;
      await dashboard.reveal();
      await dashboard.refresh();
      await dashboard.postHistoryEntry(id);
      return true;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.exportHistory", async (historyId?: string, format?: ExportFormat) => {
      const id = historyId ?? await pickHistoryEntryId("Choose a history entry to export");
      if (!id) return false;
      const chosenFormat = await pickExportFormat(format);
      if (!chosenFormat) return false;
      try {
        const result = await runExport(id, chosenFormat);
        await dashboard.refresh();
        void vscode.window.showInformationMessage(`History export saved to ${result.savedPath}`);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`History export failed: ${message}`);
        return false;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.rebuildHistoryIndex", async () => {
      try {
        const result = rebuildHistoryEntries();
        await dashboard.refresh();
        void vscode.window.showInformationMessage(
          `History index rebuilt. Scanned ${result.scanned}, recovered ${result.recovered}, skipped ${result.skipped}.`,
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`History index rebuild failed: ${message}`);
        return false;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.syncCloudHistory", async () => {
      const progress = vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Syncing Perplexity cloud history…", cancellable: false },
        async (reporter) => {
          const result = await runCloudSync((evt) => {
            const pct = evt.total && evt.fetched ? Math.min(100, Math.round((evt.fetched / Math.max(evt.fetched, evt.total)) * 100)) : undefined;
            reporter.report({
              message: evt.phase === "syncing"
                ? `Fetched ${evt.fetched ?? 0} (${evt.inserted ?? 0} new, ${evt.updated ?? 0} updated)`
                : evt.phase,
              ...(pct !== undefined ? { increment: 0 } : {}),
            });
          });
          await dashboard.refresh();
          return result;
        },
      );
      try {
        const result = await progress;
        void vscode.window.showInformationMessage(
          `Perplexity cloud sync done: ${result.inserted} new, ${result.updated} updated, ${result.skipped} unchanged.`,
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Cloud sync failed: ${message}`);
        return false;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.refreshModels", async () => {
      await dashboard.refreshModels();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.daemon.status", async () => {
      try {
        const status = await getBundledDaemonStatus();
        const tunnel = status.health?.tunnel?.url ? ` tunnel=${status.health.tunnel.url}` : "";
        void vscode.window.showInformationMessage(
          status.running && status.health
            ? `Perplexity daemon pid=${status.health.pid} port=${status.health.port}${tunnel}`
            : `Perplexity daemon is not running (${status.lockPath}).`,
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Could not read daemon status: ${message}`);
        return false;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.daemon.rotateToken", async () => {
      try {
        const daemon = await rotateBundledDaemonToken();
        void vscode.window.showInformationMessage(`Perplexity daemon token rotated for pid=${daemon.pid} port=${daemon.port}.`);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Daemon token rotation failed: ${message}`);
        return false;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.copyDaemonBearer", async () => {
      await dashboard.dispatchFromCommand({ type: "daemon:bearer:copy", id: crypto.randomUUID() });
    }),
    vscode.commands.registerCommand("Perplexity.showDaemonBearer", async () => {
      await dashboard.dispatchFromCommand({ type: "daemon:bearer:reveal", id: crypto.randomUUID() });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.daemon.enableTunnel", async () => {
      await vscode.commands.executeCommand("Perplexity.openDashboard");
      void vscode.window.showInformationMessage("Enable the daemon tunnel from the dashboard after confirming the security prompt.");
      return false;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.daemon.disableTunnel", async () => {
      try {
        await disableBundledDaemonTunnel();
        void vscode.window.showInformationMessage("Perplexity daemon tunnel disabled.");
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Daemon tunnel disable failed: ${message}`);
        return false;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.installSpeedBoost", async () => {
      await dashboard.installSpeedBoost();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.uninstallSpeedBoost", async () => {
      await dashboard.uninstallSpeedBoost();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.login", async () => {
      const profile = getActiveName();
      const meta = profile ? getProfile(profile) : null;
      if (!profile || !meta) {
        return (await vscode.commands.executeCommand("Perplexity.addAccount")) === true;
      }

      const loginMode = normalizeLoginMode(meta.loginMode);
      let email: string | undefined;
      if (loginMode === "auto") {
        email = await promptEmailForAutoLogin(profile);
        if (!email) return false;
      }

      return runLoginForProfile(profile, loginMode, email);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.logout", async () => {
      const purge = (await vscode.window.showQuickPick(["Soft (keep dir)", "Hard (purge dir)"], { placeHolder: "Logout mode" })) === "Hard (purge dir)";
      const profile = getActiveName() ?? "default";
      await authManager.logout({ profile, purge });
      serverDefinitionsChanged.fire();
      await dashboard.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.switchAccount", async () => {
      const pick = await vscode.window.showQuickPick(listProfiles().map((p) => p.name), { placeHolder: "Switch account" });
      if (pick) {
        setActive(pick);
        serverDefinitionsChanged.fire();
        await dashboard.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.addAccount", async () => {
      const config = await promptNewProfileConfig();
      if (!config) return false;

      try {
        createProfile(config.name, { loginMode: config.mode });
        setActive(config.name);
        serverDefinitionsChanged.fire();
        await dashboard.refresh();
        await dashboard.postNotice("info", `Created profile '${config.name}'. Starting login…`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await dashboard.postNotice("error", `Could not create profile: ${msg}`);
        return false;
      }

      return runLoginForProfile(config.name, config.mode, config.email);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.doctor", async () => {
      await dashboard.reveal();
      await dashboard.postDoctorRun(false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.doctorReportIssue", async () => {
      await dashboard.reveal();
      await dashboard.postDoctorReportIssue();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.captureDiagnostics", async () => {
      const extVersion = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");
      const runDoctorBound = createExtensionAwareRunDoctor(context, {
        getChromePath: () => getSettingsSnapshot().chromePath,
        getVaultPassphrase: () => peekStoredVaultPassphrase(context),
      });
      let savedPath: string | null = null;
      const outcome = await runDiagnosticsCaptureFlow({
        showSaveDialog: async (defaultPath) => {
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultPath),
            filters: { "Zip archive": ["zip"] },
          });
          return uri?.fsPath;
        },
        captureDiagnostics: async (opts) => {
          savedPath = opts.outputPath;
          return captureDiagnostics(opts);
        },
        runDoctor: runDoctorBound,
        getConfigDir: () =>
          process.env.PERPLEXITY_CONFIG_DIR ?? path.join(os.homedir(), ".perplexity-mcp"),
        getLogsText: () => outputBuffer?.snapshot() ?? "",
        getExtensionVersion: () => extVersion,
        getVscodeVersion: () => vscode.version,
        getHomedir: () => os.homedir(),
        showInformationMessage: async (message) => {
          const choice = await vscode.window.showInformationMessage(message, "Show in folder");
          if (choice === "Show in folder" && savedPath) {
            try {
              await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(savedPath));
            } catch {
              await vscode.env.openExternal(vscode.Uri.file(savedPath));
            }
          }
          return choice;
        },
        showErrorMessage: async (message) => vscode.window.showErrorMessage(message),
      });
      return outcome.kind === "ok";
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "Perplexity.generateConfigs",
      async (target: string = "all") => {
        const settings = getSettingsSnapshot();
        const deps = await buildApplyIdeConfigDepsLive(context);
        const outcome = await configureTargets(
          target as IdeTarget | "all",
          launcherPath,
          settings.chromePath,
          {
            transportByIde: settings.mcpTransportByIde as Partial<Record<IdeTarget, McpTransportId>>,
            deps,
          }
        );
        for (const { target: t, result } of outcome.results) {
          if (!result.ok) {
            log(`[auto-config] ${t}: ${result.reason} — ${result.message}`);
          }
        }
        await dashboard.refresh();

        // v0.8.4 - surface per-IDE failures to the user. Prior to this commit
        // configureTargets would silently log failures to the Output channel
        // while the dashboard notice lied "refreshed." to the user.
        const failures = outcome.results.filter((r) => !r.result.ok);
        if (failures.length === 0) {
          await dashboard.postNotice(
            "info",
            `External MCP configuration files refreshed (${outcome.results.length} updated).`,
          );
        } else {
          const messages = failures
            .map(({ target: t, result }) => {
              if (result.ok) return "";
              const prefix = `[${t}] ${result.transportId} -> `;
              switch (result.reason) {
                case "unsupported":
                  return `${prefix}${result.message}`;
                case "sync-folder":
                  return `${prefix}sync folder detected — cancelled by user or default-deny.`;
                case "tunnel-unstable":
                  return `${prefix}${result.message}`;
                case "port-unavailable":
                  return `${prefix}start the daemon or pin Perplexity.daemonPort to a fixed port.`;
                case "cancelled":
                  return `${prefix}cancelled by user.`;
                case "error":
                  return `${prefix}${result.message}`;
                default:
                  return `${prefix}failed.`;
              }
            })
            .filter(Boolean);
          void vscode.window
            .showErrorMessage(
              `MCP config generation finished with ${failures.length} failure${
                failures.length === 1 ? "" : "s"
              }.`,
              { detail: messages.join("\n") },
              "Open Output",
            )
            .then((choice) => {
              if (choice === "Open Output") outputChannel.show(true);
            });
          // Keep the dashboard notice consistent — user sees both the modal
          // (actionable) and the inline banner (persistent until dismissed).
          await dashboard.postNotice(
            "warning",
            `MCP config generation finished with ${failures.length} failure${
              failures.length === 1 ? "" : "s"
            }. See the error modal or the Perplexity Output channel.`,
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "Perplexity.resetTransportConfirmations",
      async () => {
        await context.workspaceState.update(TRANSPORT_CONFIRM_STATE_KEY, {});
        portPinNudgedThisSession = false;
        void vscode.window.showInformationMessage(
          "Per-IDE transport confirmations reset."
        );
        return true;
      }
    )
  );

  const lmApi = (vscode as unknown as {
    lm?: {
      registerMcpServerDefinitionProvider?: (
        id: string,
        provider: {
          onDidChangeMcpServerDefinitions?: vscode.Event<void>;
          provideMcpServerDefinitions: () => Promise<unknown[]>;
          resolveMcpServerDefinition?: (definition: unknown) => Promise<unknown | undefined>;
        }
      ) => vscode.Disposable;
    };
  }).lm;

  if (typeof lmApi?.registerMcpServerDefinitionProvider === "function") {
    context.subscriptions.push(
      lmApi.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: serverDefinitionsChanged.event,
        provideMcpServerDefinitions: async () => {
          try {
            const settings = getSettingsSnapshot();
            const daemon = await ensureBundledDaemon();
            const version = String((context.extension.packageJSON as { version?: string }).version ?? "0.1.0");
            const httpCtor = (vscode as unknown as { McpHttpServerDefinition?: new (...args: unknown[]) => unknown })
              .McpHttpServerDefinition;
            if (httpCtor) {
              return [
                createHttpDefinition(
                  MCP_SERVER_LABEL,
                  vscode.Uri.parse(`${daemon.url}/mcp`),
                  {
                    Authorization: `Bearer ${daemon.bearerToken}`,
                  },
                  version,
                ),
              ];
            }
            return [
              createStdioDefinition(
                MCP_SERVER_LABEL,
                process.execPath,
                [getBundledServerPath(context), "daemon", "attach"],
                getServerEnvironment(settings, getBundledDaemonConfigDir()),
                version
              )
            ];
          } catch (err) {
            log(`provideMcpServerDefinitions error: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          }
        },
        resolveMcpServerDefinition: async (definition) => {
          if (hasStoredLogin()) {
            return definition;
          }

          const choice = await vscode.window.showWarningMessage(
            "Perplexity login is required before the MCP server can start.",
            "Login",
            "Open Dashboard"
          );

          if (choice === "Login") {
            await vscode.commands.executeCommand("Perplexity.login");
          } else if (choice === "Open Dashboard") {
            await vscode.commands.executeCommand("Perplexity.openDashboard");
          }

          return hasStoredLogin() ? definition : undefined;
        }
      })
    );
  } else {
    void vscode.window.showWarningMessage(
      "This VS Code build does not expose native MCP registration APIs. The Perplexity dashboard is still available."
    );
  }

  void ensureBundledDaemon()
    .then((daemon) => {
      log(`Daemon warm: pid=${daemon.pid} port=${daemon.port}`);
    })
    .catch((error) => {
      log(`Daemon warm skipped: ${error instanceof Error ? error.message : String(error)}`);
    });

  log("Extension activation complete.");
  await dashboard.refresh();

  // Opportunistic first-load refresh: if we have cookies but the models cache is
  // older than 24h (or missing), fire a live fetch so new models land without the
  // user clicking anything. Runs in the background — doesn't block activation.
  void (async () => {
    try {
      const { getModelsCacheInfo } = await import("perplexity-user-mcp/refresh");
      const info = getModelsCacheInfo();
      if (!info.exists || (info.ageHours !== null && info.ageHours > 24)) {
        debug(`Auto-refresh on activation: cache age=${info.ageHours?.toFixed(1) ?? "n/a"}h, triggering live fetch`);
        await dashboard.refreshModels();
      }
    } catch (err) {
      debug(`Auto-refresh on activation skipped: ${(err as Error).message}`);
    }
  })();

  const refreshHours = settings.autoRefreshIntervalHours ?? 0;
  if (refreshHours > 0) {
    const ms = refreshHours * 60 * 60 * 1000;
    const timer = setInterval(async () => {
      debug("Auto-refresh: live-fetching models config...");
      await dashboard.refreshModels();
    }, ms);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  await maybePromptAutoConfiguration(context, dashboard, launcherPath);
}

export function deactivate(): void {}
