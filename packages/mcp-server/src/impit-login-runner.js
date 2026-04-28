// Impit-driven Auto-OTP login runner. Same emit/IPC protocol as
// `login-runner.js` but drives the 6-step Perplexity email+OTP flow
// (csrf → sso check → signin/email → wait OTP → otp-redirect → callback)
// through impit (Rust HTTP client) instead of through a Patchright
// browser. The visible browser window is replaced with a brief headless
// CF warmup (only when the vault has no fresh `cf_clearance` cookie).
//
// Plan: docs/impit-coverage-plan.md §3 (Phase 1).
//
// Inputs (env):
//   PERPLEXITY_EMAIL              — required
//   PERPLEXITY_PROFILE            — profile name to write cookies to
//   PERPLEXITY_OTP_TIMEOUT_MS     — default 300_000
//   PERPLEXITY_LOGIN_MAX_RETRIES  — default 2
//
// Outputs:
//   process.send({ phase: "awaiting_otp", attempt: N })       — IPC, parent prompts user
//   process.stdin gets { otp: "123456" }                      — IPC, parent sends back
//   process.stdout: JSON line `{ ok, ... }` final result
//   exit codes: 0 success, 2 logical fail, 4 chrome/impit missing, 5 crash

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { Vault } from "./vault.js";
import { getProfilePaths, getActiveName, recordLoginSuccess } from "./profiles.js";
import { redact } from "./redact.js";
import { buildRuntimeEndpoints } from "./session-metadata.js";
import { CookieJar } from "./cookie-jar.js";
import { loadImpit, isImpitAvailable } from "./refresh.js";
import { warmCloudflare } from "./cf-warmup.js";

const ORIGIN = process.env.PERPLEXITY_ORIGIN || "https://www.perplexity.ai";
const EMAIL = process.env.PERPLEXITY_EMAIL;
const OTP_TIMEOUT_MS = Number(process.env.PERPLEXITY_OTP_TIMEOUT_MS ?? 300_000);
const MAX_RETRIES = Number(process.env.PERPLEXITY_LOGIN_MAX_RETRIES ?? 2);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const CHROME_CLIENT_HINTS = {
  "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

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

/**
 * Wrap an impit instance in a small fetch helper that round-trips the
 * cookie jar. Returns { status, headers, json, text }.
 */
async function impitJsonRequest(client, jar, url, init = {}) {
  const cookieHeader = jar.buildCookieHeader(url);
  const headers = {
    "user-agent": USER_AGENT,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    ...CHROME_CLIENT_HINTS,
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    referer: `${ORIGIN}/`,
    origin: ORIGIN,
    ...(init.headers ?? {}),
  };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await client.fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
      redirect: init.redirect ?? "manual",
    });
    const text = await res.text();
    // Capture Set-Cookie before reading body — Node Headers carries them.
    const setCookies = readSetCookies(res.headers);
    if (setCookies.length) jar.consumeSetCookieHeader(setCookies, url);
    let json;
    if (text) {
      try { json = JSON.parse(text); } catch { /* leave undefined */ }
    }
    return { status: res.status, headers: res.headers, text, json };
  } finally {
    clearTimeout(to);
  }
}

function readSetCookies(headers) {
  if (!headers) return [];
  // Node 20+ standard
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  // Headers#raw() (undici)
  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    return raw["set-cookie"] ?? [];
  }
  // Plain object fallback
  const lower = Object.keys(headers).find((k) => k.toLowerCase() === "set-cookie");
  if (!lower) return [];
  const v = headers[lower];
  return Array.isArray(v) ? v : [v];
}

/**
 * Follow redirects manually so we can capture Set-Cookie at every hop —
 * the OTP callback chain depends on cookies set in 302 responses, which
 * `redirect: "follow"` would swallow.
 */
async function followRedirectsManually(client, jar, startUrl, init = {}, maxHops = 10) {
  let url = startUrl;
  let lastStatus = 0;
  for (let hop = 0; hop < maxHops; hop++) {
    const result = await impitJsonRequest(client, jar, url, { ...init, redirect: "manual", method: hop === 0 ? init.method ?? "GET" : "GET" });
    lastStatus = result.status;
    if (result.status >= 300 && result.status < 400) {
      const loc = readHeader(result.headers, "location");
      if (!loc) return { ok: false, status: result.status, finalUrl: url };
      url = new URL(loc, url).toString();
      // Subsequent hops must not re-send the body
      init.body = undefined;
      continue;
    }
    return { ok: result.status >= 200 && result.status < 300, status: result.status, finalUrl: url, json: result.json, text: result.text };
  }
  return { ok: false, status: lastStatus, finalUrl: url, error: "max_redirects" };
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/**
 * Steps 1-3 of the auth flow: csrf → sso check → email signin.
 * Returns either { kind: "live", redirectUrl } on success, or a structured
 * failure that the caller maps to an exit reason.
 */
async function startEmailFlow(client, jar) {
  const endpoints = buildRuntimeEndpoints(ORIGIN);

  const csrf = await impitJsonRequest(client, jar, endpoints.csrf);
  if (csrf.status !== 200 || !csrf.json?.csrfToken) {
    return { kind: "unsupported", detail: { step: "csrf", status: csrf.status } };
  }

  const sso = await impitJsonRequest(client, jar, endpoints.ssoDetails, {
    method: "POST",
    body: { email: EMAIL },
  });
  if (sso.status === 200 && sso.json?.organization) {
    return { kind: "sso_required" };
  }

  const redirectUrl = `${ORIGIN}/account?login-source=settings`;
  const signIn = await impitJsonRequest(client, jar, endpoints.signInEmail, {
    method: "POST",
    body: {
      email: EMAIL,
      useNumericOtp: "true",
      csrfToken: csrf.json.csrfToken,
      callbackUrl: `${redirectUrl}#locale=en-US`,
      json: "true",
    },
  });

  if (signIn.status !== 200 || !signIn.json?.url) {
    return {
      kind: signIn.status >= 400 && signIn.status < 500 ? "email_rejected" : "unsupported",
      detail: { step: "signin_email", status: signIn.status },
    };
  }

  return { kind: "live", redirectUrl, csrfToken: csrf.json.csrfToken };
}

async function submitOtp(client, jar, flow, otp) {
  const endpoints = buildRuntimeEndpoints(ORIGIN);
  const redirectResp = await impitJsonRequest(client, jar, endpoints.otpRedirectLink, {
    method: "POST",
    body: {
      email: EMAIL,
      otp,
      redirectUrl: flow.redirectUrl,
      emailLoginMethod: "web-otp",
      loginSource: null,
    },
  });
  if (redirectResp.status !== 200 || !redirectResp.json?.redirect) {
    return { ok: false };
  }
  // Follow the callback redirect chain manually to capture session cookies.
  const callbackUrl = new URL(redirectResp.json.redirect, ORIGIN).toString();
  const callback = await followRedirectsManually(client, jar, callbackUrl, { method: "GET" });
  if (!callback.ok) return { ok: false };
  // After the chain, the jar should have __Secure-next-auth.session-token.
  const cookies = jar.toPlaywrightShape();
  const hasSession = cookies.some((c) => c.name === "__Secure-next-auth.session-token");
  if (!hasSession) return { ok: false };
  return { ok: true, cookies };
}

/**
 * Probe an authenticated endpoint to fetch session/user metadata after a
 * successful OTP. We don't have a page to evaluate in, so this is a small
 * direct fetch — reusing the same jar.
 */
async function fetchSessionInfo(client, jar) {
  const session = await impitJsonRequest(client, jar, `${ORIGIN}/api/auth/session?version=2.18&source=default`);
  return session.json ?? {};
}

async function fetchModelsCache(client, jar) {
  // Mirrors what `refresh.ts` writes — but via this jar. Best-effort.
  const result = {};
  for (const [key, path] of [
    ["models", "/rest/configs/models?version=2.18&source=default"],
    ["asi", "/rest/configs/asi-access?version=2.18&source=default"],
    ["rateLimits", "/rest/rate-limits?version=2.18&source=default"],
    ["experiments", "/rest/experiments?version=2.18&source=default"],
    ["userInfo", "/rest/user/info?version=2.18&source=default"],
  ]) {
    try {
      const r = await impitJsonRequest(client, jar, `${ORIGIN}${path}`);
      if (r.status === 200 && r.json) result[key] = r.json;
    } catch { /* ignore — partial cache is fine */ }
  }
  return result;
}

function deriveTier(modelsCache) {
  if (modelsCache.userInfo?.subscription_tier === "enterprise") return "Enterprise";
  if (modelsCache.userInfo?.subscription_tier === "max") return "Max";
  if (modelsCache.userInfo?.subscription_tier === "pro") return "Pro";
  if (modelsCache.experiments?.server_is_enterprise) return "Enterprise";
  if (modelsCache.experiments?.server_is_max) return "Max";
  if (modelsCache.experiments?.server_is_pro) return "Pro";
  if (modelsCache.asi?.can_use_computer) return "Pro";
  return "Authenticated";
}

async function main() {
  if (!EMAIL) {
    emit({ ok: false, reason: "no_email" });
    process.exit(1);
  }
  if (!isImpitAvailable()) {
    emit({ ok: false, reason: "impit_missing", error: "Speed Boost (impit) not installed" });
    process.exit(4);
  }

  const PROFILE = resolveProfile();

  // 1. Seed jar from existing vault cookies (if any). Brand-new logins
  //    get an empty jar; subsequent re-logins inherit cf_clearance etc.
  const vault = new Vault();
  const jar = new CookieJar([]);
  try {
    const stored = await vault.get(PROFILE, "cookies").catch(() => null);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        for (const c of parsed) jar.set?.(c.name, c.value, { domain: c.domain, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite });
      }
    }
  } catch { /* ignore — seed is best-effort */ }

  // 2. CF warmup if jar has no cf_clearance. ~1-2s headless launch.
  if (!jar.toPlaywrightShape().some((c) => c.name === "cf_clearance")) {
    const warmup = await warmCloudflare();
    if (warmup.cookies.length) {
      for (const c of warmup.cookies) {
        jar.set?.(c.name, c.value, { domain: c.domain, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite });
      }
    }
    if (!warmup.hasCfClearance) {
      // No cf_clearance after warmup → CF is challenging this IP. Bail to
      // browser fallback which has the headed CF solver.
      emit({ ok: false, reason: "cf_blocked", detail: { warmupOk: warmup.ok } });
      process.exit(3);
    }
  }

  // 3. Load impit and run the email→OTP→callback flow.
  const impitMod = await loadImpit();
  if (!impitMod) {
    emit({ ok: false, reason: "impit_load_failed" });
    process.exit(4);
  }
  const client = new impitMod.Impit({ browser: "chrome", ignoreTlsErrors: false });

  let authFlow;
  try {
    authFlow = await startEmailFlow(client, jar);
  } catch (err) {
    emit({ ok: false, reason: "auto_unsupported", detail: { step: "start", error: redact(String(err?.message ?? err)) } });
    process.exit(2);
  }

  if (authFlow.kind === "sso_required") {
    emit({ ok: false, reason: "sso_required" });
    process.exit(2);
  }
  if (authFlow.kind === "email_rejected") {
    emit({ ok: false, reason: "email_rejected", detail: authFlow.detail });
    process.exit(2);
  }
  if (authFlow.kind !== "live") {
    emit({ ok: false, reason: "auto_unsupported", detail: authFlow.detail });
    process.exit(2);
  }

  // 4. OTP loop with retry.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    ipc({ phase: "awaiting_otp", attempt });
    let otp;
    try {
      otp = await awaitOtp();
    } catch {
      emit({ ok: false, reason: "otp_timeout" });
      process.exit(2);
    }

    const submitResp = await submitOtp(client, jar, authFlow, otp);
    if (submitResp.ok) {
      // 5. Persist cookies + session metadata.
      const sessionInfo = await fetchSessionInfo(client, jar).catch(() => ({}));
      const modelsCache = await fetchModelsCache(client, jar).catch(() => ({}));
      const tier = deriveTier(modelsCache);

      await vault.set(PROFILE, "cookies", JSON.stringify(submitResp.cookies));
      if (sessionInfo?.user?.email) await vault.set(PROFILE, "email", sessionInfo.user.email);
      if (sessionInfo?.user?.id) await vault.set(PROFILE, "userId", sessionInfo.user.id);

      const paths = getProfilePaths(PROFILE);
      if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.modelsCache, JSON.stringify(modelsCache, null, 2));
      recordLoginSuccess(PROFILE, { tier, loginMode: "auto", lastLogin: new Date().toISOString() });
      writeFileSync(paths.reinit, String(Date.now()));

      emit({ ok: true, tier, modelCount: Object.keys(modelsCache?.models?.models ?? {}).length, transport: "impit" });
      process.exit(0);
    }

    if (attempt === MAX_RETRIES) {
      emit({ ok: false, reason: "otp_rejected" });
      process.exit(2);
    }
  }
}

main().catch((err) => {
  const msg = err?.message ?? err;
  emit({
    ok: false,
    reason: "crash",
    error: redact(String(msg ?? "unknown error")),
    ...(err?.stack ? { stack: redact(String(err.stack)) } : {}),
  });
  process.exit(5);
});
