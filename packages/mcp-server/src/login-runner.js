// Auto-OTP login runner. Parent provides email via PERPLEXITY_EMAIL; we
// drive the real Perplexity email+OTP flow (NextAuth on the live site,
// legacy /login/* on the local mock), prompt for the six-digit code via
// IPC, and persist the resulting session into the profile vault.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { chromium } from "patchright";
import { Vault } from "./vault.js";
import { resolveBrowserExecutable } from "./config.js";
import { getProfilePaths, getActiveName, recordLoginSuccess } from "./profiles.js";
import { redact } from "./redact.js";
import { minimizePageWindow } from "./browser-window.js";
import {
  buildRuntimeEndpoints,
  collectSessionMetadata,
  pageRequest,
} from "./session-metadata.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
const LOGIN_PATH = process.env.PERPLEXITY_LOGIN_PATH || "/account";
const EMAIL = process.env.PERPLEXITY_EMAIL;
const OTP_TIMEOUT_MS = Number(process.env.PERPLEXITY_OTP_TIMEOUT_MS ?? 300_000);
const CF_TIMEOUT_MS = Number(process.env.PERPLEXITY_CF_TIMEOUT_MS ?? 20_000);
const MAX_RETRIES = 2;

function resolveProfile() {
  return process.env.PERPLEXITY_PROFILE || getActiveName() || "default";
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/i.test(origin);
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
  const localOrigin = isLocalOrigin(ORIGIN);

  let executablePath;
  let channel;
  if (!localOrigin) {
    try {
      ({ path: executablePath, channel } = await resolveBrowserExecutable());
    } catch (err) {
      emit({ ok: false, reason: "chrome_missing", error: redact(String(err?.message ?? err)) });
      process.exit(4);
    }
  }

  const browser = await chromium.launch({
    headless: localOrigin,
    ...(executablePath ? { executablePath } : {}),
    ...(channel && ["chrome", "msedge", "chromium"].includes(channel) ? { channel } : {}),
    args: localOrigin ? [] : ["--start-minimized"],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  try {
    await page.goto(`${ORIGIN}${LOGIN_PATH}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {}
  if (!localOrigin) await minimizePageWindow(page);

  const ready = await waitForLoginReady(page);
  if (!ready) {
    const title = await page.title().catch(() => "");
    await browser.close().catch(() => {});
    emit({ ok: false, reason: /just a moment/i.test(title) ? "cf_blocked" : "auto_unsupported" });
    process.exit(/just a moment/i.test(title) ? 3 : 2);
  }

  const liveAttempt = await startLiveEmailFlow(page);
  let authFlow = liveAttempt;
  if (liveAttempt.kind === "unsupported") {
    authFlow = await startLegacyMockFlow(page);
  }
  if (!localOrigin) await minimizePageWindow(page);

  if (authFlow.kind === "sso_required") {
    await browser.close().catch(() => {});
    emit({ ok: false, reason: "sso_required" });
    process.exit(2);
  }

  if (authFlow.kind === "unsupported") {
    await browser.close().catch(() => {});
    emit({ ok: false, reason: "auto_unsupported", detail: authFlow.detail });
    process.exit(2);
  }

  if (authFlow.kind === "email_rejected") {
    await browser.close().catch(() => {});
    emit({ ok: false, reason: "email_rejected", detail: authFlow.detail });
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

    const submitResp = await submitOtp(page, authFlow, otp);
    if (submitResp.ok) {
      const allCookies = await ctx.cookies();
      const metadata = await collectSessionMetadata(page, ORIGIN, {
        sessionData: submitResp.sessionData,
        sessionTimeoutMs: 10_000,
      });

      const vault = new Vault();
      await vault.set(PROFILE, "cookies", JSON.stringify(allCookies));
      if (metadata.sessionData?.user?.email) await vault.set(PROFILE, "email", metadata.sessionData.user.email);
      if (metadata.sessionData?.user?.id) await vault.set(PROFILE, "userId", metadata.sessionData.user.id);

      const paths = getProfilePaths(PROFILE);
      if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.modelsCache, JSON.stringify(metadata.cache, null, 2));
      recordLoginSuccess(PROFILE, { tier: metadata.tier, loginMode: "auto", lastLogin: new Date().toISOString() });
      writeFileSync(paths.reinit, String(Date.now()));

      await browser.close().catch(() => {});
      emit({ ok: true, tier: metadata.tier, modelCount: Object.keys(metadata.models?.models ?? {}).length });
      process.exit(0);
    }

    if (authFlow.kind === "live") {
      await page.goto(authFlow.verifyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      if (!localOrigin) await minimizePageWindow(page);
    }

    if (attempt === MAX_RETRIES) {
      await browser.close().catch(() => {});
      emit({ ok: false, reason: "otp_rejected" });
      process.exit(2);
    }
  }
}

async function waitForLoginReady(page) {
  const started = Date.now();
  while (Date.now() - started < CF_TIMEOUT_MS) {
    if (await page.locator('input[type="email"]').count().catch(() => 0)) {
      return true;
    }
    const title = await page.title().catch(() => "");
    if (title && !/just a moment/i.test(title)) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (/continue with email/i.test(body) || /single sign-on/i.test(body) || /continue/i.test(body)) {
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function startLiveEmailFlow(page) {
  const endpoints = buildRuntimeEndpoints(ORIGIN);
  const csrf = await pageRequest(page, endpoints.csrf);
  if (!(csrf.ok && csrf.contentType.includes("json") && csrf.json?.csrfToken)) {
    return {
      kind: "unsupported",
      detail: { step: "csrf", status: csrf.status, contentType: csrf.contentType, error: csrf.error ?? undefined },
    };
  }

  const sso = await pageRequest(page, endpoints.ssoDetails, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL }),
  });
  if (sso.ok && sso.json?.organization) {
    return { kind: "sso_required" };
  }

  const redirectUrl = `${ORIGIN}/account?login-source=settings`;
  const signIn = await pageRequest(page, endpoints.signInEmail, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: EMAIL,
      useNumericOtp: "true",
      csrfToken: csrf.json.csrfToken,
      callbackUrl: `${redirectUrl}#locale=en-US`,
      json: "true",
    }),
  });

  if (!(signIn.ok && signIn.contentType.includes("json") && signIn.json?.url)) {
    return {
      kind: signIn.status >= 400 && signIn.status < 500 ? "email_rejected" : "unsupported",
      detail: { step: "signin_email", status: signIn.status, contentType: signIn.contentType, error: signIn.error ?? undefined },
    };
  }

  const verifyUrl = new URL(signIn.json.url, ORIGIN);
  verifyUrl.searchParams.set("email", EMAIL);
  verifyUrl.searchParams.set("redirectUrl", redirectUrl);
  await page.goto(verifyUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

  return {
    kind: "live",
    redirectUrl,
    verifyUrl: verifyUrl.toString(),
  };
}

async function startLegacyMockFlow(page) {
  const emailResp = await pageRequest(page, `${ORIGIN}/login/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL }),
  });

  if (emailResp.redirected && (emailResp.url || "").includes("/sso")) {
    return { kind: "sso_required" };
  }

  const looksUnsupported =
    emailResp.status === 404 ||
    emailResp.status === 405 ||
    emailResp.status >= 500 ||
    !emailResp.contentType.includes("json");

  if (looksUnsupported) {
    return {
      kind: "unsupported",
      detail: { step: "legacy_email", status: emailResp.status, contentType: emailResp.contentType, error: emailResp.error ?? undefined },
    };
  }

  if (!emailResp.ok) {
    return { kind: "email_rejected", detail: emailResp.status };
  }

  return { kind: "legacy" };
}

async function submitOtp(page, flow, otp) {
  if (flow.kind === "legacy") {
    const submitResp = await pageRequest(page, `${ORIGIN}/login/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, otp }),
    });
    if (submitResp.status !== 200) {
      return { ok: false };
    }
    const metadata = await collectSessionMetadata(page, ORIGIN, { sessionTimeoutMs: 2_000 });
    return { ok: !!metadata.sessionData?.user?.id, sessionData: metadata.sessionData };
  }

  const endpoints = buildRuntimeEndpoints(ORIGIN);
  const redirectResp = await pageRequest(page, endpoints.otpRedirectLink, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: EMAIL,
      otp,
      redirectUrl: flow.redirectUrl,
      emailLoginMethod: "web-otp",
      loginSource: null,
    }),
  });

  if (!(redirectResp.ok && redirectResp.contentType.includes("json") && redirectResp.json?.redirect)) {
    return { ok: false };
  }

  const callbackUrl = new URL(redirectResp.json.redirect, ORIGIN).toString();
  await page.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  const metadata = await collectSessionMetadata(page, ORIGIN, { sessionTimeoutMs: 5_000 });
  return { ok: !!metadata.sessionData?.user?.id, sessionData: metadata.sessionData };
}

main().catch((err) => {
  const msg = err?.message ?? err;
  const stack = err?.stack;
  emit({
    ok: false,
    reason: "crash",
    error: redact(String(msg ?? "unknown error")),
    detail: redact(String(msg ?? "unknown error")),
    ...(stack ? { stack: redact(String(stack)) } : {}),
  });
  process.exit(5);
});
