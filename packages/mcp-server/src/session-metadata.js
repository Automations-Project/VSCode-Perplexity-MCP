const API_VERSION_QUERY = "version=2.18&source=default";

export function buildRuntimeEndpoints(origin) {
  const base = origin.replace(/\/+$/, "");
  return {
    session: `${base}/api/auth/session?${API_VERSION_QUERY}`,
    csrf: `${base}/api/auth/csrf?${API_VERSION_QUERY}`,
    signInEmail: `${base}/api/auth/signin/email?${API_VERSION_QUERY}`,
    otpRedirectLink: `${base}/api/auth/otp-redirect-link`,
    ssoDetails: `${base}/rest/enterprise/organization/login/details?${API_VERSION_QUERY}`,
    models: `${base}/rest/models/config?config_schema=v1&${API_VERSION_QUERY}`,
    asi: `${base}/rest/billing/asi-access-decision?${API_VERSION_QUERY}`,
    rateLimits: `${base}/rest/rate-limit/status?${API_VERSION_QUERY}`,
    experiments: `${base}/rest/experiments/attributes?${API_VERSION_QUERY}`,
    userInfo: `${base}/rest/user/info?${API_VERSION_QUERY}`,
  };
}

export async function pageRequest(page, url, init = {}) {
  return page.evaluate(async ({ url: target, init: requestInit }) => {
    try {
      const response = await fetch(target, {
        credentials: "include",
        ...requestInit,
      });
      const contentType = response.headers.get("content-type") ?? "";
      let json = null;
      let text = null;
      try {
        if (contentType.includes("json")) json = await response.json();
        else text = (await response.text()).slice(0, 500);
      } catch {}
      return {
        ok: response.ok,
        status: response.status,
        redirected: response.redirected,
        url: response.url,
        contentType,
        json,
        text,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        redirected: false,
        url: target,
        contentType: "",
        json: null,
        text: null,
        error: error?.message ?? String(error),
      };
    }
  }, { url, init });
}

export async function pollSession(page, sessionUrl, { timeoutMs = 10_000, intervalMs = 500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const sessionResp = await pageRequest(page, sessionUrl);
    if (sessionResp.ok && sessionResp.json?.user?.id) {
      return sessionResp.json;
    }
    await page.waitForTimeout(intervalMs);
  }
  return null;
}

export function deriveAccountFlags({ experiments, userInfo, asi }) {
  const isEnterprise = userInfo?.is_enterprise === true || experiments?.server_is_enterprise === true;
  const isMax = experiments?.server_is_max === true;
  const canUseComputer = asi?.can_use_computer ?? false;
  const isPro =
    experiments?.server_is_pro === true ||
    (canUseComputer && !isMax && !isEnterprise);

  return { isPro, isMax, isEnterprise, canUseComputer };
}

export function deriveTier(payload) {
  const { isPro, isMax, isEnterprise } = deriveAccountFlags(payload);
  if (isMax) return "Max";
  if (isEnterprise) return "Enterprise";
  if (isPro) return "Pro";
  return "Authenticated";
}

export async function collectSessionMetadata(page, origin, opts = {}) {
  const endpoints = buildRuntimeEndpoints(origin);
  const sessionData =
    opts.sessionData ??
    await pollSession(page, endpoints.session, { timeoutMs: opts.sessionTimeoutMs ?? 10_000 });

  if (!sessionData?.user?.id) {
    return {
      sessionData: null,
      models: null,
      asi: null,
      rateLimits: null,
      experiments: null,
      userInfo: null,
      tier: "Authenticated",
      cache: {
        modelsConfig: null,
        rateLimits: null,
        isPro: false,
        isMax: false,
        isEnterprise: false,
        canUseComputer: false,
      },
    };
  }

  const [modelsResp, asiResp, rateResp, expResp, userInfoResp] = await Promise.all([
    pageRequest(page, endpoints.models),
    pageRequest(page, endpoints.asi),
    pageRequest(page, endpoints.rateLimits),
    pageRequest(page, endpoints.experiments),
    pageRequest(page, endpoints.userInfo),
  ]);

  const payload = {
    experiments: expResp.ok ? expResp.json : null,
    userInfo: userInfoResp.ok ? userInfoResp.json : null,
    asi: asiResp.ok ? asiResp.json : null,
  };
  const flags = deriveAccountFlags(payload);

  return {
    sessionData,
    models: modelsResp.ok ? modelsResp.json : null,
    asi: asiResp.ok ? asiResp.json : null,
    rateLimits: rateResp.ok ? rateResp.json : null,
    experiments: expResp.ok ? expResp.json : null,
    userInfo: userInfoResp.ok ? userInfoResp.json : null,
    tier: deriveTier(payload),
    cache: {
      modelsConfig: modelsResp.ok ? modelsResp.json : null,
      rateLimits: rateResp.ok ? rateResp.json : null,
      isPro: flags.isPro,
      isMax: flags.isMax,
      isEnterprise: flags.isEnterprise,
      canUseComputer: flags.canUseComputer,
    },
  };
}
