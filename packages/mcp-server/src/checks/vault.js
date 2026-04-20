import { existsSync } from "node:fs";
import { join } from "node:path";

const CATEGORY = "vault";

async function tryKeychain() {
  try {
    const mod = await import("keytar");
    const keytar = mod.default ?? mod;
    const hex = await keytar.getPassword("perplexity-user-mcp", "vault-master-key");
    return { available: true, hasKey: !!hex };
  } catch {
    return { available: false, hasKey: false };
  }
}

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
  const kc = await tryKeychain();

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

  return results;
}
