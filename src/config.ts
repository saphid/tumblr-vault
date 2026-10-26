import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statfsSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Profile, Settings } from "./contract.js";
export interface Token {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  obtained: number;
}
export interface Account extends Profile {
  token?: Token;
}
export interface Config {
  password?: string;
  clientId?: string;
  clientSecret?: string;
  clip: Settings["clip"];
  mlUrl: string;
  scheduleHours: number;
  accounts: Account[];
  demo: boolean;
}
export function defaultDir() {
  return (
    process.env.VAULT_DATA_DIR ||
    join(
      platform() === "win32"
        ? process.env.LOCALAPPDATA || homedir()
        : platform() === "darwin"
          ? join(homedir(), "Library", "Application Support")
          : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "tumblr-vault",
    )
  );
}
export function atomicJSON(path: string, value: unknown) {
  const temp = path + "." + randomBytes(8).toString("hex") + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // Windows requires a writable handle for FlushFileBuffers (fsync).
  const fd = openSync(temp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export function hashPassword(password: string) {
  if (password.length < 12 || password.length > 1024)
    throw new Error("Use a password between 12 and 1024 characters.");
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function checkPassword(password: string, hash: string) {
  const [salt, value] = hash.split(":");
  const expected = Buffer.from(value, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export class Configuration {
  readonly dir: string;
  value: Config;
  constructor(dir = defaultDir(), demo = false) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const folder of ["media", "thumbs", "exports", "models"])
      mkdirSync(join(this.dir, folder), { recursive: true, mode: 0o700 });
    const file = join(this.dir, "config.json");
    this.value = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { clip: "off", mlUrl: "", scheduleHours: 24, accounts: [], demo };
    if (this.value.demo !== demo && existsSync(file))
      throw new Error(
        "Demo data must use its own directory. Start with --demo --data-dir <new-directory>.",
      );
  }
  save() {
    atomicJSON(join(this.dir, "config.json"), this.value);
  }
  free() {
    const s = statfsSync(this.dir);
    return s.bavail * s.bsize;
  }
  public(baseUrl: string): Settings {
    return {
      configured: !!this.value.password,
      dataDir: this.dir,
      storageFree: this.free(),
      clip: this.value.clip,
      mlUrl: this.value.mlUrl,
      scheduleHours: this.value.scheduleHours,
      profiles: this.value.accounts.map(({ token, ...p }) => p),
      callbackUrl: baseUrl + "/oauth/callback",
      demo: this.value.demo,
    };
  }
  configure(input: Record<string, unknown>, initial = false) {
    const c = this.value;
    const next = { ...c };
    if (initial || input.password) {
      next.password = hashPassword(String(input.password || ""));
    }
    if (input.clip !== undefined) {
      if (!["off", "local", "immich"].includes(String(input.clip)))
        throw new Error("Choose an image search option.");
      next.clip = input.clip as Config["clip"];
    }
    if (input.mlUrl !== undefined) {
      const url = String(input.mlUrl).replace(/\/$/, "");
      if (url) {
        const u = new URL(url);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash
        )
          throw new Error(
            "Use an HTTP(S) machine-learning endpoint without credentials.",
          );
      }
      next.mlUrl = url;
    }
    if (next.clip === "immich" && !next.mlUrl)
      throw new Error("Enter your Immich machine-learning URL.");
    if (input.scheduleHours !== undefined) {
      const hours = Number(input.scheduleHours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 720)
        throw new Error("Backup interval must be 0–720 hours.");
      next.scheduleHours = hours;
    }
    if (input.clientId) {
      next.clientId = String(input.clientId).trim();
    }
    if (input.clientSecret) {
      next.clientSecret = String(input.clientSecret).trim();
    }
    this.value = next;
    this.save();
  }
}
