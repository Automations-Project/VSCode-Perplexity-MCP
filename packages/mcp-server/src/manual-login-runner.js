// Headed login runner. User drives the browser; we poll cookies until the
// session token appears, then write the vault + meta + models-cache +
// .reinit sentinel, and exit.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium } from "patchright";
import { Vault } from "./vault.js";
import { resolveBrowserExecutable } from "./config.js";
import { getProfilePaths, getActiveName, recordLoginSuccess } from "./profiles.js";
import { redact } from "./redact.js";
import { collectSessionMetadata } from "./session-metadata.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
// Perplexity's login flow lives at /account (the `/login` path doesn't exist
// on www.perplexity.ai). Integration tests override via env var to point at
// the mock server's /login route.
const LOGIN_PATH = process.env.PERPLEXITY_LOGIN_PATH || "/account";
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
  let executablePath;
  if (!isTest) {
    try {
      ({ path: executablePath } = await resolveBrowserExecutable());
    } catch (err) {
      emit({ ok: false, reason: "chrome_missing", error: redact(String(err?.message ?? err)) });
      process.exit(4);
    }
  }

  const browser = await chromium.launch({
    headless: isTest,
    ...(executablePath ? { executablePath } : {}),
  });  // isTest = headless in CI; humans see headed.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  let cfClosed = false;
  browser.on("disconnected", () => { cfClosed = true; });

  // Navigate to the login page so the page has a same-origin context for
  // subsequent credentialed fetch() calls. Going to ORIGIN's root path can
  // land on a marketing page that may not set a usable document origin for
  // in-page fetch. Path is env-var-configurable for the mock server tests.
  try { await page.goto(`${ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
  catch { /* continue; next phase checks CF */ }
  if (!isTest) await page.bringToFront().catch(() => {});

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
  if (!isTest) await page.bringToFront().catch(() => {});

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
  const metadata = await collectSessionMetadata(page, ORIGIN, { sessionTimeoutMs: 10_000 });

  const vault = new Vault();
  await vault.set(PROFILE, "cookies", JSON.stringify(allCookies));
  if (metadata.sessionData?.user?.email) await vault.set(PROFILE, "email", metadata.sessionData.user.email);
  if (metadata.sessionData?.user?.id) await vault.set(PROFILE, "userId", metadata.sessionData.user.id);

  const paths = getProfilePaths(PROFILE);
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.modelsCache, JSON.stringify(metadata.cache, null, 2));

  recordLoginSuccess(PROFILE, { tier: metadata.tier, loginMode: "manual", lastLogin: new Date().toISOString() });

  writeFileSync(paths.reinit, String(Date.now()));

  await browser.close().catch(() => {});
  emit({ ok: true, tier: metadata.tier, modelCount: Object.keys(metadata.models?.models ?? {}).length });
  process.exit(0);
}

main().catch((err) => {
  emit({ ok: false, reason: "crash", error: redact(String(err?.message ?? err)) });
  process.exit(5);
});
