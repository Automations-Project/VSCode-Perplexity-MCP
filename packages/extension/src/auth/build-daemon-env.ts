import * as vscode from "vscode";
import { peekStoredVaultPassphrase } from "./vault-passphrase.js";

/**
 * Build the env-var overlay that `spawnBundledDaemon` merges into the daemon's
 * spawn environment. Today this is just the SecretStorage vault passphrase
 * (when one exists); future overlays can extend this without touching
 * `daemon/runtime.ts`. Called once per daemon spawn, never cached.
 *
 * Invariant: never mutates `process.env`. The returned object is consumed
 * by the spawn() call site and discarded.
 */
export async function buildDaemonEnv(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const passphrase = await peekStoredVaultPassphrase(context);
  if (passphrase && passphrase.length > 0) {
    env.PERPLEXITY_VAULT_PASSPHRASE = passphrase;
  }
  return env;
}
