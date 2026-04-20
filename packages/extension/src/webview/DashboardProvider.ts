import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  EXTENSION_ID,
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
import { readHistory, runDoctor } from "perplexity-user-mcp";
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

export class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private debugCollector?: DebugCollector;
  private authManager?: AuthManager;
  private otpResolvers = new Map<string, (s: string | null) => void>();
  private onMcpServerDefinitionsChanged?: () => void;
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

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
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
      history: readHistory(25),
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
