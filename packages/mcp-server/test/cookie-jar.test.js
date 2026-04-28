import { describe, it, expect } from "vitest";
import { CookieJar } from "../src/cookie-jar.js";

const HTTPS = "https://www.perplexity.ai";

describe("CookieJar — Set-Cookie parsing", () => {
  it("parses a single Set-Cookie with Domain, Path, Secure, HttpOnly", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "__Secure-next-auth.session-token=abc123; Domain=.perplexity.ai; Path=/; Secure; HttpOnly; SameSite=Lax",
      `${HTTPS}/api/auth/callback/credentials`,
    );
    const out = jar.toPlaywrightShape();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "__Secure-next-auth.session-token",
      value: "abc123",
      domain: ".perplexity.ai",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
  });

  it("accepts an array of Set-Cookie values from a single response", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      [
        "next-auth.csrf-token=token-csrf; Path=/; SameSite=Lax",
        "cf_clearance=cf-value; Domain=.perplexity.ai; Path=/; Secure",
      ],
      `${HTTPS}/api/auth/csrf`,
    );
    const out = jar.toPlaywrightShape();
    expect(out).toHaveLength(2);
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(["cf_clearance", "next-auth.csrf-token"]);
  });

  it("ignores malformed Set-Cookie headers", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader("=novalue", HTTPS);
    jar.consumeSetCookieHeader("noequalsign", HTTPS);
    jar.consumeSetCookieHeader("", HTTPS);
    expect(jar.toPlaywrightShape()).toHaveLength(0);
  });
});

describe("CookieJar — buildCookieHeader serialisation", () => {
  it("includes only matching cookies and joins with '; '", () => {
    const jar = new CookieJar();
    jar.set("a", "1", { domain: ".perplexity.ai", path: "/" });
    jar.set("b", "2", { domain: "other.com", path: "/" });
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("a=1");
  });

  it("returns '' when nothing matches", () => {
    const jar = new CookieJar();
    jar.set("a", "1", { domain: "other.com", path: "/" });
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("");
  });

  it("returns '' for invalid request URLs", () => {
    const jar = new CookieJar();
    jar.set("a", "1", { domain: "perplexity.ai", path: "/" });
    expect(jar.buildCookieHeader("not-a-url")).toBe("");
  });

  it("sorts cookies by path length descending (RFC 6265 §5.4)", () => {
    const jar = new CookieJar();
    jar.set("short", "s", { domain: ".perplexity.ai", path: "/" });
    jar.set("long", "l", { domain: ".perplexity.ai", path: "/api/auth" });
    expect(jar.buildCookieHeader(`${HTTPS}/api/auth/csrf`)).toBe("long=l; short=s");
  });
});

describe("CookieJar — domain matching", () => {
  it("a Domain=.perplexity.ai cookie matches both www.perplexity.ai and perplexity.ai", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "session=abc; Domain=.perplexity.ai; Path=/",
      `${HTTPS}/`,
    );
    expect(jar.buildCookieHeader("https://www.perplexity.ai/")).toBe("session=abc");
    expect(jar.buildCookieHeader("https://perplexity.ai/")).toBe("session=abc");
  });

  it("a host-only cookie on api.perplexity.ai does NOT match www.perplexity.ai", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      // No Domain attribute → host-only cookie pinned to api.perplexity.ai.
      "x=y; Path=/",
      "https://api.perplexity.ai/v1/foo",
    );
    expect(jar.buildCookieHeader("https://www.perplexity.ai/")).toBe("");
    expect(jar.buildCookieHeader("https://api.perplexity.ai/v1/foo")).toBe("x=y");
  });
});

describe("CookieJar — path matching", () => {
  it("an /api/auth cookie matches /api/auth/csrf but not /", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "csrf=v; Domain=.perplexity.ai; Path=/api/auth",
      `${HTTPS}/api/auth/csrf`,
    );
    expect(jar.buildCookieHeader(`${HTTPS}/api/auth/csrf`)).toBe("csrf=v");
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("");
  });

  it("uses RFC 6265 default-path when Path attribute is absent", () => {
    const jar = new CookieJar();
    // No Path → default-path of /api/auth/foo is /api/auth (everything before
    // the last slash). So /api/auth/foo matches but /api matches only because
    // it doesn't have a slash boundary — we expect / NOT to match.
    jar.consumeSetCookieHeader(
      "p=v",
      `${HTTPS}/api/auth/foo`,
    );
    expect(jar.buildCookieHeader(`${HTTPS}/api/auth/foo`)).toBe("p=v");
    expect(jar.buildCookieHeader(`${HTTPS}/api/auth/csrf`)).toBe("p=v");
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("");
  });
});

describe("CookieJar — expiry handling", () => {
  it("expires-in-the-past cookie is excluded from header but kept in jar", () => {
    const jar = new CookieJar();
    // Construct via set() so we can drop in a stale-but-not-server-deleted
    // entry — Expires header arriving on-the-wire IS treated as a delete.
    jar.set("stale", "v", {
      domain: ".perplexity.ai",
      path: "/",
      expires: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("");
    // Still present in the jar — a refresh should be able to overwrite it.
    expect(jar.toPlaywrightShape()).toHaveLength(1);
    expect(jar.toPlaywrightShape()[0].name).toBe("stale");
  });

  it("session cookies (expires=-1) are always included", () => {
    const jar = new CookieJar();
    jar.set("session", "v", {
      domain: ".perplexity.ai",
      path: "/",
      expires: -1,
    });
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("session=v");
  });

  it("Max-Age=0 deletes the cookie outright", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "kill=me; Domain=.perplexity.ai; Path=/",
      `${HTTPS}/`,
    );
    expect(jar.toPlaywrightShape()).toHaveLength(1);
    jar.consumeSetCookieHeader(
      "kill=me; Domain=.perplexity.ai; Path=/; Max-Age=0",
      `${HTTPS}/`,
    );
    expect(jar.toPlaywrightShape()).toHaveLength(0);
  });

  it("Max-Age wins when both Expires and Max-Age are present", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      // Expires would be in the past, but Max-Age=3600 keeps it alive.
      "live=yes; Domain=.perplexity.ai; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600",
      `${HTTPS}/`,
    );
    expect(jar.buildCookieHeader(`${HTTPS}/`)).toBe("live=yes");
  });
});

describe("CookieJar — replacement semantics", () => {
  it("replaces an existing cookie with the same (name, domain, path) triple", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "session=old; Domain=.perplexity.ai; Path=/",
      `${HTTPS}/`,
    );
    jar.consumeSetCookieHeader(
      "session=new; Domain=.perplexity.ai; Path=/",
      `${HTTPS}/`,
    );
    const all = jar.toPlaywrightShape();
    expect(all).toHaveLength(1);
    expect(all[0].value).toBe("new");
  });

  it("treats different paths as distinct cookies even with same name", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "x=root; Domain=.perplexity.ai; Path=/",
      `${HTTPS}/`,
    );
    jar.consumeSetCookieHeader(
      "x=auth; Domain=.perplexity.ai; Path=/api/auth",
      `${HTTPS}/api/auth/csrf`,
    );
    expect(jar.toPlaywrightShape()).toHaveLength(2);
    // Path /api/auth wins by length sort when both apply.
    expect(jar.buildCookieHeader(`${HTTPS}/api/auth/csrf`)).toBe("x=auth; x=root");
  });
});

describe("CookieJar — Secure attribute", () => {
  it("Secure cookies are excluded from http:// requests", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "secret=v; Domain=.perplexity.ai; Path=/; Secure",
      `${HTTPS}/`,
    );
    expect(jar.buildCookieHeader("http://www.perplexity.ai/")).toBe("");
    expect(jar.buildCookieHeader("https://www.perplexity.ai/")).toBe("secret=v");
  });

  it("non-Secure cookies are sent over both http:// and https://", () => {
    const jar = new CookieJar();
    jar.consumeSetCookieHeader(
      "open=v; Domain=.perplexity.ai; Path=/",
      `${HTTPS}/`,
    );
    expect(jar.buildCookieHeader("http://www.perplexity.ai/")).toBe("open=v");
    expect(jar.buildCookieHeader("https://www.perplexity.ai/")).toBe("open=v");
  });
});

describe("CookieJar — PlaywrightCookie round-trip", () => {
  it("constructs from PlaywrightCookie[] and emits an equivalent array", () => {
    /** @type {import("../src/config.js").PlaywrightCookie[]} */
    const initial = [
      {
        name: "__Secure-next-auth.session-token",
        value: "tok",
        domain: ".perplexity.ai",
        path: "/",
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "host-only",
        value: "v",
        domain: "api.perplexity.ai",
        path: "/v1",
        expires: 9999999999,
        secure: true,
        httpOnly: false,
      },
    ];
    const jar = new CookieJar(initial);
    const out = jar.toPlaywrightShape();
    expect(out).toHaveLength(2);

    // Order is not guaranteed by Map iteration semantics in our public API.
    const byName = Object.fromEntries(out.map((c) => [c.name, c]));
    expect(byName["__Secure-next-auth.session-token"]).toMatchObject({
      value: "tok",
      domain: ".perplexity.ai",   // domain cookie keeps the leading dot on round-trip
      path: "/",
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(byName["host-only"]).toMatchObject({
      value: "v",
      domain: "api.perplexity.ai", // host-only cookie has NO leading dot
      path: "/v1",
      expires: 9999999999,
      secure: true,
      httpOnly: false,
    });
  });

  it("buildCookieHeader uses the seeded cookies on subsequent requests", () => {
    const jar = new CookieJar([
      {
        name: "cf_clearance",
        value: "cf-token",
        domain: ".perplexity.ai",
        path: "/",
        expires: -1,
        secure: true,
        httpOnly: true,
      },
    ]);
    expect(jar.buildCookieHeader(`${HTTPS}/api/auth/csrf`)).toBe("cf_clearance=cf-token");
  });
});
