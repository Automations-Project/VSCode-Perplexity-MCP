import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../profiles.js";
import { safeAtomicWriteFileSync } from "../safe-write.js";

export interface DaemonTokenRecord {
  bearerToken: string;
  version: number;
  createdAt: string;
  rotatedAt: string;
}

export interface TokenOptions {
  tokenPath?: string;
  now?: () => string;
}

export function getTokenPath(configDir = getConfigDir()): string {
  return join(configDir, "daemon.token");
}

export function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readToken(options: TokenOptions = {}): DaemonTokenRecord | null {
  const tokenPath = options.tokenPath ?? getTokenPath();
  if (!existsSync(tokenPath)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(tokenPath, "utf8"));
  return normalizeRecord(parsed);
}

export function ensureToken(options: TokenOptions = {}): DaemonTokenRecord {
  const existing = readToken(options);
  if (existing) {
    return existing;
  }

  const now = (options.now ?? defaultNow)();
  const record: DaemonTokenRecord = {
    bearerToken: generateBearerToken(),
    version: 1,
    createdAt: now,
    rotatedAt: now,
  };
  writeToken(record, options);
  return record;
}

export function rotateToken(options: TokenOptions = {}): DaemonTokenRecord {
  const previous = readToken(options);
  const now = (options.now ?? defaultNow)();
  const record: DaemonTokenRecord = {
    bearerToken: generateBearerToken(),
    version: (previous?.version ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    rotatedAt: now,
  };
  writeToken(record, options);
  return record;
}

function writeToken(record: DaemonTokenRecord, options: TokenOptions = {}): void {
  const tokenPath = options.tokenPath ?? getTokenPath();
  const normalized = normalizeRecord(record);
  mkdirSync(dirname(tokenPath), { recursive: true });

  safeAtomicWriteFileSync(tokenPath, JSON.stringify(normalized, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  applyPrivatePermissions(tokenPath);
}

function normalizeRecord(value: unknown): DaemonTokenRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Daemon token file must contain a JSON object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.bearerToken !== "string" || record.bearerToken.length === 0) {
    throw new Error("Daemon token file field 'bearerToken' must be a non-empty string.");
  }
  if (!Number.isInteger(record.version) || Number(record.version) <= 0) {
    throw new Error("Daemon token file field 'version' must be a positive integer.");
  }
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) {
    throw new Error("Daemon token file field 'createdAt' must be a non-empty string.");
  }
  if (typeof record.rotatedAt !== "string" || record.rotatedAt.length === 0) {
    throw new Error("Daemon token file field 'rotatedAt' must be a non-empty string.");
  }

  return {
    bearerToken: record.bearerToken,
    version: Number(record.version),
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
  };
}

function applyPrivatePermissions(tokenPath: string): void {
  if (process.platform === "win32") {
    restrictWindowsAcl(tokenPath);
    return;
  }

  chmodSync(tokenPath, 0o600);
}

function restrictWindowsAcl(tokenPath: string): void {
  const username = getWindowsUserName();
  const grantTarget = `${username}:(R,W)`;
  const result = spawnSync("icacls", [tokenPath, "/inheritance:r", "/grant:r", grantTarget], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Failed to restrict daemon token ACL via icacls.${detail ? ` ${detail}` : ""}`);
  }
}

function getWindowsUserName(): string {
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  if (domain && username) {
    return `${domain}\\${username}`;
  }
  if (username) {
    return username;
  }
  throw new Error("Unable to resolve Windows username for daemon token ACL.");
}

function defaultNow(): string {
  return new Date().toISOString();
}
