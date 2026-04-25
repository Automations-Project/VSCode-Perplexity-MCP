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

import * as path from "node:path";
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
  /**
   * Variadic because the `Perplexity.captureDiagnostics` command wire-up
   * passes a "Show in folder" action button. The flow helper itself calls
   * this with zero items — the items parameter is retained only so the
   * command call-site can reuse the same dep shape.
   */
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
  // Use path.join so separator direction is consistent with the rest of the
  // codebase. When no home directory is available, fall back to just the name.
  return home ? path.join(home, "Downloads", name) : name;
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
    // Fire-and-forget: VS Code info notifications without an auto-dismiss
    // (and even some without action items) only resolve when the user clicks
    // the X. Awaiting that gates the dashboard spinner on user interaction
    // with a toast — leaving the "Capturing…" label stuck for minutes after
    // the zip is already on disk. The "Show in folder" action wired by the
    // command-palette caller still fires asynchronously when clicked, since
    // the underlying lambda runs to completion in the background.
    void Promise.resolve(deps.showInformationMessage(`Diagnostics saved to ${result.outputPath}`)).catch(() => {});
    return { kind: "ok", result };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Redact before surfacing — the error may embed paths or tokens.
    const redacted = redactMessage(raw);
    void Promise.resolve(deps.showErrorMessage(`Diagnostics capture failed: ${redacted}`)).catch(() => {});
    return { kind: "error", error: redacted };
  }
}

/**
 * Dashboard dispatch: runs the flow, posts a typed result back to the
 * webview, AND returns the outcome so the caller can map it to the
 * generic `action:result` (spinner) state. The command-palette path does
 * NOT use this wrapper — it calls `runDiagnosticsCaptureFlow` directly
 * because the webview may not be open.
 */
export async function handleDiagnosticsCapture(
  id: string,
  deps: DiagnosticsFlowDeps,
  post: (message: ExtensionMessage) => void | Promise<void>,
): Promise<DiagnosticsFlowOutcome> {
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
    return outcome;
  }
  const error = outcome.kind === "cancelled" ? "cancelled" : outcome.error;
  await post({
    type: "diagnostics:capture:result",
    id,
    ok: false,
    error,
  });
  return outcome;
}
