import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { copyFileSync, existsSync, constants, statfsSync } from "node:fs";
import { Configuration } from "./config.js";
import { Archive, type Raw } from "./store.js";
import { lockVault } from "./lock.js";
// Explicit, offline migration: source database opened read-only; credentials are never imported.
export async function importLegacy(from: string, to: string) {
  const source = resolve(from);
  const destination = resolve(to);
  if (
    source === destination ||
    source.startsWith(destination + sep) ||
    destination.startsWith(source + sep)
  )
    throw new Error(
      "Use separate, non-overlapping source and destination directories.",
    );
  const c = new Configuration(destination);
  if (c.value.demo) throw new Error("Cannot import into a demo vault.");
  const unlock = lockVault(c.dir);
  const sourceDb = join(source, "data", "archive.sqlite");
  if (!existsSync(sourceDb)) {
    unlock();
    throw new Error(
      "Source must contain data/archive.sqlite from the legacy archive.",
    );
  }
  const old = new DatabaseSync(sourceDb, { readOnly: true });
  const db = new Archive(c.dir);
  try {
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
    for (const m of old
      .prepare(
        "SELECT m.account,m.role,m.liked_at,p.raw FROM membership m JOIN posts p ON p.id=m.post",
      )
      .iterate() as Iterable<Raw>) {
      const raw = JSON.parse(m.raw);
      if (m.liked_at) raw.liked_timestamp = m.liked_at;
      db.ingest(m.account, m.role, raw);
      records++;
    }
    for (const media of old
      .prepare("SELECT * FROM media")
      .iterate() as Iterable<Raw>) {
      const current = db.db
        .prepare("SELECT id FROM media WHERE url=?")
        .get(media.url);
      if (!current) continue;
      const copy = (kind: string, relative: string | null, hash: string) => {
        if (!relative) return null;
        const origin = resolve(source, kind, relative);
        if (
          !origin.startsWith(resolve(source, kind) + sep) ||
          !existsSync(origin)
        )
          return null;
        const disk = statfsSync(c.dir);
        if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
          throw new Error(
            "Import stopped at disk reserve. Source is unchanged; remove the incomplete destination before retrying.",
          );
        const name = hash + (kind === "thumbs" ? ".webp" : "");
        const target = join(c.dir, kind, name);
        if (!existsSync(target))
          copyFileSync(origin, target, constants.COPYFILE_EXCL);
        files++;
        return name;
      };
      const key = media.sha256 || String(current.id);
      const path = copy("media", media.path, key);
      const thumb = copy("thumbs", media.thumb, key);
      db.db
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
    await db.snapshot();
    return {
      records,
      files,
      profiles: accounts.length,
      message:
        "Source untouched. Open the new vault, set its password, then reconnect accounts for future backups.",
    };
  } finally {
    old.close();
    db.close();
    unlock();
  }
}
