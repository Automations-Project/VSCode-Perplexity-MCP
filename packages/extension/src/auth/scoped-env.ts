// v0.8.6 — Scoped PERPLEXITY_VAULT_PASSPHRASE injection for extension-host
// vault reads.
//
// Why this exists: `vault.js` reads `process.env.PERPLEXITY_VAULT_PASSPHRASE`
// synchronously in `getMasterKey()`. AuthManager sets that env for child
// login-runner processes only. In-process extension-host code (doctor,
// refreshAccountInfo, anything else that imports from `perplexity-user-mcp`
// and touches the vault) runs with an empty env and fails silently on
// headless Linux where keytar is absent. The symptom is `getSavedCookies()`
// returning [] because `_vault.get().catch(() => null)` swallows the
// "Vault locked" throw, which then reports as misleading "no-cookies".
//
// This helper lets a caller scope the passphrase injection around a single
// async call. process.env is mutated for the duration, then restored — even
// if the callback throws — so we never leak the passphrase across the
// helper boundary for other extension-host code to observe.
//
// Note on caching: `vault.js` caches the derived master key in a module-local
// `_keyCache` after the first successful `getMasterKey()`. Once the first
// scoped call completes, subsequent callers in the same extension-host
// process get the cached key and don't need the env var anymore — but
// wrapping every vault-reading call with this helper is still cheap and
// keeps the "env never ambient" invariant regardless of cache state.

const ENV_KEY = "PERPLEXITY_VAULT_PASSPHRASE";

export async function withScopedVaultPassphrase<T>(
  passphrase: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!passphrase) return fn();
  const prev = process.env[ENV_KEY];
  process.env[ENV_KEY] = passphrase;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
}
