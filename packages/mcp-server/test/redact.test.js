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
    it("redacts __Secure-next-auth.session-token", () => {
      const input = '__Secure-next-auth.session-token=eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..abc';
      expect(redact(input)).toMatch(/__Secure-next-auth\.session-token=<cookie>/);
    });
    it("redacts cf_clearance", () => {
      const input = 'cf_clearance=longrandomstring12345';
      expect(redact(input)).toBe("cf_clearance=<cookie>");
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
});
