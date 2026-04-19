// Spawnable health-check runner. Reads the active profile's vault cookies,
// launches a NON-persistent Chromium, injects cookies, probes auth + rest
// endpoints, writes models-cache.json on success, emits one JSON line,
// and exits. Never touches the long-lived MCP server's browser profile dir.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium } from "patchright";
import { Vault } from "./vault.js";
import { getProfilePaths } from "./profiles.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
const PROFILE = process.env.PERPLEXITY_PROFILE || "default";

async function main() {
  const vault = new Vault();
  const cookiesRaw = await vault.get(PROFILE, "cookies").catch(() => null);
  if (!cookiesRaw) {
    emit({ valid: false, reason: "no_cookies" });
    process.exit(2);
  }
  const cookies = JSON.parse(cookiesRaw);

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
    // injected). `/login` is used because the mock server and production
    // both return HTML there; the mock's `/` returns 404 which leaves the
    // page in a state where fetch() throws TypeError.
    await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" }).catch(() => {});

    const sessionData = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include" });
      return r.ok ? r.json() : null;
    }, `${ORIGIN}/api/auth/session`);

    if (!sessionData || !sessionData.user?.id) {
      result = { valid: false, reason: "expired" };
    } else {
      const [models, asi, rate, exp] = await Promise.all([
        pageFetch(page, `${ORIGIN}/rest/models-config`),
        pageFetch(page, `${ORIGIN}/rest/asi-access`),
        pageFetch(page, `${ORIGIN}/rest/rate-limit`),
        pageFetch(page, `${ORIGIN}/rest/user/experiments`),
      ]);
      const tier = exp?.server_is_max ? "Max"
                 : exp?.server_is_pro ? "Pro"
                 : exp?.server_is_enterprise ? "Enterprise"
                 : "Authenticated";
      result = {
        valid: true,
        tier,
        modelCount: Object.keys(models?.models ?? {}).length,
        rateLimits: rate ?? null,
      };
      try {
        const paths = getProfilePaths(PROFILE);
        if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.modelsCache, JSON.stringify({ modelsConfig: models, rateLimits: rate, isPro: !!exp?.server_is_pro, isMax: !!exp?.server_is_max, isEnterprise: !!exp?.server_is_enterprise, canUseComputer: !!asi?.can_use_computer }, null, 2));
      } catch {}
    }
  } finally {
    await browser.close().catch(() => {});
  }

  emit(result);
  process.exit(result.valid ? 0 : 2);
}

async function pageFetch(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    return r.ok ? r.json() : null;
  }, url);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

main().catch((err) => {
  emit({ valid: false, reason: "crash", error: String(err?.message ?? err) });
  process.exit(5);
});
