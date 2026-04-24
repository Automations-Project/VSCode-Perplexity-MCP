// v0.8.6 — Extension-aware doctor wrapper.
//
// Doctor needs two pieces of context the raw `runDoctor()` export can't infer:
//
//   1. `baseDir` + `ideStatuses` so the bundled-runtime checks (patchright
//      resolution, got-scraping chain, package version, IDE audit) see the
//      VSIX's `dist/` tree rather than the dev workspace.
//   2. The vault passphrase, when one lives in VS Code SecretStorage. Without
//      this, doctor on a keytar-less Linux reports "vault locked: no keychain,
//      no env var, no TTY" even though the extension has a stored passphrase
//      that would unseal cookies fine.
//
// Historically the three doctor call sites in DashboardProvider constructed
// that context inline, but the two diagnostics-capture call sites passed the
// raw `runDoctor` — which is why the diagnostics zip's embedded
// doctor-report.json looked much worse than the live dashboard report. This
// factory is the single path now.
//
// Passphrase injection is scoped: we set `PERPLEXITY_VAULT_PASSPHRASE` in
// `process.env` around the `runDoctor` call and restore the prior value in a
// `finally`, so we never leave it dangling for other extension-host code.

import * as vscode from "vscode";
import { runDoctor as runDoctorCore } from "perplexity-user-mcp";
import { getIdeStatuses } from "../auto-config/index.js";

export interface ExtensionDoctorDeps {
  /** The extension's chromePath setting — drives IDE status detection. */
  getChromePath: () => string | undefined;
  /**
   * Resolve the stored vault passphrase without prompting. When provided and
   * a passphrase exists, it is injected as a scoped env var for the doctor
   * run so the vault check reports the correct unseal path.
   */
  getVaultPassphrase?: () => Promise<string | undefined>;
}

export interface RunDoctorExtras {
  probe?: boolean;
}

/**
 * Build a `runDoctor` function bound to the extension context. The returned
 * function is compatible with the `() => Promise<unknown>` signature the
 * diagnostics-capture flow expects, while also accepting optional extras like
 * `{ probe: true }` for the dashboard's doctor:probe path.
 */
export function createExtensionAwareRunDoctor(
  context: vscode.ExtensionContext,
  deps: ExtensionDoctorDeps,
): (extras?: RunDoctorExtras) => Promise<unknown> {
  return async (extras: RunDoctorExtras = {}) => {
    const bundledServerPath = vscode.Uri.joinPath(
      context.extensionUri,
      "dist",
      "mcp",
      "server.mjs",
    ).fsPath;
    const baseDir = vscode.Uri.joinPath(context.extensionUri, "dist").fsPath;
    const ideStatuses = getIdeStatuses(bundledServerPath, deps.getChromePath());

    const passphrase = deps.getVaultPassphrase ? await deps.getVaultPassphrase() : undefined;
    const options = { baseDir, ideStatuses, ...extras };

    if (!passphrase) {
      return runDoctorCore(options);
    }

    const key = "PERPLEXITY_VAULT_PASSPHRASE";
    const prev = process.env[key];
    process.env[key] = passphrase;
    try {
      return await runDoctorCore(options);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}
