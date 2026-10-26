import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
export function lockVault(dir: string) {
  const path = join(dir, "instance.lock");
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      closeSync(fd);
      return () => {
        try {
          if (JSON.parse(readFileSync(path, "utf8")).nonce === nonce)
            rmSync(path);
        } catch {
          /* A missing lock is already released. */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try {
        pid = JSON.parse(readFileSync(path, "utf8")).pid;
        if (!Number.isInteger(pid) || pid <= 0)
          throw new Error("Invalid lock.");
      } catch {
        throw new Error(
          "Vault lock is unreadable. Check that no other instance uses this directory before removing instance.lock.",
        );
      }
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          rmSync(path);
          continue;
        }
      }
      throw new Error(
        "This vault is already open in another process. Use a different --data-dir or stop the other instance.",
      );
    }
  }
  throw new Error("Could not acquire vault lock.");
}
