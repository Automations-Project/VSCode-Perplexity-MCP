// The published `./redact` subpath emits a source-shaped d.ts (tsup dts
// plugin copies the .js body verbatim for this module). Declare a minimal
// proper type shim so TS consumers see the correct signatures instead of
// the raw function body.
import * as _redactMod from "perplexity-user-mcp/redact";

type RedactMod = {
  redact: <T>(value: T) => T;
  redactSecrets: (input: string) => string;
  SECRET_PATTERNS: ReadonlyArray<{ name: string; kind: string; re: RegExp }>;
};

const redactMod = _redactMod as unknown as RedactMod;
const { redact, SECRET_PATTERNS } = redactMod;

/**
 * String redactor for log lines. Applies the full composite redactor from
 * mcp-server: SECRET_PATTERNS first (bearer / OAuth / JWT / ngrok / cookies,
 * kind-tagged `<redacted:<kind>>`) then the legacy PATTERNS (emails / userIds /
 * home paths / IPs / generic long-token). Non-string inputs fall through.
 */
export function redactMessage(input: string): string {
  return typeof input === "string" ? (redact(input) as string) : input;
}

/**
 * Object-graph redactor. Serialises the value to JSON (so `bearerToken`-style
 * key+value JSON shapes become visible to SECRET_PATTERNS), runs the redactor
 * over the serialised string, then parses back. Falls back to per-leaf
 * redaction via mcp-server `redact` when the object isn't JSON-serialisable
 * (functions, circular refs, BigInts, etc.).
 *
 * This matters because mcp-server's recursive `redact` walks the object key
 * by key and only sees each string leaf in isolation — a bare bearer value
 * `"SECRET_..."` doesn't match any `"bearerToken":"..."` JSON-shape pattern
 * until it is serialised alongside its key.
 */
export function redactObject<T>(value: T): T {
  if (value == null || typeof value !== "object") {
    return redact(value) as T;
  }
  try {
    const serialised = JSON.stringify(value);
    if (typeof serialised !== "string") {
      return redact(value) as T;
    }
    const redacted = redact(serialised) as string;
    return JSON.parse(redacted) as T;
  } catch {
    // Non-serialisable input (functions / circular refs / BigInts): fall back
    // to the per-leaf walker so we still scrub anything the walker can reach.
    return redact(value) as T;
  }
}

export { SECRET_PATTERNS };
