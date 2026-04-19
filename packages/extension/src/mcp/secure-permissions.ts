import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Lock down a directory so only the current OS user can access it.
 * Best-effort — failures are logged but don't throw.
 */
export async function secureDirectory(dirPath: string): Promise<void> {
  try {
    const stat = await fs.stat(dirPath).catch(() => null);
    if (!stat?.isDirectory()) return;

    if (process.platform === "win32") {
      await secureWindows(dirPath);
    } else {
      await secureUnix(dirPath);
    }
    console.log(`[secure-permissions] Secured: ${dirPath}`);
  } catch (err) {
    console.warn(`[secure-permissions] Failed to secure ${dirPath}:`, err);
  }
}

async function secureUnix(dirPath: string): Promise<void> {
  await fs.chmod(dirPath, 0o700);

  const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    const fullPath = path.join((entry as unknown as { parentPath?: string }).parentPath ?? (entry as unknown as { path: string }).path, entry.name);
    try {
      if (entry.isDirectory()) {
        await fs.chmod(fullPath, 0o700);
      } else {
        await fs.chmod(fullPath, 0o600);
      }
    } catch {
      // skip entries we can't chmod (e.g., symlinks)
    }
  }
}

async function secureWindows(dirPath: string): Promise<void> {
  const user = await resolveWindowsUser();
  if (!user) {
    console.warn("[secure-permissions] Could not resolve Windows user, skipping Windows ACL");
    return;
  }

  await execFileAsync("icacls", [
    dirPath,
    "/inheritance:r",
    "/grant:r",
    `${user}:(OI)(CI)F`,
  ]);
}

async function resolveWindowsUser(): Promise<string | null> {
  if (process.env.USERNAME) return process.env.USERNAME;
  if (process.env.USERPROFILE) {
    const base = process.env.USERPROFILE.split(/[\\/]/).filter(Boolean).pop();
    if (base) return base;
  }
  try {
    const { stdout } = await execFileAsync("whoami");
    return stdout.trim().split(/[\\/]/).pop() ?? null;
  } catch { return null; }
}
