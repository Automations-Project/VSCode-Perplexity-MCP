import { describe, it, expect } from "vitest";
import { redact, redactSecrets, SECRET_PATTERNS } from "../../src/redact.js";

describe("daemon redactor — SECRET_PATTERNS", () => {
  const KNOWN_BAD = [
    '"bearerToken":"TEST_DAEMON_BEARER_0123456789012345678901"',
    '"bearer":"TEST_REVEAL_BEARER_0123456789012345"',
    "Authorization: Bearer pplx_at_AAAAAAAAAAAAAAAAAAAA",
    "refresh=pplx_rt_BBBBBBBBBBBBBBBBBBBB",
    "code=pplx_ac_CCCCCCCCCCCCCCCCCCCC",
    "local=pplx_local_claudedesktop_DDDDDDDDDDDDDDDDDDDD",
    '"authtoken":"12345678EEEEEEEEEEEEEEEEEEEEEEEE"',
    "jwt=eyJabc.eyJdef.ghi123",
    "Cookie: cf_clearance=CLEARANCEVAL; __Secure-next-auth.session-token=SESSIONVAL",
  ];

  it("every pattern matches its canonical example", () => {
    const joined = KNOWN_BAD.join("\n");
    for (const { name, re } of SECRET_PATTERNS) {
      const fresh = new RegExp(re.source, re.flags);
      expect(fresh.test(joined), `pattern ${name} did not match canonical example`).toBe(true);
    }
  });

  it("redactSecrets removes every canonical secret from the joined corpus", () => {
    const joined = KNOWN_BAD.join("\n");
    const out = redactSecrets(joined);
    expect(out).not.toMatch(/pplx_(at|rt|ac|local)_[A-Za-z0-9_\-]{10,}/);
    expect(out).not.toMatch(/eyJabc\.eyJdef\.ghi123/);
    expect(out).not.toContain("CLEARANCEVAL");
    expect(out).not.toContain("SESSIONVAL");
    expect(out).not.toContain("TEST_DAEMON_BEARER_0123456789012345678901");
    expect(out).not.toContain("12345678EEEEEEEEEEEEEEEEEEEEEEEE");
  });

  it("composite redact() — what every existing daemon call site uses — ALSO strips every canonical secret", () => {
    // This is the explicit anti-regression test for the fix that wires
    // SECRET_PATTERNS into redactString inside redact.js. If a future change
    // reverts that wiring (accidental revert, refactor), daemon-side log
    // sinks silently stop scrubbing the new shapes — which is the exact bug
    // H0 is designed to prevent. Keep this test.
    const joined = KNOWN_BAD.join("\n");
    const out = redact(joined);
    expect(out).not.toMatch(/pplx_(at|rt|ac|local)_[A-Za-z0-9_\-]{10,}/);
    expect(out).not.toMatch(/eyJabc\.eyJdef\.ghi123/);
    expect(out).not.toContain("CLEARANCEVAL");
    expect(out).not.toContain("SESSIONVAL");
    expect(out).not.toContain("TEST_DAEMON_BEARER_0123456789012345678901");
    expect(out).not.toContain("12345678EEEEEEEEEEEEEEEEEEEEEEEE");
  });

  it("composite redact() preserves legacy PATTERNS behavior for emails + userIds + paths + IPs", () => {
    // Regression guard: merging SECRET_PATTERNS must NOT accidentally remove
    // or shadow the existing email / userId / path / IP redaction that
    // daemon callers already depend on.
    const raw = "Contact alice@example.com user_abcdef12 at /home/alice from 10.0.0.1";
    const out = redact(raw);
    expect(out).toContain("<email>");
    expect(out).toContain("<userId>");
    expect(out).toContain("<home>");
    expect(out).toContain("<ip>");
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("user_abcdef12");
    expect(out).not.toContain("/home/alice");
    expect(out).not.toContain("10.0.0.1");
  });

  it("clean strings round-trip unchanged", () => {
    const clean = "[trace] daemon:oauth-consent-request clientId=abc redirectUri=http://cb/x";
    expect(redactSecrets(clean)).toBe(clean);
  });
});
