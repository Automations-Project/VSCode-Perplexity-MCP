/**
 * Fixed-capacity line buffer used to mirror the extension's OutputChannel
 * contents so the diagnostics capture flow can snapshot them on demand.
 *
 * VS Code does not expose a read API for OutputChannel, so every line appended
 * via the extension's `log()` / `debug()` helpers is teed here by the caller.
 * The buffer stores already-redacted strings — the caller is responsible for
 * running `redactMessage` (etc.) on each line BEFORE calling `append`.
 */
export class OutputRingBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly maxLines: number) {}

  append(line: string): void {
    this.lines.push(line);
    // Trim from the front once over cap. `shift()` is O(n) on V8 but the cap
    // is small (5000 at the default call site), so the amortised cost is fine.
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  snapshot(): string {
    return this.lines.join("\n");
  }

  clear(): void {
    this.lines.length = 0;
  }

  get size(): number {
    return this.lines.length;
  }
}
