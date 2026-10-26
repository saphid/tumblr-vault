import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
import { renameSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import type {
  Detail,
  Entry,
  Media,
  SearchResult,
  Status,
  Progress,
  Profile,
} from "./contract.js";
export type Raw = Record<string, any>;
export function plain(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
export function extract(post: Raw) {
  const text: string[] = [];
  const media: { url: string; kind: string }[] = [];
  const add = (url: unknown, kind = "image") => {
    if (
      typeof url === "string" &&
      /^https?:\/\//.test(url) &&
      !media.some((m) => m.url === url)
    )
      media.push({
        url: url.replace(/^http:\/\/([^/]*\.tumblr\.com)\//, "https://$1/"),
        kind,
      });
  };
  const visit = (p: Raw) => {
    for (const k of [
      "title",
      "body",
      "caption",
      "description",
      "question",
      "answer",
      "text",
      "source",
      "link_text",
    ])
      if (typeof p[k] === "string") {
        text.push(plain(p[k]));
        for (const m of p[k].matchAll(/<img[^>]+src=["']([^"']+)/g)) add(m[1]);
      }
    for (const photo of p.photos || []) add(photo.original_size?.url);
    add(p.video_url, "video");
    add(p.audio_url, "audio");
    if (["image", "video", "audio"].includes(p.type)) {
      const variants = Array.isArray(p.media)
        ? p.media
        : p.media
          ? [p.media]
          : [];
      const v = variants.sort(
        (a: Raw, b: Raw) =>
          (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
      )[0];
      add(v?.url || p.url, p.type);
      add(p.poster?.[0]?.url);
    }
    for (const k of ["content", "trail", "dialogue"])
      for (const child of p[k] || []) visit(child);
  };
  visit(post);
  let type = post.original_type || post.type || "text";
  if (type === "blocks")
    type = media.some((m) => m.kind === "image") ? "photo" : "text";
  const lineage =
    post.reblogged_root_id ||
    post.trail?.find((t: Raw) => t.post?.id)?.post.id ||
    post.id_string ||
    post.id;
  return {
    title: plain(post.title || post.summary || "").slice(0, 240),
    text: text.filter(Boolean).join("\n\n"),
    media,
    type,
    groupId: String(lineage),
  };
}
export class Archive {
  readonly db: DatabaseSync;
  constructor(readonly dir: string) {
    this.db = new DatabaseSync(join(dir, "archive.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
 CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,blog TEXT NOT NULL,timestamp INTEGER NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,url TEXT NOT NULL,raw TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS post_group ON posts(group_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED,title,tags,body);
 CREATE TABLE IF NOT EXISTS membership(account TEXT NOT NULL,post TEXT NOT NULL REFERENCES posts(id),role TEXT NOT NULL,liked_at INTEGER,PRIMARY KEY(account,post,role)); CREATE INDEX IF NOT EXISTS membership_post ON membership(post,account);
 CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY,url TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,hash TEXT,path TEXT,thumb TEXT,bytes INTEGER DEFAULT 0,error TEXT,embedding BLOB,model TEXT);
 CREATE TABLE IF NOT EXISTS post_media(post TEXT NOT NULL REFERENCES posts(id),media INTEGER NOT NULL REFERENCES media(id),position INTEGER,PRIMARY KEY(post,media)); CREATE INDEX IF NOT EXISTS media_posts ON post_media(media,post);
 CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  ingest(account: string, role: string, post: Raw) {
    const id = String(post.id_string || post.id);
    if (!id || id === "undefined") throw new Error("Source record has no ID.");
    const e = extract(post);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,blog=excluded.blog,timestamp=excluded.timestamp,type=excluded.type,title=excluded.title,body=excluded.body,tags=excluded.tags,url=excluded.url,raw=excluded.raw",
        )
        .run(
          id,
          e.groupId,
          post.blog_name || post.blog?.name || "unknown",
          post.timestamp || 0,
          e.type,
          e.title,
          e.text,
          JSON.stringify(post.tags || []),
          post.post_url || "",
          JSON.stringify(post),
        );
      this.db.prepare("DELETE FROM fts WHERE id=?").run(id);
      this.db
        .prepare("INSERT INTO fts VALUES(?,?,?,?)")
        .run(id, e.title, (post.tags || []).join(" "), e.text);
      this.db
        .prepare("INSERT OR REPLACE INTO membership VALUES(?,?,?,?)")
        .run(account, id, role, post.liked_timestamp || null);
      this.db.prepare("DELETE FROM post_media WHERE post=?").run(id);
      e.media.forEach((m, i) => {
        this.db
          .prepare("INSERT OR IGNORE INTO media(url,kind) VALUES(?,?)")
          .run(m.url, m.kind);
        const row = this.db
          .prepare("SELECT id FROM media WHERE url=?")
          .get(m.url)!;
        this.db
          .prepare("INSERT INTO post_media VALUES(?,?,?)")
          .run(id, row.id as number, i);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return id;
  }
  state(key: string, value?: unknown): any {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO state VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const row = this.db.prepare("SELECT value FROM state WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  checkpoint(key: string, value?: unknown): any {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO checkpoints VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const r = this.db
      .prepare("SELECT value FROM checkpoints WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.value)) : undefined;
  }
  media(id: string): Raw | undefined {
    return this.db.prepare("SELECT * FROM media WHERE id=?").get(id);
  }
  mediaFor(id: string): Media[] {
    return (
      this.db
        .prepare(
          "SELECT m.* FROM media m JOIN post_media pm ON pm.media=m.id WHERE pm.post=? ORDER BY pm.position",
        )
        .all(id) as Raw[]
    ).map((m) => ({
      id: m.id,
      kind: m.kind,
      thumb: !!m.thumb,
      saved: !!m.path,
      bytes: m.bytes,
      error: m.error || undefined,
    }));
  }
  private scope(profile: string) {
    return profile ? "AND account=?" : "";
  }
  private entry(row: Raw, profile = ""): Entry {
    const versions = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM posts p JOIN membership m ON m.post=p.id WHERE p.group_id=? ${profile ? "AND m.account=?" : ""}`,
      )
      .all(...[row.group_id, ...(profile ? [profile] : [])]) as Raw[];
    const ids = versions.map((p) => p.id);
    const actions = new Set<string>();
    for (const id of ids)
      for (const m of this.db
        .prepare(
          `SELECT role FROM membership WHERE post=? ${this.scope(profile)}`,
        )
        .all(...[id, ...(profile ? [profile] : [])]))
        actions.add(
          m.role === "like"
            ? "Liked"
            : m.role === "post"
              ? JSON.parse(String(versions.find((p) => p.id === id)!.raw))
                  .reblogged_root_id
                ? "Reblogged"
                : "Posted"
              : String(m.role),
        );
    return {
      id: row.id,
      groupId: row.group_id,
      blog: row.blog,
      title: row.title,
      text: row.body,
      timestamp: row.timestamp,
      type: row.type,
      tags: [...new Set<string>(versions.flatMap((p) => JSON.parse(p.tags)))],
      actions: [...actions],
      media: this.mediaFor(row.id),
      versions: ids.length,
      score: row.score,
    };
  }
  filter(params: Record<string, string>) {
    const where: string[] = ["1=1"];
    const binds: any[] = [];
    const membership = ["m.post=p.id"];
    if (params.profile) {
      membership.push("m.account=?");
      binds.push(params.profile);
    }
    if (params.role) {
      if (!["post", "like"].includes(params.role))
        throw new Error("Unknown collection.");
      membership.push("m.role=?");
      binds.push(params.role);
    }
    for (const [key, op] of [
      ["likedAfter", ">="],
      ["likedBefore", "<"],
    ] as const) {
      if (params[key]) {
        membership.push("m.liked_at " + op + " ?");
        binds.push(day(params[key], key === "likedBefore"));
      }
    }
    where.push(
      "EXISTS(SELECT 1 FROM membership m WHERE " +
        membership.join(" AND ") +
        ")",
    );
    for (const key of ["blog", "type"])
      if (params[key]) {
        where.push("p." + key + "=?");
        binds.push(params[key]);
      }
    if (params.tag) {
      where.push("EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)");
      binds.push(params.tag);
    }
    for (const [key, op] of [
      ["after", ">="],
      ["before", "<"],
    ] as const)
      if (params[key]) {
        where.push("p.timestamp " + op + " ?");
        binds.push(day(params[key], key === "before"));
      }
    for (const [a, b] of [
      ["after", "before"],
      ["likedAfter", "likedBefore"],
    ])
      if (params[a] && params[b] && params[a] > params[b])
        throw new Error("The start date must be on or before the end date.");
    return { where: where.join(" AND "), binds };
  }
  search(
    params: Record<string, string>,
    ranking?: Map<string, number>,
  ): SearchResult {
    const { where, binds } = this.filter(params);
    let from = "posts p";
    let condition = where;
    let select = "p.*";
    const q = (params.q || "").trim().slice(0, 1000);
    if (q && params.mode !== "image" && !params.similar) {
      const words = q.match(/[\p{L}\p{N}_]+/gu) || [];
      if (!words.length)
        return {
          entries: [],
          total: 0,
          page: 1,
          pages: 0,
          ...this.facets(params.profile),
        };
      const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
      const expression =
        params.match === "phrase"
          ? quote(words.join(" "))
          : words.map(quote).join(params.match === "any" ? " OR " : " AND ");
      from += " JOIN fts ON fts.id=p.id";
      condition += " AND fts MATCH ?";
      binds.push(expression);
      select += ",bm25(fts,0,5,3,1) score";
    }
    // Ranking happens per saved version before grouping, then count/pagination.
    const rows = this.db
      .prepare(`SELECT ${select} FROM ${from} WHERE ${condition}`)
      .all(...binds) as Raw[];
    const filtered: Raw[] = ranking
      ? rows
          .filter((r) => ranking.has(r.id))
          .map((r) => ({ ...r, score: ranking.get(r.id) }))
      : rows;
    const relevant = (a: Raw, b: Raw) =>
      ranking
        ? (b.score ?? 0) - (a.score ?? 0)
        : (a.score ?? 0) - (b.score ?? 0);
    filtered.sort((a, b) =>
      params.sort === "oldest"
        ? a.timestamp - b.timestamp || a.id.localeCompare(b.id)
        : params.sort === "newest"
          ? b.timestamp - a.timestamp || b.id.localeCompare(a.id)
          : relevant(a, b) ||
            b.timestamp - a.timestamp ||
            b.id.localeCompare(a.id),
    );
    const groups = new Map<string, Raw>();
    for (const r of filtered)
      if (!groups.has(r.group_id)) groups.set(r.group_id, r);
    const all = [...groups.values()];
    const pages = Math.ceil(all.length / 24);
    const page = Math.min(
      Math.max(1, Number.parseInt(params.page || "1") || 1),
      Math.max(1, pages),
    );
    return {
      entries: all
        .slice((page - 1) * 24, page * 24)
        .map((r) => this.entry(r, params.profile)),
      total: all.length,
      page,
      pages,
      ...this.facets(params.profile),
    };
  }
  facets(profile = "") {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.blog,p.type FROM posts p JOIN membership m ON m.post=p.id ${profile ? "WHERE m.account=?" : ""}`,
      )
      .all(...(profile ? [profile] : [])) as Raw[];
    return {
      blogs: [...new Set<string>(rows.map((r) => r.blog))].sort(),
      types: [...new Set<string>(rows.map((r) => r.type))].sort(),
    };
  }
  detail(id: string, profile = ""): Detail | undefined {
    const row = this.db
      .prepare(
        `SELECT p.* FROM posts p WHERE p.id=? AND EXISTS(SELECT 1 FROM membership m WHERE m.post=p.id ${this.scope(profile)})`,
      )
      .get(...[id, ...(profile ? [profile] : [])]) as Raw | undefined;
    if (!row) return;
    const raw = JSON.parse(row.raw);
    const savedVersions = (
      this.db
        .prepare(
          `SELECT DISTINCT p.* FROM posts p JOIN membership m ON p.id=m.post WHERE p.group_id=? ${profile ? "AND m.account=?" : ""} ORDER BY timestamp DESC`,
        )
        .all(...[row.group_id, ...(profile ? [profile] : [])]) as Raw[]
    ).map((r) => ({
      id: r.id,
      blog: r.blog,
      timestamp: r.timestamp,
      actions: this.entry(r, profile).actions,
    }));
    const blocks = (raw.trail || []).map((t: Raw) => ({
      author: t.blog?.name || "Unavailable author",
      text: extract(t).text,
    }));
    if (raw.content)
      blocks.push({
        author: row.blog,
        text: extract({ content: raw.content }).text,
      });
    return {
      ...this.entry(row, profile),
      raw,
      url: row.url,
      blocks,
      savedVersions,
    };
  }
  status(profiles: Profile[], progress: Progress, profile = ""): Status {
    const p = profile ? [profile] : [];
    const postScope = `SELECT DISTINCT post FROM membership ${profile ? "WHERE account=?" : ""}`;
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) records,COUNT(DISTINCT group_id) entries FROM posts WHERE id IN (${postScope})`,
      )
      .get(...p)!;
    const m = this.db
      .prepare(
        `SELECT COUNT(*) media,COALESCE(SUM(path IS NOT NULL),0) saved,COALESCE(SUM(error IS NOT NULL),0) unavailable,COALESCE(SUM(embedding IS NOT NULL),0) indexed_count,COALESCE(SUM(bytes),0) bytes FROM media WHERE id IN (SELECT media FROM post_media WHERE post IN (${postScope}))`,
      )
      .get(...p)!;
    return {
      profiles: profiles.filter((a) => !profile || a.id === profile),
      entries: Number(counts.entries),
      records: Number(counts.records),
      media: Number(m.media),
      saved: Number(m.saved),
      unavailable: Number(m.unavailable),
      indexed: Number(m.indexed_count),
      bytes: Number(m.bytes),
      progress,
    };
  }
  async snapshot() {
    const path = join(this.dir, "exports", "latest.sqlite");
    await backup(this.db, path + ".pending");
    chmodSync(path + ".pending", 0o600);
    renameSync(path + ".pending", path);
    return path;
  }
  close() {
    this.db.close();
  }
}
function day(value: string, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Use dates in YYYY-MM-DD format.");
  const d = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== value)
    throw new Error("Enter a valid calendar date.");
  return Math.floor(d.valueOf() / 1000) + (end ? 86400 : 0);
}
export function mediaHash(url: string) {
  return createHash("sha256").update(url).digest("hex");
}
