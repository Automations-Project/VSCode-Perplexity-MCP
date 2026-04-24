import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as os from "os";
import * as realFs from "fs/promises";
import JSZip from "jszip";
import { captureDiagnostics } from "../src/diagnostics/capture.js";

const SAMPLE_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7QqVh8SrUp4Jm4s4Zv5K",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "-----END CERTIFICATE-----",
].join("\n");

type FakeFsEntry = { kind: "file"; content: string } | { kind: "missing" };

/** Minimal fake fs that the capture accepts via dependency injection. */
function makeFakeFs(entries: Record<string, FakeFsEntry>): typeof import("fs/promises") {
  return {
    readFile: async (p: string, _enc?: BufferEncoding): Promise<string> => {
      const entry = entries[normalise(p)];
      if (!entry || entry.kind === "missing") {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error(`ENOENT: no such file, open '${p}'`),
          { code: "ENOENT" },
        );
        throw err;
      }
      return entry.content;
    },
    // captureDiagnostics uses writeFile on the real fs to write the zip output.
    writeFile: realFs.writeFile,
    mkdir: realFs.mkdir,
  } as unknown as typeof import("fs/promises");
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/");
}

async function readZip(zipPath: string): Promise<JSZip> {
  const buf = await realFs.readFile(zipPath);
  return JSZip.loadAsync(buf);
}

describe("captureDiagnostics", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), "pplx-diag-test-"));
  });

  afterEach(async () => {
    await realFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("happy path: writes all 9 expected entries with redaction", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({
      [`${configDir}/daemon.log`]: { kind: "file", content: "daemon starting\nAuthorization: Bearer pplx_at_XYZ1234567890ABCD\n" },
      [`${configDir}/audit.log`]: { kind: "file", content: "line1\nline2\nline3\n" },
      [`${configDir}/daemon.lock`]: { kind: "file", content: JSON.stringify({ pid: 1234, port: 7764, bearer: "SECRET_BEARER_VALUE_ABCDEFGHIJKLMNOPQR" }) },
      [`${configDir}/tunnel-settings.json`]: { kind: "file", content: JSON.stringify({ provider: "cf-quick" }) },
      [`${configDir}/oauth-clients.json`]: { kind: "file", content: JSON.stringify({ clients: [] }) },
    });

    const result = await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      logsText: "output channel contents",
      doctorReport: { overall: "ok" },
      fs: fakeFs,
      now: () => new Date("2026-04-24T00:00:00Z"),
    });

    expect(result.outputPath).toBe(outputPath);
    expect(result.bytesWritten).toBeGreaterThan(0);

    const zip = await readZip(outputPath);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(
      [
        "REDACTION_NOTES.md",
        "audit.log.tail",
        "daemon.lock.json",
        "daemon.log",
        "doctor-report.json",
        "logs.txt",
        "oauth-clients.json",
        "package-versions.json",
        "tunnel-settings.json",
      ].sort(),
    );

    const daemonLog = await zip.file("daemon.log")!.async("string");
    expect(daemonLog).not.toContain("pplx_at_XYZ1234567890ABCD");
    expect(daemonLog).toMatch(/Bearer <redacted:(oauth-access|bearer-header)>/);

    const lock = JSON.parse(await zip.file("daemon.lock.json")!.async("string"));
    expect(lock.bearer).toBe("<redacted:daemon-bearer>");
    expect(lock.pid).toBe(1234);
    expect(lock.port).toBe(7764);

    expect(result.sourcesIncluded).toEqual(
      expect.arrayContaining([
        "daemon.log",
        "audit.log",
        "daemon.lock",
        "tunnel-settings.json",
        "oauth-clients.json",
      ]),
    );
    expect(result.sourcesMissing).toEqual([]);
  });

  it("missing files appear in sourcesMissing and get .MISSING markers", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({
      // everything missing
    });

    const result = await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      fs: fakeFs,
    });

    expect(result.sourcesMissing).toEqual(
      expect.arrayContaining([
        "daemon.log",
        "audit.log",
        "daemon.lock",
        "tunnel-settings.json",
        "oauth-clients.json",
      ]),
    );

    const zip = await readZip(outputPath);
    expect(zip.file("daemon.log.MISSING")).toBeTruthy();
    expect(zip.file("audit.log.MISSING")).toBeTruthy();
    expect(zip.file("daemon.lock.MISSING")).toBeTruthy();
    expect(zip.file("tunnel-settings.json.MISSING")).toBeTruthy();
    expect(zip.file("oauth-clients.json.MISSING")).toBeTruthy();

    // The never-redacted versions file is always present.
    expect(zip.file("package-versions.json")).toBeTruthy();
    // REDACTION_NOTES.md is always present.
    expect(zip.file("REDACTION_NOTES.md")).toBeTruthy();
  });

  it("audit.log.tail contains only the last 1000 lines", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const lines: string[] = [];
    for (let i = 1; i <= 1500; i++) lines.push(`line-${i}`);
    const fakeFs = makeFakeFs({
      [`${configDir}/audit.log`]: { kind: "file", content: lines.join("\n") },
    });

    await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      fs: fakeFs,
    });

    const zip = await readZip(outputPath);
    const tail = await zip.file("audit.log.tail")!.async("string");
    const tailLines = tail.split("\n");
    expect(tailLines.length).toBe(1000);
    expect(tailLines[0]).toBe("line-501");
    expect(tailLines[999]).toBe("line-1500");
  });

  it("package-versions.json is NEVER redacted", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({});

    // A version string that contains "user_abc12345deadbeef" (>=8 hex chars
    // → would match the userId redactor if it ran).
    const result = await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1-user_abc12345deadbeef",
      vscodeVersion: "1.100.0",
      fs: fakeFs,
    });
    expect(result.sourcesIncluded).toEqual(expect.arrayContaining([])); // trivial
    const zip = await readZip(outputPath);
    const pv = JSON.parse(await zip.file("package-versions.json")!.async("string"));
    expect(pv.extension).toBe("0.8.1-user_abc12345deadbeef");
    expect(pv.vscode).toBe("1.100.0");
    expect(pv.node).toBe(process.version);
    expect(pv.platform).toBe(process.platform);
    expect(pv.arch).toBe(process.arch);
  });

  it("malformed daemon.lock JSON → parse-error text entry", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({
      [`${configDir}/daemon.lock`]: { kind: "file", content: "not-json {bearer: pplx_at_ABCDEFGHIJ1234567890}" },
    });

    await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      fs: fakeFs,
    });

    const zip = await readZip(outputPath);
    expect(zip.file("daemon.lock.json")).toBeNull();
    const err = await zip.file("daemon.lock.parse-error.txt")!.async("string");
    expect(err).not.toContain("pplx_at_ABCDEFGHIJ1234567890");
    expect(err).toContain("<redacted:oauth-access>");
  });

  it("PEM in tunnel-settings.json is redacted", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({
      [`${configDir}/tunnel-settings.json`]: {
        kind: "file",
        content: JSON.stringify({ provider: "cf-named", originCert: SAMPLE_PEM }),
      },
    });

    await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      fs: fakeFs,
    });

    const zip = await readZip(outputPath);
    const ts = await zip.file("tunnel-settings.json")!.async("string");
    expect(ts).toContain("<redacted:pem>");
    expect(ts).not.toContain("BEGIN CERTIFICATE");
  });

  it("bytesWritten matches the actual zip output length", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({
      [`${configDir}/daemon.log`]: { kind: "file", content: "hi" },
    });

    const result = await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      fs: fakeFs,
    });

    const stat = await realFs.stat(outputPath);
    expect(result.bytesWritten).toBe(stat.size);
  });

  it("omits logs.txt and doctor-report.json when caller passes null/undefined", async () => {
    const configDir = "/home/user/.perplexity-mcp";
    const outputPath = path.join(tmpDir, "diag.zip");
    const fakeFs = makeFakeFs({});

    await captureDiagnostics({
      outputPath,
      configDir,
      extensionVersion: "0.8.1",
      vscodeVersion: "1.100.0",
      logsText: null,
      doctorReport: null,
      fs: fakeFs,
    });

    const zip = await readZip(outputPath);
    expect(zip.file("logs.txt")).toBeNull();
    expect(zip.file("doctor-report.json")).toBeNull();
  });
});
