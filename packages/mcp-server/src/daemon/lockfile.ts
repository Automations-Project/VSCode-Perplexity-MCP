import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../profiles.js";

export interface DaemonLockRecord {
  pid: number;
  uuid: string;
  port: number;
  bearerToken: string;
  version: string;
  startedAt: string;
  cloudflaredPid?: number | null;
  tunnelUrl?: string | null;
}

export interface LockfileOptions {
  lockPath?: string;
}

export interface ReplaceLockfileOptions extends LockfileOptions {
  expectedUuid?: string;
}

export interface LockfileStaleOptions {
  echoedUuid?: string | null;
}

export function getLockfilePath(configDir = getConfigDir()): string {
  return join(configDir, "daemon.lock");
}

export function acquire(record: DaemonLockRecord, options: LockfileOptions = {}): boolean {
  const lockPath = options.lockPath ?? getLockfilePath();
  const normalized = normalizeRecord(record);

  mkdirSync(dirname(lockPath), { recursive: true });

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (isExistsError(error)) {
      return false;
    }
    throw error;
  }

  let wrote = false;
  try {
    writeFileSync(fd, serialize(normalized), "utf8");
    wrote = true;
  } finally {
    closeSync(fd);
    if (!wrote) {
      rmSync(lockPath, { force: true });
    }
  }

  return true;
}

export function read(options: LockfileOptions = {}): DaemonLockRecord | null {
  const lockPath = options.lockPath ?? getLockfilePath();
  if (!existsSync(lockPath)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  return normalizeRecord(parsed);
}

export function release(options: LockfileOptions & { expectedUuid?: string } = {}): boolean {
  const lockPath = options.lockPath ?? getLockfilePath();
  if (!existsSync(lockPath)) {
    return false;
  }

  if (options.expectedUuid) {
    const current = read({ lockPath });
    if (!current || current.uuid !== options.expectedUuid) {
      return false;
    }
  }

  rmSync(lockPath, { force: true });
  return true;
}

export function replace(record: DaemonLockRecord, options: ReplaceLockfileOptions = {}): boolean {
  const lockPath = options.lockPath ?? getLockfilePath();
  const normalized = normalizeRecord(record);

  if (options.expectedUuid) {
    const current = read({ lockPath });
    if (!current || current.uuid !== options.expectedUuid) {
      return false;
    }
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const tempPath = `${lockPath}.tmp`;
  writeFileSync(tempPath, serialize(normalized), "utf8");
  renameSync(tempPath, lockPath);
  return true;
}

export function isStale(record: DaemonLockRecord | null, options: LockfileStaleOptions = {}): boolean {
  if (!record) {
    return true;
  }

  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return true;
  }

  if (!record.uuid || typeof record.uuid !== "string") {
    return true;
  }

  if (options.echoedUuid && options.echoedUuid !== record.uuid) {
    return true;
  }

  return !isProcessAlive(record.pid);
}

function normalizeRecord(value: unknown): DaemonLockRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Daemon lockfile must contain a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const pid = asPositiveInteger(record.pid, "pid");
  const port = asPort(record.port);
  const uuid = asRequiredString(record.uuid, "uuid");
  const bearerToken = asRequiredString(record.bearerToken, "bearerToken");
  const version = asRequiredString(record.version, "version");
  const startedAt = asRequiredString(record.startedAt, "startedAt");

  return {
    pid,
    port,
    uuid,
    bearerToken,
    version,
    startedAt,
    cloudflaredPid: asOptionalInteger(record.cloudflaredPid, "cloudflaredPid"),
    tunnelUrl: asOptionalString(record.tunnelUrl, "tunnelUrl"),
  };
}

function asPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Daemon lockfile field '${name}' must be a positive integer.`);
  }
  return Number(value);
}

function asPort(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 65535) {
    throw new Error("Daemon lockfile field 'port' must be an integer between 0 and 65535.");
  }
  return Number(value);
}

function asRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Daemon lockfile field '${name}' must be a non-empty string.`);
  }
  return value;
}

function asOptionalInteger(value: unknown, name: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Daemon lockfile field '${name}' must be a positive integer when present.`);
  }
  return Number(value);
}

function asOptionalString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Daemon lockfile field '${name}' must be a string when present.`);
  }
  return value;
}

function serialize(record: DaemonLockRecord): string {
  return JSON.stringify(record, null, 2) + "\n";
}

function isExistsError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM") {
      return true;
    }
    return false;
  }
}
