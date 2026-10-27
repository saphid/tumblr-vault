import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { flush, writeDurable } from "./durable.js";
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
// Replaceable for tests; sharp work cannot be cancelled once started. Rendering fails
// mostly for the content (corrupt, unsupported, too large); writing fails for storage.
export const imaging = {
  render: (source: string): Promise<Uint8Array> =>
    sharp(source, { limitInputPixels: 100000000, animated: false })
      .rotate()
      .resize({
        width: 1000,
        height: 1000,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer(),
  write: async (destination: string, data: Uint8Array) =>
    writeDurable(destination, data),
};
export const PREVIEW_UNSUPPORTED = "preview_unsupported";
export const PREVIEW_STORAGE = "preview_storage";
// Stop waiting on shutdown; a late failure is observed and a late result is unused.
function untilStopped<T>(work: Promise<T>, stop?: AbortSignal): Promise<T> {
  work.catch(() => {});
  if (!stop) return work;
  if (stop.aborted) return Promise.reject(new Error("stopped"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("stopped"));
    stop.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => stop.removeEventListener("abort", abort));
  });
}
export async function download(archive: Archive, row: Raw, stop?: AbortSignal) {
  let url = row.url;
  let saved: { id: number; path: string } | undefined;
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
        signal: stop
          ? AbortSignal.any([AbortSignal.timeout(120000), stop])
          : AbortSignal.timeout(120000),
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
    // The original is flushed and its name made durable before the row says "saved".
    if (existsSync(target)) {
      rmSync(tmp);
      await flush.file(target);
    } else {
      await flush.file(tmp);
      renameSync(tmp, target);
    }
    // A previous rename may have succeeded before its directory flush failed.
    // Existence alone is never evidence that the name is durable.
    flush.directory(join(archive.dir, "media"));
    if (stop?.aborted) throw new Error("stopped");
    archive.db
      .prepare(
        "UPDATE media SET hash=?,path=?,thumb=NULL,thumb_error=NULL,bytes=?,error=NULL WHERE id=?",
      )
      .run(sha, path, bytes, row.id);
    saved = { id: row.id, path };
  } catch (error) {
    rmSync(tmp, { force: true });
    const message = error instanceof Error ? error.message : "download_failed";
    // Shutdown and disk pressure stop the run without marking the source unavailable.
    if (message.startsWith("disk_reserve") || stop?.aborted) throw error;
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
  // Outside the download's error handling: a preview failure keeps the saved original,
  // and previews retry from it without downloading again.
  if (saved && row.kind === "image") await preview(archive, saved, stop);
}
// Builds the preview from the saved original; no network. Content failures are recorded
// once; storage failures are recorded and retried on the next run. Returns success.
export async function preview(
  archive: Archive,
  row: { id: number; path: string },
  stop?: AbortSignal,
) {
  const source = join(archive.dir, "media", row.path);
  const record = (thumb: string | null, error: string | null) =>
    archive.db
      .prepare("UPDATE media SET thumb=?,thumb_error=? WHERE id=?")
      .run(thumb, error, row.id);
  try {
    if (!statSync(source).isFile()) throw new Error("not a file");
  } catch (error) {
    // The recorded original is gone: download it again rather than report it saved.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      archive.db
        .prepare(
          "UPDATE media SET path=NULL,thumb=NULL,thumb_error=NULL WHERE id=?",
        )
        .run(row.id);
      return false;
    }
    record(null, PREVIEW_STORAGE);
    return false;
  }
  let data: Uint8Array;
  try {
    data = await untilStopped(imaging.render(source), stop);
  } catch (error) {
    if (stop?.aborted) throw error;
    // Memory or I/O trouble while decoding is not the image's fault: retry next run.
    const transient =
      typeof (error as NodeJS.ErrnoException)?.code === "string" ||
      /memory|alloc|EIO|EMFILE|ENFILE|ENOMEM|is missing/i.test(
        String((error as Error)?.message),
      );
    record(null, transient ? PREVIEW_STORAGE : PREVIEW_UNSUPPORTED);
    return false;
  }
  // Named after the content-addressed original, so shared images share one preview.
  const name = row.path + ".webp";
  try {
    await untilStopped(
      imaging.write(join(archive.dir, "thumbs", name), data),
      stop,
    );
  } catch (error) {
    if (stop?.aborted) throw error;
    record(null, PREVIEW_STORAGE);
    return false;
  }
  if (stop?.aborted) throw new Error("stopped");
  record(name, null);
  return true;
}
// Saved images whose preview is missing for a retryable reason: a storage failure, an
// interrupted run, or a failure 1.0.0 discarded without recording.
export function previewsToRetry(archive: Archive, profile = "") {
  return archive.db
    .prepare(
      `SELECT id,path FROM media WHERE kind='image' AND path IS NOT NULL AND thumb IS NULL AND (thumb_error IS NULL OR thumb_error=?) ${profile ? "AND id IN (SELECT media FROM post_media pm JOIN membership m ON m.post=pm.post WHERE m.account=?)" : ""}`,
    )
    .all(PREVIEW_STORAGE, ...(profile ? [profile] : [])) as {
    id: number;
    path: string;
  }[];
}
