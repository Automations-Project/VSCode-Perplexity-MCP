// Security-critical: scrubs sensitive patterns from strings before logging
// or before sending to external destinations (GitHub issue reports, debug
// exports). Pattern list ordered from most-specific to least-specific to
// avoid accidental re-matching by a more general rule.

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
  // Cookie name=value pairs we know are sensitive.
  {
    re: /(__Secure-next-auth\.session-token|cf_clearance)=[^;\s,'"]+/g,
    replace: (_m, name) => `${name}=<cookie>`,
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
  // IPv6 (simplified — must have at least 3 colon-separated groups)
  {
    re: /\b[0-9a-fA-F:]{2,}:[0-9a-fA-F:]{2,}\b/g,
    replace: (match) => {
      const colonCount = (match.match(/:/g) || []).length;
      // Only redact if 2+ colons (indicates multi-group like IPv6)
      // Single colon patterns are likely MAC addresses or other identifiers we shouldn't redact
      return colonCount >= 2 ? "<ip>" : match;
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
 */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

function redactString(s) {
  let out = s;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
