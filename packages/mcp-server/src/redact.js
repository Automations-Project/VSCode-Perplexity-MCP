// Security-critical: scrubs sensitive patterns from strings before logging
// or before sending to external destinations (GitHub issue reports, debug
// exports). Pattern list ordered from most-specific to least-specific to
// avoid accidental re-matching by a more general rule.

// Scope: this module is called on OUR OWN trusted log/debug data (logger
// output, doctor reports, cookies). It is NOT a user-input sanitizer.
// Deliberate trade-offs in the current pattern set:
//   - Emails are matched post-URL-decode only (raw %40 encoded forms pass through)
//   - Unix home paths assume no whitespace in usernames
//   - Windows home paths only cover C:\Users\... (UNC paths pass through)
//   - Long-token redaction (≥20 base64/hex chars) may over-redact legitimate
//     long URLs or JSON values — accepted trade-off for safety over debuggability
// If any of these assumptions changes (e.g., we start redacting user-supplied
// payloads), the pattern set must be revisited.

/**
 * Canonical secret-shape regex list. Distinct from the legacy PATTERNS array
 * below because every match emits a kind-tagged `<redacted:<kind>>` placeholder
 * so the redactor's output is unambiguous for audit / test / grep-gate
 * purposes. Applied BEFORE the legacy PATTERNS inside redactString so specific
 * shapes win over the generic long-token catchall.
 */
export const SECRET_PATTERNS = Object.freeze([
  // OAuth / local prefixes come FIRST so a value like `"bearer":"pplx_at_…"`
  // gets the specific oauth-access tag instead of the generic daemon-bearer
  // one from the bearer-json catchall below.
  { name: "oauth-access",         kind: "oauth-access",       re: /pplx_at_[A-Za-z0-9_\-]{10,}/g },
  { name: "oauth-refresh",        kind: "oauth-refresh",      re: /pplx_rt_[A-Za-z0-9_\-]{10,}/g },
  { name: "oauth-code",           kind: "oauth-code",         re: /pplx_ac_[A-Za-z0-9_\-]{10,}/g },
  { name: "local-bearer",         kind: "local-bearer",       re: /pplx_local_[a-z0-9-]+_[A-Za-z0-9_\-]{10,}/g },
  { name: "daemon-bearer-json",   kind: "daemon-bearer",      re: /"bearerToken"\s*:\s*"[A-Za-z0-9_\-]{30,}"/g },
  // Matches the `"bearer":"..."` shape used by daemon:bearer:reveal:response
  // so reveal-payload logs stay leak-free. Value is only required to be
  // 20+ safe-identifier chars — covers both raw daemon bearers and future
  // short-lived tokens.
  { name: "bearer-json",          kind: "daemon-bearer",      re: /"bearer"\s*:\s*"[A-Za-z0-9_\-]{20,}"/g },
  { name: "authorization-header", kind: "bearer-header",      re: /[Aa]uthorization\s*:\s*Bearer\s+[A-Za-z0-9_\-\.]{20,}/g },
  { name: "ngrok-authtoken",      kind: "ngrok-authtoken",    re: /"authtoken"\s*:\s*"\d+[A-Za-z0-9]{20,}"/g },
  { name: "jwt",                  kind: "jwt",                re: /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { name: "cf-clearance",         kind: "cf-clearance",       re: /cf_clearance=[^;\s]+/g },
  { name: "perplexity-session",   kind: "perplexity-session", re: /__Secure-next-auth\.session-token=[^;\s]+/g },
]);

/**
 * String-only secret redactor. Applies SECRET_PATTERNS and returns a string
 * with kind-tagged placeholders. Does NOT apply the legacy PATTERNS
 * (emails / userIds / paths / IPs / generic long-token); call `redact()` for
 * the full composite behavior.
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (typeof input !== "string") return input;
  let out = input;
  for (const { re, kind } of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      if (match.startsWith('"bearerToken"')) return `"bearerToken":"<redacted:${kind}>"`;
      if (match.startsWith('"bearer"')) return `"bearer":"<redacted:${kind}>"`;
      if (/^[Aa]uthorization\s*:/i.test(match)) return match.replace(/Bearer\s+[A-Za-z0-9_\-\.]{20,}/, `Bearer <redacted:${kind}>`);
      if (match.startsWith('"authtoken"')) return `"authtoken":"<redacted:${kind}>"`;
      if (match.startsWith("cf_clearance=")) return `cf_clearance=<redacted:${kind}>`;
      if (match.startsWith("__Secure-next-auth.session-token=")) return `__Secure-next-auth.session-token=<redacted:${kind}>`;
      return `<redacted:${kind}>`;
    });
  }
  return out;
}

const PATTERNS = [
  // Emails: RFC 5322 subset. Must come before generic token rules because
  // emails contain characters that other rules would catch.
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "<email>",
  },
  // Perplexity user IDs: user_ followed by hex/alphanum (>=8 chars).
  {
    re: /\buser_[A-Fa-f0-9]{8,}\b/g,
    replace: "<userId>",
  },
  // Home directory paths. Must replace before the "long opaque token" rule
  // because long path segments would otherwise trip it.
  {
    re: /(\/Users\/|\/home\/)[^/\s]+/g,
    replace: "<home>",
  },
  {
    re: /([A-Z]:)\\Users\\[^\\]+/g,
    replace: "<home>",
  },
  // IPv4
  {
    re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replace: "<ip>",
  },
  // IPv6. Three alternations cover: (1) full 8-group addresses, (2) :: compressed
  // forms with at least one prefix group (e.g. 2001:db8::1, fe80::1), (3) leading-::
  // forms like ::1 and ::. A function filter then requires hex letters (a-f/A-F) OR
  // a double-colon so that pure-digit colon-separated strings like "23:59:59"
  // (HH:MM:SS wall-clock) and ISO timestamps are left untouched.
  {
    re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?\b|(?<!\w)::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?!\w)/g,
    replace: (match) => {
      const hasHex = /[a-fA-F]/.test(match);
      const hasDoubleColon = /::/.test(match);
      return (hasHex || hasDoubleColon) ? "<ip>" : match;
    },
  },
  // Long opaque tokens (base64 / hex, >=20 chars). Applied last so more
  // specific rules win first. Captures key=value and replaces only the value.
  {
    re: /=([A-Za-z0-9+/=]{20,})/g,
    replace: "=<redacted>",
  },
];

/**
 * Redact sensitive patterns from a string or object graph.
 * For objects: every string-valued leaf is redacted recursively.
 * Arrays are handled recursively too. Primitive non-strings are returned unchanged.
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [_seen]
 * @returns {T}
 */
export function redact(value, _seen) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;

  // Cycle detection for objects/arrays. We use a WeakSet threaded through the
  // recursion so siblings don't falsely collide with each other.
  const seen = _seen ?? new WeakSet();
  if (seen.has(value)) return "<circular>";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, seen);
  return out;
}

function redactString(s) {
  // SECRET_PATTERNS first: specific bearer / OAuth / JWT / ngrok / cookie
  // shapes get tagged "<redacted:<kind>>" placeholders. Then the legacy
  // PATTERNS handle everything else (emails / userIds / home paths / IPs /
  // generic long-token catchall). Running secrets first prevents the generic
  // `=(20+chars)` catchall from eating a bearer with a plain `<redacted>`
  // label when we'd rather have `<redacted:oauth-access>`.
  let out = redactSecrets(s);
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
