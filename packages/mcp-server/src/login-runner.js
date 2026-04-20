// Auto-OTP login runner. Parent provides email via PERPLEXITY_EMAIL; we
// POST it, parent is prompted via IPC for the OTP code, we submit, and on
// success we complete the same vault + meta + models-cache + .reinit +
// exit-0 sequence as the manual runner.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium } from "patchright";
import { Vault } from "./vault.js";
import { getProfilePaths, getActiveName, recordLoginSuccess } from "./profiles.js";
import { redact } from "./redact.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
const LOGIN_PATH = process.env.PERPLEXITY_LOGIN_PATH || "/account";
const EMAIL = process.env.PERPLEXITY_EMAIL;
const OTP_TIMEOUT_MS = Number(process.env.PERPLEXITY_OTP_TIMEOUT_MS ?? 300_000);
const MAX_RETRIES = 2;

function resolveProfile() {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

function ipc(msg) { if (process.send) process.send(msg); }
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function awaitOtp() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.removeListener("message", handler);
      reject(new Error("otp_timeout"));
    }, OTP_TIMEOUT_MS);
    const handler = (m) => {
      if (m && typeof m.otp === "string") {
        clearTimeout(timer);
        process.removeListener("message", handler);
        resolve(m.otp);
      }
    };
    process.on("message", handler);
  });
}

async function main() {
  if (!EMAIL) {
    emit({ ok: false, reason: "no_email" });
    process.exit(1);
  }

  const PROFILE = resolveProfile();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  try {
    await page.goto(`${ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {}

  // Submit email. Mock returns 302 -> /sso for @sso.test emails.
  // Browser fetch() with redirect:"manual" yields an opaqueredirect response
  // (type === "opaqueredirect", status === 0) and hides the Location header,
  // so we follow the redirect and inspect the final URL instead.
  const emailResp = await page.evaluate(async ({ origin, email }) => {
    const r = await fetch(`${origin}/login/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    return { status: r.status, url: r.url, redirected: r.redirected };
  }, { origin: ORIGIN, email: EMAIL });

  if (emailResp.redirected && (emailResp.url || "").includes("/sso")) {
    await browser.close().catch(() => {});
    emit({ ok: false, reason: "sso_required" });
    process.exit(2);
  }
  if (emailResp.status >= 400) {
    await browser.close().catch(() => {});
    emit({ ok: false, reason: "email_rejected", detail: emailResp.status });
    process.exit(2);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    ipc({ phase: "awaiting_otp", attempt });
    let otp;
    try {
      otp = await awaitOtp();
    } catch {
      await browser.close().catch(() => {});
      emit({ ok: false, reason: "otp_timeout" });
      process.exit(2);
    }

    const submitResp = await page.evaluate(async ({ origin, email, otp }) => {
      const r = await fetch(`${origin}/login/otp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, otp }) });
      return r.status;
    }, { origin: ORIGIN, email: EMAIL, otp });

    if (submitResp === 200) {
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
      recordLoginSuccess(PROFILE, { tier, loginMode: "auto", lastLogin: new Date().toISOString() });
      writeFileSync(paths.reinit, String(Date.now()));

      await browser.close().catch(() => {});
      emit({ ok: true, tier, modelCount: Object.keys(models?.models ?? {}).length });
      process.exit(0);
    }

    if (attempt === MAX_RETRIES) {
      await browser.close().catch(() => {});
      emit({ ok: false, reason: "otp_rejected" });
      process.exit(2);
    }
  }
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
