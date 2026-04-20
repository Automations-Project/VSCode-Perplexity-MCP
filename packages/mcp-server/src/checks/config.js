import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CATEGORY = "config";

export async function run(opts = {}) {
  const dir = opts.configDir;
  const results = [];

  if (!existsSync(dir)) {
    results.push({
      category: CATEGORY,
      name: "config-dir",
      status: "fail",
      message: `Config dir not found: ${dir}`,
      hint: "Run `npx perplexity-user-mcp login` to initialize it.",
    });
    return results;
  }
  results.push({
    category: CATEGORY,
    name: "config-dir",
    status: "pass",
    message: `Config dir present at ${dir}`,
  });

  if (process.platform !== "win32") {
    const mode = statSync(dir).mode & 0o777;
    if (mode & 0o077) {
      results.push({
        category: CATEGORY,
        name: "config-perms",
        status: "warn",
        message: `Config dir is world/group readable (mode 0${mode.toString(8)})`,
        hint: "Run `chmod 700 ~/.perplexity-mcp`.",
      });
    } else {
      results.push({ category: CATEGORY, name: "config-perms", status: "pass", message: "0700" });
    }
  } else {
    results.push({ category: CATEGORY, name: "config-perms", status: "skip", message: "NTFS ACL (see icacls)" });
  }

  const activePath = join(dir, "active");
  if (!existsSync(activePath)) {
    results.push({
      category: CATEGORY,
      name: "active-pointer",
      status: "warn",
      message: "No active profile set.",
      hint: "Add an account to create and activate your first profile.",
      action: { label: "Add account", commandId: "Perplexity.addAccount" },
    });
  } else {
    const name = readFileSync(activePath, "utf8").trim();
    const metaPath = join(dir, "profiles", name, "meta.json");
    if (!existsSync(metaPath)) {
      results.push({
        category: CATEGORY,
        name: "active-pointer",
        status: "fail",
        message: `active -> '${name}' but profile does not exist`,
        hint: "Run `npx perplexity-user-mcp list-accounts` and pick a real profile.",
      });
    } else {
      results.push({ category: CATEGORY, name: "active-pointer", status: "pass", message: name });
    }
  }

  const cfgJson = join(dir, "config.json");
  if (!existsSync(cfgJson)) {
    results.push({ category: CATEGORY, name: "config-json", status: "skip", message: "optional file absent" });
  } else {
    try {
      JSON.parse(readFileSync(cfgJson, "utf8"));
      results.push({ category: CATEGORY, name: "config-json", status: "pass", message: "valid" });
    } catch (err) {
      results.push({
        category: CATEGORY,
        name: "config-json",
        status: "warn",
        message: `config.json malformed: ${err.message}`,
        hint: "Delete or fix the file — doctor reads it for reporting.githubIssueButton etc.",
      });
    }
  }

  return results;
}
