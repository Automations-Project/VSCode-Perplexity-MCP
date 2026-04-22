import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../profiles.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface AuditEntry {
  timestamp: string;
  clientId: string;
  tool: string;
  durationMs: number;
  source: "loopback" | "tunnel";
  ok: boolean;
  error?: string;
  // Phase 6a: populated for every HTTP-level request. Tool-call audit entries
  // (written by /mcp middleware) also include these.
  ip?: string;
  userAgent?: string;
  path?: string;
  httpStatus?: number;
  auth?: "bearer" | "oauth" | "oauth-cached" | "none";
}

export interface AuditOptions {
  auditPath?: string;
  maxBytes?: number;
}

export function getAuditLogPath(configDir = getConfigDir()): string {
  return join(configDir, "audit.log");
}

export function appendAuditEntry(entry: AuditEntry, options: AuditOptions = {}): void {
  const auditPath = options.auditPath ?? getAuditLogPath();
  const line = JSON.stringify(entry) + "\n";

  mkdirSync(dirname(auditPath), { recursive: true });
  rotateIfNeeded(auditPath, Buffer.byteLength(line), options.maxBytes ?? DEFAULT_MAX_BYTES);
  appendFileSync(auditPath, line, "utf8");
}

export function readAuditTail(limit = 50, options: AuditOptions = {}): AuditEntry[] {
  const auditPath = options.auditPath ?? getAuditLogPath();
  if (!existsSync(auditPath)) {
    return [];
  }

  return readFileSync(auditPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as AuditEntry);
}

function rotateIfNeeded(auditPath: string, nextWriteBytes: number, maxBytes: number): void {
  if (!existsSync(auditPath)) {
    return;
  }

  const size = statSync(auditPath).size;
  if (size + nextWriteBytes <= maxBytes) {
    return;
  }

  const rotatedPath = `${auditPath}.1`;
  rmSync(rotatedPath, { force: true });
  renameSync(auditPath, rotatedPath);
}
