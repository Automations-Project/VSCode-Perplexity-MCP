// Unified diagnostics capture. Packages a fixed set of config files and
// caller-supplied blobs (extension output channel, doctor-report JSON) into a
// single .zip for bug-report attachment. Every source except
// `package-versions.json` passes through the diagnostics redactor before being
// added to the archive. See REDACTION_NOTES in this file for the user-facing
// description.
//
// Why zip (not tarball): the primary consumer is a human pasting an
// attachment into a GitHub issue, and zip has native Explorer / Finder preview
// on both Windows and macOS without extra tools.

import * as path from "path";
import type * as fsType from "fs/promises";
import JSZip from "jszip";
import {
  redactDiagnosticsString,
  redactDiagnosticsObject,
} from "./redact.js";

export interface CaptureOptions {
  outputPath: string;
  configDir: string;
  extensionVersion: string;
  vscodeVersion: string;
  logsText?: string | null;
  doctorReport?: unknown | null;
  now?: () => Date;
  fs?: typeof fsType;
}

export interface CaptureResult {
  outputPath: string;
  bytesWritten: number;
  sourcesIncluded: string[];
  sourcesMissing: string[];
}

const REDACTION_NOTES = `# Redaction notes

This diagnostics bundle has been scrubbed of known sensitive shapes before being written.

The following patterns are replaced with \`<redacted:<kind>>\` tags:
- Daemon bearer tokens (\`bearerToken\`, \`bearer\` JSON fields, \`Authorization: Bearer ...\` headers)
- OAuth access / refresh / authorization-code tokens (\`pplx_at_…\`, \`pplx_rt_…\`, \`pplx_ac_…\`)
- Per-client local bearers (\`pplx_local_<clientId>_<secret>\`)
- JWTs (three-part base64url)
- ngrok authtoken fields
- \`cf_clearance\` and \`__Secure-next-auth.session-token\` cookies
- PEM blocks (origin certificates, private keys)

The following additional anonymizations are applied:
- Email addresses → \`<email>\`
- Perplexity user IDs → \`<userId>\`
- Home directory paths → \`<home>\`
- IPv4 / IPv6 addresses → \`<ip>\`
- Long opaque tokens in \`key=value\` form → \`key=<redacted>\`

\`package-versions.json\` is intentionally NOT redacted — it contains only runtime version metadata.

If you spot any remaining sensitive content, please redact before sharing.
`;

/** Try to read a file as utf8, returning `null` on ENOENT. Other errors bubble. */
async function tryReadFile(fs: typeof fsType, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

export async function captureDiagnostics(opts: CaptureOptions): Promise<CaptureResult> {
  const fs = opts.fs ?? (await import("fs/promises"));
  const zip = new JSZip();
  const sourcesIncluded: string[] = [];
  const sourcesMissing: string[] = [];

  const join = (name: string): string => path.posix.join(opts.configDir.replace(/\\/g, "/"), name);

  // 1. daemon.log — full file, redacted.
  {
    const raw = await tryReadFile(fs, join("daemon.log"));
    if (raw == null) {
      sourcesMissing.push("daemon.log");
      zip.file("daemon.log.MISSING", "source file was not present at capture time");
    } else {
      sourcesIncluded.push("daemon.log");
      zip.file("daemon.log", redactDiagnosticsString(raw));
    }
  }

  // 2. audit.log.tail — last 1000 lines, redacted.
  {
    const raw = await tryReadFile(fs, join("audit.log"));
    if (raw == null) {
      sourcesMissing.push("audit.log");
      zip.file("audit.log.MISSING", "source file was not present at capture time");
    } else {
      sourcesIncluded.push("audit.log");
      const lines = raw.split("\n");
      const tail = lines.slice(-1000).join("\n");
      zip.file("audit.log.tail", redactDiagnosticsString(tail));
    }
  }

  // 3. daemon.lock.json — parsed, bearer stripped, re-serialised. Malformed
  //    JSON → daemon.lock.parse-error.txt with the redacted raw bytes.
  {
    const raw = await tryReadFile(fs, join("daemon.lock"));
    if (raw == null) {
      sourcesMissing.push("daemon.lock");
      zip.file("daemon.lock.MISSING", "source file was not present at capture time");
    } else {
      sourcesIncluded.push("daemon.lock");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") {
        if ("bearer" in parsed) parsed.bearer = "<redacted:daemon-bearer>";
        if ("bearerToken" in parsed) parsed.bearerToken = "<redacted:daemon-bearer>";
        // Defensive: a future version of the lockfile might add another token
        // field. Run the composite redactor to catch those.
        const scrubbed = redactDiagnosticsObject(parsed);
        zip.file("daemon.lock.json", JSON.stringify(scrubbed, null, 2));
      } else {
        zip.file("daemon.lock.parse-error.txt", redactDiagnosticsString(raw));
      }
    }
  }

  // 4. tunnel-settings.json — redacted as JSON-if-possible, else as string.
  {
    const raw = await tryReadFile(fs, join("tunnel-settings.json"));
    if (raw == null) {
      sourcesMissing.push("tunnel-settings.json");
      zip.file("tunnel-settings.json.MISSING", "source file was not present at capture time");
    } else {
      sourcesIncluded.push("tunnel-settings.json");
      zip.file("tunnel-settings.json", redactDiagnosticsString(raw));
    }
  }

  // 5. oauth-clients.json — redacted defensively even though the file should
  //    never store secrets.
  {
    const raw = await tryReadFile(fs, join("oauth-clients.json"));
    if (raw == null) {
      sourcesMissing.push("oauth-clients.json");
      zip.file("oauth-clients.json.MISSING", "source file was not present at capture time");
    } else {
      sourcesIncluded.push("oauth-clients.json");
      zip.file("oauth-clients.json", redactDiagnosticsString(raw));
    }
  }

  // 6. logs.txt — caller-provided extension output channel text. Redacted.
  if (opts.logsText != null) {
    zip.file("logs.txt", redactDiagnosticsString(opts.logsText));
  }

  // 7. doctor-report.json — caller-provided. Redacted through the object path
  //    (which serialises internally) to catch `"bearer":"…"`-shaped values.
  if (opts.doctorReport != null) {
    const scrubbed = redactDiagnosticsObject(opts.doctorReport);
    zip.file("doctor-report.json", JSON.stringify(scrubbed, null, 2));
  }

  // 8. package-versions.json — NEVER redacted. Runtime version metadata only.
  const versions = {
    extension: opts.extensionVersion,
    vscode: opts.vscodeVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    capturedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  zip.file("package-versions.json", JSON.stringify(versions, null, 2));

  // 9. REDACTION_NOTES.md — static.
  zip.file("REDACTION_NOTES.md", REDACTION_NOTES);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

  // Ensure the parent directory exists before writing. Callers usually pass a
  // path inside an existing OS temp dir, but a fresh install might not yet
  // have a configured diagnostics output dir.
  const parent = path.dirname(opts.outputPath);
  if (parent && parent !== "." && parent !== opts.outputPath) {
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch {
      // Non-fatal: if mkdir fails and the dir already exists, writeFile
      // succeeds; if it doesn't, writeFile surfaces the error below.
    }
  }

  await fs.writeFile(opts.outputPath, zipBuf);

  return {
    outputPath: opts.outputPath,
    bytesWritten: zipBuf.length,
    sourcesIncluded,
    sourcesMissing,
  };
}
