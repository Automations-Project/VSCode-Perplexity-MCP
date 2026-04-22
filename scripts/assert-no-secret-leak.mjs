#!/usr/bin/env node
// Scans controlled test-capture directories for known secret shapes.
// Usage: node scripts/assert-no-secret-leak.mjs <dir>...
// Exit 0 = clean, 1 = leak detected, 2 = usage error.
//
// LEAK_CANARIES env var: comma-separated literal strings the test runner
// generated during the run. Any appearance in captured output fails.

import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const PATTERNS = [
  { name: "oauth-access",         re: /pplx_at_[A-Za-z0-9_\-]{10,}/ },
  { name: "oauth-refresh",        re: /pplx_rt_[A-Za-z0-9_\-]{10,}/ },
  { name: "oauth-code",           re: /pplx_ac_[A-Za-z0-9_\-]{10,}/ },
  { name: "local-bearer",         re: /pplx_local_[a-z0-9-]+_[A-Za-z0-9_\-]{10,}/ },
  { name: "daemon-bearer-json",   re: /"bearerToken"\s*:\s*"[A-Za-z0-9_\-]{30,}"/ },
  { name: "authorization-bearer", re: /[Aa]uthorization\s*:\s*Bearer\s+[A-Za-z0-9_\-\.]{20,}/ },
  { name: "jwt",                  re: /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/ },
  { name: "cf-clearance",         re: /cf_clearance=[^;\s]+/ },
  { name: "perplexity-session",   re: /__Secure-next-auth\.session-token=[^;\s]+/ },
  { name: "ngrok-authtoken",      re: /"authtoken"\s*:\s*"\d+[A-Za-z0-9]{20,}"/ },
  ...((process.env.LEAK_CANARIES ?? "").split(",").filter(Boolean).map(
    (v, i) => ({ name: `canary-${i}`, re: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }),
  )),
];

const ALLOWED_SHAPES = [
  /TEST_DAEMON_BEARER_FIXTURE_NOT_A_REAL_SECRET/,
  /TEST_REAL_BEARER_FIXTURE/,
  /_FIXTURE_/,
];

function isAllowed(match) {
  return ALLOWED_SHAPES.some((re) => re.test(match));
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: assert-no-secret-leak.mjs <capturedLogsDir>...");
  process.exit(2);
}

let hits = 0;
for (const root of roots) {
  walk(root, (path, content) => {
    for (const { name, re } of PATTERNS) {
      const match = content.match(re);
      if (match && !isAllowed(match[0])) {
        console.error(`[LEAK] ${name} in ${path}: ${match[0].slice(0, 80)}…`);
        hits += 1;
      }
    }
  });
}
process.exit(hits > 0 ? 1 : 0);

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    console.error(`[WARN] cannot read ${dir}`);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile() && [".log", ".txt", ".json", ".ndjson", ".md"].includes(extname(full))) {
      try {
        const content = readFileSync(full, "utf8");
        visit(full, content);
      } catch { /* unreadable */ }
    }
  }
}
