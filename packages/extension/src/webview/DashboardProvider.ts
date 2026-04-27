import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  EXTENSION_ID,
  IDE_METADATA,
  type DaemonAuditEntry,
  type DaemonStatusState,
  type DaemonTunnelState,
  type DashboardState,
  type ExtensionMessage,
  type McpTransportId,
  type TunnelPerformanceSnapshot,
  type TunnelProbeResult,
  type TunnelProbeTarget,
  type TunnelProviderIdShared,
  type WebviewMessage
} from "@perplexity-user-mcp/shared";
import type { AuthManager, AuthState } from "../mcp/auth-manager.js";
import {
  getIdeStatuses,
  removeTarget,
  syncRulesForIde,
  removeRulesForIde,
  getRulesStatuses
} from "../auto-config/index.js";
import type { IdeTarget } from "@perplexity-user-mcp/shared";
import { getAccountSnapshot, setLastRefreshTier } from "../auth/session.js";
import { ensureVaultPassphrase, peekStoredVaultPassphrase } from "../auth/vault-passphrase.js";
import { withScopedVaultPassphrase } from "../auth/scoped-env.js";
import { createExtensionAwareRunDoctor } from "../diagnostics/doctor-runner.js";
import { log, debug, getOutputRingBuffer } from "../extension.js";
import { captureDiagnostics } from "../diagnostics/capture.js";
import { handleDiagnosticsCapture } from "../diagnostics/flow.js";
import { redactMessage, redactObject } from "../redact.js";
import { REVEAL_CONFIRM_LABEL, runBearerRevealGate } from "./bearer-reveal-gate.js";
import { detectStaleConfigs } from "./staleness-detector.js";
import {
  regenerateStaleIdes,
  type RegenerateStaleIdesDeps,
} from "./staleness-auto-regen.js";
import { handleTransportSelect } from "./transport-select-handler.js";
import { TunnelEnableRecorder } from "./tunnel-enable-recorder.js";
import { parseTunnelPerformance } from "./tunnel-performance.js";
import { confirmTunnelSwitch } from "./tunnel-switch-confirm.js";
import {
  handleCfNamedCreate,
  handleCfNamedDeleteRemote,
  handleCfNamedList,
  handleCfNamedLogin,
  handleCfNamedUnbindLocal,
  type CfNamedDeps,
} from "./cf-named-handlers.js";
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
  clearCfNamedConfig,
  createCfNamedTunnel,
  deleteCfNamedTunnel,
  disableBundledDaemonTunnel,
  enableBundledDaemonTunnel,
  ensureBundledDaemon,
  getBundledActiveTunnelProvider,
  getBundledCfNamedState,
  getBundledDaemonStatus,
  getBundledNgrokSettings,
  installBundledCloudflared,
  isCloudflaredInstalled,
  killBundledDaemon,
  listBundledOAuthClients,
  listBundledOAuthConsents,
  listBundledTunnelProviders,
  listCfNamedTunnels,
  readBundledDaemonAuditTail,
  readCfNamedConfig,
  restartBundledDaemon,
  revokeAllBundledOAuthClients,
  revokeAllBundledOAuthConsents,
  revokeBundledOAuthClient,
  revokeBundledOAuthConsent,
  rotateBundledDaemonToken,
  runCfNamedLogin,
  setBundledActiveTunnelProvider,
  setBundledNgrokAuthtoken,
  setBundledNgrokDomain,
} from "../daemon/runtime.js";

export class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private authManager?: AuthManager;
  private otpResolvers = new Map<string, (s: string | null) => void>();
  private onMcpServerDefinitionsChanged?: () => void;
  private daemonEventsAbort: AbortController | null = null;
  // v0.8.5: deps factory injected from extension.ts so the auto-regen hook
  // on `postStaleness` can reuse the live ApplyIdeConfigDeps without pulling
  // the daemon runtime singletons into the webview module.
  private autoRegenDepsFactory: RegenerateStaleIdesDeps | null = null;
  // Cache the most-recent doctor report so "Report issue" can reuse it instead
  // of re-running all 10 checks. Cleared when the user clicks Run again.
  private lastDoctorReport: unknown = null;
  // v0.8.5: session-local ring buffer of tunnel enable timings. Populated by
  // the `daemon:enable-tunnel` handler (click-time timestamp) and finalised
  // in `postDaemonState` when we observe tunnel.status === "enabled" for the
  // first time after a click. Read back out via `postTunnelPerformance`.
  private readonly enableRecorder = new TunnelEnableRecorder();
  // Click-time metadata for an in-flight tunnel enable. `null` when no
  // enable is pending. Set synchronously in the `daemon:enable-tunnel`
  // handler before any await so the recorder sees a monotonic wall-clock.
  private pendingTunnelEnable:
    | { provider: TunnelProviderIdShared; startedAt: string; startPerf: number }
    | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setAuthManager(m: AuthManager): void {
    this.authManager = m;
  }

  setOnMcpServerDefinitionsChanged(fn: () => void): void {
    this.onMcpServerDefinitionsChanged = fn;
  }

  /**
   * v0.8.5: inject the deps factory the staleness auto-regen hook uses. This
   * stays in extension.ts because buildApplyIdeConfigDepsLive closes over the
   * extension context (workspaceState, daemon runtime, vscode.window prompts).
   * DashboardProvider must not grow an import on those.
   */
  setAutoRegenDeps(factory: RegenerateStaleIdesDeps): void {
    this.autoRegenDepsFactory = factory;
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
      webviewView.webview.html = `<!DOCTYPE html><html><body style="padding:16px;font-family:sans-serif;color:#f8fafc;background:#0f172a"><h2>Perplexity Dashboard Error</h2><pre style="white-space:pre-wrap;color:#fca5a5">${msg.replace(/</g, "&lt;")}</pre><p>Check Output &gt; Perplexity MCP for details.</p></body></html>`;
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
        const safeArgs = redactObject(args);
        const serialized = safeArgs.map((a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ");
        debug(`[webview/${level}] ${ts} ${serialized}`);
        return;
      }
      debug(`Webview message received: ${redactMessage(JSON.stringify(message))}`);
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
              // DashboardProvider doesn't own the deps factory (that lives in
              // extension.ts with workspaceState access). For the webview-driven
              // regenerate we defer to the command so the same deps apply.
              // v0.8.4 — the command itself now posts success / failure notices
              // (including the "N failures" error modal). Don't emit a blanket
              // "MCP config written" notice here; it would overwrite the
              // actionable failure notice the command just emitted.
              await vscode.commands.executeCommand(
                "Perplexity.generateConfigs",
                message.payload.target
              );
              void settings;
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
            // v0.8.5: enableTunnels=false triggers a confirm modal + atomic
            // tunnel shutdown before the setting flip. The check happens here
            // (not on the webview) so the modal + daemon call run as a single
            // host-side transaction. Other keys in the same payload are still
            // applied even when the user cancels the tunnel opt-out.
            if (message.payload.enableTunnels === false) {
              const status = await getBundledDaemonStatus().catch(() => null);
              const tunnelActive =
                status?.health?.tunnel?.status === "enabled" ||
                status?.health?.tunnel?.status === "starting";
              const choice = await vscode.window.showWarningMessage(
                "Disable tunnel options?",
                {
                  modal: true,
                  detail: tunnelActive
                    ? "The active tunnel will shut down. http-loopback and stdio configs remain working."
                    : "The dashboard will hide tunnel controls. http-loopback and stdio configs remain working.",
                },
                "Disable",
              );
              if (choice !== "Disable") {
                // Strip the enableTunnels toggle from the partial so any
                // co-sent keys still apply, then refresh so the UI stays
                // consistent with the unchanged value.
                const rest = { ...message.payload };
                delete rest.enableTunnels;
                if (Object.keys(rest).length > 0) {
                  await updateSettings(rest);
                }
                await this.refresh();
                break;
              }
              if (tunnelActive) {
                try {
                  await disableBundledDaemonTunnel();
                } catch (err) {
                  // Log + surface but continue flipping the setting — the
                  // user asked to hide tunnel UI and we shouldn't trap them
                  // with a stuck tunnel if shutdown races a crashed process.
                  debug(
                    `disable-tunnel during enableTunnels=false failed: ${(err as Error).message}`,
                  );
                  await this.postNotice(
                    "warning",
                    `Tunnel shutdown reported: ${(err as Error).message}`,
                  );
                }
              }
            }
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
                // v0.8.6: Linux-viable unseal. Keytar-happy machines short-circuit
                // inside the provider; headless Linux prompts once via SecretStorage.
                passphraseProvider: () => ensureVaultPassphrase(this.context),
              });
              const result = await runLogin(mode);

              // v0.8.6: post a user-facing notice that includes the runner's real
              // error message (not just the `reason` enum). Truncation happens in
              // the auth manager so the detail fits a toast.
              const loginFailedNotice = (reason: string, error?: string, detail?: string) => {
                const text = error && error !== reason
                  ? `Login failed for '${profile}' (${reason}): ${error}`
                  : `Login failed for '${profile}': ${reason}`;
                void this.postNotice("error", text);
                if (detail && detail !== error) {
                  debug(`[login:${profile}] detail: ${detail}`);
                }
              };

              if (!result.ok && result.reason === "auto_unsupported" && mode === "auto") {
                await this.postNotice("info", "Auto login could not continue with the current site response — opening manual login instead.");
                const fallback = await runLogin("manual");
                if (!fallback.ok) {
                  loginFailedNotice(fallback.reason ?? "manual-fallback-failed", fallback.error, fallback.detail);
                  await this.postActionResult(message.id, false, fallback.reason ?? "manual-fallback-failed");
                } else {
                  this.onMcpServerDefinitionsChanged?.();
                  await this.postActionResult(message.id, true);
                }
              } else if (!result.ok) {
                loginFailedNotice(result.reason ?? "login_failed", result.error, result.detail);
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
              const runDoctorBound = this.buildRunDoctor();
              const report = await runDoctorBound({
                probe: message.type === "doctor:probe",
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
                const runDoctorBound = this.buildRunDoctor();
                const report = await runDoctorBound();
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
                const runDoctorBound = this.buildRunDoctor();
                report = await runDoctorBound();
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
              // v0.8.5: confirm gate. Read pre-switch state so the modal can
              // tell the user what will be disrupted. We inspect the live
              // daemon status for the "tunnel actually enabled right now"
              // signal (matches the existing hasTunnel check in
              // daemon:clear-ngrok-settings) and use the settings file for the
              // currently-selected provider.
              const beforeStatus = await getBundledDaemonStatus();
              const currentTunnelEnabled = Boolean(
                beforeStatus.health?.tunnel?.url ?? beforeStatus.record?.tunnelUrl,
              );
              const currentProvider = getBundledActiveTunnelProvider();
              const confirmed = await confirmTunnelSwitch({
                nextProvider: providerId,
                deps: {
                  showWarningMessage: vscode.window.showWarningMessage,
                  currentProvider,
                  currentTunnelEnabled,
                },
              });
              if (!confirmed) {
                // User cancelled — not a failure. Clear the spinner and bail.
                await this.postActionResult(message.id, true);
                break;
              }

              const wasRunning = beforeStatus.record?.tunnelUrl != null;
              if (wasRunning) {
                await disableBundledDaemonTunnel();
              }
              setBundledActiveTunnelProvider(providerId);
              await this.postTunnelProviders();
              const providerLabel =
                providerId === "ngrok"
                  ? "ngrok"
                  : providerId === "cf-named"
                    ? "Cloudflare Named Tunnel"
                    : "Cloudflare Quick";
              await this.postNotice("info", `Active tunnel provider set to ${providerLabel}. Click Enable to start it.`);
              // v0.8.5: re-run staleness so the banner reflects the new
              // provider immediately. The tunnel URL is gone at this point (we
              // disabled it above), so any http-tunnel IDE should now flag as
              // stale until the user re-enables + regenerates.
              await this.postStaleness(await getBundledDaemonStatus());
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
              const activeProvider = getBundledActiveTunnelProvider();
              const status = await getBundledDaemonStatus();
              const hasTunnel = Boolean(status.health?.tunnel?.url ?? status.record?.tunnelUrl);
              if (activeProvider === "ngrok" && hasTunnel) {
                await disableBundledDaemonTunnel();
              }
              clearBundledNgrokSettings();
              await this.postTunnelProviders();
              await this.postDaemonState({ restartEvents: true });
              await this.postNotice("info", "ngrok local settings deleted. Remote ngrok endpoints/domains remain in the ngrok dashboard.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:install-cloudflared": {
            // Simple passthrough — the cf-named widget uses this when the
            // user clicks "Install cloudflared" in the missing-binary state.
            // The enable-tunnel path has its own inline install prompt; this
            // message lets the cf-named widget trigger the same install
            // without also enabling a tunnel.
            try {
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
              await this.postTunnelProviders();
              await this.postNotice("info", "cloudflared installed.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:cf-named-login": {
            // Delegate to the pure helper so tests can exercise the modal +
            // runtime wiring without a webview host. The helper posts the
            // result message in every branch (cancel / ok / error).
            const deps = this.makeCfNamedDeps();
            const outcome = await handleCfNamedLogin(message.id, deps);
            debug(`[cf-named] post-login: handler returned outcome=${outcome}`);
            if (outcome === "ok") {
              await this.postTunnelProviders();
              debug(`[cf-named] post-login: postTunnelProviders done`);
              await this.postNotice("info", "cloudflared login complete.");
              debug(`[cf-named] post-login: postNotice done`);
              await this.postActionResult(message.id, true);
              debug(`[cf-named] post-login: postActionResult done`);
            } else {
              await this.postActionResult(message.id, false, outcome);
            }
            break;
          }
          case "daemon:cf-named-create": {
            const deps = this.makeCfNamedDeps();
            const outcome = await handleCfNamedCreate(message.id, message.payload, deps);
            if (outcome === "ok") {
              await this.postTunnelProviders();
              await this.postNotice(
                "info",
                message.payload.mode === "create"
                  ? `Created tunnel "${message.payload.name}" → ${message.payload.hostname}.`
                  : `Bound existing tunnel → ${message.payload.hostname}.`,
              );
              await this.postActionResult(message.id, true);
            } else {
              await this.postActionResult(message.id, false, outcome);
            }
            break;
          }
          case "daemon:cf-named-list": {
            const deps = this.makeCfNamedDeps();
            const outcome = await handleCfNamedList(message.id, deps);
            await this.postActionResult(message.id, outcome === "ok");
            break;
          }
          case "daemon:cf-named-unbind-local": {
            const deps = this.makeCfNamedDeps();
            const outcome = await handleCfNamedUnbindLocal(message.id, message.payload, deps);
            if (outcome === "ok") {
              await this.postTunnelProviders();
              await this.postDaemonState({ restartEvents: true });
              await this.postNotice("info", "Cloudflare named tunnel local config unbound.");
              await this.postActionResult(message.id, true);
            } else {
              await this.postActionResult(message.id, false, outcome);
            }
            break;
          }
          case "daemon:cf-named-delete-remote": {
            const deps = this.makeCfNamedDeps();
            const outcome = await handleCfNamedDeleteRemote(message.id, message.payload, deps);
            if (outcome === "ok") {
              await this.postTunnelProviders();
              await this.postDaemonState({ restartEvents: true });
              await this.postNotice("warning", `Deleted remote Cloudflare tunnel "${message.payload.name}". Remove the DNS CNAME for ${message.payload.hostname ?? "the hostname"} in Cloudflare DNS if it still exists.`);
              await this.postActionResult(message.id, true);
            } else {
              await this.postTunnelProviders();
              await this.postDaemonState({ restartEvents: true });
              await this.postActionResult(message.id, false, outcome);
            }
            break;
          }
          case "daemon:tunnel-probe": {
            await this.handleTunnelProbe(message);
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

            // v0.8.5: start the perf timer only AFTER the user confirms. The
            // modal open time is not a tunnel metric — it's UX time. We use
            // performance.now() for duration (monotonic, immune to clock
            // changes) and Date for the display timestamp.
            const provider = getBundledActiveTunnelProvider();
            const startPerf = performance.now();
            const startedAt = new Date().toISOString();
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
              this.enableRecorder.record({
                provider,
                startedAt,
                durationMs: performance.now() - startPerf,
                ok: true,
              });
              await this.postDaemonState({ ensure: true, restartEvents: true });
              await this.postNotice("info", "Cloudflare Quick Tunnel enabled for the daemon.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              const message_ = (err as Error).message;
              this.enableRecorder.record({
                provider,
                startedAt,
                durationMs: performance.now() - startPerf,
                ok: false,
              });
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
          case "daemon:bearer:copy": {
            const confirm = await vscode.window.showWarningMessage(
              "Copy the daemon bearer to your clipboard?",
              { modal: true, detail: "Anyone on this machine with clipboard access can read it while it sits there. The clipboard is not auto-cleared." },
              "Copy to clipboard",
            );
            if (confirm !== "Copy to clipboard") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }
            try {
              const daemon = await getBundledDaemonStatus();
              if (!daemon.record?.bearerToken) throw new Error("Daemon is not running.");
              await vscode.env.clipboard.writeText(daemon.record.bearerToken);
              await this.postNotice("info", "Daemon bearer copied to clipboard.");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "daemon:bearer:reveal": {
            const confirm = await vscode.window.showWarningMessage(
              "Show the daemon bearer in the dashboard for 30 seconds?",
              { modal: true, detail: "The token will auto-clear from the dashboard after 30 seconds. It is not persisted anywhere by the dashboard." },
              "Show for 30 seconds",
            );
            if (confirm !== "Show for 30 seconds") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }
            try {
              const daemon = await getBundledDaemonStatus();
              if (!daemon.record?.bearerToken) throw new Error("Daemon is not running.");
              const nonce = crypto.randomUUID();
              await this.view?.webview.postMessage({
                type: "daemon:bearer:reveal:response",
                id: message.id,
                payload: { bearer: daemon.record.bearerToken, expiresInMs: 30_000, nonce },
              } satisfies ExtensionMessage);
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "oauth-clients:list": {
            try {
              await this.postOAuthClients();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "oauth-clients:revoke": {
            const clientId = message.payload.clientId;
            const confirm = await vscode.window.showWarningMessage(
              `Revoke access for "${clientId}"?`,
              {
                modal: true,
                detail:
                  "All outstanding access tokens for this client will be invalidated. The client must go through /register + /authorize again to reconnect.",
              },
              "Revoke access",
            );
            if (confirm !== "Revoke access") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }
            try {
              const ok = await revokeBundledOAuthClient(clientId);
              await this.postOAuthClients();
              await this.postNotice(
                ok ? "info" : "warning",
                ok ? `Revoked ${clientId}.` : `No client with id ${clientId}.`,
              );
              await this.postActionResult(message.id, ok);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "oauth-clients:revoke-all": {
            let current: Awaited<ReturnType<typeof listBundledOAuthClients>> = [];
            try {
              current = await listBundledOAuthClients();
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
              break;
            }
            const confirm = await vscode.window.showWarningMessage(
              `Revoke access for ${current.length} OAuth client${current.length === 1 ? "" : "s"}?`,
              {
                modal: true,
                detail: `All outstanding access tokens for every registered client will be invalidated. Affected:\n${current
                  .map((c) => `- ${c.clientName ?? c.clientId}`)
                  .join("\n")}`,
              },
              "Revoke all",
            );
            if (confirm !== "Revoke all") {
              await this.postActionResult(message.id, false, "cancelled");
              break;
            }
            try {
              const removed = await revokeAllBundledOAuthClients();
              await this.postOAuthClients();
              await this.postNotice("info", `Revoked ${removed} client${removed === 1 ? "" : "s"}.`);
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
          case "transport:select": {
            try {
              const { ideTag, transportId } = message.payload;
              const outcome = await handleTransportSelect(
                { ideTag, transportId },
                {
                  readTransportByIde: () =>
                    vscode.workspace
                      .getConfiguration("Perplexity")
                      .get<Record<string, McpTransportId>>("mcpTransportByIde", {}),
                  writeTransportByIde: async (next) => {
                    await vscode.workspace
                      .getConfiguration("Perplexity")
                      .update("mcpTransportByIde", next, vscode.ConfigurationTarget.Global);
                  },
                },
              );
              if (outcome.ok) {
                // Post a fresh settings snapshot so the webview sees the update.
                await this.refresh();
                await this.postActionResult(message.id, true);
              } else {
                await this.postActionResult(message.id, false, outcome.reason);
              }
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "transport:regenerate-stale": {
            try {
              // Route through the existing command so user-facing modals +
              // staleness recomputation land through a single path.
              await vscode.commands.executeCommand("Perplexity.generateConfigs", "all");
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "browser:select": {
            try {
              if (!this.authManager) {
                await this.postActionResult(message.id, false, "AuthManager not ready");
                break;
              }
              const { mode, channel, executablePath, label } = message.payload;
              const choice = mode === "custom" && executablePath
                ? { mode, channel, executablePath, label }
                : mode === "auto" && (channel || executablePath)
                  ? { mode, channel, executablePath, label }
                  : { mode }; // pure auto: reset to first-available
              // Persist to VS Code settings so the pick survives restarts.
              // Passing `null` clears the custom setting when the user chooses
              // pure auto so the schema doesn't hold a stale object forever.
              await vscode.workspace.getConfiguration("Perplexity").update(
                "browserChoice",
                choice.mode === "auto" && !choice.executablePath && !choice.channel ? null : choice,
                vscode.ConfigurationTarget.Global,
              );
              this.authManager.setBrowserChoice(choice);
              await this.postActionResult(message.id, true);
              await this.refresh();
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "browser:refresh-detection": {
            try {
              if (!this.authManager) {
                await this.postActionResult(message.id, false, "AuthManager not ready");
                break;
              }
              this.authManager.refreshBrowserDetection();
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "browser:pick-custom": {
            try {
              // Native VS Code file picker so the path value is validated and
              // normalized for the current platform (preserves spaces in
              // "/Applications/Google Chrome.app/…" on macOS, etc.).
              const filters = process.platform === "win32"
                ? { Executables: ["exe"] }
                : undefined;
              const uri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: "Use this browser",
                title: "Select a Chromium-based browser executable",
                ...(filters ? { filters } : {}),
              });
              if (!uri || uri.length === 0) {
                await this.postActionResult(message.id, true);
                break;
              }
              if (this.authManager) {
                const fsPath = uri[0].fsPath;
                const label = path.basename(fsPath);
                const choice = {
                  mode: "custom" as const,
                  channel: "chromium" as const,
                  executablePath: fsPath,
                  label: label.replace(/\.(exe|app)$/i, "") || label,
                };
                await vscode.workspace.getConfiguration("Perplexity").update(
                  "browserChoice",
                  choice,
                  vscode.ConfigurationTarget.Global,
                );
                this.authManager.setBrowserChoice(choice);
                await this.refresh();
              }
              await this.postActionResult(message.id, true);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "browser:install-bundled": {
            try {
              if (!this.authManager) {
                await this.postActionResult(message.id, false, "AuthManager not ready");
                break;
              }
              debug("[browser:install-bundled] starting patchright install chromium");
              const state = await this.authManager.downloadBundledChromium();
              debug(`[browser:install-bundled] finished status=${state.status}${state.error ? ` error=${state.error}` : ""}`);
              await this.postActionResult(message.id, state.status !== "error", state.error);
            } catch (err) {
              const msg = (err as Error).message;
              debug(`[browser:install-bundled] threw: ${msg}`);
              await this.postActionResult(message.id, false, msg);
            }
            break;
          }
          case "browser:remove-bundled": {
            try {
              if (!this.authManager) {
                await this.postActionResult(message.id, false, "AuthManager not ready");
                break;
              }
              const ok = await this.authManager.removeBundledChromium();
              await this.postActionResult(message.id, ok);
            } catch (err) {
              await this.postActionResult(message.id, false, (err as Error).message);
            }
            break;
          }
          case "diagnostics:capture": {
            try {
              // Closure-captured so the "Show in folder" handler in the
              // showInformationMessage lambda below can reveal the zip after
              // the toast is clicked — mirrors the Perplexity.captureDiagnostics
              // command-palette wire-up so the dashboard path gets the same
              // affordance.
              let savedPath: string | null = null;
              const outcome = await handleDiagnosticsCapture(
                message.id,
                {
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
                  runDoctor: this.buildRunDoctor(),
                  getConfigDir: () =>
                    process.env.PERPLEXITY_CONFIG_DIR ?? path.join(os.homedir(), ".perplexity-mcp"),
                  getLogsText: () => getOutputRingBuffer()?.snapshot() ?? "",
                  getExtensionVersion: () =>
                    String((this.context.extension.packageJSON as { version?: string }).version ?? "0.0.0"),
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
                  showErrorMessage: async (m) => vscode.window.showErrorMessage(m),
                },
                async (msg) => {
                  await this.view?.webview.postMessage(msg satisfies ExtensionMessage);
                },
              );
              // Map the outcome to postActionResult so the dashboard spinner
              // releases whether we succeeded, cancelled, or errored. Treat
              // cancellation as a user-initiated action (ok=true) — consistent
              // with cancel semantics elsewhere and so the spinner doesn't
              // render as a failure when the user just dismissed the dialog.
              if (outcome.kind === "ok") {
                await this.postActionResult(message.id, true);
              } else if (outcome.kind === "cancelled") {
                await this.postActionResult(message.id, true);
              } else {
                await this.postActionResult(message.id, false, outcome.error);
              }
            } catch (err) {
              // If handleDiagnosticsCapture itself throws (shouldn't happen
              // since it catches internally, but guard anyway so the spinner
              // always releases), post a failure result and log the detail.
              const detail = err instanceof Error ? err.message : String(err);
              log(`[diagnostics:capture] handler threw: ${detail}`);
              await this.postActionResult(message.id, false, detail);
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
    if (this.authManager) {
      await this.postAuthState(this.authManager.state);
    }
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
      // Scope PERPLEXITY_VAULT_PASSPHRASE around the call so headless-Linux
      // users (no keytar) can unseal vault.enc with the SecretStorage-stored
      // passphrase. Without this the in-process getMasterKey throws and the
      // silent catch in config.getSavedCookies returns [] → "no-cookies".
      const result = await withScopedVaultPassphrase(
        await peekStoredVaultPassphrase(this.context),
        () => refreshAccountInfo({ log: (line: string) => log(`[refresh] ${line}`) }),
      );
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

  /**
   * Build the dependency bundle the cf-named handlers consume. Lives on the
   * instance so the handlers always see the live webview post target (the
   * webview reference can change across a dispose/resolve cycle).
   */
  private makeCfNamedDeps(): CfNamedDeps {
    return {
      runCfNamedLogin: () => runCfNamedLogin(),
      createCfNamedTunnel: (params) => createCfNamedTunnel(params),
      listCfNamedTunnels: () => listCfNamedTunnels(),
      readCfNamedConfig: () => readCfNamedConfig(),
      clearCfNamedConfig: () => clearCfNamedConfig(),
      deleteCfNamedTunnel: (uuid) => deleteCfNamedTunnel(uuid),
      disableActiveTunnelIfNeeded: () => this.disableActiveTunnelIfNeeded(),
      showWarningMessage: async (msg, options, ...items) =>
        vscode.window.showWarningMessage(msg, options, ...items),
      post: async (m) => {
        await this.view?.webview.postMessage(m);
      },
      log: (msg) => debug(`[cf-named] ${msg}`),
    };
  }

  private async disableActiveTunnelIfNeeded(): Promise<void> {
    const status = await getBundledDaemonStatus();
    const tunnelStatus = status.health?.tunnel?.status;
    const hasUrl = Boolean(status.health?.tunnel?.url ?? status.record?.tunnelUrl);
    if (hasUrl || tunnelStatus === "enabled" || tunnelStatus === "starting") {
      await disableBundledDaemonTunnel();
    }
  }

  private async handleTunnelProbe(message: Extract<WebviewMessage, { type: "daemon:tunnel-probe" }>): Promise<void> {
    const timeoutMs = 5000 as const;
    const targets = normalizeProbeTargets(message.payload?.targets);
    try {
      const status = await getBundledDaemonStatus();
      const baseUrl = status.health?.tunnel?.url ?? status.record?.tunnelUrl ?? null;
      if (!baseUrl) {
        const checkedAt = new Date().toISOString();
        const results: TunnelProbeResult[] = targets.map((target) => ({
          target,
          cfMitigated: false,
          verdict: "retryable",
          checkedAt,
          error: "no-tunnel-url",
        }));
        await this.view?.webview.postMessage({
          type: "daemon:tunnel-probe:result",
          id: message.id,
          payload: { ok: false, results, timeoutMs, error: "no-tunnel-url" },
        } satisfies ExtensionMessage);
        await this.postActionResult(message.id, false, "no-tunnel-url");
        return;
      }

      const results = await Promise.all(targets.map((target) => probeTunnelTarget(baseUrl, target, timeoutMs)));
      await this.view?.webview.postMessage({
        type: "daemon:tunnel-probe:result",
        id: message.id,
        payload: { ok: true, results, timeoutMs },
      } satisfies ExtensionMessage);
      await this.postActionResult(message.id, true);
    } catch (err) {
      await this.view?.webview.postMessage({
        type: "daemon:tunnel-probe:result",
        id: message.id,
        payload: { ok: false, timeoutMs, error: err instanceof Error ? err.message : String(err) },
      } satisfies ExtensionMessage);
      await this.postActionResult(message.id, false, err instanceof Error ? err.message : String(err));
    }
  }

  private async postTunnelProviders(): Promise<void> {
    if (!this.view) return;
    try {
      debug(`[trace] postTunnelProviders enter`);
      const providers = await listBundledTunnelProviders();
      const activeProvider = getBundledActiveTunnelProvider();
      const ngrok = getBundledNgrokSettings();
      const cfNamed = getBundledCfNamedState();
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
          cfNamed,
        },
      } satisfies ExtensionMessage);
      debug(`[trace] postTunnelProviders exit OK active=${activeProvider} count=${providers.length} cf-named.ready=${providers.find((p) => p.id === "cf-named")?.setup.ready ?? "n/a"}`);
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

  private async postOAuthClients(): Promise<void> {
    if (!this.view) return;
    try {
      const clients = await listBundledOAuthClients();
      await this.view.webview.postMessage({
        type: "daemon:oauth-clients",
        payload: { clients },
      } satisfies ExtensionMessage);
    } catch (err) {
      debug(`[trace] postOAuthClients failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Phase 8.4 / v0.8.4 - Emit the staleness map to the webview. Called on
   * every successful postDaemonState so the dashboard reflects current reality
   * whenever the daemon port, tunnel URL, or bearer rotates. An empty array
   * is the explicit zero-signal (never `null`).
   */
  private async postStaleness(
    status: Awaited<ReturnType<typeof getBundledDaemonStatus>>,
  ): Promise<void> {
    if (!this.view) return;
    try {
      const settings = getSettingsSnapshot();
      const bundledServerPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "mcp",
        "server.mjs",
      ).fsPath;
      const ideStatus = getIdeStatuses(bundledServerPath, settings.chromePath);
      const daemonPort = status.health?.port ?? status.record?.port ?? null;
      const tunnelUrl = status.health?.tunnel?.url ?? status.record?.tunnelUrl ?? null;
      const daemonBearer = status.record?.bearerToken ?? null;
      // v0.8.5: trace the pipeline inputs so smoke logs prove the detector ran.
      debug(
        `[staleness] checking ${Object.keys(ideStatus).length} ides against ` +
          `daemonPort=${daemonPort} tunnelUrl=${tunnelUrl ?? "<none>"} ` +
          `bearerPresent=${Boolean(daemonBearer)}`,
      );
      const stale = detectStaleConfigs({
        ideStatus,
        daemonPort,
        tunnelUrl,
        daemonBearer,
        onSkip: (ideTag, reason) => {
          debug(`[staleness] skipped ${ideTag}: ${reason}`);
        },
      });
      await this.view.webview.postMessage({
        type: "transport:staleness",
        payload: { stale },
      } satisfies ExtensionMessage);
      // v0.8.5: success-path trace. Without this the smoke operator can't tell
      // whether the detector produced zero entries because everything was fresh
      // vs. because the pipeline silently errored out upstream.
      debug(
        `[staleness] posted ${stale.length} stale config${stale.length === 1 ? "" : "s"}` +
          (stale.length > 0
            ? ": " + stale.map((s) => `${s.ideTag}(${s.reason})`).join(", ")
            : ""),
      );

      // v0.8.5: auto-regenerate path. Gated on the injected deps factory AND
      // the `autoRegenerateStaleConfigs` setting (checked inside the helper).
      // The factory is injected in activateInner; absent in unit-test harnesses.
      if (this.autoRegenDepsFactory) {
        try {
          await regenerateStaleIdes(
            {
              stale,
              autoRegenerateStaleConfigs: settings.autoRegenerateStaleConfigs,
              mcpTransportByIde: settings.mcpTransportByIde,
              serverPath: LAUNCHER_PATH,
              chromePath: settings.chromePath || undefined,
            },
            this.autoRegenDepsFactory,
          );
        } catch (err) {
          debug(
            `[staleness] auto-regenerate batch threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      debug(`[trace] postStaleness failed: ${err instanceof Error ? err.message : String(err)}`);
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
      await this.postOAuthClients();
      await this.postStaleness(status);
      await this.postTunnelPerformance();

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
      // H12: `resource` is the RFC 8707 audience the client will bind its token
      // to. Showing it explicitly in the modal lets the user spot
      // cross-resource replay attempts (client approved for tunnel-A now asks
      // for tunnel-B). Absent = legacy / loopback client; render an
      // "(unbound — loopback-only)" hint so the difference is visible.
      const resource = typeof payload.resource === "string" && payload.resource.length > 0 ? payload.resource : null;
      if (!consentId) {
        return;
      }
      const approve = "Approve";
      const deny = "Deny";
      const resourceLine = resource
        ? `Resource: ${resource}\n`
        : `Resource: (unbound — loopback-only; legacy clients)\n`;
      const choice = await vscode.window.showWarningMessage(
        `An MCP client is requesting access to your Perplexity session.\n\n` +
          `Client: ${clientName}\n` +
          `Client ID: ${clientId}\n` +
          `Redirect: ${redirectUri}\n` +
          resourceLine +
          `\n` +
          `Approve only if you just initiated this flow from that application, ` +
          `and the resource above matches the MCP server URL you configured in it.`,
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

  /**
   * Dispatch a message from a VS Code command (no webview context). Today
   * only `daemon:bearer:copy` and `daemon:bearer:reveal` are wired here —
   * copy runs the same modal + clipboard write, reveal shows the bearer in
   * a modal information message with a Copy button since the webview may
   * not be open.
   */
  async dispatchFromCommand(message: { type: "daemon:bearer:copy" | "daemon:bearer:reveal"; id: string }): Promise<void> {
    if (message.type === "daemon:bearer:copy") {
      const confirm = await vscode.window.showWarningMessage(
        "Copy the daemon bearer to your clipboard?",
        { modal: true, detail: "Anyone on this machine with clipboard access can read it while it sits there. The clipboard is not auto-cleared." },
        "Copy to clipboard",
      );
      if (confirm !== "Copy to clipboard") return;
      try {
        const daemon = await getBundledDaemonStatus();
        if (!daemon.record?.bearerToken) throw new Error("Daemon is not running.");
        await vscode.env.clipboard.writeText(daemon.record.bearerToken);
        void vscode.window.showInformationMessage("Daemon bearer copied to clipboard.");
      } catch (err) {
        void vscode.window.showErrorMessage(`Copy daemon bearer failed: ${(err as Error).message}`);
      }
      return;
    }
    if (message.type === "daemon:bearer:reveal") {
      // H0: every reveal path MUST be explicit and modal-confirmed before the
      // bearer leaves the extension host. Route through the shared gate so
      // cancellation on the command-palette side can never emit a reveal
      // response. See packages/extension/src/webview/bearer-reveal-gate.ts.
      await runBearerRevealGate(message.id, {
        confirm: async () =>
          vscode.window.showWarningMessage(
            "Show the daemon bearer in the dashboard for 30 seconds?",
            {
              modal: true,
              detail: "The token will auto-clear from the dashboard after 30 seconds. It is not persisted anywhere by the dashboard.",
            },
            REVEAL_CONFIRM_LABEL,
          ),
        getBearer: async () => {
          const daemon = await getBundledDaemonStatus();
          return daemon.record?.bearerToken ?? null;
        },
        openDashboard: async () => {
          await this.reveal();
          await this.refresh();
        },
        postMessage: async (msg) => {
          await this.view?.webview.postMessage(msg satisfies ExtensionMessage);
        },
        showError: (text) => {
          void vscode.window.showErrorMessage(text);
        },
        randomNonce: () => crypto.randomUUID(),
      });
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
      bearerAvailable: Boolean(record?.bearerToken),
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

  private buildRunDoctor(): ReturnType<typeof createExtensionAwareRunDoctor> {
    return createExtensionAwareRunDoctor(this.context, {
      getChromePath: () => getSettingsSnapshot().chromePath,
      getVaultPassphrase: () => peekStoredVaultPassphrase(this.context),
    });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`workbench.view.extension.${EXTENSION_ID}`);
    await vscode.commands.executeCommand(`${EXTENSION_ID}.dashboard.focus`);
  }

  /**
   * v0.8.5: compute and post a tunnel-performance snapshot to the webview.
   * Combines the audit-derived slice (health latency + /mcp status ratios)
   * with the session-local enable-timing ring buffer. Best-effort — audit
   * read failures or parser glitches must not break the rest of the daemon
   * state flow, so we swallow + debug-log here.
   */
  private async postTunnelPerformance(): Promise<void> {
    if (!this.view) return;
    try {
      // Pull a larger window than the webview's audit-tail slice so the /mcp
      // ratios have meaningful denominators even when the user has been idle
      // for a while. 200 is a compromise — read cost is bounded by the
      // 10 MB audit log cap configured in the daemon.
      const auditTail = readBundledDaemonAuditTail(200) as DaemonAuditEntry[];
      const currentProvider = getBundledActiveTunnelProvider() as TunnelProviderIdShared;
      const base = parseTunnelPerformance(auditTail, currentProvider);
      const snapshot: TunnelPerformanceSnapshot = {
        ...base,
        // Enable history comes from the extension-host ring buffer, not the
        // audit log. See TunnelEnableRecorder for rationale.
        enableHistory: this.enableRecorder.snapshot().slice(),
      };
      await this.view.webview.postMessage({
        type: "tunnel:performance",
        payload: snapshot,
      } satisfies ExtensionMessage);
      debug(
        `[perf] posted enableHistory=${snapshot.enableHistory.length} health-avg=${
          snapshot.healthLatencyAvgMs ?? "n/a"
        }ms mcp-total=${snapshot.mcpTotal}`,
      );
    } catch (err) {
      debug(
        `[perf] postTunnelPerformance failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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

function normalizeProbeTargets(targets: TunnelProbeTarget[] | undefined): TunnelProbeTarget[] {
  const allowed = new Set<TunnelProbeTarget>(["/", "/mcp"]);
  const normalized = (targets ?? ["/", "/mcp"]).filter((target): target is TunnelProbeTarget => allowed.has(target));
  return normalized.length > 0 ? normalized : ["/", "/mcp"];
}

async function probeTunnelTarget(
  baseUrl: string,
  target: TunnelProbeTarget,
  timeoutMs: 5000,
): Promise<TunnelProbeResult> {
  const checkedAt = new Date().toISOString();
  const url = new URL(target, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    // Deliberately do not read the response body. Only status + headers cross
    // the webview boundary so challenge pages and daemon payloads never leak.
    void response.body?.cancel().catch(() => undefined);
    const cfMitigated = response.headers.get("cf-mitigated") === "challenge";
    return {
      target,
      status: response.status,
      cfMitigated,
      verdict: classifyProbeVerdict(target, response.status, cfMitigated),
      checkedAt,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      target,
      cfMitigated: false,
      verdict: "retryable",
      checkedAt,
      error: aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyProbeVerdict(
  target: TunnelProbeTarget,
  status: number,
  cfMitigated: boolean,
): TunnelProbeResult["verdict"] {
  if (cfMitigated && status === 403) return "challenge";
  if (target === "/mcp" && status === 200) return "security-flag";
  if (target === "/mcp" && status === 401) return "ok";
  if (status >= 500) return "retryable";
  if (target === "/" && status >= 200 && status < 400) return "ok";
  return "unknown";
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
