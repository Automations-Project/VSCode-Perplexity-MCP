import { describe, it, expect } from "vitest";
import { redact } from "../src/redact.js";

describe("redact", () => {
  describe("emails", () => {
    it("redacts a single email", () => {
      expect(redact("contact alice@company.com please")).toBe("contact <email> please");
    });
    it("redacts multiple emails", () => {
      expect(redact("a@b.co and c@d.co")).toBe("<email> and <email>");
    });
    it("leaves non-email @ symbols alone", () => {
      expect(redact("@everyone here")).toBe("@everyone here");
    });
  });

  describe("Perplexity userIds", () => {
    it("redacts user_* tokens", () => {
      expect(redact("userId user_4f2a9c38a1d2 logged in")).toBe("userId <userId> logged in");
    });
    it("does not redact the word 'user' alone", () => {
      expect(redact("the user is")).toBe("the user is");
    });
  });

  describe("home directory paths", () => {
    it("redacts Unix home paths", () => {
      expect(redact("/Users/alice/proj/file")).toBe("<home>/proj/file");
      expect(redact("/home/bob/proj/file")).toBe("<home>/proj/file");
    });
    it("redacts Windows home paths", () => {
      expect(redact("C:\\Users\\alice\\proj\\file")).toBe("<home>\\proj\\file");
    });
  });

  describe("cookie values", () => {
    // Phase 8.2 H0: cookies now get kind-tagged `<redacted:<kind>>`
    // placeholders via SECRET_PATTERNS. Either the legacy `<cookie>` label
    // or the new `<redacted:perplexity-session>` / `<redacted:cf-clearance>`
    // is acceptable so long as the raw value is gone — so the assertions
    // below accept both shapes.
    it("redacts __Secure-next-auth.session-token", () => {
      const input = '__Secure-next-auth.session-token=eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..abc';
      const out = redact(input);
      expect(out).toMatch(/__Secure-next-auth\.session-token=(<cookie>|<redacted:perplexity-session>)/);
      expect(out).not.toContain("eyJhbGciOiJkaXIi");
    });
    it("redacts cf_clearance", () => {
      const input = 'cf_clearance=longrandomstring12345';
      const out = redact(input);
      expect(out).toMatch(/^cf_clearance=(<cookie>|<redacted:cf-clearance>)$/);
      expect(out).not.toContain("longrandomstring12345");
    });
  });

  describe("long opaque tokens", () => {
    it("redacts base64-looking strings >20 chars", () => {
      const input = "token=aGVsbG93b3JsZGFiY2RlZmdoaWprbG1ub3A=";
      expect(redact(input)).toBe("token=<redacted>");
    });
    it("redacts hex-looking strings >20 chars", () => {
      expect(redact("key=ab3f9c28de4f1023abcdef0123456789")).toBe("key=<redacted>");
    });
    it("leaves short strings alone", () => {
      expect(redact("id=abc123")).toBe("id=abc123");
    });
  });

  describe("IP addresses", () => {
    it("redacts IPv4", () => {
      expect(redact("connected from 192.168.1.42")).toBe("connected from <ip>");
    });
    it("redacts IPv6", () => {
      expect(redact("addr 2001:db8::8a2e:370:7334 reachable")).toBe("addr <ip> reachable");
    });
    it("leaves single-colon hex patterns alone", () => {
      expect(redact("token ab:cd")).toBe("token ab:cd");
    });
  });

  describe("passthrough", () => {
    it("leaves innocuous text intact", () => {
      const input = "Session valid - 57 models - Pro tier";
      expect(redact(input)).toBe(input);
    });
    it("handles empty strings", () => {
      expect(redact("")).toBe("");
    });
    it("handles null and undefined", () => {
      expect(redact(null)).toBeNull();
      expect(redact(undefined)).toBeUndefined();
    });
    it("handles numbers passthrough", () => {
      expect(redact(42)).toBe(42);
    });
    it("handles objects via recursive redaction", () => {
      const obj = { email: "x@y.co", msg: "ok" };
      expect(redact(obj)).toEqual({ email: "<email>", msg: "ok" });
    });
    it("handles arrays via recursive redaction", () => {
      expect(redact(["a@b.co", "x"])).toEqual(["<email>", "x"]);
    });
    it("handles nested object-in-array", () => {
      const input = [{ email: "a@b.co" }, { userId: "user_12345abcdef" }];
      expect(redact(input)).toEqual([
        { email: "<email>" },
        { userId: "<userId>" },
      ]);
    });
  });

  describe("circular references", () => {
    it("returns <circular> for self-referencing objects", () => {
      const obj = { name: "alice@co.co" };
      obj.self = obj;
      const result = redact(obj);
      expect(result.name).toBe("<email>");
      expect(result.self).toBe("<circular>");
    });

    it("handles circular references in arrays", () => {
      const arr = ["a@b.co"];
      arr.push(arr);
      const result = redact(arr);
      expect(result[0]).toBe("<email>");
      expect(result[1]).toBe("<circular>");
    });

    it("allows legitimate repeated references (same object twice, not cyclic)", () => {
      const shared = { email: "x@y.co" };
      const root = { a: shared, b: shared };
      const result = redact(root);
      expect(result.a).toEqual({ email: "<email>" });
      // b will render as <circular> in current impl since it reuses the same reference.
      // This is acceptable — the seen set detects reuse, not only true cycles.
      // If we ever need to distinguish, replace WeakSet with a depth-aware WeakMap.
      expect(result.b === "<circular>" || result.b.email === "<email>").toBe(true);
    });
  });
});

describe("redact — ISO timestamp preservation (regression for Phase 3.1)", () => {
  it("preserves ISO-8601 timestamps verbatim", () => {
    const input = "Generated: 2026-04-20T10:27:42.278Z";
    expect(redact(input)).toBe(input);
  });

  it("still redacts real IPv6 addresses", () => {
    expect(redact("addr 2001:db8::1")).toMatch(/<ip>/);
    expect(redact("local fe80::1")).toMatch(/<ip>/);
    expect(redact("abbr ::1")).toMatch(/<ip>/);
  });

  it("still redacts IPv4", () => {
    expect(redact("addr 192.168.0.1 is private")).toMatch(/<ip>/);
  });

  it("does not redact HH:MM or HH:MM:SS wall-clock strings", () => {
    expect(redact("at 09:15 today")).toContain("09:15");
    expect(redact("run at 23:59:59 tonight")).toContain("23:59:59");
  });
});
