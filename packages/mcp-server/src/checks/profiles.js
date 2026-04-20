import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CATEGORY = "profiles";
const STALE_CACHE_DAYS = 7;

export async function run(opts = {}) {
  const dir = opts.configDir;
  const results = [];
  const profilesDir = join(dir, "profiles");

  if (!existsSync(profilesDir)) {
    results.push({ category: CATEGORY, name: "profile-count", status: "warn", message: "No profiles dir." });
    return results;
  }

  const listing = readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const names = opts.allProfiles
    ? listing
    : opts.profile
      ? [opts.profile]
      : listing;

  if (names.length === 0) {
    results.push({
      category: CATEGORY,
      name: "profile-count",
      status: "warn",
      message: "No profiles found. Run `login` to create one.",
    });
    return results;
  }
  results.push({
    category: CATEGORY,
    name: "profile-count",
    status: "pass",
    message: `${names.length} profile(s): ${names.join(", ")}`,
  });

  for (const name of names) {
    const pdir = join(profilesDir, name);
    const meta = join(pdir, "meta.json");
    try {
      JSON.parse(readFileSync(meta, "utf8"));
      results.push({ category: CATEGORY, name: `${name}/meta`, status: "pass", message: "valid" });
    } catch {
      results.push({
        category: CATEGORY,
        name: `${name}/meta`,
        status: "fail",
        message: `${name}/meta.json missing or corrupt`,
        hint: `Delete and re-run login for profile '${name}'.`,
      });
    }

    const enc = join(pdir, "vault.enc");
    const plain = join(pdir, "vault.json");
    if (existsSync(enc)) {
      results.push({ category: CATEGORY, name: `${name}/vault`, status: "pass", message: "encrypted" });
    } else if (existsSync(plain)) {
      results.push({
        category: CATEGORY,
        name: `${name}/vault`,
        status: "warn",
        message: "plaintext opt-out (security.encryptCookies=false)",
        hint: "Consider re-running login without --plain-cookies for encrypted storage.",
      });
    } else {
      results.push({
        category: CATEGORY,
        name: `${name}/vault`,
        status: "warn",
        message: "no vault file — profile never logged in",
      });
    }

    const cache = join(pdir, "models-cache.json");
    if (!existsSync(cache)) {
      results.push({ category: CATEGORY, name: `${name}/models-cache`, status: "skip", message: "no cache yet" });
    } else {
      const ageDays = (Date.now() - statSync(cache).mtime.getTime()) / (24 * 3600 * 1000);
      if (ageDays > STALE_CACHE_DAYS) {
        results.push({
          category: CATEGORY,
          name: `${name}/models-cache`,
          status: "warn",
          message: `models cache is ${Math.round(ageDays)} days old`,
          hint: "Open the dashboard and click 'Fetch live' to refresh.",
        });
      } else {
        results.push({ category: CATEGORY, name: `${name}/models-cache`, status: "pass", message: `${Math.round(ageDays)}d old` });
      }
    }
  }

  return results;
}
