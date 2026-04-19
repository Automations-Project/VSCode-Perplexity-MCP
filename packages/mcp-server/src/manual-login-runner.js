// Headed login runner. User drives the browser; we poll cookies until the
// session token appears, then write the vault + meta + models-cache +
// .reinit sentinel, and exit.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium } from "patchright";
import { Vault } from "./vault.js";
import { getProfilePaths, getActiveName, recordLoginSuccess } from "./profiles.js";
import { redact } from "./redact.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
const POLL_MS = Number(process.env.PERPLEXITY_POLL_MS ?? 2000);
const MAX_WAIT_MS = 180_000;
const CF_TIMEOUT_MS = Number(process.env.PERPLEXITY_CF_TIMEOUT_MS ?? 20_000);

function resolveProfile() {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

const isTest = !!process.env.PERPLEXITY_TEST_AUTO_LOGIN_EMAIL || !!process.env.PERPLEXITY_TEST_BROWSER_CLOSE_AFTER_MS;

function ipc(msg) { if (process.send) process.send(msg); }
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function main() {
  const PROFILE = resolveProfile();

  const browser = await chromium.launch({ headless: isTest });  // isTest = headless in CI; humans see headed.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  let cfClosed = false;
  browser.on("disconnected", () => { cfClosed = true; });

  // Navigate to /login so the page has a same-origin context for subsequent
  // credentialed fetch() calls. Going to ORIGIN's root path can land on a 404
  // (mock server) or a marketing page (production) that may not set a usable
  // document origin for in-page fetch.
  try { await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
  catch { /* continue; next phase checks CF */ }

  // CF resolve check
  const cfStart = Date.now();
  while (Date.now() - cfStart < CF_TIMEOUT_MS) {
    try {
      const title = await page.title();
      if (!/just a moment/i.test(title)) break;
    } catch { break; }
    await page.waitForTimeout(500);
  }
  if (Date.now() - cfStart >= CF_TIMEOUT_MS) {
    const title = await page.title().catch(() => "");
    if (/just a moment/i.test(title)) {
      await browser.close().catch(() => {});
      emit({ ok: false, reason: "cf_blocked" });
      process.exit(3);
    }
  }

  ipc({ phase: "awaiting_user" });

  // Test hook: auto-drive the login so CI doesn't need a human.
  if (process.env.PERPLEXITY_TEST_AUTO_LOGIN_EMAIL) {
    const email = process.env.PERPLEXITY_TEST_AUTO_LOGIN_EMAIL;
    await page.evaluate(async ({ origin, email }) => {
      await fetch(`${origin}/login/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      await fetch(`${origin}/login/otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, otp: "123456" }) });
    }, { origin: ORIGIN, email });
  }

  // Test hook: force a browser close to exercise the cancelled path.
  if (process.env.PERPLEXITY_TEST_BROWSER_CLOSE_AFTER_MS) {
    setTimeout(() => browser.close().catch(() => {}), Number(process.env.PERPLEXITY_TEST_BROWSER_CLOSE_AFTER_MS));
  }

  const started = Date.now();
  let sessionCookie = null;
  while (Date.now() - started < MAX_WAIT_MS) {
    if (cfClosed) {
      emit({ ok: false, reason: "cancelled" });
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    const cookies = await ctx.cookies().catch(() => []);
    sessionCookie = cookies.find((c) => c.name === "__Secure-next-auth.session-token");
    if (sessionCookie) break;
  }
  if (!sessionCookie) {
    await browser.close().catch(() => {});
    emit({ ok: false, reason: "timeout" });
    process.exit(2);
  }

  const allCookies = await ctx.cookies();
  const sessionData = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    return r.ok ? r.json() : null;
  }, `${ORIGIN}/api/auth/session`);

  const vault = new Vault();
  await vault.set(PROFILE, "cookies", JSON.stringify(allCookies));
  if (sessionData?.user?.email) await vault.set(PROFILE, "email", sessionData.user.email);
  if (sessionData?.user?.id) await vault.set(PROFILE, "userId", sessionData.user.id);

  const [models, asi, rate, exp] = await Promise.all([
    pageFetch(page, `${ORIGIN}/rest/models-config`),
    pageFetch(page, `${ORIGIN}/rest/asi-access`),
    pageFetch(page, `${ORIGIN}/rest/rate-limit`),
    pageFetch(page, `${ORIGIN}/rest/user/experiments`),
  ]);
  const tier = exp?.server_is_max ? "Max" : exp?.server_is_pro ? "Pro"
             : exp?.server_is_enterprise ? "Enterprise" : "Authenticated";

  const paths = getProfilePaths(PROFILE);
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.modelsCache, JSON.stringify({ modelsConfig: models, rateLimits: rate, isPro: !!exp?.server_is_pro, isMax: !!exp?.server_is_max, isEnterprise: !!exp?.server_is_enterprise, canUseComputer: !!asi?.can_use_computer }, null, 2));

  recordLoginSuccess(PROFILE, { tier, loginMode: "manual", lastLogin: new Date().toISOString() });

  writeFileSync(paths.reinit, String(Date.now()));

  await browser.close().catch(() => {});
  emit({ ok: true, tier, modelCount: Object.keys(models?.models ?? {}).length });
  process.exit(0);
}

async function pageFetch(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    return r.ok ? r.json() : null;
  }, url);
}

main().catch((err) => {
  emit({ ok: false, reason: "crash", error: redact(String(err?.message ?? err)) });
  process.exit(5);
});
