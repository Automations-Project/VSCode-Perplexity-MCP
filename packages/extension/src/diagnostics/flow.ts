/**
 * Dependency-injected flow for the unified diagnostics capture entry points.
 *
 * Both the `Perplexity.captureDiagnostics` VS Code command and the
 * `diagnostics:capture` dashboard message route through `runDiagnosticsCaptureFlow`
 * so the save-dialog, doctor-probe, capture, and result-reporting logic lives
 * in one place and can be exercised by unit tests without standing up the
 * VS Code host or the webview.
 *
 * `handleDiagnosticsCapture` is the dashboard-specific wrapper that posts a
 * `diagnostics:capture:result` ExtensionMessage back to the webview.
 */

import type { ExtensionMessage } from "@perplexity-user-mcp/shared";
import type { CaptureOptions, CaptureResult } from "./capture.js";
import { redactMessage } from "../redact.js";

export interface DiagnosticsFlowDeps {
  /**
   * Shows the OS save dialog with the given default absolute path. Returns
   * the chosen absolute path, or undefined when the user cancels.
   */
  showSaveDialog: (defaultPath: string) => Promise<string | undefined>;
  /** Concrete capture implementation. Production wires `./capture.js#captureDiagnostics`. */
  captureDiagnostics: (opts: CaptureOptions) => Promise<CaptureResult>;
  /**
   * Runs the doctor probe. May take 1-3s; we swallow any error and pass
   * `null` to the capture step so a broken doctor never blocks the bundle.
   */
  runDoctor: () => Promise<unknown>;
  getConfigDir: () => string;
  getLogsText: () => string | null | undefined;
  getExtensionVersion: () => string;
  getVscodeVersion: () => string;
  now?: () => Date;
  getHomedir?: () => string;
  showInformationMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
  showErrorMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
}

export type DiagnosticsFlowOutcome =
  | { kind: "cancelled" }
  | { kind: "ok"; result: CaptureResult }
  | { kind: "error"; error: string };

function sanitizeTimestamp(d: Date): string {
  // ISO with colons + dots replaced so the filename is valid on Windows.
  return d.toISOString().replace(/[:.]/g, "-");
}

function defaultSuggestedPath(deps: DiagnosticsFlowDeps): string {
  const now = (deps.now ?? (() => new Date()))();
  const home = deps.getHomedir ? deps.getHomedir() : "";
  const name = `perplexity-mcp-diagnostics-${sanitizeTimestamp(now)}.zip`;
  // posix-style join; the VS Code save-dialog normalises to the platform.
  const sep = home.endsWith("/") || home.endsWith("\\") ? "" : "/";
  const downloadsSeg = home ? `${home}${sep}Downloads/` : "";
  return `${downloadsSeg}${name}`;
}

export async function runDiagnosticsCaptureFlow(deps: DiagnosticsFlowDeps): Promise<DiagnosticsFlowOutcome> {
  const defaultPath = defaultSuggestedPath(deps);
  const outputPath = await deps.showSaveDialog(defaultPath);
  if (!outputPath) return { kind: "cancelled" };

  let doctorReport: unknown = null;
  try {
    doctorReport = await deps.runDoctor();
  } catch {
    doctorReport = null;
  }

  try {
    const result = await deps.captureDiagnostics({
      outputPath,
      configDir: deps.getConfigDir(),
      extensionVersion: deps.getExtensionVersion(),
      vscodeVersion: deps.getVscodeVersion(),
      logsText: deps.getLogsText() ?? null,
      doctorReport,
      now: deps.now,
    });
    await deps.showInformationMessage(`Diagnostics saved to ${result.outputPath}`);
    return { kind: "ok", result };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Redact before surfacing — the error may embed paths or tokens.
    const redacted = redactMessage(raw);
    await deps.showErrorMessage(`Diagnostics capture failed: ${redacted}`);
    return { kind: "error", error: redacted };
  }
}

/**
 * Dashboard dispatch: runs the flow and posts a typed result back to the
 * webview. The command-palette path does NOT use this wrapper — it calls
 * `runDiagnosticsCaptureFlow` directly because the webview may not be open.
 */
export async function handleDiagnosticsCapture(
  id: string,
  deps: DiagnosticsFlowDeps,
  post: (message: ExtensionMessage) => void | Promise<void>,
): Promise<void> {
  const outcome = await runDiagnosticsCaptureFlow(deps);
  if (outcome.kind === "ok") {
    await post({
      type: "diagnostics:capture:result",
      id,
      ok: true,
      outputPath: outcome.result.outputPath,
      bytesWritten: outcome.result.bytesWritten,
      sourcesIncluded: outcome.result.sourcesIncluded,
      sourcesMissing: outcome.result.sourcesMissing,
    });
    return;
  }
  const error = outcome.kind === "cancelled" ? "cancelled" : outcome.error;
  await post({
    type: "diagnostics:capture:result",
    id,
    ok: false,
    error,
  });
}
