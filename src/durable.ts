import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
// Platforms that cannot open or flush a directory (Windows, some filesystems) skip it.
const UNSUPPORTED = new Set([
  "EISDIR",
  "EPERM",
  "EINVAL",
  "EBADF",
  "ENOTSUP",
  "EACCES",
]);
export function syncDirectory(dir: string) {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!UNSUPPORTED.has((error as NodeJS.ErrnoException).code || ""))
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// Windows requires a writable handle for FlushFileBuffers (fsync).
export async function syncFile(path: string) {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function syncFileSync(path: string) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
// Data is flushed before it becomes visible under its final name, and the rename is
// flushed before callers record it as saved.
export function writeDurable(path: string, data: Uint8Array | string) {
  const temp = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    writeFileSync(temp, data, { mode: 0o600 });
    syncFileSync(temp);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  syncDirectory(dirname(path));
}
// Names created only by this app's temporary writers. Call only while holding the vault
// lock, so no live writer in another process can own one of these files.
const TEMPORARY: [string, RegExp][] = [
  ["media", /^\.[0-9a-f]{24}$/],
  ["thumbs", /^[\w.-]+\.webp\.[0-9a-f]{16}\.tmp$/],
  [".", /^config\.json\.[0-9a-f]{16}\.tmp$/],
  ["exports", /^latest\.sqlite\.pending$/],
];
export function sweepTemporary(dir: string) {
  let removed = 0;
  for (const [folder, pattern] of TEMPORARY) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names)
      if (pattern.test(basename(name))) {
        rmSync(join(dir, folder, name), { force: true });
        removed++;
      }
  }
  return removed;
}
// Replaceable for tests that check flush ordering.
export const flush = { file: syncFile, directory: syncDirectory };
