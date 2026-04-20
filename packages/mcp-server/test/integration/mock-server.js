import express from "express";

/**
 * Minimal Perplexity-shaped mock. Accepts:
 *   POST /login/email            { email }                     -> 200, stores pending-OTP
 *   POST /login/otp              { email, otp }                -> 200 + Set-Cookie if otp==="123456"
 *                                                                401 otherwise
 *   GET  /login                                                 -> HTML with email form
 *   GET  /login/otp                                             -> HTML with OTP form (set after email step)
 *   GET  /api/auth/session                                     -> {user:{id,email}} if cookie, else {}
 *   GET  /rest/models-config                                   -> fixed models list
 *   GET  /rest/asi-access                                      -> {can_use_computer: true}
 *   GET  /rest/rate-limit                                      -> rate-limit shape
 *   GET  /rest/user/experiments                                -> {server_is_pro:true, ...}
 *
 * Query param `?force_cf=1` on `GET /login` simulates CF block (returns 503 + cf title).
 */
export async function start(opts = {}) {
  const app = express();
  app.use(express.json());

  const sessions = new Map();  // token -> {email, userId}
  const pendingOtp = new Set(); // emails currently expecting OTP

  function makeUserId(email) {
    return "user_" + Buffer.from(email).toString("hex").slice(0, 16);
  }

  app.get("/login", (req, res) => {
    if (req.query.force_cf) {
      return res.status(503).type("html").send("<html><head><title>Just a moment...</title></head><body>cf</body></html>");
    }
    res.type("html").send(`<!doctype html><html><body>
      <form method="POST" action="/login/email">
        <input name="email" type="email" />
        <button type="submit">Continue</button>
      </form>
    </body></html>`);
  });

  app.post("/login/email", (req, res) => {
    // `forceUnsupported: true` (startup option) simulates a non-mock origin
    // (e.g. real perplexity.ai) that doesn't expose this endpoint. Returns an
    // HTML 404 so the runner should classify it as `auto_unsupported` instead
    // of `email_rejected`.
    if (opts.forceUnsupported) {
      return res.status(404).type("html").send("<html><body>Not Found</body></html>");
    }
    const email = req.body?.email;
    if (!email) return res.status(400).json({ error: "email required" });
    if (email.includes("@sso.test")) return res.status(302).set("Location", "/sso").send();
    pendingOtp.add(email);
    res.status(200).json({ ok: true, next: "otp" });
  });

  app.get("/login/otp", (req, res) => {
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
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.set(token, { email, userId: makeUserId(email) });
    pendingOtp.delete(email);
    // `__Secure-` prefix requires secure:true — Chromium rejects the cookie otherwise.
    // 127.0.0.1 is a potentially-trustworthy origin so Chromium accepts Secure cookies over plain HTTP.
    res.cookie("__Secure-next-auth.session-token", token, { httpOnly: true, secure: true, path: "/" });
    res.cookie("cf_clearance", "mock-cf", { path: "/" });
    res.status(200).json({ ok: true });
  });

  function readSession(req) {
    const cookies = Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((kv) => kv.split("=")));
    const tok = cookies["__Secure-next-auth.session-token"];
    return tok ? sessions.get(tok) : null;
  }

  app.get("/api/auth/session", (req, res) => {
    const s = readSession(req);
    if (!s) return res.json({});
    res.json({ user: { id: s.userId, email: s.email, name: s.email.split("@")[0] } });
  });

  app.get("/rest/models-config", (req, res) => {
    if (!readSession(req)) return res.status(401).end();
    res.json({ models: { turbo: { id: "turbo", displayName: "Sonar" }, pplx_alpha: { id: "pplx_alpha", displayName: "Research" } } });
  });

  app.get("/rest/asi-access", (req, res) => {
    if (!readSession(req)) return res.status(401).end();
    res.json({ can_use_computer: true });
  });

  app.get("/rest/rate-limit", (req, res) => {
    if (!readSession(req)) return res.status(401).end();
    res.json({ pro_search: { remaining: 100 }, research: { remaining: 10 } });
  });

  app.get("/rest/user/experiments", (req, res) => {
    if (!readSession(req)) return res.status(401).end();
    res.json({ server_is_pro: true, server_is_max: false, server_is_enterprise: false });
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
