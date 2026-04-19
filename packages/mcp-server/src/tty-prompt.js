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
