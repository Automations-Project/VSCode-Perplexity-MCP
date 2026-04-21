import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);

const VIEWER_BINARIES = {
  obsidian: process.platform === "win32" ? "obsidian.exe" : "obsidian",
  typora: process.platform === "win32" ? "typora.exe" : "typora",
  logseq: process.platform === "win32" ? "logseq.exe" : "logseq",
};

async function detectBinary(binary) {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFile(command, [binary]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function detectViewer(id) {
  const binary = VIEWER_BINARIES[id];
  if (!binary) {
    return false;
  }
  return detectBinary(binary);
}

export async function detectAllViewers() {
  const entries = await Promise.all(
    Object.keys(VIEWER_BINARIES).map(async (id) => [id, await detectViewer(id)]),
  );
  return Object.fromEntries(entries);
}
