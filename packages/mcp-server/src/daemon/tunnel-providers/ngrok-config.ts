/**
 * Persistence for ngrok credentials.
 *
 * Stored at `<configDir>/ngrok.json` with file mode 0600 (POSIX) or
 * user-only ACL (Windows). Mirrors the token.ts safety pattern.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { safeAtomicWriteFileSync } from "../../safe-write.js";

export interface NgrokSettings {
  authtoken: string;
  domain?: string;
  updatedAt: string;
}

export function getNgrokConfigPath(configDir: string): string {
  return join(configDir, "ngrok.json");
}

export function readNgrokSettings(configDir: string): NgrokSettings | null {
  const path = getNgrokConfigPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NgrokSettings>;
    if (typeof parsed.authtoken === "string" && parsed.authtoken.length > 0) {
      return {
        authtoken: parsed.authtoken,
        domain: typeof parsed.domain === "string" && parsed.domain.length > 0 ? parsed.domain : undefined,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeNgrokSettings(configDir: string, next: { authtoken?: string; domain?: string | null }): NgrokSettings {
  const path = getNgrokConfigPath(configDir);
  const prev = readNgrokSettings(configDir);
  const merged: NgrokSettings = {
    authtoken: next.authtoken ?? prev?.authtoken ?? "",
    domain: next.domain === null ? undefined : (next.domain ?? prev?.domain),
    updatedAt: new Date().toISOString(),
  };
  if (!merged.authtoken) {
    throw new Error("ngrok authtoken is required.");
  }
  mkdirSync(dirname(path), { recursive: true });
  safeAtomicWriteFileSync(path, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  applyPrivatePermissions(path);
  return merged;
}

export function clearNgrokSettings(configDir: string): void {
  const path = getNgrokConfigPath(configDir);
  rmSync(path, { force: true });
}

function applyPrivatePermissions(path: string): void {
  if (process.platform === "win32") {
    const username = process.env.USERNAME;
    const domain = process.env.USERDOMAIN;
    const target = domain && username ? `${domain}\\${username}` : username ?? "";
    if (!target) return;
    spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${target}:(R,W)`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return;
  }
  chmodSync(path, 0o600);
}
