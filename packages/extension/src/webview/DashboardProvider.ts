import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  EXTENSION_ID,
  type DashboardState,
  type ExtensionMessage,
  type WebviewMessage
} from "@perplexity/shared";
import type { AuthManager, AuthState } from "../mcp/auth-manager.js";
import {
  getIdeStatuses,
  removeTarget,
  configureTargets,
  syncRulesForIde,
  removeRulesForIde,
  getRulesStatuses
} from "../auto-config/index.js";
import type { IdeTarget } from "@perplexity/shared";
import { getAccountSnapshot, setLastRefreshTier } from "../auth/session.js";
import { log, debug } from "../extension.js";
import type { DebugCollector } from "../debug/collector.js";
import { readHistory } from "perplexity-user-mcp";
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  setDebugCollector(collector: DebugCollector): void {
    this.debugCollector = collector;
  }

  setAuthManager(m: AuthManager): void {
    this.authManager = m;
  }

  async postAuthState(s: AuthState): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({ type: "auth:state", payload: s });
  }

  async postProfileList(): Promise<void> {
    if (!this.view) return;
    const { listProfiles, getActiveName } = await import("perplexity-user-mcp/profiles" as string) as { listProfiles: () => unknown[]; getActiveName: () => string | null };
    await this.view.webview.postMessage({ type: "profile:list", payload: { active: getActiveName(), profiles: listProfiles() } });
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
              await vscode.commands.executeCommand("Perplexity.login");
              await this.postActionResult(message.id, true);
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
                const { IDE_METADATA } = await import("@perplexity/shared");
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
            let pendingId: string | undefined;
            await this.authManager.login({
              profile, mode, email,
              onOtpPrompt: () => new Promise<string | null>((resolve) => {
                pendingId = crypto.randomUUID();
                this.view?.webview.postMessage({ type: "auth:otp-prompt", payload: { profile, attempt: 0, email: email ?? "" } });
                this.otpResolvers.set(pendingId!, resolve);
              }),
            });
            await this.postActionResult(message.id, true);
            await this.refresh();
            break;
          }
          case "auth:otp-submit": {
            const first = [...this.otpResolvers.values()][0];
            if (first) first(message.payload.otp);
            this.otpResolvers.clear();
            break;
          }
          case "auth:logout": {
            if (!this.authManager) break;
            await this.authManager.logout(message.payload);
            await this.postActionResult(message.id, true);
            await this.refresh();
            break;
          }
          case "auth:dismiss-expired":
            break;
          case "profile:switch": {
            const { setActive } = await import("perplexity-user-mcp/profiles" as string) as { setActive: (n: string) => void };
            setActive(message.payload.name);
            await this.postActionResult(message.id, true);
            await this.postProfileList();
            await this.refresh();
            break;
          }
          case "profile:add": {
            const { createProfile } = await import("perplexity-user-mcp/profiles" as string) as { createProfile: (n: string, o: unknown) => unknown };
            try {
              createProfile(message.payload.name, { loginMode: message.payload.loginMode });
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            await this.postProfileList();
            break;
          }
          case "profile:delete": {
            const { deleteProfile } = await import("perplexity-user-mcp/profiles" as string) as { deleteProfile: (n: string) => void };
            deleteProfile(message.payload.name);
            await this.postActionResult(message.id, true);
            await this.postProfileList();
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
