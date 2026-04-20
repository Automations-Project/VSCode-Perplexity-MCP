// Spawnable health-check runner. Reads the active profile's vault cookies,
// launches a NON-persistent Chromium, injects cookies, probes auth + rest
// endpoints, writes models-cache.json on success, emits one JSON line,
// and exits. Never touches the long-lived MCP server's browser profile dir.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium } from "patchright";
import { Vault } from "./vault.js";
import { getProfilePaths, getActiveName } from "./profiles.js";
import { redact } from "./redact.js";
import { collectSessionMetadata } from "./session-metadata.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
const LOGIN_PATH = process.env.PERPLEXITY_LOGIN_PATH || "/account";

function resolveProfile() {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

async function main() {
  const PROFILE = resolveProfile();
  const vault = new Vault();
  const cookiesRaw = await vault.get(PROFILE, "cookies").catch(() => null);
  if (!cookiesRaw) {
    emit({ valid: false, reason: "no_cookies" });
    process.exit(2);
  }
  const cookies = JSON.parse(cookiesRaw);
  if (!Array.isArray(cookies) || cookies.length === 0) {
    emit({ valid: false, reason: "no_cookies" });
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  let result;
  try {
    const ctx = await browser.newContext();
    // Patchright's addCookies wants EITHER url OR (domain+path), not both.
    // Pass cookies with domain/url already set through untouched; only
    // synthesize a url from ORIGIN when neither is present. Additionally,
    // Chromium rejects `__Secure-`-prefixed cookies with `secure:false` —
    // force the flag so imports from other tools stay usable (Chromium
    // treats localhost/127.0.0.1 as secure origins, so the cookie will
    // still be delivered over plain HTTP in tests).
    const normalized = cookies.map((c) => {
      const withSecure = c.name?.startsWith("__Secure-") ? { ...c, secure: true } : c;
      return (withSecure.url || withSecure.domain) ? withSecure : { ...withSecure, url: `${ORIGIN}${withSecure.path ?? "/"}` };
    });
    await ctx.addCookies(normalized);
    const page = await ctx.newPage();
    // Navigate to an origin URL so page-context fetches are same-origin
    // (required for `credentials: "include"` to attach the cookies we just
    // injected). The default path `/account` exists on production; mock
    // integration tests override via PERPLEXITY_LOGIN_PATH to point at the
    // mock's `/login` route.
    await page.goto(`${ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded" }).catch(() => {});

    const metadata = await collectSessionMetadata(page, ORIGIN, { sessionTimeoutMs: 4_000 });

    if (!metadata.sessionData?.user?.id) {
      result = { valid: false, reason: "expired" };
    } else {
      result = {
        valid: true,
        tier: metadata.tier,
        modelCount: Object.keys(metadata.models?.models ?? {}).length,
        rateLimits: metadata.rateLimits ?? null,
      };
      try {
        const paths = getProfilePaths(PROFILE);
        if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.modelsCache, JSON.stringify(metadata.cache, null, 2));
      } catch {}
    }
  } finally {
    await browser.close().catch(() => {});
  }

  emit(result);
  process.exit(result.valid ? 0 : 2);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

main().catch((err) => {
  emit({ valid: false, reason: "crash", error: redact(String(err?.message ?? err)) });
  process.exit(5);
});
