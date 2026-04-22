import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { MCP_PROVIDER_ID, MCP_SERVER_LABEL, type ExportFormat, type IdeTarget } from "@perplexity-user-mcp/shared";
import { getActiveName, getProfile, listProfiles, setActive, createProfile } from "perplexity-user-mcp/profiles";
import { redactMessage } from "./redact.js";
import { configureTargets, getIdeStatuses } from "./auto-config/index.js";
import { hasStoredLogin } from "./auth/session.js";
import { getSettingsSnapshot } from "./settings.js";
import { DashboardProvider } from "./webview/DashboardProvider.js";
import { ensureLauncher } from "./launcher/write-launcher.js";
import {
  configureDaemonRuntime,
  disableBundledDaemonTunnel,
  ensureBundledDaemon,
  getBundledDaemonConfigDir,
  getBundledDaemonStatus,
  rotateBundledDaemonToken,
} from "./daemon/runtime.js";
import { DebugCollector } from "./debug/collector.js";
import { traceConfigChanges } from "./debug/instrumentation.js";
import { exportDebugLog } from "./debug/exporter.js";
import { listHistoryEntries, rebuildHistoryEntries, runCloudSync, runExport } from "./history/open-handlers.js";

let outputChannel: vscode.OutputChannel;
let debugEnabled = false;

export function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${redactMessage(message)}`);
}

export function debug(message: string): void {
  if (debugEnabled) {
    outputChannel?.appendLine(`[${new Date().toISOString()}] [DEBUG] ${redactMessage(message)}`);
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

  configureTargets("all", launcherPath, settings.chromePath);
  await dashboard.refresh();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Perplexity Internal MCP");
  context.subscriptions.push(outputChannel);
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
  const debugCollector = new DebugCollector(settings.debugBufferSize);
  const MANUAL_LOGIN_NOTICE = "Manual login opened in Chrome. Finish sign-in there; if it is behind other windows, bring Chrome to the front.";

  // Wire collector events to a dedicated debug output channel
  const debugChannel = vscode.window.createOutputChannel("Perplexity Debug Trace");
  context.subscriptions.push(debugChannel);
  debugCollector.onEvent = (event) => {
    debugChannel.appendLine(`[${event.ts}] [${event.source}/${event.category}] ${event.event}${event.error ? ` ERROR: ${event.error}` : ""}`);
  };

  const dashboard = new DashboardProvider(context);
  dashboard.setDebugCollector(debugCollector);
  const { AuthManager } = await import("./mcp/auth-manager.js");
  const authManager = new AuthManager({ extensionUri: context.extensionUri });
  context.subscriptions.push(authManager);
  dashboard.setAuthManager(authManager);
  authManager.onDidChange(async (s) => { await dashboard.postAuthState(s); });
  const serverDefinitionsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(serverDefinitionsChanged);
  dashboard.setOnMcpServerDefinitionsChanged(() => { serverDefinitionsChanged.fire(); });

  const bundledServerPath = getBundledServerPath(context);
  const { launcherPath, configDir } = ensureLauncher(bundledServerPath);
  configureDaemonRuntime({ serverPath: bundledServerPath, configDir });
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
      });

      if (!result.ok && result.reason === "auto_unsupported" && mode === "auto") {
        log(`[login:${profile}] auto_unsupported — falling back to manual`);
        await dashboard.postNotice("info", "Auto login could not continue with the current site response — opening manual login instead.");
        return runLoginForProfile(profile, "manual");
      }

      if (!result.ok) {
        log(`[login:${profile}] Failed: ${result.reason ?? "unknown"}`);
        await dashboard.postNotice("error", `Login failed for '${profile}': ${result.reason ?? "unknown"}`);
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
    vscode.commands.registerCommand(
      "Perplexity.generateConfigs",
      async (target: string = "all") => {
        const settings = getSettingsSnapshot();
        configureTargets(target as IdeTarget | "all", launcherPath, settings.chromePath);
        await dashboard.refresh();
        await dashboard.postNotice("info", "External MCP configuration files refreshed.");
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

  // Debug commands
  const extVersion = String((context.extension.packageJSON as { version?: string }).version ?? "0.1.0");

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.debugStartSession", () => {
      debugCollector.startSession();
      debugCollector.trace("ext", "command", "debug:session_start", {});
      void vscode.window.showInformationMessage("Perplexity debug session started.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.debugStopAndExport", async () => {
      const session = debugCollector.stopSession();
      debugCollector.trace("ext", "command", "debug:session_stop", { session });
      await exportDebugLog(debugCollector, true, extVersion);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("Perplexity.debugExportAll", async () => {
      await exportDebugLog(debugCollector, false, extVersion);
    })
  );

  context.subscriptions.push(traceConfigChanges(debugCollector));

  debugCollector.trace("ext", "config", "extension:activated", {
    version: extVersion,
    debugMode: settings.debugMode,
    bufferSize: settings.debugBufferSize,
  });

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
