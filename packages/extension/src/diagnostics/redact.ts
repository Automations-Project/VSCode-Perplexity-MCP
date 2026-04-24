// Diagnostics-specific redaction layer. Wraps the base redactor
// (packages/extension/src/redact.ts which composites mcp-server's SECRET_PATTERNS
// + legacy PATTERNS) and adds PEM-block collapsing for diagnostics bundles,
// where operators may erroneously paste an origin cert / private key into a
// tunnel-settings field.
//
// Why a separate module: the base redactor is shared with runtime logging
// paths where PEM handling would be wasted work. Diagnostics captures a fixed
// set of config files that may legitimately contain PEM, so we pay the extra
// regex only there.

import { redactMessage, redactObject } from "../redact.js";

export { redactMessage, redactObject };

// Match a full armored PEM envelope (BEGIN line through END line, body
// included). `[\s\S]` handles the multi-line body (no DOTALL flag needed
// because the pattern uses no bare `.`); /g ensures every block in a string
// is collapsed. We match a trailing newline when present so we don't leave
// a dangling blank line when the block was the entire content. The inner
// type token must match between BEGIN and END so we don't accidentally join
// two adjacent blocks.
const PEM_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+?)-----[\s\S]*?-----END \1-----\n?/g;

/**
 * Collapses any PEM block (`-----BEGIN ... -----` through `-----END ... -----`)
 * to the literal placeholder `<redacted:pem>`. Covers CERTIFICATE, PRIVATE KEY,
 * RSA PRIVATE KEY, EC PRIVATE KEY, and any other armoured type — the BEGIN/END
 * type tokens must match so two adjacent blocks are handled independently.
 */
export function redactPem(input: string): string {
  if (typeof input !== "string") return input;
  return input.replace(PEM_BLOCK_RE, "<redacted:pem>");
}

/**
 * Diagnostics-string redactor. Order matters: PEM first so a cert body's
 * base64 payload doesn't get partially eaten by the generic long-token rule
 * inside `redactMessage`, leaving a half-redacted cert envelope. After PEM
 * collapse, run the base string redactor to catch bearer tokens / emails /
 * paths.
 */
export function redactDiagnosticsString(input: string): string {
  if (typeof input !== "string") return input;
  return redactMessage(redactPem(input));
}

/**
 * Diagnostics-object redactor. Applies the base object redactor (which
 * serialises → runs SECRET_PATTERNS → parses back so `"bearer":"…"` shapes
 * match), then stringifies again and applies redactPem to catch PEM bodies
 * embedded as string values. Non-serialisable inputs fall back to the base
 * object redactor only.
 */
export function redactDiagnosticsObject<T>(value: T): T {
  const base = redactObject(value);
  if (base == null || typeof base !== "object") return base;
  try {
    const serialised = JSON.stringify(base);
    if (typeof serialised !== "string") return base;
    const pemScrubbed = redactPem(serialised);
    return JSON.parse(pemScrubbed) as T;
  } catch {
    return base;
  }
}
