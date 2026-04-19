import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "./mock-server.js";

describe("mock-server", () => {
  let server;
  beforeAll(async () => { server = await start({ port: 0 }); });
  afterAll(async () => { await server.close(); });

  it("serves /login GET HTML with an email field", async () => {
    const r = await fetch(`${server.url}/login`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toMatch(/name="email"/);
  });

  it("POST /login/email returns 200 and remembers the email", async () => {
    const r = await fetch(`${server.url}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com" }),
    });
    expect(r.status).toBe(200);
  });

  it("POST /login/otp with the accepted code sets the session cookie", async () => {
    await fetch(`${server.url}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com" }),
    });
    const r = await fetch(`${server.url}/login/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com", otp: "123456" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/__Secure-next-auth\.session-token=/);
  });

  it("POST /login/otp with wrong code returns 401", async () => {
    const r = await fetch(`${server.url}/login/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com", otp: "999999" }),
    });
    expect(r.status).toBe(401);
  });

  it("GET /api/auth/session returns user when session cookie present", async () => {
    await fetch(`${server.url}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com" }),
    });
    const otp = await fetch(`${server.url}/login/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com", otp: "123456" }),
    });
    const cookie = otp.headers.get("set-cookie").split(";")[0];
    const s = await fetch(`${server.url}/api/auth/session`, { headers: { cookie } });
    const json = await s.json();
    expect(json.user.email).toBe("t@example.com");
    expect(json.user.id).toMatch(/^user_/);
  });

  it("GET /rest/user/experiments returns Pro flags when authed", async () => {
    await fetch(`${server.url}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com" }),
    });
    const otp = await fetch(`${server.url}/login/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "t@example.com", otp: "123456" }),
    });
    const cookie = otp.headers.get("set-cookie").split(";")[0];
    const r = await fetch(`${server.url}/rest/user/experiments`, { headers: { cookie } });
    const json = await r.json();
    expect(json.server_is_pro).toBe(true);
  });
});
