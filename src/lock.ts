import lockfile from "proper-lockfile";
import { join } from "node:path";
// A filesystem lease works across Docker PID namespaces and survives unclean exits.
// A crashed owner expires within 10 seconds; live owners refresh every 2 seconds.
export async function lockVault(dir: string, wait = true) {
  try {
    return await lockfile.lock(dir, {
      lockfilePath: join(dir, "instance.lease"),
      stale: 10000,
      update: 2000,
      retries: wait ? { retries: 12, minTimeout: 1000, maxTimeout: 1000 } : 0,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED")
      throw new Error(
        "This vault is already open in another process. Use a different --data-dir or stop the other instance.",
      );
    throw error;
  }
}
