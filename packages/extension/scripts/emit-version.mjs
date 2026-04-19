import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../mcp-server/package.json"), "utf-8"));

let gitSha = "unknown";
try {
  gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
} catch {}

const outDir = join(__dirname, "../dist/mcp");
mkdirSync(outDir, { recursive: true });

const info = { name: pkg.name, version: pkg.version, timestamp: new Date().toISOString(), gitSha };
writeFileSync(join(outDir, "version.json"), JSON.stringify(info, null, 2));
console.log("Emitted version.json:", JSON.stringify(info));
