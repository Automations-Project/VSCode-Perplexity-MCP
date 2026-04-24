import * as nodeCrypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../profiles.js";

export interface LocalTokenMetadata {
  id: string;
  ideTag: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked?: boolean;
}

export interface LocalTokenOptions {
  tokenPath?: string;
  now?: () => string;
}

interface LocalTokenRecord extends LocalTokenMetadata {
  hash: string;
}

const TOKEN_PREFIX = "pplx_local_";
const TOKEN_REGEX = /^pplx_local_([a-z0-9-]+)_([A-Za-z0-9_-]{32})$/;
const SANITIZED_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getLocalTokensPath(configDir = getConfigDir()): string {
  return join(configDir, "local-tokens.json");
}

export function issueLocalToken(
  input: { ideTag: string; label: string },
  options: LocalTokenOptions = {},
): { token: string; metadata: LocalTokenMetadata } {
  const sanitized = sanitizeIdeTag(input.ideTag ?? "");
  if (!sanitized || !SANITIZED_REGEX.test(sanitized)) {
    throw new Error("issueLocalToken: ideTag must contain at least one alphanumeric character.");
  }

  const label = (input.label ?? "").trim();
  if (label.length === 0) {
    throw new Error("issueLocalToken: label must be a non-empty string.");
  }

  const secret = nodeCrypto.randomBytes(24).toString("base64url");
  const token = `${TOKEN_PREFIX}${sanitized}_${secret}`;
  const idSuffix = nodeCrypto.randomBytes(8).toString("base64url");
  const id = `local-${sanitized}-${idSuffix}`;

  const now = (options.now ?? defaultNow)();
  const metadata: LocalTokenMetadata = {
    id,
    ideTag: sanitized,
    label,
    createdAt: now,
    revoked: false,
  };

  const record: LocalTokenRecord = {
    ...metadata,
    hash: hashToken(token),
  };

  const records = readRecords(options);
  records.push(record);
  writeRecords(records, options);

  return { token, metadata: toPublic(metadata) };
}

export function verifyLocalToken(
  raw: string,
  options: LocalTokenOptions = {},
): LocalTokenMetadata | null {
  if (typeof raw !== "string" || !TOKEN_REGEX.test(raw)) {
    return null;
  }

  const records = readRecordsSafe(options);
  if (records.length === 0) {
    return null;
  }

  const candidateHashBuf = Buffer.from(hashToken(raw), "hex");

  for (const record of records) {
    if (record.revoked) {
      continue;
    }
    const storedHashBuf = Buffer.from(record.hash, "hex");
    if (storedHashBuf.length !== candidateHashBuf.length) {
      continue;
    }
    if (nodeCrypto.timingSafeEqual(storedHashBuf, candidateHashBuf)) {
      const now = (options.now ?? defaultNow)();
      record.lastUsedAt = now;
      // lastUsedAt is ancillary audit metadata — a failed write-back must
      // not DOS the verify hot-path. Never log the plaintext token or the
      // hash; writeFileSync/renameSync messages typically include the file
      // path (safe) but never the token content.
      try {
        writeRecords(records, options);
      } catch (err) {
        console.warn(
          "[local-tokens] lastUsedAt write-back failed: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      return toPublic(record);
    }
  }

  return null;
}

export function revokeLocalToken(
  id: string,
  options: LocalTokenOptions = {},
): boolean {
  // Use strict readRecords (not readRecordsSafe) so callers can distinguish
  // "no such id" (false) from "disk unreadable" (thrown). Only verify's
  // per-request hot-path is allowed to swallow malformed-file errors.
  const records = readRecords(options);
  const match = records.find((entry) => entry.id === id);
  if (!match) {
    return false;
  }
  if (match.revoked) {
    return false;
  }
  match.revoked = true;
  writeRecords(records, options);
  return true;
}

export function listLocalTokens(
  options: LocalTokenOptions = {},
): LocalTokenMetadata[] {
  const records = readRecords(options);
  return records.map(toPublic);
}

function toPublic(record: LocalTokenMetadata | LocalTokenRecord): LocalTokenMetadata {
  const metadata: LocalTokenMetadata = {
    id: record.id,
    ideTag: record.ideTag,
    label: record.label,
    createdAt: record.createdAt,
  };
  if (record.lastUsedAt !== undefined) {
    metadata.lastUsedAt = record.lastUsedAt;
  }
  if (record.revoked) {
    metadata.revoked = true;
  }
  return metadata;
}

function sanitizeIdeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashToken(token: string): string {
  return nodeCrypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// readRecords throws on unexpected IO errors (non-ENOENT) so operators notice
// broken disks; missing-file returns [] and parse failures throw.
function readRecords(options: LocalTokenOptions): LocalTokenRecord[] {
  const tokenPath = options.tokenPath ?? getLocalTokensPath();
  if (!existsSync(tokenPath)) {
    return [];
  }

  const raw = readFileSync(tokenPath, "utf8");
  if (raw.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Local tokens file is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Local tokens file must contain a JSON array.");
  }

  return parsed.map(normalizeRecord);
}

// readRecordsSafe is used on verify paths where a malformed file must not
// raise — the daemon consults verify on every request.
function readRecordsSafe(options: LocalTokenOptions): LocalTokenRecord[] {
  try {
    return readRecords(options);
  } catch {
    return [];
  }
}

function normalizeRecord(value: unknown): LocalTokenRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Local tokens file entries must be JSON objects.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("Local token entry field 'id' must be a non-empty string.");
  }
  if (typeof record.ideTag !== "string" || record.ideTag.length === 0) {
    throw new Error("Local token entry field 'ideTag' must be a non-empty string.");
  }
  if (typeof record.label !== "string" || record.label.length === 0) {
    throw new Error("Local token entry field 'label' must be a non-empty string.");
  }
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) {
    throw new Error("Local token entry field 'createdAt' must be a non-empty string.");
  }
  if (typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash)) {
    throw new Error("Local token entry field 'hash' must be a 64-char hex SHA-256 digest.");
  }

  const normalized: LocalTokenRecord = {
    id: record.id,
    ideTag: record.ideTag,
    label: record.label,
    createdAt: record.createdAt,
    hash: record.hash,
  };
  if (typeof record.lastUsedAt === "string" && record.lastUsedAt.length > 0) {
    normalized.lastUsedAt = record.lastUsedAt;
  }
  if (record.revoked === true) {
    normalized.revoked = true;
  }
  return normalized;
}

function writeRecords(records: LocalTokenRecord[], options: LocalTokenOptions): void {
  const tokenPath = options.tokenPath ?? getLocalTokensPath();
  mkdirSync(dirname(tokenPath), { recursive: true });

  const serializable = records.map((record) => {
    const entry: Record<string, unknown> = {
      id: record.id,
      ideTag: record.ideTag,
      label: record.label,
      createdAt: record.createdAt,
      hash: record.hash,
    };
    if (record.lastUsedAt !== undefined) {
      entry.lastUsedAt = record.lastUsedAt;
    }
    if (record.revoked) {
      entry.revoked = true;
    } else {
      entry.revoked = false;
    }
    return entry;
  });

  const tempPath = `${tokenPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(serializable, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  rmSync(tokenPath, { force: true });
  renameSync(tempPath, tokenPath);
  applyPrivatePermissions(tokenPath);
}

// Inlined from daemon/token.ts: coupling both security-critical files to a
// shared helper would risk a future refactor of one silently weakening the
// other. See the 8.6.1 spec note for the deliberate duplication.
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
    throw new Error(`Failed to restrict local-tokens ACL via icacls.${detail ? ` ${detail}` : ""}`);
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
  throw new Error("Unable to resolve Windows username for local-tokens ACL.");
}

function defaultNow(): string {
  return new Date().toISOString();
}
