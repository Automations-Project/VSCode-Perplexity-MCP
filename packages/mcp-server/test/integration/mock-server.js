import express from "express";

/**
 * Minimal Perplexity-shaped mock. Supports both the old local `/login/*`
 * flow and the live-site NextAuth + OTP flow used on `www.perplexity.ai`.
 */
export async function start(opts = {}) {
  const app = express();
  app.use(express.json());

  const sessions = new Map(); // token -> {email, userId}
  const pendingOtp = new Set(); // emails currently expecting OTP

  function makeUserId(email) {
    return "user_" + Buffer.from(email).toString("hex").slice(0, 16);
  }

  function setSessionCookies(res, email) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.set(token, { email, userId: makeUserId(email) });
    pendingOtp.delete(email);
    // `__Secure-` prefix requires secure:true — Chromium rejects the cookie otherwise.
    // 127.0.0.1 is a potentially-trustworthy origin so Chromium accepts Secure cookies over plain HTTP.
    res.cookie("__Secure-next-auth.session-token", token, { httpOnly: true, secure: true, path: "/" });
    res.cookie("cf_clearance", "mock-cf", { path: "/" });
  }

  function readSession(req) {
    const cookies = Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((kv) => kv.split("=")));
    const tok = cookies["__Secure-next-auth.session-token"];
    return tok ? sessions.get(tok) : null;
  }

  function requireSession(req, res) {
    if (!readSession(req)) {
      res.status(401).end();
      return false;
    }
    return true;
  }

  function renderCf(res) {
    return res.status(503).type("html").send("<html><head><title>Just a moment...</title></head><body>cf</body></html>");
  }

  app.get("/login", (req, res) => {
    if (req.query.force_cf) return renderCf(res);
    res.type("html").send(`<!doctype html><html><body>
      <form method="POST" action="/login/email">
        <input name="email" type="email" />
        <button type="submit">Continue</button>
      </form>
    </body></html>`);
  });

  app.get("/account", (req, res) => {
    if (req.query.force_cf) return renderCf(res);
    res.type("html").send(`<!doctype html><html><body>
      <input name="email" type="email" placeholder="Enter your email" />
      <button type="button">Continue with email</button>
      <button type="button">Single sign-on (SSO)</button>
    </body></html>`);
  });

  app.post("/login/email", (req, res) => {
    if (opts.forceUnsupported) {
      return res.status(404).type("html").send("<html><body>Not Found</body></html>");
    }
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: "email required" });
    if (email.includes("@sso.test")) return res.status(302).set("Location", "/sso").send();
    pendingOtp.add(email);
    res.status(200).json({ ok: true, next: "otp" });
  });

  app.get("/login/otp", (_req, res) => {
    res.type("html").send(`<!doctype html><html><body>
      <form method="POST" action="/login/otp">
        <input name="email" />
        <input name="otp" />
        <button type="submit">Verify</button>
      </form>
    </body></html>`);
  });

  app.post("/login/otp", (req, res) => {
    const { email, otp } = req.body ?? {};
    if (otp !== "123456") return res.status(401).json({ error: "wrong otp" });
    if (!email || !pendingOtp.has(email)) return res.status(400).json({ error: "no pending otp" });
    setSessionCookies(res, email);
    res.status(200).json({ ok: true });
  });

  app.post("/rest/enterprise/organization/login/details", (req, res) => {
    const email = req.body?.email ?? "";
    if (email.includes("@sso.test")) {
      return res.json({ organization: { id: "org_mock", name: "Mock SSO" } });
    }
    res.json({ organization: null });
  });

  app.get("/api/auth/csrf", (_req, res) => {
    if (opts.forceUnsupported) {
      return res.status(404).type("html").send("<html><body>Not Found</body></html>");
    }
    res.json({ csrfToken: "mock-csrf-token" });
  });

  app.post("/api/auth/signin/email", (req, res) => {
    if (opts.forceUnsupported) {
      return res.status(404).type("html").send("<html><body>Not Found</body></html>");
    }
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: "email required" });
    if (email.includes("@sso.test")) return res.status(400).json({ error: "sso required" });
    pendingOtp.add(email);
    res.json({ url: "/auth/verify-request" });
  });

  app.get("/auth/verify-request", (req, res) => {
    const email = String(req.query.email ?? "");
    res.type("html").send(`<!doctype html><html><body>
      <h1>Check your email</h1>
      <p>A temporary sign-in link has been sent to ${email}</p>
      <div>
        <input inputmode="numeric" maxlength="1" />
        <input inputmode="numeric" maxlength="1" />
        <input inputmode="numeric" maxlength="1" />
        <input inputmode="numeric" maxlength="1" />
        <input inputmode="numeric" maxlength="1" />
        <input inputmode="numeric" maxlength="1" />
      </div>
      <button type="button">Confirm</button>
    </body></html>`);
  });

  app.post("/api/auth/otp-redirect-link", (req, res) => {
    const { email, otp, redirectUrl } = req.body ?? {};
    if (!email) return res.status(400).json({ error: "email required" });
    res.json({
      status: "success",
      redirect:
        `/api/auth/callback/email?callbackUrl=${encodeURIComponent(redirectUrl ?? "/account")}` +
        `&email=${encodeURIComponent(email)}&email-login-method=web-otp&token=${encodeURIComponent(otp ?? "")}`,
    });
  });

  app.get("/api/auth/callback/email", (req, res) => {
    const email = String(req.query.email ?? "");
    const token = String(req.query.token ?? "");
    const callbackUrl = String(req.query.callbackUrl ?? "/account");
    if (!email || !pendingOtp.has(email) || token !== "123456") {
      return res.redirect(307, "/auth/error?error=Verification");
    }
    setSessionCookies(res, email);
    res.redirect(307, callbackUrl);
  });

  app.get("/auth/error", (_req, res) => {
    res.type("html").send(`<!doctype html><html><body>
      <h1>Unable to sign in</h1>
      <p>The sign in link is no longer valid.</p>
    </body></html>`);
  });

  app.get("/api/auth/session", (req, res) => {
    const s = readSession(req);
    if (!s) return res.json({});
    res.json({ user: { id: s.userId, email: s.email, name: s.email.split("@")[0] } });
  });

  const modelsHandler = (req, res) => {
    if (!requireSession(req, res)) return;
    res.json({
      models: {
        turbo: { id: "turbo", displayName: "Sonar" },
        pplx_alpha: { id: "pplx_alpha", displayName: "Research" },
      },
      config: [],
      default_models: {},
    });
  };
  app.get("/rest/models-config", modelsHandler);
  app.get("/rest/models/config", modelsHandler);

  const asiHandler = (req, res) => {
    if (!requireSession(req, res)) return;
    res.json({ can_use_computer: true });
  };
  app.get("/rest/asi-access", asiHandler);
  app.get("/rest/billing/asi-access-decision", asiHandler);

  const rateHandler = (req, res) => {
    if (!requireSession(req, res)) return;
    res.json({ pro_search: { remaining: 100 }, research: { remaining: 10 } });
  };
  app.get("/rest/rate-limit", rateHandler);
  app.get("/rest/rate-limit/status", rateHandler);

  const experimentsHandler = (req, res) => {
    if (!requireSession(req, res)) return;
    res.json({ server_is_pro: true, server_is_max: false, server_is_enterprise: false });
  };
  app.get("/rest/user/experiments", experimentsHandler);
  app.get("/rest/experiments/attributes", experimentsHandler);

  app.get("/rest/user/info", (req, res) => {
    if (!requireSession(req, res)) return;
    res.json({ is_enterprise: false, has_non_public_email: false });
  });

  const port = opts.port ?? 0;
  const srv = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  const { port: actual } = srv.address();
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise((r) => srv.close(r)),
  };
}
