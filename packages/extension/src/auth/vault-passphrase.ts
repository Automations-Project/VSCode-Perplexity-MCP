// v0.8.6 — Linux-viable vault unseal path.
//
// Background: `packages/mcp-server/src/vault.js` `getMasterKey()` tries three
// sources in order: (1) OS keychain via keytar, (2) env var
// PERPLEXITY_VAULT_PASSPHRASE, (3) TTY prompt. In an IDE-spawned login runner
// stdio is piped (no TTY) and on headless Linux libsecret/gnome-keyring is
// often missing, which made the runner throw "Vault locked" and emit
// `{ ok: false, reason: "crash" }`. The user saw only "crash" in the dashboard.
//
// This helper closes that gap by providing the env-var leg: if keytar is NOT
// available we prompt for a passphrase via `showInputBox`, persist it in VS
// Code `SecretStorage` under a single per-user key, and return the stored
// value on subsequent logins. Callers pass it into the runner spawn env as
// PERPLEXITY_VAULT_PASSPHRASE so the runner's `hkdfFromPassphrase` path is
// used transparently.
//
// Zero change for users who already have a working keychain: `probeKeytar`
// returns true, this helper short-circuits with `{ passphrase: undefined }`,
// and the runner still uses keychain.

import { fork } from "node:child_process";
import { join } from "node:path";
import * as vscode from "vscode";

export const VAULT_PASSPHRASE_SECRET_KEY = "perplexity.vault.passphrase";
const PASSPHRASE_MIN_LEN = 8;

export interface PassphraseResult {
  /** The passphrase to pass via PERPLEXITY_VAULT_PASSPHRASE, or undefined when keytar is available. */
  passphrase: string | undefined;
  /**
   * "keytar"       → keychain present, no passphrase needed.
   * "stored"       → retrieved from SecretStorage.
   * "prompted"     → user typed a new passphrase, now stored.
   * "cancelled"    → user dismissed the prompt; login should abort with a clean message.
   */
  source: "keytar" | "stored" | "prompted" | "cancelled";
}

export interface EnsureVaultPassphraseDeps {
  /** Keytar probe. Should be cheap and not throw. */
  probeKeytar?: () => Promise<boolean>;
  /** Override the SecretStorage backing. Defaults to `context.secrets`. */
  secrets?: vscode.SecretStorage;
  /** Override the input prompt. Defaults to `vscode.window.showInputBox`. */
  showInputBox?: typeof vscode.window.showInputBox;
}

/**
 * Resolve a passphrase suitable for `PERPLEXITY_VAULT_PASSPHRASE`, or
 * signal that keytar handles unseal on its own.
 *
 * Order:
 *   1. If keytar works (native module loads and getPassword doesn't throw),
 *      return `{ passphrase: undefined, source: "keytar" }`. Caller should NOT
 *      set the env var — keychain wins in vault.js and setting the env var
 *      would trigger the "keychain-preferred" doctor warning.
 *   2. Look up the stored passphrase in SecretStorage.
 *   3. If absent, prompt the user once and store the result.
 *   4. If the user dismisses the prompt, return `{ source: "cancelled" }`.
 */
export async function ensureVaultPassphrase(
  context: vscode.ExtensionContext,
  deps: EnsureVaultPassphraseDeps = {},
): Promise<PassphraseResult> {
  const probe = deps.probeKeytar ?? (() => probeKeytarAvailable(context));
  const secrets = deps.secrets ?? context.secrets;
  const showInputBox = deps.showInputBox ?? vscode.window.showInputBox.bind(vscode.window);

  const keytarOk = await probe();
  if (keytarOk) {
    return { passphrase: undefined, source: "keytar" };
  }

  const existing = await secrets.get(VAULT_PASSPHRASE_SECRET_KEY);
  if (existing && existing.length > 0) {
    return { passphrase: existing, source: "stored" };
  }

  const entered = await showInputBox({
    prompt:
      "Your Perplexity extension needs a local encryption passphrase to store login cookies. " +
      "This is stored per-user via VS Code SecretStorage. 8+ chars recommended.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "Enter a passphrase (min 8 characters)",
    validateInput: (value) => {
      if (!value || value.length < PASSPHRASE_MIN_LEN) {
        return `Passphrase must be at least ${PASSPHRASE_MIN_LEN} characters.`;
      }
      return null;
    },
  });

  if (!entered || entered.length < PASSPHRASE_MIN_LEN) {
    return { passphrase: undefined, source: "cancelled" };
  }

  await secrets.store(VAULT_PASSPHRASE_SECRET_KEY, entered);
  return { passphrase: entered, source: "prompted" };
}

/**
 * Read the stored vault passphrase from SecretStorage without prompting. Used
 * by diagnostic flows (doctor, capture-diagnostics) that need the same unseal
 * material the runner would get but must not interrupt the user to ask for it.
 * Returns undefined when nothing is stored.
 */
export async function peekStoredVaultPassphrase(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const value = await context.secrets.get(VAULT_PASSPHRASE_SECRET_KEY);
  return value && value.length > 0 ? value : undefined;
}

/**
 * Best-effort probe: spawn a short-lived child that tries to `import("keytar")`
 * and call `getPassword` with a dummy lookup. We do not load keytar in-process
 * because the extension host runs one keytar per VS Code instance and loading
 * a broken native module can destabilize it; the child reports back with exit
 * code 0 on success and non-zero on any failure.
 *
 * On Linux this will fail when libsecret/gnome-keyring is absent. On Windows
 * and macOS it should succeed.
 */
export async function probeKeytarAvailable(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  // Use the bundled mcp-server probe so we agree with the runner's own
  // detection. The file lives at `dist/mcp/server.mjs` when packaged; the
  // runner scripts sit next to it. We spawn a 1-shot inline script so we don't
  // need a new dist entry.
  return new Promise<boolean>((resolve) => {
    const bundledServer = join(context.extensionUri.fsPath, "dist", "mcp", "server.mjs");
    // The probe script imports keytar from the bundled mcp-server's
    // node_modules. Relative require from the server file works because
    // prepare-package-deps copies keytar into `dist/node_modules`.
    const code = `
      (async () => {
        try {
          const mod = await import("keytar");
          const kt = mod.default ?? mod;
          if (!kt || typeof kt.getPassword !== "function") {
            process.exit(2);
          }
          await kt.getPassword("perplexity-user-mcp", "vault-master-key");
          process.exit(0);
        } catch {
          process.exit(3);
        }
      })();
    `;
    try {
      const child = fork("-", [], {
        execArgv: ["--input-type=module", "-e", code],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        cwd: bundledServer.replace(/[\\/]server\.mjs$/, ""),
      });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve(false);
      }, 3000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}
