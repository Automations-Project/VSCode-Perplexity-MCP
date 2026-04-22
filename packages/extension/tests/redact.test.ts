import { describe, it, expect } from "vitest";
import { redactMessage, redactObject } from "../src/redact.js";

describe("extension redactor", () => {
  it("redacts daemon bearer in a JSON-shaped string", () => {
    const raw = `posting {"type":"daemon:status-updated","payload":{"bearerToken":"TEST_DAEMON_BEARER_FIXTURE_NOT_A_REAL_SECRET","port":7764}}`;
    const out = redactMessage(raw);
    expect(out).not.toContain("TEST_DAEMON_BEARER_FIXTURE_NOT_A_REAL_SECRET");
    expect(out).toContain('"bearerToken":"<redacted:daemon-bearer>"');
  });

  it("redacts an Authorization header value", () => {
    const raw = "GET /mcp HTTP/1.1\r\nAuthorization: Bearer pplx_at_abcdefghij12345\r\n";
    const out = redactMessage(raw);
    expect(out).not.toContain("pplx_at_abcdefghij12345");
    expect(out).toMatch(/Authorization:\s*Bearer <redacted:(bearer-header|oauth-access)>/);
  });

  it("redacts OAuth access / refresh / code tokens", () => {
    const raw = "access=pplx_at_xxxxxxxxxxxxxxxxxxx refresh=pplx_rt_yyyyyyyyyyyyyyyyyyy code=pplx_ac_zzzzzzzzzzzzzzzzzzz";
    const out = redactMessage(raw);
    expect(out).not.toMatch(/pplx_(at|rt|ac)_[A-Za-z0-9_\-]{5,}/);
    expect(out).toContain("<redacted:oauth-access>");
    expect(out).toContain("<redacted:oauth-refresh>");
    expect(out).toContain("<redacted:oauth-code>");
  });

  it("redacts ngrok authtoken inside a JSON blob", () => {
    const raw = '{"authtoken":"12345678AbCdEfGhIjKlMnOpQrStUvWx","domain":"myapp.ngrok-free.app"}';
    const out = redactMessage(raw);
    expect(out).not.toContain("12345678AbCdEfGhIjKlMnOpQrStUvWx");
    expect(out).toContain('"authtoken":"<redacted:ngrok-authtoken>"');
  });

  it("redacts JWT-shaped strings", () => {
    const raw = "token=eyJhbGc.eyJzdWIi.abc123";
    expect(redactMessage(raw)).toContain("<redacted:jwt>");
    expect(redactMessage(raw)).not.toContain("eyJhbGc.eyJzdWIi.abc123");
  });

  it("redacts cf_clearance + perplexity session cookies", () => {
    const raw = "Cookie: cf_clearance=abc.def.ghi; __Secure-next-auth.session-token=xyz.pqr.stu";
    const out = redactMessage(raw);
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("xyz.pqr.stu");
    expect(out).toContain("<redacted:cf-clearance>");
    expect(out).toContain("<redacted:perplexity-session>");
  });

  it("redactObject recursively scrubs nested values", () => {
    const input = {
      type: "log:webview",
      payload: { args: [{ button: "click", status: { bearerToken: "SECRET_1234567890_abcdefghijklmnop", port: 7764 } }] },
    };
    const out = redactObject(input);
    expect(JSON.stringify(out)).not.toContain("SECRET_1234567890_abcdefghijklmnop");
    expect(JSON.stringify(out)).toContain("<redacted:daemon-bearer>");
    expect((out as any).payload.args[0].status.port).toBe(7764);
  });

  it("is a no-op for strings without secrets", () => {
    const clean = "daemon:status-updated port=7764 tunnel=enabled";
    expect(redactMessage(clean)).toBe(clean);
  });
});
