import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "..", "..", "webview", "dist");
const targetDir = join(__dirname, "..", "media", "webview");

if (!existsSync(sourceDir)) {
  throw new Error(`Webview build output not found at ${sourceDir}. Run the webview build first.`);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
