import { DatabaseSync, backup } from "node:sqlite";
import { join } from "node:path";
import { renameSync, chmodSync } from "node:fs";
import { syncDirectory } from "./durable.js";
import { createHash, randomBytes } from "node:crypto";
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
type Facets = { blogs: string[]; types: string[] };
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
// Bump with each migration in migrate(); opening never downgrades a newer schema.
export const SCHEMA_VERSION = 1;
export class Archive {
  readonly db: DatabaseSync;
  private generation = 0;
  private facetCache = new Map<string, { at: number; value: Facets }>();
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
    this.migrate();
  }
  // Version 1 (1.0.1): FTS rows are keyed by a stable rowid recorded in fts_doc, so an
  // update deletes by rowid instead of scanning the UNINDEXED id column; previews record
  // failures; media hashes are indexed for deduplicated indexing. Existing rows are kept.
  private migrate() {
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version > SCHEMA_VERSION)
      throw new Error(
        "This vault was created by a newer Tumblr Vault. Upgrade the app to open it.",
      );
    if (version < 1)
      this.transaction(() => {
        const columns = this.db
          .prepare("PRAGMA table_info(media)")
          .all()
          .map((c) => c.name);
        if (!columns.includes("thumb_error"))
          this.db.exec("ALTER TABLE media ADD COLUMN thumb_error TEXT");
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS fts_doc(post TEXT PRIMARY KEY,doc INTEGER NOT NULL UNIQUE); CREATE INDEX IF NOT EXISTS media_hash ON media(hash); PRAGMA user_version=1",
        );
      });
    this.reconcileSearchIndex();
  }
  // Validate associations once on open, not per ingest. Older interrupted writes can
  // reuse a deleted rowid without changing either the count or maximum rowid.
  private reconcileSearchIndex() {
    const fts = this.db
      .prepare("SELECT COUNT(*) n,COALESCE(MAX(id),0) top FROM fts_docsize")
      .get()!;
    const docs = this.db
      .prepare("SELECT COUNT(*) n,COALESCE(MAX(doc),0) top FROM fts_doc")
      .get()!;
    if (
      fts.n === docs.n &&
      fts.top === docs.top &&
      !this.db
        .prepare(
          "SELECT 1 FROM fts_doc d LEFT JOIN fts f ON f.rowid=d.doc WHERE f.id IS NULL OR f.id!=d.post LIMIT 1",
        )
        .get()
    )
      return;
    this.transaction(() => {
      this.db.exec("DELETE FROM fts_doc");
      this.db.exec(
        "DELETE FROM fts WHERE rowid NOT IN (SELECT MAX(rowid) FROM fts GROUP BY id)",
      );
      this.db.exec(
        "INSERT INTO fts_doc(post,doc) SELECT id,rowid FROM fts WHERE id IS NOT NULL",
      );
    });
  }
  // Nested calls join the outer transaction, so a page of records commits once.
  transaction<T>(work: () => T): T {
    const name = "s" + randomBytes(4).toString("hex");
    this.db.exec("SAVEPOINT " + name);
    try {
      const result = work();
      this.db.exec("RELEASE " + name);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO " + name);
      this.db.exec("RELEASE " + name);
      throw error;
    }
  }
  ingest(account: string, role: string, post: Raw) {
    const id = String(post.id_string || post.id);
    if (!id || id === "undefined") throw new Error("Source record has no ID.");
    const e = extract(post);
    this.transaction(() => {
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
      const doc = this.db
        .prepare("SELECT doc FROM fts_doc WHERE post=?")
        .get(id)?.doc as number | undefined;
      if (doc !== undefined)
        this.db.prepare("DELETE FROM fts WHERE rowid=?").run(doc);
      const inserted = this.db
        .prepare("INSERT INTO fts(rowid,id,title,tags,body) VALUES(?,?,?,?,?)")
        .run(doc ?? null, id, e.title, (post.tags || []).join(" "), e.text);
      if (doc === undefined)
        this.db
          .prepare("INSERT INTO fts_doc(post,doc) VALUES(?,?)")
          .run(id, inserted.lastInsertRowid);
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
    });
    this.generation++;
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
    return this.mediaForPosts([id]).get(id) || [];
  }
  private mediaForPosts(ids: string[]) {
    const out = new Map<string, Media[]>();
    for (const m of this.db
      .prepare(
        "SELECT pm.post,m.id,m.kind,m.thumb,m.path,m.bytes,m.error,m.thumb_error FROM post_media pm JOIN media m ON m.id=pm.media WHERE pm.post IN (SELECT value FROM json_each(?)) ORDER BY pm.post,pm.position",
      )
      .iterate(JSON.stringify(ids)) as Iterable<Raw>) {
      const list = out.get(m.post) || [];
      list.push({
        id: m.id,
        kind: m.kind,
        thumb: !!m.thumb,
        saved: !!m.path,
        bytes: m.bytes,
        error: m.error || undefined,
        previewError: m.thumb_error || undefined,
      });
      out.set(m.post, list);
    }
    return out;
  }
  private scope(profile: string) {
    return profile ? "AND account=?" : "";
  }
  // Saved versions of the given lineages, with their actions, in a fixed number of queries.
  private versions(groups: string[], profile = "") {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.id,p.group_id,p.blog,p.timestamp,p.tags,CASE WHEN json_extract(p.raw,'$.reblogged_root_id') IS NULL OR json_extract(p.raw,'$.reblogged_root_id') IN ('',0) THEN 0 ELSE 1 END reblog FROM posts p JOIN membership m ON m.post=p.id WHERE p.group_id IN (SELECT value FROM json_each(?)) ${profile ? "AND m.account=?" : ""} ORDER BY p.timestamp DESC,p.id DESC`,
      )
      .all(JSON.stringify(groups), ...(profile ? [profile] : [])) as Raw[];
    const roles = new Map<string, string[]>();
    for (const m of this.db
      .prepare(
        `SELECT post,role FROM membership WHERE post IN (SELECT value FROM json_each(?)) ${this.scope(profile)} ORDER BY post,role`,
      )
      .iterate(
        JSON.stringify(rows.map((r) => r.id)),
        ...(profile ? [profile] : []),
      ) as Iterable<Raw>)
      roles.set(m.post, [...(roles.get(m.post) || []), String(m.role)]);
    const byGroup = new Map<string, Raw[]>();
    for (const r of rows) {
      r.actions = (roles.get(r.id) || []).map((role) =>
        role === "like"
          ? "Liked"
          : role === "post"
            ? r.reblog
              ? "Reblogged"
              : "Posted"
            : role,
      );
      byGroup.set(r.group_id, [...(byGroup.get(r.group_id) || []), r]);
    }
    return byGroup;
  }
  // Only the selected page is loaded in full; ranking and grouping use compact columns.
  private entries(ids: string[], scores: Map<string, number>, profile = "") {
    if (!ids.length) return [];
    const rows = new Map(
      (
        this.db
          .prepare(
            "SELECT id,group_id,blog,title,body,timestamp,type FROM posts WHERE id IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(ids)) as Raw[]
      ).map((r) => [r.id, r]),
    );
    const versions = this.versions(
      [...new Set([...rows.values()].map((r) => r.group_id))],
      profile,
    );
    const media = this.mediaForPosts(ids);
    return ids
      .filter((id) => rows.has(id))
      .map((id): Entry => {
        const row = rows.get(id)!;
        const group = versions.get(row.group_id) || [];
        return {
          id: row.id,
          groupId: row.group_id,
          blog: row.blog,
          title: row.title,
          text: row.body,
          timestamp: row.timestamp,
          type: row.type,
          tags: [...new Set<string>(group.flatMap((p) => JSON.parse(p.tags)))],
          actions: [...new Set<string>(group.flatMap((p) => p.actions))],
          media: media.get(id) || [],
          versions: group.length,
          score: scores.get(id),
        };
      });
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
    let score = "NULL";
    const q = (params.q || "").trim().slice(0, 1000);
    const text = !!q && params.mode !== "image" && !params.similar;
    if (text) {
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
      score = "bm25(fts,0,5,3,1)";
    }
    if (ranking) {
      from += " JOIN json_each(?) r ON r.key=p.id";
      binds.unshift(JSON.stringify(Object.fromEntries(ranking)));
      score = "r.value";
    }
    // Rank each saved version, keep the best version per lineage, then count and page.
    const order =
      params.sort === "oldest"
        ? "timestamp ASC,id ASC"
        : params.sort === "newest"
          ? "timestamp DESC,id DESC"
          : ranking
            ? "score DESC,timestamp DESC,id DESC"
            : text
              ? "score ASC,timestamp DESC,id DESC"
              : "timestamp DESC,id DESC";
    const candidates = `WITH c AS (SELECT p.id id,p.group_id group_id,p.timestamp timestamp,${score} score FROM ${from} WHERE ${condition})`;
    const total = Number(
      this.db
        .prepare(`${candidates} SELECT COUNT(DISTINCT group_id) n FROM c`)
        .get(...binds)!.n,
    );
    const pages = Math.ceil(total / 24);
    const page = Math.min(
      Math.max(1, Number.parseInt(params.page || "1") || 1),
      Math.max(1, pages),
    );
    const rows = this.db
      .prepare(
        `${candidates}, g AS (SELECT c.*,ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY ${order}) rn FROM c) SELECT id,score FROM g WHERE rn=1 ORDER BY ${order} LIMIT 24 OFFSET ?`,
      )
      .all(...binds, (page - 1) * 24) as Raw[];
    const scores = new Map<string, number>();
    for (const r of rows) if (r.score !== null) scores.set(r.id, r.score);
    return {
      entries: this.entries(
        rows.map((r) => r.id),
        scores,
        params.profile,
      ),
      total,
      page,
      pages,
      ...this.facets(params.profile),
    };
  }
  // Facets change only on ingest; reuse them between searches in this process.
  facets(profile = ""): Facets {
    const cached = this.facetCache.get(profile);
    if (cached?.at === this.generation) return cached.value;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.blog,p.type FROM posts p JOIN membership m ON m.post=p.id ${profile ? "WHERE m.account=?" : ""}`,
      )
      .all(...(profile ? [profile] : [])) as Raw[];
    const value = {
      blogs: [...new Set<string>(rows.map((r) => r.blog))].sort(),
      types: [...new Set<string>(rows.map((r) => r.type))].sort(),
    };
    this.facetCache.set(profile, { at: this.generation, value });
    return value;
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
      this.versions([row.group_id], profile).get(row.group_id) || []
    ).map((r) => ({
      id: r.id,
      blog: r.blog,
      timestamp: r.timestamp,
      actions: r.actions,
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
      ...this.entries([row.id], new Map(), profile)[0],
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
        `SELECT COUNT(*) media,COALESCE(SUM(path IS NOT NULL),0) saved,COALESCE(SUM(error IS NOT NULL),0) unavailable,COALESCE(SUM(embedding IS NOT NULL),0) indexed_count,COALESCE(SUM(thumb_error IS NOT NULL),0) previews,COALESCE(SUM(bytes),0) bytes FROM media WHERE id IN (SELECT media FROM post_media WHERE post IN (${postScope}))`,
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
      previewsFailed: Number(m.previews),
      bytes: Number(m.bytes),
      progress,
    };
  }
  async snapshot() {
    const path = join(this.dir, "exports", "latest.sqlite");
    await backup(this.db, path + ".pending");
    chmodSync(path + ".pending", 0o600);
    renameSync(path + ".pending", path);
    syncDirectory(join(this.dir, "exports"));
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
