import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  EXTENSION_ID,
  type DaemonAuditEntry,
  type DaemonStatusState,
  type DaemonTunnelState,
  type DashboardState,
  type ExtensionMessage,
  type WebviewMessage
} from "@perplexity-user-mcp/shared";
import type { AuthManager, AuthState } from "../mcp/auth-manager.js";
import {
  getIdeStatuses,
  removeTarget,
  configureTargets,
  syncRulesForIde,
  removeRulesForIde,
  getRulesStatuses
} from "../auto-config/index.js";
import type { IdeTarget } from "@perplexity-user-mcp/shared";
import { getAccountSnapshot, setLastRefreshTier } from "../auth/session.js";
import { log, debug } from "../extension.js";
import type { DebugCollector } from "../debug/collector.js";
import { runDoctor } from "perplexity-user-mcp";
import {
  listProfiles,
  getActiveName,
  setActive,
  createProfile,
  deleteProfile,
} from "perplexity-user-mcp/profiles";
import { refreshAccountInfo } from "../browser/runtime.js";
import { installImpit, uninstallImpit } from "../native-deps.js";
import { getSettingsSnapshot, updateSettings } from "../settings.js";
import { renderWebviewHtml } from "./html.js";
import { LAUNCHER_PATH } from "../launcher/write-launcher.js";
import {
  configureExternalViewer,
  deleteHistoryEntry,
  listExternalViewers,
  listHistoryEntries,
  openExternalViewer,
  openPreview,
  openRichView,
  pinHistoryEntry,
  rebuildHistoryEntries,
  runCloudSync,
  hydrateCloudEntry,
  runExport,
  tagHistoryEntry,
} from "../history/open-handlers.js";
import {
  clearBundledNgrokSettings,
  disableBundledDaemonTunnel,
  enableBundledDaemonTunnel,
  ensureBundledDaemon,
  getBundledActiveTunnelProvider,
  getBundledDaemonStatus,
  getBundledNgrokSettings,
  installBundledCloudflared,
  isCloudflaredInstalled,
  killBundledDaemon,
  listBundledOAuthConsents,
  listBundledTunnelProviders,
  readBundledDaemonAuditTail,
  restartBundledDaemon,
  revokeAllBundledOAuthConsents,
  revokeBundledOAuthConsent,
  rotateBundledDaemonToken,
  setBundledActiveTunnelProvider,
  setBundledNgrokAuthtoken,
  setBundledNgrokDomain,
} from "../daemon/runtime.js";

export class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private debugCollector?: DebugCollector;
  private authManager?: AuthManager;
  private otpResolvers = new Map<string, (s: string | null) => void>();
  private onMcpServerDefinitionsChanged?: () => void;
  private daemonEventsAbort: AbortController | null = null;
  // Cache the most-recent doctor report so "Report issue" can reuse it instead
  // of re-running all 10 checks. Cleared when the user clicks Run again.
  private lastDoctorReport: unknown = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setDebugCollector(collector: DebugCollector): void {
    this.debugCollector = collector;
  }

  setAuthManager(m: AuthManager): void {
    this.authManager = m;
  }

  setOnMcpServerDefinitionsChanged(fn: () => void): void {
    this.onMcpServerDefinitionsChanged = fn;
  }

  async postAuthState(s: AuthState): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({ type: "auth:state", payload: s });
  }

  async postProfileList(): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({ type: "profile:list", payload: { active: getActiveName(), profiles: listProfiles() } });
  }

  async postHistoryList(limit = 50): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({ type: "history:list", payload: { items: listHistoryEntries(limit) } });
  }

  async postViewersList(): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({ type: "viewers:list", payload: { viewers: await listExternalViewers() } });
  }

  async postHistoryEntry(historyId: string): Promise<void> {
    if (!this.view) return;
    await openRichView(historyId, (message) => this.view?.webview.postMessage(message));
  }

  async postDoctorRun(probe: boolean): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({
      type: probe ? "doctor:probe" : "doctor:run",
      id: crypto.randomBytes(6).toString("hex"),
      payload: {},
    });
  }

  async postDoctorReportIssue(): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({
      type: "doctor:report-issue",
      id: crypto.randomBytes(6).toString("hex"),
      payload: { category: "runtime", check: "run" },
    });
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    log("resolveWebviewView called");
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media", "webview")]
    };

    try {
      const state = this.buildState();
      log(`buildState succeeded: loggedIn=${state.snapshot.loggedIn}, historyLen=${state.history.length}`);
      const html = renderWebviewHtml(
        webviewView.webview,
        this.context.extensionUri,
        state
      );
      log(`renderWebviewHtml succeeded: ${html.length} chars`);
      webviewView.webview.html = html;
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      log(`resolveWebviewView ERROR: ${msg}`);
      webviewView.webview.html = `<!DOCTYPE html><html><body style="padding:16px;font-family:sans-serif;color:#f8fafc;background:#0f172a"><h2>Perplexity Dashboard Error</h2><pre style="white-space:pre-wrap;color:#fca5a5">${msg.replace(/</g, "&lt;")}</pre><p>Check Output &gt; Perplexity Internal MCP for details.</p></body></html>`;
    }

    const disposeHook = (webviewView as vscode.WebviewView & { onDidDispose?: (listener: () => void) => vscode.Disposable }).onDidDispose?.(() => {
      this.stopDaemonEventStream();
    });
    if (disposeHook) {
      this.context.subscriptions.push(disposeHook);
    }
    void this.postDaemonState({ ensure: true, restartEvents: true });

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.type === "log:webview") {
        const { level, args, ts } = message.payload;
        const serialized = args.map((a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ");
        debug(`[webview/${level}] ${ts} ${serialized}`);
        return;
      }
      debug(`Webview message received: ${JSON.stringify(message)}`);
      try {
        switch (message.type) {
          case "ready":
          case "dashboard:refresh":
            debug("Handling refresh/ready");
            await this.refresh();
            break;
          case "auth:login":
            debug("Handling auth:login");
            try {
              const ok = await vscode.commands.executeCommand<boolean>("Perplexity.login");
              await this.postActionResult(message.id, ok !== false, ok === false ? "login_not_completed" : undefined);
            } catch (err) {
              await this.postActionResult(message.id, false, String(err));
            }
            break;
          case "configs:generate": {
            try {
              const settings = getSettingsSnapshot();
              debug(`configs:generate target=${message.payload.target} launcherPath=${LAUNCHER_PATH}`);
              configureTargets(message.payload.target as IdeTarget | "all", LAUNCHER_PATH, settings.chromePath);
              await this.postNotice("info", `MCP config written for ${message.payload.target === "all" ? "all IDEs" : message.payload.target}.`);
              await this.refresh();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, String(err));
            }
            break;
          }
          case "configs:remove": {
            try {
              debug(`configs:remove target=${message.payload.target}`);
              removeTarget(message.payload.target);
              await this.postNotice("info", `MCP config removed from ${message.payload.target}.`);
              await this.refresh();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, String(err));
            }
            break;
          }
          case "rules:sync": {
            try {
              const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              debug(`rules:sync target=${message.payload.target} wsRoot=${wsRoot ?? "(none)"}`);
              if (!wsRoot) {
                await this.postNotice("warning", "No workspace folder open. Open a project first.");
                await this.postActionResult(message.id, false, "No workspace folder open");
                break;
              }
              if (message.payload.target === "all") {
                const { IDE_METADATA } = await import("@perplexity-user-mcp/shared");
                for (const key of Object.keys(IDE_METADATA)) {
                  syncRulesForIde(key as IdeTarget, wsRoot);
                }
                await this.postNotice("info", "Perplexity rules synced to all IDE formats.");
              } else {
                syncRulesForIde(message.payload.target, wsRoot);
                await this.postNotice("info", `Perplexity rules synced for ${message.payload.target}.`);
              }
              await this.refresh();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, String(err));
            }
            break;
          }
          case "rules:remove": {
            try {
              const wsRoot2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              debug(`rules:remove target=${message.payload.target} wsRoot=${wsRoot2 ?? "(none)"}`);
              if (wsRoot2) {
                removeRulesForIde(message.payload.target, wsRoot2);
                await this.postNotice("info", `Perplexity rules removed from ${message.payload.target}.`);
              }
              await this.refresh();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, String(err));
            }
            break;
          }
          case "settings:update":
            debug(`settings:update payload=${JSON.stringify(message.payload)}`);
            await updateSettings(message.payload);
            await this.refresh();
            break;
          case "models:refresh":
            debug("Handling models:refresh");
            await this.handleModelsRefresh(message.id);
            break;
          case "speed-boost:install":
            debug("Handling speed-boost:install");
            await this.handleSpeedBoostInstall(message.id);
            break;
          case "speed-boost:uninstall":
            debug("Handling speed-boost:uninstall");
            await this.handleSpeedBoostUninstall(message.id);
            break;
          case "auth:login-start": {
            if (!this.authManager) break;
            const { profile, mode, email } = message.payload;
            // Reject any stale resolver for this profile so a retried login doesn't leak.
            this.otpResolvers.get(profile)?.(null);
            this.otpResolvers.delete(profile);
            try {
              const runLogin = (loginMode: "auto" | "manual") => this.authManager!.login({
                profile,
                mode: loginMode,
                ...(loginMode === "auto" ? { email } : {}),
                onOtpPrompt: () => new Promise<string | null>((resolve) => {
                  void this.view?.webview.postMessage({ type: "auth:otp-prompt", payload: { profile, attempt: 0, email: email ?? "" } });
                  this.otpResolvers.set(profile, resolve);
                }),
                onProgress: (phase) => {
                  if (phase !== "awaiting_user" || loginMode !== "manual") return;
                  const message = "Manual login opened in Chrome. Finish sign-in there; if it is behind other windows, bring Chrome to the front.";
                  void vscode.window.showInformationMessage(message);
                  void this.postNotice("info", message);
                },
              });
              const result = await runLogin(mode);

              if (!result.ok && result.reason === "auto_unsupported" && mode === "auto") {
                await this.postNotice("info", "Auto login could not continue with the current site response — opening manual login instead.");
                const fallback = await runLogin("manual");
                if (!fallback.ok) {
                  await this.postActionResult(message.id, false, fallback.reason ?? "manual-fallback-failed");
                } else {
                  this.onMcpServerDefinitionsChanged?.();
                  await this.postActionResult(message.id, true);
                }
              } else if (!result.ok) {
                await this.postActionResult(message.id, false, result.reason ?? "login_failed");
              } else {
                this.onMcpServerDefinitionsChanged?.();
                await this.postActionResult(message.id, true);
              }
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            } finally {
              // Drop any un-resolved resolver for this profile (e.g. user cancelled modal)
              this.otpResolvers.delete(profile);
            }
            await this.refresh();
            break;
          }
          case "auth:otp-submit": {
            const { profile, otp } = message.payload;
            const resolver = this.otpResolvers.get(profile);
            if (resolver) {
              resolver(otp);
              this.otpResolvers.delete(profile);
            }
            break;
          }
          case "auth:logout": {
            if (!this.authManager) break;
            await this.authManager.logout(message.payload);
            this.onMcpServerDefinitionsChanged?.();
            await this.postActionResult(message.id, true);
            await this.refresh();
            break;
          }
          case "auth:dismiss-expired":
            break;
          case "profile:switch": {
            setActive(message.payload.name);
            this.onMcpServerDefinitionsChanged?.();
            await this.postActionResult(message.id, true);
            await this.postProfileList();
            await this.refresh();
            break;
          }
          case "profile:add-prompt": {
            try {
              await vscode.commands.executeCommand("Perplexity.addAccount");
            } catch (err) {
              await this.postNotice("error", `Could not add profile: ${(err as Error).message}`);
            }
            break;
          }
          case "profile:add": {
            try {
              createProfile(message.payload.name, { loginMode: message.payload.loginMode });
              setActive(message.payload.name);
              this.onMcpServerDefinitionsChanged?.();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            await this.postProfileList();
            await this.refresh();
            break;
          }
          case "profile:delete": {
            const name = message.payload.name;
            const confirm = await vscode.window.showWarningMessage(
              `Delete profile '${name}' and remove its stored cookies, browser data, cache, history, attachments, and local profile files?`,
              {
                modal: true,
                detail: "This permanently removes the local Perplexity MCP profile from this machine.",
              },
              "Delete profile",
            );
            if (confirm !== "Delete profile") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }
            const wasActive = getActiveName() === name;
            deleteProfile(name);
            if (wasActive) this.onMcpServerDefinitionsChanged?.();
            await this.postNotice("info", `Deleted profile '${name}'.`);
            await this.postActionResult(message.id, true);
            await this.postProfileList();
            await this.refresh();
            break;
          }
          case "doctor:run":
          case "doctor:probe": {
            await this.view?.webview.postMessage({ type: "doctor:running", payload: { probeRan: message.type === "doctor:probe" } });
            try {
              const settings = getSettingsSnapshot();
              const bundledServerPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "mcp", "server.mjs").fsPath;
              const ideStatuses = getIdeStatuses(bundledServerPath, settings.chromePath);
              const baseDir = vscode.Uri.joinPath(this.context.extensionUri, "dist").fsPath;
              const report = await runDoctor({
                probe: message.type === "doctor:probe",
                ideStatuses,
                baseDir,
              });
              this.lastDoctorReport = report;
              await this.view?.webview.postMessage({ type: "doctor:report", payload: report });
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "doctor:export": {
            try {
              const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`doctor-report-${Date.now()}.json`),
                filters: { JSON: ["json"] },
              });
              if (uri) {
                const settings = getSettingsSnapshot();
                const bundledServerPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "mcp", "server.mjs").fsPath;
                const ideStatuses = getIdeStatuses(bundledServerPath, settings.chromePath);
                const baseDir = vscode.Uri.joinPath(this.context.extensionUri, "dist").fsPath;
                const report = await runDoctor({ baseDir, ideStatuses });
                await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(report, null, 2)));
                await this.postNotice("info", `Doctor report written to ${uri.fsPath}.`);
              }
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "doctor:report-issue": {
            try {
              let report = this.lastDoctorReport;
              if (!report) {
                const settings = getSettingsSnapshot();
                const bundledServerPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "mcp", "server.mjs").fsPath;
                const ideStatuses = getIdeStatuses(bundledServerPath, settings.chromePath);
                const baseDir = vscode.Uri.joinPath(this.context.extensionUri, "dist").fsPath;
                report = await runDoctor({ baseDir, ideStatuses });
                this.lastDoctorReport = report;
              }
              const { collectDiagnostics, renderPreview, openIssue, buildIssueUrl } = await import("./doctor-report-handler.js");
              const diag = collectDiagnostics({
                report: report as import("@perplexity-user-mcp/shared").DoctorReport,
                stderrTail: "(extension output channel tail not yet wired)",
                extVersion: this.context.extension.packageJSON.version as string,
                nodeVersion: process.version,
                os: `${process.platform} ${process.arch}`,
                activeTier: getAccountSnapshot().tier ?? null,
              });
              const choice = await renderPreview({
                markdown: diag.markdown,
                showInformationMessage: vscode.window.showInformationMessage,
              });
              if (choice === "Copy to clipboard") {
                await vscode.env.clipboard.writeText(diag.markdown);
                await this.postNotice("info", "Redacted report copied to clipboard.");
              } else if (choice === "Open GitHub issue") {
                const url = (buildIssueUrl as Function)({
                  owner: "nskha",
                  repo: "perplexity-user-mcp",
                  category: message.payload.category,
                  check: message.payload.check,
                  body: diag.markdown,
                });
                await openIssue({ url, optOut: false, openExternal: (u: unknown) => vscode.env.openExternal(vscode.Uri.parse(String(u))) });
              }
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "doctor:action": {
            try {
              const { commandId, args } = message.payload;
              // Whitelist of commands the webview may trigger through doctor actions.
              // Keeps the `doctor:action` channel safe from arbitrary command execution
              // if the webview is ever compromised.
              const allowed = new Set([
                "Perplexity.installSpeedBoost",
                "Perplexity.uninstallSpeedBoost",
                "Perplexity.generateConfigs",
                "Perplexity.addAccount",
                "Perplexity.switchAccount",
                "Perplexity.refreshDashboard",
              ]);
              if (!allowed.has(commandId)) {
                throw new Error(`Command '${commandId}' is not allowed from a doctor action.`);
              }
              await vscode.commands.executeCommand(commandId, ...(args ?? []));
              // Invalidate cached report so the next Run picks up the now-fixed state.
              this.lastDoctorReport = null;
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:status": {
            try {
              await this.postDaemonState({ ensure: true, restartEvents: true });
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:list-tunnel-providers": {
            try {
              await this.postTunnelProviders();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:set-tunnel-provider": {
            try {
              const { providerId } = message.payload;
              const wasRunning = (await getBundledDaemonStatus()).record?.tunnelUrl != null;
              if (wasRunning) {
                await disableBundledDaemonTunnel();
              }
              setBundledActiveTunnelProvider(providerId);
              await this.postTunnelProviders();
              await this.postNotice("info", `Active tunnel provider set to ${providerId === "ngrok" ? "ngrok" : "Cloudflare Quick"}. Click Enable to start it.`);
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:set-ngrok-authtoken": {
            try {
              const token = (message.payload.authtoken ?? "").trim();
              if (token.length < 10) {
                throw new Error("Authtoken looks invalid (too short). Paste the full token from dashboard.ngrok.com/get-started/your-authtoken.");
              }
              setBundledNgrokAuthtoken(token);
              await this.postTunnelProviders();
              await this.maybeWarnNgrokChangeRequiresReEnable("authtoken");
              await this.postNotice("info", "ngrok authtoken saved.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:set-ngrok-domain": {
            try {
              const domain = (message.payload.domain ?? "").trim();
              setBundledNgrokDomain(domain.length > 0 ? domain : null);
              await this.postTunnelProviders();
              await this.maybeWarnNgrokChangeRequiresReEnable("reserved domain");
              await this.postNotice("info", domain ? `ngrok reserved domain set to ${domain}.` : "ngrok reserved domain cleared.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:clear-ngrok-settings": {
            try {
              clearBundledNgrokSettings();
              await this.postTunnelProviders();
              await this.postNotice("info", "ngrok settings cleared. Paste your authtoken again to re-enable.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:kill": {
            const confirm = await vscode.window.showWarningMessage(
              "Force-kill the daemon?\n\nThis sends SIGTERM+SIGKILL to the daemon process, closes the tunnel, and releases the lockfile. Existing MCP clients will disconnect. The extension will NOT auto-spawn a fresh daemon — click Restart to bring it back.",
              { modal: true },
              "Kill daemon",
            );
            if (confirm !== "Kill daemon") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }
            try {
              this.stopDaemonEventStream();
              const result = await killBundledDaemon();
              await this.postDaemonState();
              this.onMcpServerDefinitionsChanged?.();
              await this.postNotice(
                "info",
                result.forced
                  ? `Daemon force-killed (pid=${result.pid ?? "?"}). Lockfile released.`
                  : result.stopped
                    ? `Daemon stopped cleanly (pid=${result.pid ?? "?"}).`
                    : "Daemon was not running.",
              );
              await this.postActionResult(message.id, true);
            } catch (err) {
              const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
              await this.postNotice("error", `Kill daemon failed: ${(err as Error).message}`);
              debug(`[trace] daemon:kill FAILED: ${detail}`);
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:restart": {
            try {
              await this.postNotice("info", "Restarting daemon — this will drop any open tunnel for a few seconds.");
              this.stopDaemonEventStream();
              await restartBundledDaemon();
              await this.postDaemonState({ ensure: false, restartEvents: true });
              this.onMcpServerDefinitionsChanged?.();
              await this.postNotice("info", "Daemon restarted.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
              await this.postNotice("error", `Daemon restart failed: ${(err as Error).message}`);
              debug(`[trace] daemon:restart FAILED: ${detail}`);
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:rotate-token": {
            const confirm = await vscode.window.showWarningMessage(
              "Rotate the daemon bearer token? Existing MCP clients must reconnect before they can use the daemon again.",
              {
                modal: true,
                detail: "This updates the token file and daemon lockfile, then broadcasts a token-rotation event.",
              },
              "Rotate token",
            );
            if (confirm !== "Rotate token") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }

            try {
              await rotateBundledDaemonToken();
              await this.view?.webview.postMessage({
                type: "daemon:token-rotated",
                payload: { rotatedAt: new Date().toISOString() },
              } satisfies ExtensionMessage);
              this.onMcpServerDefinitionsChanged?.();
              await this.postDaemonState({ ensure: true, restartEvents: true });
              await this.postNotice("info", "Daemon token rotated. MCP clients will reconnect with the new bearer token.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:enable-tunnel": {
            const confirm = await vscode.window.showWarningMessage(
              "Your Perplexity Pro/Max session will be accessible over the public internet. Anyone with the tunnel URL and bearer token can use your account. Continue?",
              { modal: true },
              "Enable tunnel",
            );
            if (confirm !== "Enable tunnel") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }

            try {
              if (!isCloudflaredInstalled()) {
                const installChoice = await vscode.window.showInformationMessage(
                  "Cloudflare Tunnel requires the cloudflared binary (~25 MB). Download it now from github.com/cloudflare/cloudflared?",
                  { modal: true },
                  "Download and enable",
                );
                if (installChoice !== "Download and enable") {
                  await this.postActionResult(message.id, false, "cancelled");
                  break;
                }
                await vscode.window.withProgress(
                  {
                    location: vscode.ProgressLocation.Notification,
                    title: "Downloading cloudflared…",
                    cancellable: false,
                  },
                  async () => {
                    await installBundledCloudflared();
                  },
                );
              }
              await enableBundledDaemonTunnel();
              await this.postDaemonState({ ensure: true, restartEvents: true });
              await this.postNotice("info", "Cloudflare Quick Tunnel enabled for the daemon.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              const message_ = (err as Error).message;
              await this.postNotice("error", `Tunnel enable failed: ${message_}`);
              await this.postActionResult(message.id, false, message_);
            }
            break;
          }
          case "daemon:disable-tunnel": {
            try {
              await disableBundledDaemonTunnel();
              await this.postDaemonState({ ensure: true, restartEvents: true });
              await this.postNotice("info", "Cloudflare Quick Tunnel disabled.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:oauth-consents-list": {
            try {
              await this.postOAuthConsents();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:oauth-consents-revoke": {
            try {
              const removed = await revokeBundledOAuthConsent(message.payload.clientId, message.payload.redirectUri);
              await this.postOAuthConsents();
              await this.postNotice(
                "info",
                removed > 0
                  ? `Revoked ${removed} cached consent${removed === 1 ? "" : "s"}.`
                  : "No matching consent was cached.",
              );
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:oauth-consents-revoke-all": {
            try {
              const removed = await revokeAllBundledOAuthConsents();
              await this.postOAuthConsents();
              await this.postNotice(
                "info",
                removed > 0
                  ? `Revoked ${removed} cached consent${removed === 1 ? "" : "s"}.`
                  : "No cached consents to revoke.",
              );
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "history:request-list": {
            await this.postHistoryList(100);
            break;
          }
          case "history:request-entry":
          case "history:open-rich": {
            try {
              await this.postHistoryEntry(message.payload.historyId);
              await this.postActionResult("id" in message ? message.id : undefined, true);
            } catch (err) {
              await this.postActionResult("id" in message ? message.id : undefined, false, (err as Error).message);
            }
            break;
          }
          case "history:open-preview": {
            try {
              await openPreview(message.payload.historyId);
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "history:open-with": {
            try {
              await openExternalViewer(message.payload.historyId, message.payload.viewerId);
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "history:export": {
            try {
              await this.view?.webview.postMessage({ type: "history:export:progress", payload: { id: message.id, phase: "starting" } });
              const result = await runExport(message.payload.historyId, message.payload.format);
              await this.view?.webview.postMessage({
                type: "history:export:progress",
                payload: { id: message.id, phase: "saved", savedPath: result.savedPath, bytes: result.bytes },
              });
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.view?.webview.postMessage({
                type: "history:export:progress",
                payload: { id: message.id, phase: "error", error: (err as Error).message },
              });
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "history:pin": {
            pinHistoryEntry(message.payload.historyId, message.payload.pinned);
            await this.postHistoryList(100);
            await this.postHistoryEntry(message.payload.historyId);
            await this.postActionResult(message.id, true);
            break;
          }
          case "history:tag": {
            tagHistoryEntry(message.payload.historyId, message.payload.tags);
            await this.postHistoryList(100);
            await this.postHistoryEntry(message.payload.historyId);
            await this.postActionResult(message.id, true);
            break;
          }
          case "history:delete": {
            deleteHistoryEntry(message.payload.historyId);
            await this.postHistoryList(100);
            await this.postActionResult(message.id, true);
            break;
          }
          case "history:rebuild-index": {
            rebuildHistoryEntries();
            await this.postHistoryList(100);
            await this.postActionResult(message.id, true);
            break;
          }
          case "viewers:request-list": {
            await this.postViewersList();
            break;
          }
          case "viewers:configure": {
            try {
              const viewers = await configureExternalViewer(message.payload.viewer);
              await this.view?.webview.postMessage({ type: "viewers:list", payload: { viewers } });
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "history:cloud-sync": {
            try {
              await this.view?.webview.postMessage({
                type: "history:cloud-sync:progress",
                payload: { id: message.id, phase: "starting", fetched: 0, inserted: 0, updated: 0, skipped: 0 },
              });
              const result = await runCloudSync((evt) => {
                void this.view?.webview.postMessage({
                  type: "history:cloud-sync:progress",
                  payload: {
                    id: message.id,
                    phase: evt.phase,
                    fetched: evt.fetched,
                    total: evt.total,
                    inserted: evt.inserted,
                    updated: evt.updated,
                    skipped: evt.skipped,
                    error: evt.error,
                  },
                });
              }, { pageSize: message.payload?.pageSize });
              await this.postHistoryList(200);
              await this.view?.webview.postMessage({
                type: "history:cloud-sync:progress",
                payload: { id: message.id, phase: "done", fetched: result.fetched, inserted: result.inserted, updated: result.updated, skipped: result.skipped },
              });
              await this.postActionResult(message.id, true);
            } catch (err) {
              const errMsg = (err as Error).message;
              await this.view?.webview.postMessage({
                type: "history:cloud-sync:progress",
                payload: { id: message.id, phase: "error", error: errMsg },
              });
              await this.postActionResult(message.id, false, errMsg);
            }
            break;
          }
          case "history:cloud-hydrate": {
            try {
              await this.view?.webview.postMessage({
                type: "history:cloud-hydrate:progress",
                payload: { id: message.id, historyId: message.payload.historyId, phase: "starting" },
              });
              const res = await hydrateCloudEntry(message.payload.historyId);
              // Re-post the (now-hydrated) entry so Rich View refreshes.
              await this.postHistoryEntry(message.payload.historyId);
              await this.postHistoryList(200);
              await this.view?.webview.postMessage({
                type: "history:cloud-hydrate:progress",
                payload: { id: message.id, historyId: message.payload.historyId, phase: res.action === "hydrated" ? "done" : res.action },
              });
              await this.postActionResult(message.id, true);
            } catch (err) {
              const errMsg = (err as Error).message;
              await this.view?.webview.postMessage({
                type: "history:cloud-hydrate:progress",
                payload: { id: message.id, historyId: message.payload.historyId, phase: "error", error: errMsg },
              });
              await this.postActionResult(message.id, false, errMsg);
            }
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        log(`Message handler ERROR [${message.type}]: ${msg}`);
        await this.postNotice("error", `Action failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  buildState(): DashboardState {
    const settings = getSettingsSnapshot();
    const bundledServerPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "mcp", "server.mjs").fsPath;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const ideStatus = getIdeStatuses(bundledServerPath, settings.chromePath);
    debug(`buildState: ideStatuses=${JSON.stringify(Object.fromEntries(Object.entries(ideStatus).map(([k, v]) => [k, { detected: v.detected, configured: v.configured }])))}`);
    debug(`buildState: wsRoot=${wsRoot ?? "(none)"}`);
    return {
      snapshot: getAccountSnapshot(),
      history: listHistoryEntries(25),
      ideStatus,
      rulesStatus: wsRoot ? getRulesStatuses(wsRoot) : [],
      settings,
      debug: {
        enabled: settings.debugMode,
        sessionActive: this.debugCollector?.isSessionActive ?? false,
        eventCount: this.debugCollector?.eventCount ?? 0,
        bufferCapacity: this.debugCollector?.bufferCapacity ?? settings.debugBufferSize,
      }
    };
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage({
      type: "dashboard:state",
      payload: this.buildState()
    } satisfies ExtensionMessage);
    await this.postProfileList();
    await this.postHistoryList(100);
    await this.postViewersList();
    await this.postDaemonState({ ensure: true });
  }

  async refreshModels(): Promise<void> {
    await this.handleModelsRefresh();
  }

  private async handleModelsRefresh(id?: string): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage({
        type: "models:refresh:status",
        payload: { phase: "start" }
      } satisfies ExtensionMessage);
    }
    try {
      const result = await refreshAccountInfo({ log: (line: string) => log(`[refresh] ${line}`) });
      if (result.ok) {
        log(
          `refreshAccountInfo: live fetch OK via tier=${result.tier}, ${result.modelCount} models, accountTier=${result.accountTier}, took ${result.elapsedMs}ms`
        );
        setLastRefreshTier(result.tier);
        if (this.view) {
          await this.view.webview.postMessage({
            type: "models:refresh:status",
            payload: {
              phase: "success",
              source: "live",
              tier: result.tier ?? undefined,
              count: result.modelCount,
              elapsedMs: result.elapsedMs,
            }
          } satisfies ExtensionMessage);
        }
        await this.refresh();
        await this.postActionResult(id, true);
      } else {
        const attemptSummary = result.tierAttempts
          ? result.tierAttempts.map((a) => `${a.tier}:${a.ok ? "ok" : a.elapsedMs + "ms"}`).join(", ")
          : "";
        log(`refreshAccountInfo: ${result.source} — ${result.error ?? "unknown"} (took ${result.elapsedMs}ms; attempts: ${attemptSummary})`);
        const hint =
          result.source === "no-cookies"
            ? "Run Perplexity: Login first."
            : result.source === "cf-challenge"
            ? "Cloudflare is challenging — cookies expired. Run Perplexity: Login to re-solve Turnstile."
            : "Try Perplexity: Login.";
        if (this.view) {
          await this.view.webview.postMessage({
            type: "models:refresh:status",
            payload: { phase: "error", error: `${result.error ?? "Refresh failed"} (${hint})` }
          } satisfies ExtensionMessage);
        }
        await this.postNotice("warning", `Models refresh failed: ${result.error ?? result.source}. ${hint}`);
        await this.postActionResult(id, false, result.error ?? result.source);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`refreshAccountInfo threw: ${msg}`);
      if (this.view) {
        await this.view.webview.postMessage({
          type: "models:refresh:status",
          payload: { phase: "error", error: msg }
        } satisfies ExtensionMessage);
      }
      await this.postNotice("error", `Models refresh threw: ${msg}`);
      await this.postActionResult(id, false, msg);
    }
  }

  async installSpeedBoost(): Promise<void> {
    await this.handleSpeedBoostInstall();
  }

  async uninstallSpeedBoost(): Promise<void> {
    await this.handleSpeedBoostUninstall();
  }

  private async handleSpeedBoostInstall(id?: string): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage({
        type: "speed-boost:status",
        payload: { phase: "installing" }
      } satisfies ExtensionMessage);
    }
    const result = await installImpit({
      log: async (line: string) => {
        log(`[speed-boost install] ${line}`);
        if (this.view) {
          await this.view.webview.postMessage({
            type: "speed-boost:status",
            payload: { phase: "installing", line }
          } satisfies ExtensionMessage);
        }
      }
    });

    if (this.view) {
      await this.view.webview.postMessage({
        type: "speed-boost:status",
        payload: { phase: "idle" }
      } satisfies ExtensionMessage);
    }

    if (result.ok) {
      await this.postNotice("info", `Speed Boost installed (impit ${result.version ?? ""}). Dashboard refresh will use it automatically.`);
      await this.refresh();
      await this.postActionResult(id, true);
    } else {
      await this.postNotice("error", `Speed Boost install failed: ${result.error ?? "unknown"}`);
      await this.postActionResult(id, false, result.error);
    }
  }

  private async handleSpeedBoostUninstall(id?: string): Promise<void> {
    if (this.view) {
      await this.view.webview.postMessage({
        type: "speed-boost:status",
        payload: { phase: "uninstalling" }
      } satisfies ExtensionMessage);
    }
    const result = uninstallImpit({ log: (line: string) => log(`[speed-boost uninstall] ${line}`) });

    if (this.view) {
      await this.view.webview.postMessage({
        type: "speed-boost:status",
        payload: { phase: "idle" }
      } satisfies ExtensionMessage);
    }

    if (result.ok) {
      await this.postNotice("info", "Speed Boost removed.");
      await this.refresh();
      await this.postActionResult(id, true);
    } else {
      await this.postNotice("error", `Speed Boost uninstall failed: ${result.error ?? "unknown"}`);
      await this.postActionResult(id, false, result.error);
    }
  }

  private async maybeWarnNgrokChangeRequiresReEnable(field: string): Promise<void> {
    try {
      const status = await getBundledDaemonStatus();
      const tunnelStatus = status.health?.tunnel?.status ?? status.record?.tunnelUrl ? "enabled" : "disabled";
      const activeProvider = getBundledActiveTunnelProvider();
      if (activeProvider === "ngrok" && tunnelStatus === "enabled") {
        const choice = await vscode.window.showInformationMessage(
          `ngrok ${field} changed while a tunnel is live. Re-enable to apply?`,
          "Re-enable now",
          "Later",
        );
        if (choice === "Re-enable now") {
          try {
            await disableBundledDaemonTunnel();
            await enableBundledDaemonTunnel();
            await this.postDaemonState({ restartEvents: true });
          } catch (err) {
            await this.postNotice("error", `Re-enable failed: ${(err as Error).message}`);
          }
        }
      }
    } catch {
      // best-effort — the warning is nice-to-have, not critical.
    }
  }

  private async postTunnelProviders(): Promise<void> {
    if (!this.view) return;
    try {
      const providers = await listBundledTunnelProviders();
      const activeProvider = getBundledActiveTunnelProvider();
      const ngrok = getBundledNgrokSettings();
      await this.view.webview.postMessage({
        type: "daemon:tunnel-providers",
        payload: {
          activeProvider,
          providers: providers.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            description: p.description,
            isActive: p.isActive,
            setup: p.setup,
          })),
          ngrok,
        },
      } satisfies ExtensionMessage);
    } catch (err) {
      debug(`[trace] postTunnelProviders failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async postOAuthConsents(): Promise<void> {
    if (!this.view) return;
    try {
      const consents = await listBundledOAuthConsents();
      await this.view.webview.postMessage({
        type: "daemon:oauth-consents",
        payload: { consents },
      } satisfies ExtensionMessage);
    } catch (err) {
      debug(`[trace] postOAuthConsents failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async postDaemonState(options: { ensure?: boolean; restartEvents?: boolean } = {}): Promise<void> {
    if (!this.view) {
      return;
    }

    debug(`[trace] postDaemonState enter options=${JSON.stringify(options)}`);
    try {
      if (options.ensure) {
        try {
          const daemon = await ensureBundledDaemon();
          debug(`[trace] ensureBundledDaemon OK pid=${daemon.pid} port=${daemon.port} url=${daemon.url}`);
        } catch (err) {
          const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
          debug(`[trace] ensureBundledDaemon FAILED: ${stack}`);
          // fall through so we still post whatever status we can
        }
      }

      const status = await getBundledDaemonStatus();
      const payload = this.toDaemonStatusPayload(status);
      debug(`[trace] postDaemonState status running=${status.running} healthy=${status.healthy} stale=${status.stale} pid=${payload.pid} port=${payload.port} tunnel=${payload.tunnel?.status}`);

      await this.view.webview.postMessage({
        type: "daemon:status-updated",
        payload,
      } satisfies ExtensionMessage);
      await this.view.webview.postMessage({
        type: "daemon:audit-tail",
        payload: { items: readBundledDaemonAuditTail(50) as DaemonAuditEntry[] },
      } satisfies ExtensionMessage);
      await this.postTunnelProviders();

      if (options.restartEvents && status.running && status.healthy) {
        await this.startDaemonEventStream();
      }
      debug("[trace] postDaemonState exit OK");
    } catch (err) {
      const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
      debug(`[trace] postDaemonState THREW: ${stack}`);
      throw err;
    }
  }

  private async startDaemonEventStream(): Promise<void> {
    if (!this.view) {
      return;
    }

    this.stopDaemonEventStream();
    const controller = new AbortController();
    this.daemonEventsAbort = controller;

    try {
      const daemon = await ensureBundledDaemon();
      const response = await fetch(`${daemon.url}/daemon/events`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${daemon.bearerToken}`,
          "x-perplexity-client-id": "vscode-dashboard",
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Could not subscribe to daemon events (${response.status}).`);
      }

      void this.readDaemonEvents(response.body, controller);
    } catch (err) {
      if (!controller.signal.aborted) {
        await this.postNotice("warning", `Daemon events unavailable: ${(err as Error).message}`);
      }
    }
  }

  private stopDaemonEventStream(): void {
    this.daemonEventsAbort?.abort();
    this.daemonEventsAbort = null;
  }

  private async readDaemonEvents(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeSseFrames(buffer, (event, payload) => {
          void this.handleDaemonEvent(event, payload);
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        await this.postNotice("warning", `Daemon event stream ended: ${(err as Error).message}`);
      }
    } finally {
      if (this.daemonEventsAbort === controller) {
        this.daemonEventsAbort = null;
      }
      reader.releaseLock();
    }
  }

  private async handleDaemonEvent(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.view) {
      return;
    }

    if (event === "daemon:ready") {
      await this.postDaemonState();
      return;
    }

    if (event === "daemon:tunnel-url") {
      const tunnel = normalizeTunnelState(payload);
      await this.view.webview.postMessage({
        type: "daemon:tunnel-url",
        payload: tunnel,
      } satisfies ExtensionMessage);
      await this.postDaemonState();
      if (tunnel.status === "crashed") {
        await this.postNotice("error", `Cloudflare tunnel crashed${tunnel.error ? `: ${tunnel.error}` : "."}`);
      }
      return;
    }

    if (event === "daemon:token-rotated") {
      await this.view.webview.postMessage({
        type: "daemon:token-rotated",
        payload: { rotatedAt: typeof payload.rotatedAt === "string" ? payload.rotatedAt : new Date().toISOString() },
      } satisfies ExtensionMessage);
      this.onMcpServerDefinitionsChanged?.();
      await this.postDaemonState({ restartEvents: true });
    }

    if (event === "daemon:tunnel-auto-disabled") {
      const failures = typeof payload.failures === "number" ? payload.failures : 0;
      const windowMs = typeof payload.windowMs === "number" ? payload.windowMs : 60_000;
      await this.postNotice(
        "error",
        `Tunnel auto-disabled after ${failures} auth failures in ${Math.round(windowMs / 1000)}s. ` +
          "Rotate your bearer token if you suspect a leak, then re-enable the tunnel.",
      );
      await this.postDaemonState();
    }

    if (event === "daemon:oauth-consent-request") {
      const consentId = typeof payload.consentId === "string" ? payload.consentId : null;
      const clientId = typeof payload.clientId === "string" ? payload.clientId : "unknown";
      const clientName = typeof payload.clientName === "string" ? payload.clientName : clientId;
      const redirectUri = typeof payload.redirectUri === "string" ? payload.redirectUri : "";
      if (!consentId) {
        return;
      }
      const approve = "Approve";
      const deny = "Deny";
      const choice = await vscode.window.showWarningMessage(
        `An MCP client is requesting access to your Perplexity session.\n\n` +
          `Client: ${clientName}\n` +
          `Client ID: ${clientId}\n` +
          `Redirect: ${redirectUri}\n\n` +
          `Approve only if you just initiated this flow from that application.`,
        { modal: true },
        approve,
        deny,
      );
      const approved = choice === approve;
      try {
        const daemon = await ensureBundledDaemon();
        await fetch(`${daemon.url}/daemon/oauth-consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${daemon.bearerToken}`,
            "x-perplexity-source": "loopback",
          },
          body: JSON.stringify({ consentId, approved }),
        });
      } catch (err) {
        debug(`[trace] oauth-consent post failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  }

  private toDaemonStatusPayload(status: Awaited<ReturnType<typeof getBundledDaemonStatus>>): DaemonStatusState {
    const health = status.health;
    const record = status.record;
    const port = health?.port ?? record?.port ?? null;
    const url = port ? `http://127.0.0.1:${port}` : null;

    return {
      running: status.running,
      healthy: status.healthy,
      stale: status.stale,
      configDir: status.configDir,
      lockPath: status.lockPath,
      tokenPath: status.tokenPath,
      pid: health?.pid ?? record?.pid ?? null,
      uuid: health?.uuid ?? record?.uuid ?? null,
      port,
      url,
      version: health?.version ?? record?.version ?? null,
      startedAt: health?.startedAt ?? record?.startedAt ?? null,
      uptimeMs: health?.uptimeMs ?? null,
      heartbeatCount: typeof health?.heartbeatCount === "number" ? health.heartbeatCount : null,
      tunnel: normalizeTunnelState({
        status: health?.tunnel?.status,
        url: health?.tunnel?.url ?? record?.tunnelUrl ?? null,
        pid: health?.tunnel?.pid ?? record?.cloudflaredPid ?? null,
        error: health?.tunnel?.error ?? null,
      }),
      bearerToken: record?.bearerToken ?? null,
    };
  }

  async postNotice(level: "info" | "warning" | "error", message: string): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage({
      type: "notice",
      payload: { level, message }
    } satisfies ExtensionMessage);
  }

  private async postActionResult(id: string | undefined, ok: boolean, error?: string): Promise<void> {
    if (!this.view || !id) return;
    await this.view.webview.postMessage({ type: "action:result", id, ok, error });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`workbench.view.extension.${EXTENSION_ID}`);
    await vscode.commands.executeCommand(`${EXTENSION_ID}.dashboard.focus`);
  }
}

function normalizeTunnelState(payload: Record<string, unknown>): DaemonTunnelState {
  const rawStatus = typeof payload.status === "string" ? payload.status : "disabled";
  const status: DaemonTunnelState["status"] =
    rawStatus === "starting" || rawStatus === "enabled" || rawStatus === "crashed"
      ? rawStatus
      : "disabled";

  return {
    status,
    url: typeof payload.url === "string" && payload.url.length > 0 ? payload.url : null,
    pid: typeof payload.pid === "number" ? payload.pid : null,
    error: typeof payload.error === "string" && payload.error.length > 0 ? payload.error : null,
  };
}

function consumeSseFrames(
  buffer: string,
  onFrame: (event: string, payload: Record<string, unknown>) => void,
): string {
  while (true) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) {
      return buffer;
    }

    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (!frame.trim()) {
      continue;
    }

    let event = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith("event:")) {
        event = rawLine.slice(6).trim();
      } else if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).trim());
      }
    }

    if (!dataLines.length) {
      continue;
    }

    try {
      onFrame(event, JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
    } catch {
      // Ignore malformed daemon SSE frames.
    }
  }
}
