import { readFileSync } from "node:fs";

let cachedPackageVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedPackageVersion) {
    return cachedPackageVersion;
  }

  const moduleUrl = typeof import.meta.url === "string" && import.meta.url.length > 0 ? import.meta.url : null;
  if (moduleUrl) {
    for (const relativePath of ["./package.json", "../package.json", "../../package.json"]) {
      try {
        const pkg = JSON.parse(readFileSync(new URL(relativePath, moduleUrl), "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === "perplexity-user-mcp" && typeof pkg.version === "string" && pkg.version.length > 0) {
          cachedPackageVersion = pkg.version;
          return cachedPackageVersion;
        }
      } catch {
        // Try the next layout. Source, npm dist, and bundled VSIX dist place
        // package.json at different depths.
      }
    }
  }

  cachedPackageVersion =
    typeof process.env.npm_package_version === "string" && process.env.npm_package_version.length > 0
      ? process.env.npm_package_version
      : "0.0.0";
  return cachedPackageVersion;
}
