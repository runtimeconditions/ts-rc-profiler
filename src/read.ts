import { closeSync, openSync, readSync } from "node:fs";

import { fail } from "./errors.js";

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export function readLimited(path: string, stage: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1 << 20, MAX_INPUT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) {
        return Buffer.concat(chunks, total);
      }
      total += count;
      if (total > MAX_INPUT_BYTES) {
        fail(stage, `file exceeds the ${MAX_INPUT_BYTES} byte size limit`, path);
      }
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
}
