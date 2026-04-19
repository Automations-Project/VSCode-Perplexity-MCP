#!/usr/bin/env node
/**
 * Perplexity Internal API Traffic Capture Tool
 *
 * Opens a visible Chrome window using the persistent profile (already logged in).
 * Intercepts and logs all internal API calls in real-time, with special attention
 * to mutation endpoints (POST/PUT/PATCH/DELETE).
 *
 * Usage:
 *   node capture.js                        — capture all /rest /api /graphql traffic
 *   node capture.js --mutations-only       — only show POST/PUT/PATCH/DELETE
 *   node capture.js --all                  — capture every perplexity.ai request (noisy)
 *   node capture.js --url <url>            — open a specific Perplexity URL
 *   node capture.js --cdp                  — enable CDP on port 9222
 *   node capture.js --cdp --cdp-port 9333  — CDP on a custom port
 *
 * Output:
 *   - Real-time color-coded console output
 *   - captures/<timestamp>.json (incrementally saved)
 *   - captures/<timestamp>.summary.txt on exit
 */

import { chromium } from "patchright";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = join(__dirname, "captures");
const PROFILE_DIR = join(homedir(), ".perplexity-mcp", "chrome-profile");

// ─── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const mutationsOnly = args.includes("--mutations-only");
const captureAll = args.includes("--all");
const cdpEnabled = args.includes("--cdp");
const cdpPortIdx = args.indexOf("--cdp-port");
const cdpPort = cdpPortIdx !== -1 ? parseInt(args[cdpPortIdx + 1], 10) : 9222;
const urlIdx = args.indexOf("--url");
const startUrl = urlIdx !== -1 ? args[urlIdx + 1] : "https://www.perplexity.ai/";

// Filter: by default catch anything under /rest/, /api/, /graphql on perplexity.ai.
// Static assets (/_next/static, /cdn-cgi, .js/.css/.png) are always skipped.
const API_PATH_RE = /perplexity\.ai\/(rest|api|graphql|sse)\b/i;
const STATIC_RE = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;
const NEXT_STATIC_RE = /\/_next\/static\//;
const CF_RE = /\/cdn-cgi\//;

function shouldCapture(url) {
  if (STATIC_RE.test(url) || NEXT_STATIC_RE.test(url) || CF_RE.test(url)) return false;
  if (captureAll) return /perplexity\.ai/i.test(url);
  return API_PATH_RE.test(url);
}

// ─── Colors ─────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function methodColor(method) {
  switch (method) {
    case "GET":    return C.green;
    case "POST":   return C.yellow;
    case "PUT":
    case "PATCH":  return C.blue;
    case "DELETE": return C.red;
    default:       return C.white;
  }
}

function statusColor(status) {
  if (status < 300) return C.green;
  if (status < 400) return C.yellow;
  return C.red;
}

// ─── Capture state ──────────────────────────────────────────────

const captured = {
  startedAt: new Date().toISOString(),
  savedAt: null,
  startUrl,
  requests: [],
  responses: [],
  mutations: [],   // POST/PUT/PATCH/DELETE with decoded payloads
  websockets: [],
  endpoints: new Set(),
  errors: [],      // listener errors so users can debug silent drops
};

let requestCounter = 0;
let saveTimer = null;
let jsonPath = null;

function decodePayload(postData) {
  if (!postData) return null;
  try {
    return JSON.parse(postData);
  } catch {
    try {
      return Object.fromEntries(new URLSearchParams(postData));
    } catch {
      return postData;
    }
  }
}

function extractEndpointName(url) {
  // e.g. https://www.perplexity.ai/rest/sse/perplexity_ask/reconnect/abc-123
  //   -> rest/sse/perplexity_ask/reconnect/*
  const m = url.match(/perplexity\.ai\/(rest|api|graphql|sse)\/(.+?)(?:\?|#|$)/i);
  if (!m) return url.replace(/^https?:\/\/[^/]+/, "");
  const tail = m[2]
    // UUID v4 and similar
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "*")
    // Long hex tokens
    .replace(/[0-9a-f]{20,}/gi, "*")
    // Thread slugs (4+ dash-separated segments)
    .replace(/\/[A-Za-z0-9]+(-[A-Za-z0-9]+){3,}/g, "/*")
    .replace(/\/$/, "");
  return `${m[1]}/${tail}`;
}

function isSSE(headers) {
  const ct = headers?.["content-type"] || headers?.["Content-Type"] || "";
  return /text\/event-stream/i.test(ct);
}

function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 500);
}

function persist() {
  if (!jsonPath) return;
  try {
    const snapshot = {
      startedAt: captured.startedAt,
      savedAt: new Date().toISOString(),
      startUrl: captured.startUrl,
      stats: {
        requests: captured.requests.length,
        responses: captured.responses.length,
        mutations: captured.mutations.length,
        websockets: captured.websockets.length,
        endpoints: [...captured.endpoints],
      },
      mutations: captured.mutations,
      requests: captured.requests,
      responses: captured.responses,
      websockets: captured.websockets,
      errors: captured.errors,
    };
    writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    captured.errors.push({ at: new Date().toISOString(), where: "persist", message: String(err) });
  }
}

function writeSummary(summaryPath) {
  const lines = [];
  lines.push("PERPLEXITY INTERNAL API CAPTURE SUMMARY");
  lines.push(`Captured: ${captured.startedAt} -> ${captured.savedAt}`);
  lines.push(
    `Requests: ${captured.requests.length} | Responses: ${captured.responses.length} | ` +
    `Mutations: ${captured.mutations.length} | WebSocket frames: ${captured.websockets.length}`,
  );
  lines.push("");

  lines.push("═══ UNIQUE ENDPOINTS ═══");
  for (const ep of [...captured.endpoints].sort()) lines.push(`  ${ep}`);
  lines.push("");

  if (captured.mutations.length > 0) {
    lines.push("═══ MUTATIONS (chronological) ═══");
    for (const m of captured.mutations) {
      lines.push(`\n--- #${m.num} ${m.method} ${m.endpoint} ---`);
      lines.push(`URL: ${m.url}`);
      if (m.decoded) lines.push(`Payload: ${JSON.stringify(m.decoded, null, 2)}`);
      const resp = captured.responses.find((r) => r.num === m.num);
      if (resp) {
        lines.push(`Response: ${resp.status}${resp.sse ? " (SSE)" : ""}`);
        if (resp.body && typeof resp.body === "object") {
          lines.push(`Body: ${JSON.stringify(resp.body, null, 2)}`);
        } else if (typeof resp.body === "string") {
          lines.push(`Body: ${resp.body.slice(0, 2000)}`);
        }
      }
    }
  }
  try {
    writeFileSync(summaryPath, lines.join("\n"));
  } catch {}
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  mkdirSync(CAPTURES_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  jsonPath = join(CAPTURES_DIR, `${timestamp}.json`);
  const summaryPath = join(CAPTURES_DIR, `${timestamp}.summary.txt`);

  const launchOpts = {
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  if (cdpEnabled) {
    launchOpts.args.push(`--remote-debugging-port=${cdpPort}`);
    launchOpts.args.push("--remote-debugging-address=127.0.0.1");
  }

  const chromePaths = [
    join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  const chromePath = chromePaths.find((p) => p && existsSync(p));
  if (chromePath) launchOpts.executablePath = chromePath;

  const mode = captureAll
    ? `${C.magenta}all perplexity.ai traffic${C.reset}`
    : mutationsOnly
    ? `${C.yellow}mutations only${C.reset}`
    : `${C.green}rest / api / graphql${C.reset}`;

  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  Perplexity Internal API Capture Tool                    ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  Profile: ${C.dim}${PROFILE_DIR}${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  Chrome:  ${C.dim}${chromePath || "bundled Chromium"}${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  Mode:    ${mode}`);
  console.log(
    `${C.cyan}║${C.reset}  CDP:     ${cdpEnabled ? `${C.green}http://127.0.0.1:${cdpPort}${C.reset}` : `${C.dim}disabled${C.reset}`}`,
  );
  console.log(`${C.cyan}║${C.reset}  URL:     ${C.dim}${startUrl}${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  Output:  ${C.dim}${jsonPath}${C.reset}`);
  console.log(`${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  ${C.bold}Instructions:${C.reset}`);
  console.log(`${C.cyan}║${C.reset}   1. Browser opens with your logged-in Perplexity profile`);
  console.log(`${C.cyan}║${C.reset}   2. Perform any actions you want to capture`);
  console.log(`${C.cyan}║${C.reset}   3. New tabs/popups are captured automatically`);
  console.log(`${C.cyan}║${C.reset}   4. Press Ctrl+C (or close the browser) to save & exit`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}`);
  console.log();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

  // Attach listeners to every current and future page (captures new tabs, popups).
  const attachPageListeners = (page) => {
    page.on("websocket", (ws) => handleWebSocket(ws));
  };
  for (const p of context.pages()) attachPageListeners(p);
  context.on("page", (p) => {
    console.log(`${C.magenta}⚡ new page:${C.reset} ${C.dim}${p.url() || "(about:blank)"}${C.reset}`);
    attachPageListeners(p);
  });

  // ─── Request interception (context-wide) ─────────────────────

  context.on("request", (request) => {
    try {
      const url = request.url();
      if (!shouldCapture(url)) return;

      const method = request.method();
      const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      if (mutationsOnly && !isMutation) return;

      requestCounter++;
      const num = requestCounter;
      const endpoint = extractEndpointName(url);
      captured.endpoints.add(`${method} ${endpoint}`);

      const postData = request.postData();
      const decoded = decodePayload(postData);

      const entry = {
        num,
        timestamp: new Date().toISOString(),
        method,
        url,
        endpoint,
        resourceType: request.resourceType(),
        headers: request.headers(),
        postData,
        decoded,
      };

      captured.requests.push(entry);
      if (isMutation) captured.mutations.push(entry);

      const mc = methodColor(method);
      console.log(
        `${C.dim}#${String(num).padStart(3, "0")}${C.reset} ${mc}${C.bold}${method.padEnd(6)}${C.reset} ${C.white}${endpoint}${C.reset}`,
      );

      if (decoded && isMutation && typeof decoded === "object") {
        const preview = JSON.stringify(decoded, null, 2).split("\n").slice(0, 20).join("\n");
        for (const ln of preview.split("\n")) console.log(`     ${C.dim}${ln}${C.reset}`);
      }

      schedulePersist();
    } catch (err) {
      captured.errors.push({ at: new Date().toISOString(), where: "request", message: String(err) });
    }
  });

  // ─── Response interception (context-wide) ────────────────────

  context.on("response", async (response) => {
    try {
      const url = response.url();
      if (!shouldCapture(url)) return;

      const request = response.request();
      const method = request.method();
      if (mutationsOnly && !["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;

      const status = response.status();
      const endpoint = extractEndpointName(url);
      const matchingReq = [...captured.requests].reverse().find(
        (r) => r.url === url && r.method === method,
      );
      const num = matchingReq?.num;

      const respHeaders = response.headers();
      const sse = isSSE(respHeaders);

      let body = null;
      if (sse) {
        // Don't block the listener on an open SSE stream.
        body = "[SSE STREAM - body not captured]";
      } else {
        body = await Promise.race([
          response.text().then((t) =>
            t.length > 50000 ? t.slice(0, 50000) + `...[truncated from ${t.length} bytes]` : t,
          ),
          new Promise((resolve) => setTimeout(() => resolve("[READ TIMEOUT]"), 5000)),
        ]);
      }

      let parsed = body;
      if (typeof body === "string" && body && !body.startsWith("[")) {
        try { parsed = JSON.parse(body); } catch {}
      }

      captured.responses.push({
        num,
        timestamp: new Date().toISOString(),
        method,
        url,
        endpoint,
        status,
        sse,
        headers: respHeaders,
        body: parsed,
      });

      const sc = statusColor(status);
      const tag = num ? `#${String(num).padStart(3, "0")}` : "   ";
      const sseTag = sse ? ` ${C.magenta}SSE${C.reset}` : "";
      console.log(
        `${C.dim}${tag}${C.reset}   ${sc}← ${status}${C.reset}${sseTag} ${C.dim}${endpoint}${C.reset}` +
          (status >= 400 && typeof body === "string" ? `\n     ${C.red}${body.slice(0, 200)}${C.reset}` : ""),
      );

      schedulePersist();
    } catch (err) {
      captured.errors.push({ at: new Date().toISOString(), where: "response", message: String(err) });
    }
  });

  context.on("requestfailed", (request) => {
    try {
      const url = request.url();
      if (!shouldCapture(url)) return;
      const reason = request.failure()?.errorText || "unknown";
      const endpoint = extractEndpointName(url);
      console.log(
        `${C.red}✗ FAIL${C.reset} ${request.method()} ${C.dim}${endpoint}${C.reset} ${C.red}${reason}${C.reset}`,
      );
      captured.errors.push({
        at: new Date().toISOString(),
        where: "requestfailed",
        method: request.method(),
        url,
        reason,
      });
      schedulePersist();
    } catch {}
  });

  // ─── Navigate the initial page ───────────────────────────────

  const page = context.pages()[0] || (await context.newPage());
  console.log(`${C.cyan}→ navigating to ${startUrl}${C.reset}\n`);
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    console.log(`${C.yellow}⚠ goto failed: ${err.message}${C.reset}`);
  }

  if (cdpEnabled) {
    console.log(`\n${C.bold}${C.green}CDP ready at http://127.0.0.1:${cdpPort}${C.reset}`);
    console.log(`${C.dim}Chrome DevTools MCP can now attach.${C.reset}\n`);
  }

  console.log(`${C.bold}=== CAPTURE ACTIVE ===${C.reset}`);
  console.log(`${C.dim}Perform actions in the browser. Press Ctrl+C or close the browser to save.${C.reset}\n`);

  // ─── Shutdown ────────────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    captured.savedAt = new Date().toISOString();
    persist();
    writeSummary(summaryPath);

    console.log(`\n${C.bold}${C.green}╔══════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.green}║  Capture Complete                                        ║${C.reset}`);
    console.log(`${C.bold}${C.green}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.green}║${C.reset}  Requests:   ${captured.requests.length}`);
    console.log(`${C.green}║${C.reset}  Responses:  ${captured.responses.length}`);
    console.log(`${C.green}║${C.reset}  Mutations:  ${captured.mutations.length}`);
    console.log(`${C.green}║${C.reset}  WebSocket:  ${captured.websockets.length} frames`);
    console.log(`${C.green}║${C.reset}  Endpoints:  ${captured.endpoints.size} unique`);
    console.log(`${C.green}║${C.reset}  Errors:     ${captured.errors.length}`);
    console.log(`${C.green}║${C.reset}`);
    console.log(`${C.green}║${C.reset}  JSON:       ${C.dim}${jsonPath}${C.reset}`);
    console.log(`${C.green}║${C.reset}  Summary:    ${C.dim}${summaryPath}${C.reset}`);
    console.log(`${C.bold}${C.green}╚══════════════════════════════════════════════════════════╝${C.reset}`);

    try { await context.close(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  context.on("close", shutdown);

  // Keep the process alive.
  await new Promise(() => {});
}

function handleWebSocket(ws) {
  const wsUrl = ws.url();
  if (!/perplexity\.ai/i.test(wsUrl)) return;
  console.log(`\n${C.magenta}⚡ WebSocket:${C.reset} ${C.dim}${wsUrl}${C.reset}`);

  const record = (direction, frame) => {
    try {
      const data = typeof frame.payload === "string" ? frame.payload : frame.payload?.toString();
      if (!data) return;
      captured.websockets.push({
        timestamp: new Date().toISOString(),
        url: wsUrl,
        direction,
        data: data.length > 5000 ? data.slice(0, 5000) + "...[truncated]" : data,
      });
      if (data.length < 200) {
        const arrow = direction === "sent" ? "→" : "←";
        console.log(`${C.magenta}  WS ${arrow}${C.reset} ${C.dim}${data}${C.reset}`);
      }
      schedulePersist();
    } catch {}
  };

  ws.on("framesent", (f) => record("sent", f));
  ws.on("framereceived", (f) => record("received", f));
  ws.on("close", () => console.log(`${C.magenta}  WS closed${C.reset}`));
}

main().catch((err) => {
  console.error(`${C.red}Fatal error:${C.reset}`, err);
  process.exit(1);
});
