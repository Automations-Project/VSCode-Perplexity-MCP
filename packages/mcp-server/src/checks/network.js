import { lookup } from "node:dns/promises";
import { request } from "node:https";

const CATEGORY = "network";
const DEFAULT_HOST = "www.perplexity.ai";

function httpsHead(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "HEAD", timeout: timeoutMs }, (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers });
      res.resume();
    });
    req.on("timeout", () => { req.destroy(new Error("HTTPS HEAD timeout")); });
    req.on("error", reject);
    req.end();
  });
}

export async function run(opts = {}) {
  const results = [];
  const host = opts.host ?? DEFAULT_HOST;
  const dns = opts.dnsLookupOverride ?? lookup;
  const head = opts.httpsHeadOverride ?? ((u) => httpsHead(u));

  let addr = null;
  try {
    addr = await dns(host);
    results.push({ category: CATEGORY, name: "dns", status: "pass", message: `${host} -> ${addr.address}` });
  } catch (err) {
    results.push({
      category: CATEGORY,
      name: "dns",
      status: "fail",
      message: `DNS lookup failed: ${err.message}`,
      hint: "Check internet connection / proxy / VPN.",
    });
    return results;
  }

  let headRes;
  try {
    headRes = await head(`https://${host}${process.env.PERPLEXITY_LOGIN_PATH || "/account"}`);
    results.push({ category: CATEGORY, name: "https", status: "pass", message: `HEAD / status ${headRes.statusCode}` });
  } catch (err) {
    results.push({
      category: CATEGORY,
      name: "https",
      status: "fail",
      message: `HTTPS failed: ${err.message}`,
      hint: "TLS/MITM proxy? Corporate firewall?",
    });
    return results;
  }

  const isCf = String(headRes.headers?.server ?? "").toLowerCase().includes("cloudflare") && headRes.statusCode === 503;
  if (isCf) {
    results.push({
      category: CATEGORY,
      name: "cf-challenge",
      status: "warn",
      message: "Cloudflare challenge active — logins may need manual captcha.",
      hint: "Try login --mode manual if auto mode fails.",
    });
  } else {
    results.push({ category: CATEGORY, name: "cf-challenge", status: "pass", message: "no challenge detected" });
  }

  return results;
}
