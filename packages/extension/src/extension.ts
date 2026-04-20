import * as vscode from "vscode";
import { MCP_PROVIDER_ID, MCP_SERVER_LABEL, type IdeTarget } from "@perplexity-user-mcp/shared";
import { getActiveName, listProfiles, setActive, createProfile } from "perplexity-user-mcp/profiles";
import { configureTargets, getIdeStatuses } from "./auto-config/index.js";
import { hasStoredLogin } from "./auth/session.js";
import { getSettingsSnapshot } from "./settings.js";
import { DashboardProvider } from "./webview/DashboardProvider.js";
import { ensureLauncher } from "./launcher/write-launcher.js";
import { DebugCollector } from "./debug/collector.js";
import { traceConfigChanges } from "./debug/instrumentation.js";
import { exportDebugLog } from "./debug/exporter.js";

let outputChannel: vscode.OutputChannel;
let debugEnabled = false;

export function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function debug(message: string): void {
  if (debugEnabled) {
    outputChannel?.appendLine(`[${new Date().toISOString()}] [DEBUG] ${message}`);
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

function getBundledServerPath(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.extensionUri, "dist", "mcp", "server.mjs").fsPath;
}

function getServerEnvironment(settings: ReturnType<typeof getSettingsSnapshot>): Record<string, string> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
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

  const bundledServerPath = getBundledServerPath(context);
  const { launcherPath } = ensureLauncher(bundledServerPath);
  log("Stable launcher: " + launcherPath);

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
    vscode.commands.registerCommand("Perplexity.refreshModels", async () => {
      await dashboard.refreshModels();
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
      const profile = getActiveName() ?? "default";

      const modePick = await vscode.window.showQuickPick(
        [
          { label: "Manual (recommended)", detail: "Opens a browser pointed at perplexity.ai/account — you sign in however you want (email+password, Google, Apple, etc.). Works with SSO.", value: "manual" as const },
          { label: "Auto (email + OTP) — experimental", detail: "Enter your email; we drive a headless browser and prompt for the OTP. Only email+OTP accounts (no SSO). Real-Perplexity support is incomplete — fall back to Manual if it fails.", value: "auto" as const },
        ],
        { placeHolder: "Login mode", ignoreFocusOut: true },
      );
      if (!modePick) return; // user cancelled

      let email: string | undefined;
      if (modePick.value === "auto") {
        email = await vscode.window.showInputBox({
          prompt: "Email for auto login",
          placeHolder: "you@example.com",
          ignoreFocusOut: true,
        });
        if (!email) return;
      }

      try {
        const result = await authManager.login({
          profile,
          mode: modePick.value,
          email,
          onOtpPrompt: async () => (await vscode.window.showInputBox({ prompt: "Perplexity OTP", ignoreFocusOut: true })) ?? null,
          onProgress: (phase) => log(`[login] ${phase}`),
        });

        if (!result.ok && result.reason === "auto_unsupported" && modePick.value === "auto") {
          log(`[login] auto_unsupported — falling back to manual`);
          await dashboard.postNotice("info", "Auto mode isn't supported on the real Perplexity site yet — opening manual login instead.");
          const fallback = await authManager.login({
            profile,
            mode: "manual",
            onProgress: (phase) => log(`[login] ${phase}`),
          });
          if (!fallback.ok) {
            log(`[login] Manual fallback failed: ${fallback.reason ?? "unknown"}`);
            await dashboard.postNotice("error", `Manual fallback login failed: ${fallback.reason ?? "unknown"}`);
            return;
          }
        } else if (!result.ok) {
          log(`[login] Failed: ${result.reason ?? "unknown"}`);
          await dashboard.postNotice("error", `Login failed: ${result.reason ?? "unknown"}`);
          return;
        }

        serverDefinitionsChanged.fire();
        await dashboard.refresh();
        await dashboard.postNotice("info", "Perplexity login completed. MCP server definitions refreshed.");
        // Kick a live refresh now that we have fresh cookies.
        void dashboard.refreshModels();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[login] Failed: ${msg}`);
        await dashboard.postNotice("error", `Login failed: ${msg}`);
      }
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
      const name = await vscode.window.showInputBox({ prompt: "Profile name (a-z, 0-9, _, -; max 32)", validateInput: (v) => /^[a-z0-9_-]{1,32}$/.test(v) ? null : "Invalid name" });
      if (!name) return;
      const mode = (await vscode.window.showQuickPick(["auto", "manual"], { placeHolder: "Login mode" })) as "auto" | "manual" | undefined;
      if (!mode) return;
      createProfile(name, { loginMode: mode });
      await dashboard.refresh();
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
            return [
              createStdioDefinition(
                MCP_SERVER_LABEL,
                process.execPath,
                [getBundledServerPath(context)],
                getServerEnvironment(settings),
                String((context.extension.packageJSON as { version?: string }).version ?? "0.1.0")
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
