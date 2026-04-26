import type { WriteFileOptions } from "node:fs";

export function safeAtomicWriteFileSync(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  opts?: WriteFileOptions
): void;
