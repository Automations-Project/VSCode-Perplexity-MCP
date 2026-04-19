# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.0 and later | Yes |
| < 0.2.0 | No |

## Reporting a Vulnerability

If you discover a security vulnerability in perplexity-user-mcp, please
report it privately via GitHub Security Advisories:

https://github.com/<OWNER>/perplexity-user-mcp/security/advisories/new

Or via email to security@<TBD — user to fill>.

We aim to acknowledge receipt within 48 hours and will coordinate a
responsible disclosure timeline (default: 90 days) with the reporter.

## What is in scope

- Authentication bypass or privilege escalation
- Credential leakage (cookies, emails, OTPs, master key)
- Logic flaws in the redaction pipeline
- Unsafe deserialization or command injection
- Cross-profile contamination

## What is out of scope

- Issues in upstream Perplexity AI services
- Issues in third-party dependencies that have their own security process
  (patchright, keytar, otpauth) — report those upstream
- Missing rate limits, missing feature flags, missing UI affordances
- Social-engineering attacks that require the user to run adversarial commands

## Our commitments

- No telemetry or background egress. The only external network calls are
  to `perplexity.ai` endpoints the user explicitly invokes via MCP tools.
- Cookies, emails, and userIds are AES-256-GCM encrypted on disk by default.
- The redaction pipeline is unit-tested with ≥95% line coverage.
