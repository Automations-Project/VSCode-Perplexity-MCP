import { createInterface } from "node:readline";

export function promptSecret({ stdin = process.stdin, stderr = process.stderr, prompt = "> " } = {}) {
  return new Promise((resolve) => {
    stderr.write(prompt);
    const rl = createInterface({ input: stdin, output: stderr, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(String(line).trim());
    });
  });
}

/**
 * Minimal y/N confirmation prompt for destructive-ish CLI subcommands.
 *
 * - Prompt goes to stderr. Answer comes from stdin. Matches the existing
 *   `promptSecret` shape so tests can inject fakes.
 * - Accepts `y`, `Y`, `yes`, `YES`, `Yes` as confirmation. Everything else —
 *   including empty input, EOF (Ctrl-D), and stdin close — is treated as a
 *   decline. Returns `true` on confirm, `false` on decline.
 * - Does NOT exit the process; the caller decides whether to exit 130.
 */
export function promptYesNo({ stdin = process.stdin, stderr = process.stderr, prompt = "Continue? [y/N] " } = {}) {
  return new Promise((resolve) => {
    stderr.write(prompt);
    const rl = createInterface({ input: stdin, output: stderr, terminal: false });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch { /* ignore */ }
      resolve(value);
    };
    rl.once("line", (line) => {
      const answer = String(line).trim().toLowerCase();
      finish(answer === "y" || answer === "yes");
    });
    // EOF / stream close before a line arrives → decline.
    rl.once("close", () => finish(false));
  });
}
