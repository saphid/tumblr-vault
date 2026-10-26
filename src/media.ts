import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Archive, Raw } from "./store.js";
export function allowedMedia(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      (u.hostname === "tumblr.com" || u.hostname.endsWith(".tumblr.com"))
    );
  } catch {
    return false;
  }
}
export async function download(archive: Archive, row: Raw) {
  let url = row.url;
  const tmp = join(archive.dir, "media", "." + randomBytes(12).toString("hex"));
  try {
    const disk = statfsSync(archive.dir);
    if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
      throw new Error(
        "disk_reserve: Keep at least 2 GiB free for the database and downloads.",
      );
    let response: Response | undefined;
    for (let i = 0; i < 6; i++) {
      if (!allowedMedia(url)) throw new Error("external_host");
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(120000),
        headers: {
          "User-Agent":
            "TumblrVault/1.0 (+https://github.com/saphid/tumblr-vault)",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const next = response.headers.get("location");
        if (!next) throw new Error("invalid_redirect");
        url = new URL(next, url).href;
        continue;
      }
      break;
    }
    if (!response || (response.status >= 300 && response.status < 400))
      throw new Error("redirect_limit");
    if (!response.ok) throw new Error("HTTP " + response.status);
    if (!response.body) throw new Error("empty_response");
    const limit = 1024 ** 3;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > limit) throw new Error("file_too_large");
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > limit) return cb(new Error("file_too_large"));
        if (bytes % (16 * 1024 ** 2) < chunk.length) {
          const s = statfsSync(archive.dir);
          if (s.bavail * s.bsize < 1024 ** 3)
            return cb(new Error("disk_reserve"));
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as any),
      meter,
      createWriteStream(tmp, { mode: 0o600 }),
    );
    const sha = hash.digest("hex");
    const path = sha;
    const target = join(archive.dir, "media", path);
    if (existsSync(target)) rmSync(tmp);
    else renameSync(tmp, target);
    let thumb: string | null = null;
    if (row.kind === "image") {
      try {
        thumb = sha + ".webp";
        await sharp(target, { limitInputPixels: 100000000, animated: false })
          .rotate()
          .resize({
            width: 1000,
            height: 1000,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toFile(join(archive.dir, "thumbs", thumb));
      } catch {
        thumb = null;
      }
    }
    archive.db
      .prepare(
        "UPDATE media SET hash=?,path=?,thumb=?,bytes=?,error=NULL WHERE id=?",
      )
      .run(sha, path, thumb, bytes, row.id);
  } catch (error) {
    rmSync(tmp, { force: true });
    const message = error instanceof Error ? error.message : "download_failed";
    if (message.startsWith("disk_reserve")) throw error;
    archive.db
      .prepare("UPDATE media SET error=? WHERE id=?")
      .run(
        message.startsWith("HTTP ") ||
          [
            "external_host",
            "redirect_limit",
            "invalid_redirect",
            "file_too_large",
            "empty_response",
          ].includes(message)
          ? message
          : "network_error",
        row.id,
      );
  }
}
