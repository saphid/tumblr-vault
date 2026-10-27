import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { Archive, extract } from "../src/store.js";
import { Configuration, checkPassword, hashPassword } from "../src/config.js";
import { validateToken, rateDelay, Tumblr } from "../src/tumblr.js";
import { allowedMedia, download } from "../src/media.js";
import { normalized } from "../src/ml.js";
const temp = () => mkdtempSync(join(tmpdir(), "tumblr-vault-test-"));
const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id_string: id,
  blog_name: "synthetic",
  timestamp: Date.parse("2026-01-15T12:00:00Z") / 1000,
  type: "text",
  title: "Saved thought",
  body: "A small, quiet thought.",
  tags: ["quiet"],
  ...extra,
});
function fixture() {
  const dir = temp();
  const c = new Configuration(dir);
  const db = new Archive(dir);
  return {
    dir,
    c,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("group lineage before pagination; combine actions but never merge shared images", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 31; i++) {
      f.db.ingest("a", "like", post(String(i)));
      f.db.ingest(
        "a",
        "post",
        post("r" + i, { reblogged_root_id: String(i), tags: ["reblog"] }),
      );
    }
    const result = f.db.search({ profile: "a" });
    assert.equal(result.total, 31);
    assert.equal(result.entries.length, 24);
    assert.equal(f.db.search({ profile: "a", page: "2" }).entries.length, 7);
    assert.deepEqual(
      new Set(result.entries[0].actions),
      new Set(["Liked", "Reblogged"]),
    );
    assert(result.entries[0].tags.includes("reblog"));
    assert.equal(f.db.detail("r0", "a")!.savedVersions.length, 2);
    f.db.ingest(
      "b",
      "post",
      post("other", {
        photos: [
          { original_size: { url: "https://64.media.tumblr.com/shared.jpg" } },
        ],
      }),
    );
    assert.equal(f.db.search({ profile: "a" }).total, 31);
    assert.equal(f.db.detail("other", "a"), undefined);
  } finally {
    f.close();
  }
});
test("BM25 weights title, then tags, then body; literal safe all/any/phrase modes", () => {
  const f = fixture();
  try {
    f.db.ingest(
      "a",
      "post",
      post("body", { title: "One", body: "wonder keeps me here", tags: [] }),
    );
    f.db.ingest(
      "a",
      "post",
      post("tag", { title: "Two", body: "ordinary notes", tags: ["wonder"] }),
    );
    f.db.ingest(
      "a",
      "post",
      post("title", { title: "wonder", body: "ordinary notes", tags: [] }),
    );
    assert.deepEqual(
      f.db.search({ q: "wonder" }).entries.map((e) => e.id),
      ["title", "tag", "body"],
    );
    assert.equal(f.db.search({ q: "wonder absent", match: "all" }).total, 0);
    assert.equal(f.db.search({ q: "wonder absent", match: "any" }).total, 3);
    assert.equal(f.db.search({ q: "keeps me", match: "phrase" }).total, 1);
    assert.equal(f.db.search({ q: '" OR * - :' }).total, 0);
  } finally {
    f.close();
  }
});
test("published/liked dates include complete UTC days, reject reversal and nonexistent dates", () => {
  const f = fixture();
  try {
    for (const [id, date] of [
      ["start", "2026-01-15T00:00:00Z"],
      ["end", "2026-01-15T23:59:59Z"],
      ["next", "2026-01-16T00:00:00Z"],
    ])
      f.db.ingest(
        "a",
        "like",
        post(id, {
          timestamp: Date.parse(date) / 1000,
          liked_timestamp: Date.parse(date) / 1000,
        }),
      );
    assert.equal(
      f.db.search({ after: "2026-01-15", before: "2026-01-15" }).total,
      2,
    );
    assert.equal(
      f.db.search({ likedAfter: "2026-01-15", likedBefore: "2026-01-15" })
        .total,
      2,
    );
    assert.throws(() => f.db.search({ after: "2026-02-30" }), /valid calendar/);
    assert.throws(
      () => f.db.search({ after: "2026-02-01", before: "2026-01-01" }),
      /start date/,
    );
  } finally {
    f.close();
  }
});
test("profile facets and coverage exclude other profile and count shared media once", () => {
  const f = fixture();
  try {
    const photo = {
      photos: [
        { original_size: { url: "https://64.media.tumblr.com/shared.jpg" } },
      ],
    };
    f.db.ingest("a", "post", post("1", photo));
    f.db.ingest("a", "like", post("2", photo));
    f.db.ingest(
      "b",
      "post",
      post("3", { blog_name: "other-blog", type: "video" }),
    );
    f.db.db.prepare("UPDATE media SET bytes=200,path=?").run("synthetic");
    const s = f.db.status(
      [],
      { state: "idle", stage: "ready", message: "", processed: 0 },
      "a",
    );
    assert.equal(s.media, 1);
    assert.equal(s.bytes, 200);
    assert.deepEqual(f.db.facets("a").blogs, ["synthetic"]);
    assert(!f.db.facets("a").types.includes("video"));
  } finally {
    f.close();
  }
});
test("checkpoint and raw source survive restart; consistent snapshot quick_check", async () => {
  const dir = temp();
  try {
    new Configuration(dir);
    let db = new Archive(dir);
    db.ingest(
      "a",
      "like",
      post("1", {
        content: [{ type: "text", text: "Readable block" }],
        liked_timestamp: 123,
      }),
    );
    db.checkpoint("a:likes", { before: 456 });
    await db.snapshot();
    db.close();
    db = new Archive(dir);
    assert.deepEqual(db.checkpoint("a:likes"), { before: 456 });
    assert.equal((db.detail("1")!.raw as any).liked_timestamp, 123);
    assert.equal(db.db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
    assert(statSync(join(dir, "exports", "latest.sqlite")).size > 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("untrusted source is rendered as text, NPF images pick largest variants", () => {
  const e = extract(
    post("1", {
      body: "<script>malicious()</script><p>safe</p>",
      content: [
        {
          type: "image",
          media: [
            {
              url: "https://64.media.tumblr.com/small.jpg",
              width: 10,
              height: 10,
            },
            {
              url: "https://64.media.tumblr.com/large.jpg",
              width: 100,
              height: 100,
            },
          ],
        },
      ],
    }),
  );
  assert(!e.text.includes("<script>"));
  assert(e.media.some((m) => m.url.endsWith("large.jpg")));
  assert(!e.media.some((m) => m.url.endsWith("small.jpg")));
});
test("download URLs restrict scheme, host, credentials, port and redirect hops", async () => {
  assert(allowedMedia("https://64.media.tumblr.com/a.jpg"));
  for (const u of [
    "http://64.media.tumblr.com/a",
    "https://tumblr.com.evil.test/a",
    "https://evil.test/a",
    "https://user@tumblr.com/a",
    "https://tumblr.com:123/a",
    "file:///etc/passwd",
  ])
    assert(!allowedMedia(u), u);
  const f = fixture();
  const original = globalThis.fetch;
  try {
    f.db.ingest(
      "a",
      "post",
      post("1", {
        photos: [
          { original_size: { url: "https://64.media.tumblr.com/a.jpg" } },
        ],
      }),
    );
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    };
    const row = f.db.db.prepare("SELECT * FROM media").get()!;
    await download(f.db, row);
    assert.equal(calls, 1);
    assert.equal(f.db.media(String(row.id))!.error, "external_host");
    assert.equal(f.db.media(String(row.id))!.path, null);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("OAuth scopes exact, passwords salted, credentials private and never in public settings", () => {
  const f = fixture();
  try {
    const valid = {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 3600,
      scope: "basic offline_access",
      obtained: 0,
    };
    validateToken(valid);
    assert.throws(() =>
      validateToken({ ...valid, scope: "basic write offline_access" }),
    );
    const hash = hashPassword("synthetic password");
    assert(checkPassword("synthetic password", hash));
    assert(!checkPassword("incorrect", hash));
    f.c.configure(
      {
        password: "synthetic password",
        clientId: "synthetic-key",
        clientSecret: "synthetic-secret",
      },
      true,
    );
    assert(
      !JSON.stringify(f.c.public("http://localhost:4318")).includes(
        "synthetic-secret",
      ),
    );
    if (process.platform !== "win32")
      assert.equal(statSync(join(f.dir, "config.json")).mode & 0o777, 0o600);
    assert.notEqual(hashPassword("synthetic password"), hash);
  } finally {
    f.close();
  }
});
test("OAuth refresh serialized with rotation saved; safe read retries honor quota reset", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    f.c.configure(
      {
        password: "synthetic password",
        clientId: "key",
        clientSecret: "secret",
      },
      true,
    );
    const a = {
      id: "a",
      label: "Synthetic",
      username: "x",
      blogs: [],
      token: {
        access_token: "old",
        refresh_token: "old-refresh",
        expires_in: 1,
        obtained: 0,
        scope: "basic offline_access",
      },
    };
    f.c.value.accounts.push(a);
    let count = 0;
    globalThis.fetch = async () => {
      count++;
      await new Promise((r) => setTimeout(r, 5));
      return Response.json({
        access_token: "new",
        refresh_token: "rotated",
        expires_in: 3600,
        scope: "basic offline_access",
      });
    };
    const client = new Tumblr(f.c);
    const values = await Promise.all([client.access(a), client.access(a)]);
    assert.deepEqual(values, ["new", "new"]);
    assert.equal(count, 1);
    assert.equal(a.token.refresh_token, "rotated");
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, "config.json"), "utf8")).accounts[0]
        .token.refresh_token,
      "rotated",
    );
    assert.equal(
      rateDelay(
        new Headers({
          "Retry-After": "2",
          "X-Ratelimit-Perhour-Remaining": "0",
          "X-Ratelimit-Perhour-Reset": "123",
        }),
      ),
      124,
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("CLIP validates 512 dimensions, finite normalized vectors and nonzero norm", () => {
  const n = normalized(Array(512).fill(1));
  assert(Math.abs(n.reduce((s, v) => s + v * v, 0) - 1) < 1e-6);
  assert.deepEqual(n, normalized(JSON.stringify(Array(512).fill(1))));
  for (const value of [[], Array(512).fill(0), Array(512).fill(Infinity)])
    assert.throws(() => normalized(value));
});
test("setup, unlock, origin protection, no credential disclosure, scoped errors and durable sessions", async () => {
  const dir = temp();
  const app = await buildApp({ dataDir: dir, demo: true });
  const h = {
    host: "localhost:4318",
    "x-vault-request": "1",
    origin: "http://localhost:4318",
  };
  try {
    assert.equal(
      (await app.inject({ url: "/health", headers: h })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/search", headers: h })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup",
          headers: { host: "localhost:4318" },
          payload: { password: "synthetic password" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup",
          headers: { ...h, origin: "https://evil.test" },
          payload: { password: "synthetic password" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/session",
          headers: { host: "evil.test" },
        })
      ).statusCode,
      403,
    );
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: h,
      payload: {
        password: "synthetic password",
        clip: "off",
        scheduleHours: 0,
      },
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const cookie = setup.cookies[0].name + "=" + setup.cookies[0].value;
    const auth = { ...h, cookie };
    assert.equal(
      (await app.inject({ url: "/api/search", headers: auth })).json().total,
      8,
    );
    assert.equal(
      (await app.inject({ url: "/api/posts/nonexistent", headers: auth }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/search?after=2026-02-01&before=2026-01-01",
          headers: auth,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/search?mode=image&q=forest",
          headers: auth,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/search?similar=1&profile=demo-studio",
          headers: auth,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/setup",
          headers: auth,
          payload: { password: "override password" },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/logout",
          headers: auth,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/search", headers: auth })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: h,
          payload: { password: "wrong" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: h,
          payload: { password: "synthetic password" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/setup", headers: h })).json().profiles
        .length,
      0,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pagination follows short intermediate href pages, checkpoints and rejects duplicate active runs", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    f.c.value.accounts = [
      {
        id: "a",
        label: "Synthetic",
        username: "synthetic",
        blogs: [],
        token: {
          access_token: "synthetic",
          refresh_token: "synthetic",
          expires_in: 3600,
          scope: "basic offline_access",
          obtained: Date.now(),
        },
      },
    ];
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    const pages: Record<string, unknown>[] = [];
    sync.api.get = async (_a, path, params = {}) => {
      pages.push(params);
      if (path === "/user/info") return { user: { blogs: [], likes: 2 } };
      if (!params.before)
        return {
          liked_posts: [post("1", { liked_timestamp: 100 })],
          _links: { next: { href: "/v2/user/likes?before=100&limit=20" } },
        };
      return { liked_posts: [post("2", { liked_timestamp: 90 })] };
    };
    sync.start("a");
    assert.throws(() => sync.start("a"), /already in progress/);
    await sync.active;
    assert.equal(sync.progress.state, "complete");
    assert.equal(f.db.search({ profile: "a" }).total, 2);
    assert.equal(pages.at(-1)!.before, "100");
    assert.deepEqual(f.db.checkpoint("a:likes"), { done: true });
  } finally {
    f.close();
  }
});

test("instance lock refuses concurrent users and releases only its own lock", async () => {
  const f = fixture();
  try {
    const { lockVault } = await import("../src/lock.js");
    const release = await lockVault(f.dir);
    await assert.rejects(() => lockVault(f.dir, false), /already open/);
    await release();
    await (
      await lockVault(f.dir)
    )();
  } finally {
    f.close();
  }
});

test("legacy import is offline, preserves source/raw/media and leaves source unchanged", async () => {
  const { default: sharp } = await import("sharp");
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { importLegacy } = await import("../src/import.js");
  const src = temp();
  const dest = temp();
  try {
    mkdirSync(join(src, "data"));
    mkdirSync(join(src, "media"));
    mkdirSync(join(src, "thumbs"));
    const old = new DatabaseSync(join(src, "data", "archive.sqlite"));
    old.exec(
      "CREATE TABLE accounts(id,profile,blogs,expected_posts,expected_likes,last_sync);CREATE TABLE posts(id,raw);CREATE TABLE membership(account,post,role,liked_at);CREATE TABLE media(url,kind,sha256,path,thumb,bytes,error,embedding,model)",
    );
    old
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run("a", "Imported synthetic", '["synthetic"]', 1, 1, null);
    const raw = JSON.stringify(
      post("1", {
        photos: [
          { original_size: { url: "https://64.media.tumblr.com/import.jpg" } },
        ],
      }),
    );
    old.prepare("INSERT INTO posts VALUES(?,?)").run("1", raw);
    old
      .prepare("INSERT INTO membership VALUES(?,?,?,?)")
      .run("a", "1", "like", 123);
    old
      .prepare("INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        "https://64.media.tumblr.com/import.jpg",
        "image",
        "abc",
        "abc",
        "legacy.jpg",
        3,
        null,
        null,
        null,
      );
    writeFileSync(join(src, "media", "abc"), "abc");
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#554466" },
    })
      .jpeg()
      .toFile(join(src, "thumbs", "legacy.jpg"));
    old.close();
    const sourceBytes = readFileSync(join(src, "data", "archive.sqlite"));
    const result = await importLegacy(src, dest);
    assert.equal(result.records, 1);
    assert.deepEqual(
      sourceBytes,
      readFileSync(join(src, "data", "archive.sqlite")),
    );
    const db = new Archive(dest);
    assert.equal(db.search({ profile: "a" }).total, 1);
    assert.equal(db.detail("1")!.media[0].saved, true);
    assert.equal(db.detail("1")!.media[0].bytes, 3);
    assert.equal(
      (await sharp(readFileSync(join(dest, "thumbs", "abc.webp"))).metadata())
        .format,
      "webp",
    );
    db.close();
    assert(!new Configuration(dest).value.accounts[0].token);
    await assert.rejects(() => importLegacy(src, src));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("OAuth callback state is random, read-only, bound to an active session and consumed once", async () => {
  const dir = temp();
  const app = await buildApp({ dataDir: dir });
  const h = {
    host: "localhost:4318",
    "x-vault-request": "1",
    origin: "http://localhost:4318",
  };
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: h,
      payload: {
        password: "synthetic password",
        clientId: "synthetic-app-key",
        clientSecret: "synthetic-app-secret",
        scheduleHours: 0,
      },
    });
    const cookie = setup.cookies[0].name + "=" + setup.cookies[0].value;
    const auth = { ...h, cookie };
    const r = await app.inject({
      method: "POST",
      url: "/api/oauth/start",
      headers: auth,
      payload: { label: "Synthetic" },
    });
    assert.equal(r.statusCode, 200);
    const url = new URL(r.json().url);
    assert.equal(url.origin, "https://www.tumblr.com");
    assert.equal(url.searchParams.get("scope"), "basic offline_access");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "http://localhost:4318/oauth/callback",
    );
    const state = url.searchParams.get("state")!;
    assert.equal(state.length, 64);
    assert(!url.toString().includes("synthetic-app-secret"));
    assert.equal(
      (
        await app.inject({
          url: "/oauth/callback?state=" + state + "&error=access_denied",
          headers: h,
        })
      ).statusCode,
      302,
    );
    assert.equal(
      (
        await app.inject({
          url: "/oauth/callback?state=" + state + "&code=synthetic-code",
          headers: h,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: "/%61pi/search", headers: h })).statusCode,
      400,
    );
    const changed = await app.inject({
      method: "POST",
      url: "/api/settings",
      headers: auth,
      payload: {
        password: "replacement synthetic password",
        currentPassword: "synthetic password",
      },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/search", headers: auth })).statusCode,
      401,
    );
    assert(!changed.body.includes("synthetic-app-secret"));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health works through a local container probe with an external base URL; private routes retain Host guard", async () => {
  const dir = temp();
  const app = await buildApp({
    dataDir: dir,
    baseUrl: "https://vault.example.test",
  });
  try {
    assert.equal(
      (
        await app.inject({
          url: "/health",
          headers: { host: "127.0.0.1:4318" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/setup",
          headers: { host: "127.0.0.1:4318" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/setup",
          headers: { host: "vault.example.test" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const syntheticAccount = () => ({
  id: "a",
  label: "Synthetic",
  username: "synthetic",
  blogs: [],
  token: {
    access_token: "synthetic",
    refresh_token: "synthetic",
    expires_in: 3600,
    scope: "basic offline_access",
    obtained: Date.now(),
  },
});
test("scheduled backups compare the last backup start and support intervals beyond timer limits", async () => {
  const { backupDue } = await import("../src/sync.js");
  const now = Date.parse("2026-03-01T00:00:00Z");
  assert.equal(backupDue(undefined, 24, now), true);
  assert.equal(backupDue("2026-02-28T01:00:00Z", 24, now), false);
  assert.equal(backupDue("2026-02-28T00:00:00Z", 24, now), true);
  assert.equal(backupDue("2026-02-01T00:00:00Z", 720, now), false);
  assert.equal(backupDue("2026-01-01T00:00:00Z", 720, now), true);
  assert.equal(backupDue(undefined, 0, now), false);
});
test("shutdown interrupts a quota wait, keeps the page checkpoint and the next run resumes it", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    f.c.value.accounts = [syntheticAccount()];
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    const calls: Record<string, unknown>[] = [];
    sync.api.get = async (_a, path, params = {}) => {
      if (path === "/user/info") return { user: { blogs: [{ name: "b" }] } };
      calls.push({ path, ...params });
      if (path.endsWith("/posts") && !params.offset)
        return {
          posts: Array.from({ length: 20 }, (_, i) => post("p" + i)),
          _links: { next: { href: "/v2/blog/b/posts?offset=20" } },
        };
      await sync.api.wait(3600);
      return { posts: [] };
    };
    sync.start("a");
    while (sync.progress.state !== "waiting")
      await new Promise((r) => setTimeout(r, 2));
    const began = Date.now();
    await sync.stop();
    assert.ok(Date.now() - began < 1000);
    assert.equal(sync.progress.state, "partial");
    assert.match(sync.progress.message, /resume/);
    assert.equal(sync.progress.resumeAt, undefined);
    assert.deepEqual(f.db.checkpoint("a:posts:b"), { offset: "20" });
    assert.equal(f.c.value.accounts[0].error, undefined);
    const resumed = new Sync(f.c, f.db, new Clip(f.c, f.db));
    const seen: Record<string, unknown>[] = [];
    resumed.api.get = async (_a, path, params = {}) => {
      if (path === "/user/info") return { user: { blogs: [{ name: "b" }] } };
      seen.push({ path, ...params });
      return { posts: [], liked_posts: [] };
    };
    resumed.start("a");
    await resumed.active;
    assert.equal(resumed.progress.state, "complete");
    assert.equal(seen[0].offset, "20");
    assert.equal(f.db.search({ profile: "a" }).total, 20);
  } finally {
    f.close();
  }
});
test("backup failures explain operator-facing causes on progress and account, never raw internals", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    f.c.value.accounts = [syntheticAccount()];
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    sync.api.get = async () => {
      throw new Error("Tumblr read failed (HTTP 403). Retry the backup later.");
    };
    sync.start("a");
    await sync.active;
    assert.equal(sync.progress.state, "failed");
    assert.match(sync.progress.message, /HTTP 403/);
    assert.match(sync.progress.message, /retained/);
    assert.match(f.c.value.accounts[0].error!, /HTTP 403/);
    sync.api.get = async () => {
      throw new Error("connect ECONNRESET 10.0.0.1 token=synthetic-secret");
    };
    sync.start("a");
    await sync.active;
    assert.equal(sync.progress.state, "failed");
    assert.doesNotMatch(sync.progress.message, /ECONNRESET|secret/);
    assert.doesNotMatch(f.c.value.accounts[0].error!, /ECONNRESET|secret/);
    assert.doesNotMatch(
      readFileSync(join(f.dir, "config.json"), "utf8"),
      /ECONNRESET/,
    );
  } finally {
    f.close();
  }
});
test("image indexing skips an isolated unreadable image but stops when the model service keeps failing", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const { writeFileSync } = await import("node:fs");
    const { Clip, IMMICH_MODEL } = await import("../src/ml.js");
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    for (let i = 0; i < 4; i++) {
      f.db.ingest(
        "a",
        "like",
        post(String(i), {
          photos: [
            {
              original_size: {
                url: `https://64.media.tumblr.com/synthetic-${i}.png`,
              },
            },
          ],
        }),
      );
      writeFileSync(join(f.dir, "thumbs", `t${i}.webp`), "synthetic");
      f.db.db
        .prepare("UPDATE media SET hash=?,path=?,thumb=? WHERE url=?")
        .run(
          "h" + i,
          "h" + i,
          `t${i}.webp`,
          `https://64.media.tumblr.com/synthetic-${i}.png`,
        );
    }
    let calls = 0;
    const vector = JSON.stringify(Array.from({ length: 512 }, () => 1));
    globalThis.fetch = async () =>
      ++calls === 2
        ? new Response("unreadable", { status: 422 })
        : Response.json({ clip: vector });
    const clip = new Clip(f.c, f.db);
    assert.equal(await clip.index(() => {}), 3);
    const indexed = (model: string) =>
      Number(
        f.db.db
          .prepare("SELECT COUNT(*) n FROM media WHERE model=?")
          .get(model)!.n,
      );
    assert.equal(indexed(IMMICH_MODEL), 3);
    f.db.db.exec("UPDATE media SET embedding=NULL,model=NULL");
    globalThis.fetch = async () => new Response("down", { status: 503 });
    await assert.rejects(
      clip.index(() => {}),
      /unavailable \(HTTP 503\)/,
    );
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(
      clip.index(() => {}),
      /unreachable/,
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
function indexedImages(f: ReturnType<typeof fixture>, count: number) {
  for (let i = 0; i < count; i++) {
    const url = `https://64.media.tumblr.com/synthetic-q${i}.png`;
    f.db.ingest(
      "a",
      "like",
      post("q" + i, { photos: [{ original_size: { url } }] }),
    );
    writeFileSync(join(f.dir, "thumbs", `q${i}.webp`), "synthetic");
    f.db.db
      .prepare("UPDATE media SET hash=?,path=?,thumb=? WHERE url=?")
      .run("qh" + i, "qh" + i, `q${i}.webp`, url);
  }
}
test("a small index queue reports a model-service outage instead of completing silently", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const { Clip } = await import("../src/ml.js");
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    indexedImages(f, 1);
    const clip = new Clip(f.c, f.db);
    globalThis.fetch = async () => new Response("down", { status: 503 });
    await assert.rejects(
      clip.index(() => {}),
      /HTTP 503/,
    );
    globalThis.fetch = async () => Response.json({ clip: "[1,2]" });
    await assert.rejects(
      clip.index(() => {}),
      /invalid vector/,
    );
    globalThis.fetch = async () => new Response("bad", { status: 422 });
    assert.equal(await clip.index(() => {}), 0);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("shutdown cancels an in-flight image-service request and leaves the run resumable", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    indexedImages(f, 2);
    let requested = false;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requested = true;
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }) as typeof fetch;
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    sync.start("", true);
    while (!requested) await new Promise((r) => setTimeout(r, 2));
    const began = Date.now();
    await sync.stop();
    assert.ok(Date.now() - began < 1000);
    assert.equal(sync.progress.state, "partial");
    assert.equal(sync.progress.stage, "image_index");
    assert.equal(
      Number(
        f.db.db
          .prepare("SELECT COUNT(*) n FROM media WHERE embedding IS NOT NULL")
          .get()!.n,
      ),
      0,
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
test("index-only runs never postpone a scheduled backup, including vaults from before lastBackup", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync, backupDue } = await import("../src/sync.js");
    const legacy = "2026-01-01T00:00:00.000Z";
    f.db.state("progress", {
      state: "complete",
      stage: "finished",
      message: "Backup finished.",
      processed: 0,
      started: legacy,
    });
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    assert.equal(sync.lastBackup, legacy);
    sync.start("", true);
    await sync.active;
    assert.equal(sync.progress.state, "complete");
    assert.notEqual(sync.progress.started, legacy);
    assert.equal(new Sync(f.c, f.db, new Clip(f.c, f.db)).lastBackup, legacy);
    assert.equal(backupDue(sync.lastBackup, 24), true);
  } finally {
    f.close();
  }
});
function localClip(
  f: ReturnType<typeof fixture>,
  Clip: typeof import("../src/ml.js").Clip,
  stub: {
    local?: () => Promise<unknown>;
    read?: () => Promise<unknown>;
    processor?: () => Promise<unknown>;
    visual?: () => Promise<unknown>;
  },
) {
  f.c.configure({ clip: "local" });
  const clip = new Clip(f.c, f.db) as any;
  clip.local =
    stub.local ||
    (async () => ({ RawImage: { read: stub.read || (async () => ({})) } }));
  clip.processor = stub.processor || (async () => ({}));
  clip.visual =
    stub.visual ||
    (async () => ({
      image_embeds: { data: Float32Array.from({ length: 512 }, () => 1) },
    }));
  return clip as InstanceType<typeof Clip>;
}
test("local CLIP: execution failures stop even a one-image queue; an undecodable image is skipped", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    indexedImages(f, 1);
    const failing = localClip(f, Clip, {
      visual: async () => {
        throw new Error("synthetic ONNX session failure");
      },
    });
    await assert.rejects(
      failing.index(() => {}),
      /could not run/,
    );
    const unloadable = localClip(f, Clip, {
      local: async () => {
        throw new Error("synthetic download failure");
      },
    });
    await assert.rejects(
      unloadable.index(() => {}),
      /could not load/,
    );
    const undecodable = localClip(f, Clip, {
      read: async () => {
        throw new Error("synthetic decode failure");
      },
    });
    assert.equal(await undecodable.index(() => {}), 0);
    assert.equal(await localClip(f, Clip, {}).index(() => {}), 1);
  } finally {
    f.close();
  }
});
test("shutdown does not wait for a stalled local model download, decode, preprocessing or inference", async () => {
  const { Clip } = await import("../src/ml.js");
  const { Sync } = await import("../src/sync.js");
  for (const stage of ["local", "read", "processor", "visual"] as const) {
    const f = fixture();
    try {
      indexedImages(f, 1);
      let reached = false;
      const stalled = () => {
        reached = true;
        return new Promise<never>(() => {});
      };
      const clip = localClip(f, Clip, { [stage]: stalled });
      const sync = new Sync(f.c, f.db, clip);
      sync.start("", true);
      while (!reached) await new Promise((r) => setTimeout(r, 2));
      const began = Date.now();
      await sync.stop();
      assert.ok(Date.now() - began < 1000, stage);
      assert.equal(sync.progress.state, "partial", stage);
    } finally {
      f.close();
    }
  }
});
test("a never-backed-up vault stays due for backup across restarts after index-only runs", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync, backupDue } = await import("../src/sync.js");
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    const first = new Sync(f.c, f.db, new Clip(f.c, f.db));
    first.start("", true);
    await first.active;
    assert.equal(first.progress.state, "complete");
    const restarted = new Sync(f.c, f.db, new Clip(f.c, f.db));
    assert.equal(restarted.lastBackup, undefined);
    assert.equal(backupDue(restarted.lastBackup, 24), true);
  } finally {
    f.close();
  }
});
test("work finishing after shutdown never starts inference and never rejects unhandled", async () => {
  const f = fixture();
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    indexedImages(f, 1);
    let release!: () => void;
    let decoding = false;
    let inferred = false;
    let prepared = false;
    const clip = localClip(f, Clip, {
      read: () => {
        decoding = true;
        return new Promise((r) => (release = () => r({})));
      },
      processor: async () => {
        prepared = true;
        return {};
      },
      visual: async () => {
        inferred = true;
        throw new Error("synthetic late inference failure");
      },
    });
    const sync = new Sync(f.c, f.db, clip);
    sync.start("", true);
    while (!decoding) await new Promise((r) => setTimeout(r, 2));
    await sync.stop();
    assert.equal(sync.progress.state, "partial");
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(prepared, false);
    assert.equal(inferred, false);
    let loads = 0;
    const immediate = localClip(f, Clip, {
      local: async () => {
        loads++;
        return { RawImage: { read: async () => ({}) } };
      },
    });
    const third = new Sync(f.c, f.db, immediate);
    third.start("", true);
    await third.stop();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(loads, 0);
    assert.equal(third.progress.state, "partial");
    let rejectLate!: (e: Error) => void;
    let running = false;
    const late = localClip(f, Clip, {
      visual: () => {
        running = true;
        return new Promise((_r, reject) => (rejectLate = reject));
      },
    });
    const second = new Sync(f.c, f.db, late);
    second.start("", true);
    while (!running) await new Promise((r) => setTimeout(r, 2));
    await second.stop();
    rejectLate(new Error("synthetic late inference failure"));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
    f.close();
  }
});
test("only an interrupted full backup skips metadata; a backup after a stopped index run reads Tumblr", async () => {
  const f = fixture();
  try {
    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    f.c.value.accounts = [syntheticAccount()];
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    indexedImages(f, 1);
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        init?.signal?.addEventListener("abort", abort);
      })) as typeof fetch;
    const reads: string[] = [];
    const reader = (s: InstanceType<typeof Sync>) => {
      s.api.get = async (_a, path) => {
        reads.push(path);
        if (path === "/user/info") return { user: { blogs: [] } };
        return { liked_posts: [] };
      };
    };
    try {
      const indexing = new Sync(f.c, f.db, new Clip(f.c, f.db));
      indexing.start("", true);
      await new Promise((r) => setTimeout(r, 20));
      await indexing.stop();
      assert.equal(indexing.progress.stage, "image_index");
      f.c.configure({ clip: "off" });
      const backup = new Sync(f.c, f.db, new Clip(f.c, f.db));
      reader(backup);
      backup.start("");
      await backup.active;
      assert.equal(backup.progress.state, "complete");
      assert.deepEqual(reads, ["/user/info", "/user/likes"]);
      // A full backup stopped after metadata resumes without re-reading Tumblr.
      f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
      f.db.db.exec("UPDATE media SET embedding=NULL,model=NULL");
      const interrupted = new Sync(f.c, f.db, new Clip(f.c, f.db));
      reader(interrupted);
      interrupted.start("");
      for (let i = 0; interrupted.progress.stage !== "image_index"; i++) {
        assert.ok(i < 500, JSON.stringify(interrupted.progress));
        await new Promise((r) => setTimeout(r, 2));
      }
      await interrupted.stop();
      assert.equal(interrupted.progress.state, "partial");
      reads.length = 0;
      f.c.configure({ clip: "off" });
      const resumed = new Sync(f.c, f.db, new Clip(f.c, f.db));
      reader(resumed);
      resumed.start("");
      await resumed.active;
      assert.equal(resumed.progress.state, "complete");
      assert.deepEqual(reads, []);
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    f.close();
  }
});
test("shutdown during preview generation or snapshot neither waits nor reports success", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  const { imaging } = await import("../src/media.js");
  const render = imaging.render;
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const url = "https://64.media.tumblr.com/synthetic-preview.png";
    f.db.ingest(
      "a",
      "like",
      post("preview", { photos: [{ original_size: { url } }] }),
    );
    const row = f.db.db.prepare("SELECT * FROM media WHERE url=?").get(url)!;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    let fail!: (e: Error) => void;
    let previewing = false;
    imaging.render = () => {
      previewing = true;
      return new Promise((_r, reject) => (fail = reject));
    };
    const controller = new AbortController();
    const pending = download(f.db, row, controller.signal);
    while (!previewing) await new Promise((r) => setTimeout(r, 2));
    const began = Date.now();
    controller.abort();
    await assert.rejects(pending);
    assert.ok(Date.now() - began < 1000);
    // The durable original stays recorded; only its preview is pending a retry.
    const after = f.db.db.prepare("SELECT * FROM media WHERE url=?").get(url)!;
    assert.equal(after.path, after.hash);
    assert.equal(after.thumb, null);
    assert.equal(after.thumb_error, null);
    assert.equal(after.error, null);
    fail(new Error("synthetic late preview failure"));
    const { previewsToRetry } = await import("../src/media.js");
    assert.deepEqual(
      previewsToRetry(f.db).map((r) => r.id),
      [after.id],
    );
    imaging.render = render;

    const { Clip } = await import("../src/ml.js");
    const { Sync } = await import("../src/sync.js");
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    let finish!: () => void;
    let snapshotting = false;
    f.db.snapshot = () => {
      snapshotting = true;
      return new Promise((r) => (finish = () => r("synthetic")));
    };
    sync.start("", true);
    while (!snapshotting) await new Promise((r) => setTimeout(r, 2));
    const stopping = sync.stop();
    finish();
    await stopping;
    assert.equal(sync.progress.state, "partial");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
    imaging.render = render;
    globalThis.fetch = original;
    f.close();
  }
});
