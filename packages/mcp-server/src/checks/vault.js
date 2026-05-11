import { existsSync } from "node:fs";
import { join } from "node:path";
import { probeKeychainState } from "../vault.js";

const CATEGORY = "vault";

function keychainExpected() {
  return process.platform === "win32" || process.platform === "darwin" ||
    (process.platform === "linux" && !process.env.CI);
}

export async function run(opts = {}) {
  const results = [];
  const dir = opts.configDir;
  const profile = opts.profile ?? "default";
  const enc = join(dir, "profiles", profile, "vault.enc");
  const plain = join(dir, "profiles", profile, "vault.json");
  const envPass = process.env.PERPLEXITY_VAULT_PASSPHRASE;
  const kc = await probeKeychainState();

  // Encryption mode (separate from unseal path so plaintext opt-out is always a warn, not a skip).
  if (existsSync(plain)) {
    results.push({
      category: CATEGORY,
      name: "encryption",
      status: "warn",
      message: "plaintext vault.json (security.encryptCookies=false)",
      hint: "Re-run login without --plain-cookies to enable AES-256-GCM at rest.",
    });
  } else if (existsSync(enc)) {
    results.push({ category: CATEGORY, name: "encryption", status: "pass", message: "AES-256-GCM (vault.enc)" });
  } else {
    results.push({ category: CATEGORY, name: "encryption", status: "skip", message: "no vault yet" });
  }

  // Unseal path resolution, matching vault.js getMasterKey() priority.
  if (kc.hasKey) {
    results.push({ category: CATEGORY, name: "unseal-path", status: "pass", message: "OS keychain holds master key" });
    if (envPass) {
      results.push({
        category: CATEGORY,
        name: "keychain-preferred",
        status: "warn",
        message: "PERPLEXITY_VAULT_PASSPHRASE is also set — keychain wins, but consider removing the env var",
      });
    }
  } else if (envPass) {
    const hasKc = kc.available;
    results.push({
      category: CATEGORY,
      name: "unseal-path",
      status: "pass",
      message: `env var ${hasKc ? "(keychain available but empty)" : "(keychain unavailable — expected on headless Linux)"}`,
    });
    if (hasKc) {
      results.push({
        category: CATEGORY,
        name: "keychain-preferred",
        status: "warn",
        message: "keychain is available — moving the master key there would remove the passphrase from IDE config files",
        hint: "Run `npx perplexity-user-mcp login` once with the env var unset; the key will be written to keychain.",
      });
    } else {
      results.push({ category: CATEGORY, name: "keychain-preferred", status: "skip", message: "keychain not applicable" });
    }
  } else {
    // No keychain, no env var.
    if (!existsSync(enc) && !existsSync(plain)) {
      results.push({ category: CATEGORY, name: "unseal-path", status: "skip", message: "no vault to unseal yet" });
    } else if (existsSync(plain)) {
      results.push({ category: CATEGORY, name: "unseal-path", status: "pass", message: "plaintext — no key required" });
    } else {
      const ttyLikely = process.stdin?.isTTY === true;
      results.push({
        category: CATEGORY,
        name: "unseal-path",
        status: ttyLikely ? "warn" : "fail",
        message: ttyLikely
          ? "no keychain, no env var — TTY prompt will be required on next use"
          : "vault locked: no keychain, no env var, no TTY",
        hint: keychainExpected()
          ? "Install libsecret+gnome-keyring (Linux), or set PERPLEXITY_VAULT_PASSPHRASE."
          : "Set PERPLEXITY_VAULT_PASSPHRASE in your MCP config env.",
      });
    }
  }

  // Active-decrypt verification — only when an encrypted vault.enc actually
  // exists. This catches the "user has both keychain + passphrase set, but
  // vault.enc was written with one and the read path now prefers the other"
  // failure mode that surfaces as "Vault decrypt failed: wrong passphrase
  // or corrupted ciphertext" mid-login. A status check that just reports
  // "OS keychain holds master key" is misleading if the key can't actually
  // open the on-disk blob.
  if (existsSync(enc) && (kc.hasKey || envPass)) {
    try {
      const { Vault, __resetKeyCache } = await import("../vault.js");
      // Use a fresh resolution context so the doctor's verification doesn't
      // pollute the cached unseal material for the rest of the process.
      __resetKeyCache();
      // Vault.get returns null for absent keys without throwing; only a
      // genuine decrypt failure throws.
      await new Vault().get(profile, "cookies");
      results.push({
        category: CATEGORY,
        name: "unseal-verify",
        status: "pass",
        message: "vault.enc decrypts cleanly with the active unseal material",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDecryptFailure = /wrong passphrase or corrupted ciphertext|Vault decrypt failed/.test(msg);
      results.push({
        category: CATEGORY,
        name: "unseal-verify",
        status: "fail",
        message: isDecryptFailure
          ? "vault.enc cannot be decrypted with any available unseal material"
          : `vault.enc unreadable: ${msg}`,
        hint: isDecryptFailure
          ? (kc.hasKey && envPass
              ? "Both keychain and PERPLEXITY_VAULT_PASSPHRASE are set, but neither matches the blob. The blob was likely written under a since-rotated passphrase or a different keychain key. Run 'perplexity-user-mcp logout --purge' on this profile and log in again to write a fresh vault."
              : "The unseal material has changed since this blob was written. Restore the original passphrase, or run 'perplexity-user-mcp logout --purge' on this profile and log in again.")
          : "Inspect the file at the path under 'profiles' check; consider restoring from backup or purging.",
      });
    }
  }

  return results;
}
