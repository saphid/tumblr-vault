import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  copyFileSync,
  existsSync,
  constants,
  realpathSync,
  statfsSync,
} from "node:fs";
import { Configuration } from "./config.js";
import { Archive, type Raw } from "./store.js";
import { lockVault } from "./lock.js";
import {
  sweepTemporary,
  syncDirectory,
  syncFileSync,
  writeDurable,
} from "./durable.js";
import sharp from "sharp";
export interface ImportOptions {
  /** Legacy originals root when it is not <from>/media (legacy TUMBLR_MEDIA_ROOT). */
  mediaFrom?: string;
  /** Legacy previews root when it is not <from>/thumbs. */
  thumbsFrom?: string;
  /** Import even when recorded originals cannot be found. */
  allowMissing?: boolean;
}
// Resolve symlinked parents even when the final destination does not exist yet.
// No directory is created until every physical overlap check has passed.
function physicalPath(value: string): string {
  let ancestor = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
function contains(root: string, path: string) {
  // Windows path comparison is case-insensitive; realpath canonicalizes existing
  // components on macOS, including case-insensitive volumes.
  if (process.platform === "win32") {
    root = root.toLowerCase();
    path = path.toLowerCase();
  }
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}
// Explicit, offline migration: source database opened read-only; credentials are never imported.
export async function importLegacy(
  from: string,
  to: string,
  options: ImportOptions = {},
) {
  const source = physicalPath(from);
  const destination = physicalPath(to);
  const roots = {
    media: physicalPath(options.mediaFrom || join(source, "media")),
    thumbs: physicalPath(options.thumbsFrom || join(source, "thumbs")),
  };
  for (const root of [source, roots.media, roots.thumbs])
    if (contains(root, destination) || contains(destination, root))
      throw new Error(
        "Use separate, non-overlapping source and destination directories.",
      );
  for (const [option, root] of [
    ["--media-from", options.mediaFrom],
    ["--thumbs-from", options.thumbsFrom],
  ])
    if (root && !existsSync(root))
      throw new Error(option + " directory does not exist: " + resolve(root));
  const sourceDb = join(source, "data", "archive.sqlite");
  if (!existsSync(sourceDb))
    throw new Error(
      "Source must contain data/archive.sqlite from the legacy archive.",
    );
  const c = new Configuration(destination);
  if (c.value.demo) throw new Error("Cannot import into a demo vault.");
  const unlock = await lockVault(c.dir);
  sweepTemporary(c.dir);
  const old = new DatabaseSync(sourceDb, { readOnly: true });
  const locate = (kind: "media" | "thumbs", relative: string | null) => {
    if (!relative) return null;
    const origin = resolve(roots[kind], relative);
    return origin.startsWith(roots[kind] + sep) && existsSync(origin)
      ? origin
      : null;
  };
  let db: Archive | undefined;
  try {
    // Count before writing anything, so a wrong originals path fails with nothing to undo.
    let missingOriginals = 0;
    let missingThumbs = 0;
    for (const m of old
      .prepare("SELECT path,thumb FROM media")
      .iterate() as Iterable<Raw>) {
      if (m.path && !locate("media", m.path)) missingOriginals++;
      if (m.thumb && !locate("thumbs", m.thumb)) missingThumbs++;
    }
    if (missingOriginals && !options.allowMissing)
      throw new Error(
        `${missingOriginals} recorded originals were not found under ${roots.media}. ` +
          "If the legacy archive kept originals elsewhere (TUMBLR_MEDIA_ROOT), pass --media-from <that directory>. " +
          "To import anyway and re-download what Tumblr still serves, add --allow-missing. Nothing was imported.",
      );
    db = new Archive(c.dir);
    if (db.db.prepare("SELECT 1 FROM posts LIMIT 1").get())
      throw new Error("Import requires a new empty destination vault.");
    const accounts = old.prepare("SELECT * FROM accounts").all() as Raw[];
    c.value.accounts = accounts.map((a) => ({
      id: a.id,
      label: a.profile,
      username: JSON.parse(a.blogs || "[]")[0] || a.id,
      blogs: JSON.parse(a.blogs || "[]"),
      expectedPosts: a.expected_posts ?? undefined,
      expectedLikes: a.expected_likes ?? undefined,
      lastSync: a.last_sync ?? undefined,
      error:
        "Imported archive. Reconnect this Tumblr account to enable backups.",
    }));
    c.save();
    let records = 0,
      files = 0;
    const archive = db;
    const batch: Raw[] = [];
    // Records commit in batches: one durable write per 500 instead of per record.
    const flush = () =>
      archive.transaction(() => {
        for (const m of batch.splice(0)) {
          const raw = JSON.parse(m.raw);
          if (m.liked_at) raw.liked_timestamp = m.liked_at;
          archive.ingest(m.account, m.role, raw);
          records++;
        }
      });
    for (const m of old
      .prepare(
        "SELECT m.account,m.role,m.liked_at,p.raw FROM membership m JOIN posts p ON p.id=m.post",
      )
      .iterate() as Iterable<Raw>) {
      batch.push(m);
      if (batch.length >= 500) flush();
    }
    flush();
    for (const media of old
      .prepare("SELECT * FROM media")
      .iterate() as Iterable<Raw>) {
      const current = archive.db
        .prepare("SELECT id FROM media WHERE url=?")
        .get(media.url);
      if (!current) continue;
      const copy = async (
        kind: "media" | "thumbs",
        relative: string | null,
        hash: string,
      ) => {
        const origin = locate(kind, relative);
        if (!origin) return null;
        const disk = statfsSync(c.dir);
        if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
          throw new Error(
            "Import stopped at disk reserve. Source is unchanged; remove the incomplete destination before retrying.",
          );
        const name = hash + (kind === "thumbs" ? ".webp" : "");
        const target = join(c.dir, kind, name);
        if (!existsSync(target)) {
          if (kind === "thumbs")
            writeDurable(target, await sharp(origin).webp().toBuffer());
          else {
            copyFileSync(origin, target, constants.COPYFILE_EXCL);
            syncFileSync(target);
          }
        }
        files++;
        return name;
      };
      const key = media.sha256 || String(current.id);
      const path = await copy("media", media.path, key);
      const thumb = await copy("thumbs", media.thumb, key);
      archive.db
        .prepare(
          "UPDATE media SET hash=?,path=?,thumb=?,bytes=?,error=?,embedding=?,model=? WHERE id=?",
        )
        .run(
          media.sha256,
          path,
          thumb,
          path ? media.bytes || 0 : 0,
          media.error,
          thumb ? media.embedding : null,
          thumb ? media.model : null,
          current.id as number,
        );
    }
    syncDirectory(join(c.dir, "media"));
    await archive.snapshot();
    const warnings = [
      "Keep the legacy archive and its originals until you have opened and checked the new vault.",
    ];
    if (missingOriginals)
      warnings.push(
        `${missingOriginals} recorded originals were not found and were not imported. A backup re-downloads them only while Tumblr still serves them.`,
      );
    if (missingThumbs)
      warnings.push(
        `${missingThumbs} recorded previews were not found. The next backup rebuilds previews from imported originals.`,
      );
    return {
      records,
      files,
      profiles: accounts.length,
      missingOriginals,
      missingThumbs,
      warnings,
      message:
        "Source untouched. Open the new vault, set its password, then reconnect accounts for future backups.",
    };
  } finally {
    old.close();
    db?.close();
    await unlock();
  }
}
