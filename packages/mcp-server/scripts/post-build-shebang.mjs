#!/usr/bin/env node
/**
 * Post-build shebang injection for dist/cli.mjs.
 *
 * tsup intentionally omits shebang from bundled output because a shebang in
 * source files trips vitest/esbuild during test imports.  However, the npm
 * package.json `bin` field points directly at `dist/cli.mjs`; on POSIX npm
 * creates a symlink (not a wrapper script), so the kernel needs the shebang
 * to exec the file directly.
 *
 * This script prepends `#!/usr/bin/env node` and ensures the file is
 * executable (0o755).  It is a no-op on Windows where the kernel ignores
 * shebangs and npm uses `.cmd` wrappers anyway.
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const file = join(import.meta.dirname, "..", "dist", "cli.mjs");
if (!existsSync(file)) {
  console.error("post-build-shebang: dist/cli.mjs not found");
  process.exit(1);
}

const content = readFileSync(file, "utf8");
if (content.startsWith("#!/usr/bin/env node")) {
  console.log("post-build-shebang: already present, skipping");
  process.exit(0);
}

writeFileSync(file, "#!/usr/bin/env node\n" + content);
chmodSync(file, 0o755);
console.log("post-build-shebang: injected shebang + chmod 755");
