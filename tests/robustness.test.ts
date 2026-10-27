// Regressions for the 1.0.1 fixes. Synthetic data only; no network, no real accounts.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { buildApp } from "../src/server.js";
import { Archive, extract, type Raw } from "../src/store.js";
import { Configuration, localRuntime } from "../src/config.js";
import { Tumblr } from "../src/tumblr.js";
import { download, imaging, preview, previewsToRetry } from "../src/media.js";
import { flush } from "../src/durable.js";
import { Throttle } from "../src/throttle.js";
import { Clip } from "../src/ml.js";
import { Sync } from "../src/sync.js";
import { importLegacy } from "../src/import.js";
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
const photo = (url: string) => ({ photos: [{ original_size: { url } }] });
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
const token = (extra: Record<string, unknown> = {}) => ({
  access_token: "synthetic",
  refresh_token: "synthetic",
  expires_in: 3600,
  scope: "basic offline_access",
  obtained: Date.now(),
  ...extra,
});
const png = () =>
  sharp({
    create: { width: 16, height: 12, channels: 3, background: "#554466" },
  })
    .png()
    .toBuffer();
const h = {
  host: "localhost:4318",
  "x-vault-request": "1",
  origin: "http://localhost:4318",
};
async function app(options: Parameters<typeof buildApp>[0] = {}) {
  const dir = temp();
  const a = await buildApp({ dataDir: dir, ...options });
  return {
    app: a,
    vault: (a as any).vault,
    dir,
    async close() {
      await a.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function setUp(a: Awaited<ReturnType<typeof app>>, extra = {}) {
  const r = await a.app.inject({
    method: "POST",
    url: "/api/setup",
    headers: h,
    payload: { password: "synthetic password", scheduleHours: 0, ...extra },
  });
  assert.equal(r.statusCode, 200, r.body);
  return { ...h, cookie: r.cookies[0].name + "=" + r.cookies[0].value };
}

test("one account's metadata failure never skips healthy accounts, media or the snapshot", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const image = await png();
    f.c.value.accounts = [
      {
        id: "a",
        label: "Failing",
        username: "a",
        blogs: [],
        token: token(),
      },
      {
        id: "b",
        label: "Healthy",
        username: "b",
        blogs: [],
        token: token(),
      },
    ];
    // Media retained from an earlier run of the failing account, still unsaved.
    f.db.ingest(
      "a",
      "like",
      post("old", photo("https://64.media.tumblr.com/retained.png")),
    );
    let downloads = 0;
    globalThis.fetch = async () => {
      downloads++;
      return new Response(new Uint8Array(image));
    };
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    sync.api.get = async (account, path) => {
      if (account.id === "a")
        throw new Error(
          "Tumblr read failed (HTTP 503). Retry the backup later.",
        );
      if (path === "/user/info") return { user: { blogs: [], likes: 1 } };
      return {
        liked_posts: [
          post("new", {
            liked_timestamp: 50,
            ...photo("https://64.media.tumblr.com/new.png"),
          }),
        ],
      };
    };
    sync.start();
    await sync.active;
    assert.equal(sync.progress.state, "partial", sync.progress.message);
    assert.match(sync.progress.message, /1 of 2 accounts could not be read/);
    assert.match(sync.progress.message, /HTTP 503/);
    const [a, b] = f.c.value.accounts;
    assert.match(a.error!, /HTTP 503/);
    assert.equal(b.error, undefined);
    assert.ok(b.lastSync);
    assert.equal(f.db.search({ profile: "b" }).total, 1);
    assert.equal(downloads, 2);
    const saved = f.db.db
      .prepare(
        "SELECT COUNT(*) n FROM media WHERE path IS NOT NULL AND thumb IS NOT NULL",
      )
      .get()!.n;
    assert.equal(saved, 2);
    assert.ok(existsSync(join(f.dir, "exports", "latest.sqlite")));
    // A later interrupted run must not skip the failed account's metadata.
    assert.equal(f.db.state("runMetadataComplete"), false);
    // When every account fails, saved work is still processed and the run says failed.
    f.c.value.accounts[1].token = undefined;
    f.db.ingest(
      "a",
      "like",
      post("old2", photo("https://64.media.tumblr.com/retained2.png")),
    );
    rmSync(join(f.dir, "exports", "latest.sqlite"));
    sync.start();
    await sync.active;
    assert.equal(sync.progress.state, "failed");
    assert.match(sync.progress.message, /HTTP 503.*retained/);
    assert.equal(downloads, 3);
    assert.ok(existsSync(join(f.dir, "exports", "latest.sqlite")));
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test("a rotated refresh token survives a refused grant; the refused access token is never used", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    f.c.configure(
      { password: "synthetic password", clientId: "k", clientSecret: "s" },
      true,
    );
    f.c.value.accounts.push({
      id: "a",
      label: "Synthetic",
      username: "a",
      blogs: [],
      token: token({
        access_token: "expired",
        refresh_token: "r1",
        obtained: 0,
      }),
    });
    f.c.save();
    const bearers: string[] = [];
    const grants: string[] = [];
    let refusals = 1;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/oauth2/token")) {
        const body = new URLSearchParams(String(init!.body));
        grants.push(body.get("refresh_token")!);
        // Tumblr rotates the refresh token, but grants an unexpected scope once.
        return refusals-- > 0
          ? Response.json({
              access_token: "refused",
              refresh_token: "r2",
              expires_in: 3600,
              scope: "basic write offline_access",
            })
          : Response.json({
              access_token: "good",
              refresh_token: "r3",
              expires_in: "3600",
              scope: "basic offline_access",
            });
      }
      bearers.push(String((init!.headers as any).Authorization));
      return Response.json({ meta: { status: 200 }, response: { ok: true } });
    }) as typeof fetch;
    const client = new Tumblr(f.c);
    await assert.rejects(
      client.get(f.c.value.accounts[0], "/user/info"),
      /exactly basic offline_access/,
    );
    assert.deepEqual(bearers, []);
    // Durable: a restarted process reads the rotated credential, not the retired one.
    const disk = new Configuration(f.dir);
    const stored = disk.value.accounts[0].token!;
    assert.equal(stored.refresh_token, "r2");
    assert.equal(stored.access_token, "");
    assert.ok(
      !readFileSync(join(f.dir, "config.json"), "utf8").includes("refused"),
    );
    const restarted = new Tumblr(disk);
    assert.deepEqual(
      await restarted.get(disk.value.accounts[0], "/user/info"),
      {
        ok: true,
      },
    );
    assert.deepEqual(grants, ["r1", "r2"]);
    assert.deepEqual(bearers, ["Bearer good"]);
    assert.equal(disk.value.accounts[0].token!.refresh_token, "r3");
    assert.equal(disk.value.accounts[0].token!.expires_in, 3600);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test("preview storage failures keep the original and retry from it; corrupt content is recorded once", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  const write = imaging.write;
  try {
    const image = await png();
    const good = "https://64.media.tumblr.com/good.png";
    const corrupt = "https://64.media.tumblr.com/corrupt.png";
    f.db.ingest("a", "like", post("1", photo(good)));
    f.db.ingest("a", "like", post("2", photo(corrupt)));
    let fetches = 0;
    globalThis.fetch = (async (url: unknown) => {
      fetches++;
      return new Response(
        String(url) === good ? new Uint8Array(image) : "this is not an image",
      );
    }) as typeof fetch;
    let writes = 0;
    imaging.write = async (destination, data) => {
      if (writes++ === 0)
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return write(destination, data);
    };
    const row = (url: string) =>
      f.db.db.prepare("SELECT * FROM media WHERE url=?").get(url)!;
    await download(f.db, row(good));
    await download(f.db, row(corrupt));
    assert.equal(fetches, 2);
    assert.ok(row(good).path);
    assert.equal(row(good).thumb, null);
    assert.equal(row(good).thumb_error, "preview_storage");
    assert.equal(row(good).error, null);
    assert.ok(row(corrupt).path);
    assert.equal(row(corrupt).thumb_error, "preview_unsupported");
    assert.equal(f.db.detail("1")!.media[0].previewError, "preview_storage");
    assert.equal(f.db.detail("1")!.media[0].saved, true);
    const status = f.db.status([], {
      state: "idle",
      stage: "ready",
      message: "",
      processed: 0,
    });
    assert.equal(status.previewsFailed, 2);
    assert.deepEqual(
      previewsToRetry(f.db).map((r) => r.id),
      [row(good).id],
    );
    // A backup run rebuilds the preview from the saved original without the network.
    f.c.configure({ clip: "off" });
    const sync = new Sync(f.c, f.db, new Clip(f.c, f.db));
    sync.start("", true);
    await sync.active;
    assert.equal(sync.progress.state, "complete", sync.progress.message);
    assert.equal(fetches, 2);
    assert.equal(row(good).thumb_error, null);
    const thumb = join(f.dir, "thumbs", row(good).thumb);
    assert.equal((await sharp(readFileSync(thumb)).metadata()).format, "webp");
    assert.equal(row(corrupt).thumb_error, "preview_unsupported");
    assert.deepEqual(previewsToRetry(f.db), []);
    // Running out of memory while decoding is retried, not blamed on the image.
    const render = imaging.render;
    imaging.render = () => Promise.reject(new Error("vips: out of memory"));
    f.db.db.prepare("UPDATE media SET thumb=NULL WHERE url=?").run(good);
    try {
      assert.equal(await preview(f.db, row(good)), false);
    } finally {
      imaging.render = render;
    }
    assert.equal(row(good).thumb_error, "preview_storage");
    assert.equal(await preview(f.db, row(good)), true);
    // A recorded original that disappeared is downloaded again, not reported saved.
    f.db.db.prepare("UPDATE media SET thumb=NULL WHERE url=?").run(good);
    rmSync(join(f.dir, "media", row(good).path));
    assert.equal(await preview(f.db, row(good)), false);
    assert.equal(row(good).path, null);
  } finally {
    imaging.write = write;
    globalThis.fetch = original;
    f.close();
  }
});

test("an original is flushed and its directory entry made durable before it is recorded as saved", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  const { file, directory } = flush;
  try {
    const url = "https://64.media.tumblr.com/durable.bin";
    f.db.ingest("a", "like", post("1", { video_url: url }));
    const bytes = new Uint8Array(70000).fill(7);
    globalThis.fetch = async () => new Response(bytes);
    const events: string[] = [];
    const recorded = () =>
      f.db.db.prepare("SELECT path FROM media WHERE url=?").get(url)!.path;
    flush.file = async (path) => {
      events.push("file:" + statSync(path).size + ":" + recorded());
      return file(path);
    };
    flush.directory = (dir) => {
      events.push("directory:" + recorded());
      return directory(dir);
    };
    await download(
      f.db,
      f.db.db.prepare("SELECT * FROM media WHERE url=?").get(url)!,
    );
    assert.deepEqual(events, ["file:70000:null", "directory:null"]);
    assert.ok(recorded());
  } finally {
    flush.file = file;
    flush.directory = directory;
    globalThis.fetch = original;
    f.close();
  }
});

test("startup under the vault lock removes only crash-left temporary files", async () => {
  const dir = temp();
  try {
    new Configuration(dir);
    const files = {
      temp: [
        "media/.0123456789abcdef01234567",
        "thumbs/" + "a".repeat(64) + ".webp.0123456789abcdef.tmp",
        "config.json.0123456789abcdef.tmp",
        "exports/latest.sqlite.pending",
      ],
      kept: [
        "media/" + "b".repeat(64),
        "media/.keep",
        "media/.0123",
        "thumbs/" + "b".repeat(64) + ".webp",
        "exports/latest.sqlite",
      ],
    };
    for (const name of [...files.temp, ...files.kept])
      writeFileSync(join(dir, name), "synthetic");
    const a = await buildApp({ dataDir: dir });
    await a.close();
    for (const name of files.temp)
      assert.ok(!existsSync(join(dir, name)), name);
    for (const name of files.kept) assert.ok(existsSync(join(dir, name)), name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent first-run setup has exactly one winner; the loser gets 409 and no session", async () => {
  const a = await app();
  try {
    const attempt = (password: string) =>
      a.app.inject({
        method: "POST",
        url: "/api/setup",
        headers: h,
        payload: { password, scheduleHours: 0 },
      });
    const results = await Promise.all([
      attempt("first synthetic password"),
      attempt("second synthetic password"),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const winner = results[0].statusCode === 200 ? "first" : "second";
    const loser = results.find((r) => r.statusCode === 409)!;
    assert.equal(loser.headers["set-cookie"], undefined);
    const login = (password: string) =>
      a.app.inject({
        method: "POST",
        url: "/api/login",
        headers: h,
        payload: { password },
      });
    assert.equal((await login(winner + " synthetic password")).statusCode, 200);
    assert.equal(
      (
        await login(
          (winner === "first" ? "second" : "first") + " synthetic password",
        )
      ).statusCode,
      401,
    );
  } finally {
    await a.close();
  }
});

test("setup beyond loopback needs the one-time code; loopback setup stays a single step", async () => {
  const local = await app({ host: "127.0.0.1" });
  try {
    assert.equal(local.vault.setupCode, "");
    const s = (
      await local.app.inject({ url: "/api/setup", headers: h })
    ).json();
    assert.equal(s.setupCodeRequired, false);
    await setUp(local);
  } finally {
    await local.close();
  }
  for (const options of [
    { host: "0.0.0.0" },
    { host: "127.0.0.1", baseUrl: "https://vault.example.test" },
  ]) {
    const exposed = await app(options);
    const headers = options.baseUrl
      ? {
          host: "vault.example.test",
          "x-vault-request": "1",
          origin: options.baseUrl,
        }
      : h;
    try {
      const code: string = exposed.vault.setupCode;
      assert.match(code, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
      assert.equal(
        (await exposed.app.inject({ url: "/api/setup", headers })).json()
          .setupCodeRequired,
        true,
      );
      const post = (payload: Record<string, unknown>) =>
        exposed.app.inject({
          method: "POST",
          url: "/api/setup",
          headers,
          payload: {
            password: "synthetic password",
            scheduleHours: 0,
            ...payload,
          },
        });
      assert.equal((await post({})).statusCode, 403);
      assert.equal(
        (await post({ setupCode: "AAAAA-AAAAA-AAAAA-AAAAA" })).statusCode,
        403,
      );
      const ok = await post({ setupCode: code.toLowerCase() });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(exposed.vault.setupCode, "");
      assert.equal((await post({ setupCode: code })).statusCode, 409);
    } finally {
      await exposed.close();
    }
  }
});

test("loopback aliases can unlock; other origins, ports, schemes and malformed hosts cannot", async () => {
  const a = await app();
  try {
    await setUp(a);
    const login = (host: string, origin?: string) =>
      a.app.inject({
        method: "POST",
        url: "/api/login",
        headers: {
          host,
          "x-vault-request": "1",
          ...(origin === undefined ? {} : { origin }),
        },
        payload: { password: "synthetic password" },
      });
    for (const [host, origin] of [
      ["127.0.0.1:4318", "http://127.0.0.1:4318"],
      ["[::1]:4318", "http://[::1]:4318"],
      ["LOCALHOST:4318", "http://localhost:4318"],
    ])
      assert.equal((await login(host, origin)).statusCode, 200, host);
    assert.equal(
      (await login("127.0.0.1:4318", "http://localhost:4318")).statusCode,
      200,
    );
    for (const origin of [
      "http://127.0.0.1:9999",
      "https://localhost:4318",
      "http://localhost.:4318",
      "http://evil.test:4318",
      "http://localhost:4318/path",
      "null",
    ])
      assert.equal(
        (await login("localhost:4318", origin)).statusCode,
        403,
        origin,
      );
    for (const host of [
      "localhost",
      "localhost:4318/x",
      "127.0.0.2:4318",
      "evil.test:4318",
    ])
      assert.equal((await login(host)).statusCode, 403, host);
  } finally {
    await a.close();
  }
  // Default ports are equivalent to an omitted port; external base URLs get no aliases.
  const defaults = await app({ baseUrl: "http://localhost" });
  try {
    for (const host of ["localhost", "localhost:80", "127.0.0.1"])
      assert.equal(
        (await defaults.app.inject({ url: "/api/session", headers: { host } }))
          .statusCode,
        200,
        host,
      );
    assert.equal(
      (
        await defaults.app.inject({
          url: "/api/session",
          headers: { host: "localhost:8080" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await defaults.close();
  }
  const external = await app({ baseUrl: "https://vault.example.test" });
  try {
    for (const [host, code] of [
      ["vault.example.test:443", 200],
      ["localhost", 403],
      ["127.0.0.1:443", 403],
    ] as const)
      assert.equal(
        (await external.app.inject({ url: "/api/session", headers: { host } }))
          .statusCode,
        code,
        host,
      );
  } finally {
    await external.close();
  }
});

test("password guesses back off for at most a minute, never lock out the owner, and expire", async () => {
  const t = new Throttle();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(t.check("x", now), 0);
  for (let i = 0; i < 40; i++) t.fail("x", now);
  assert.equal(t.check("x", now), 60000);
  assert.equal(t.check("x", now + 60000), 0);
  assert.equal(t.check("y", now), 60000); // global slow-down, still bounded
  t.prune(now + 15 * 60000 + 1);
  assert.equal(t.records.size, 0);
  for (let i = 0; i < 12000; i++) t.fail("k" + i, now);
  assert.ok(t.records.size <= 10000);

  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = await app();
  try {
    await setUp(a);
    const login = (password: string, remoteAddress = "127.0.0.1", extra = {}) =>
      a.app.inject({
        method: "POST",
        url: "/api/login",
        headers: { ...h, ...extra },
        remoteAddress,
        payload: { password },
      });
    for (let i = 0; i < 5; i++)
      assert.equal((await login("wrong")).statusCode, 401);
    const limited = await login("synthetic password");
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers["retry-after"]) <= 60);
    // Forwarded headers are ignored unless a proxy is configured.
    assert.equal(
      (
        await login("synthetic password", "127.0.0.1", {
          "x-forwarded-for": "10.0.0.9",
        })
      ).statusCode,
      429,
    );
    mock.timers.tick(61000);
    assert.equal((await login("synthetic password")).statusCode, 200);
    for (let i = 0; i < 30; i++) await login("wrong");
    assert.ok(Number((await login("wrong")).headers["retry-after"]) <= 60);
    mock.timers.tick(15 * 60000 + 1);
    await login("synthetic password", "10.0.0.1");
    assert.equal(a.vault.throttle.records.size, 0);
  } finally {
    await a.close();
    mock.timers.reset();
  }
  const proxied = await app({ trustProxy: "127.0.0.1" });
  try {
    await setUp(proxied);
    const login = (forwarded: string, password = "wrong") =>
      proxied.app.inject({
        method: "POST",
        url: "/api/login",
        headers: { ...h, "x-forwarded-for": forwarded },
        remoteAddress: "127.0.0.1",
        payload: { password },
      });
    for (let i = 0; i < 6; i++) await login("10.0.0.9");
    assert.equal(
      (await login("10.0.0.9", "synthetic password")).statusCode,
      429,
    );
    assert.equal(
      (await login("10.0.0.8", "synthetic password")).statusCode,
      200,
    );
  } finally {
    await proxied.close();
  }
});

test("changing the vault password requires the current password", async () => {
  const a = await app();
  try {
    const auth = await setUp(a);
    const change = (payload: Record<string, unknown>) =>
      a.app.inject({
        method: "POST",
        url: "/api/settings",
        headers: auth,
        payload,
      });
    assert.equal(
      (await change({ password: "replacement password" })).statusCode,
      403,
    );
    assert.equal(
      (
        await change({
          password: "replacement password",
          currentPassword: "wrong",
        })
      ).statusCode,
      403,
    );
    assert.equal((await change({ scheduleHours: 6 })).statusCode, 200);
    const ok = await change({
      password: "replacement password",
      currentPassword: "synthetic password",
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(
      (
        await a.app.inject({
          method: "POST",
          url: "/api/login",
          headers: h,
          payload: { password: "replacement password" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await a.close();
  }
});

test("an OAuth callback bound to an expired session is refused", async () => {
  const a = await app();
  try {
    const auth = await setUp(a, { clientId: "key", clientSecret: "secret" });
    const start = await a.app.inject({
      method: "POST",
      url: "/api/oauth/start",
      headers: auth,
      payload: { label: "Synthetic" },
    });
    const state = new URL(start.json().url).searchParams.get("state");
    const id = auth.cookie.split("=")[1];
    a.vault.sessions.get(id).expires = Date.now() - 1;
    const r = await a.app.inject({
      url: "/oauth/callback?state=" + state + "&code=synthetic",
      headers: { host: "localhost:4318" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.headers["set-cookie"], undefined);
  } finally {
    await a.close();
  }
});

test("text-only installs explain the optional local CLIP runtime instead of failing obscurely", async () => {
  const available = localRuntime.available;
  const a = await app();
  try {
    const auth = await setUp(a);
    localRuntime.available = () => false;
    const s = (
      await a.app.inject({ url: "/api/settings", headers: auth })
    ).json();
    assert.equal(s.localClipAvailable, false);
    const r = await a.app.inject({
      method: "POST",
      url: "/api/settings",
      headers: auth,
      payload: { clip: "local" },
    });
    assert.equal(r.statusCode, 400);
    assert.match(
      r.json().error,
      /optional.*--include=optional.*Text search works/,
    );
    localRuntime.available = available;
    assert.equal(localRuntime.available(), true);
  } finally {
    localRuntime.available = available;
    await a.close();
  }
});

// The 1.0.0 schema and write path, verbatim, to prove the migration preserves old vaults.
const LEGACY_SCHEMA = `PRAGMA journal_mode=WAL;
 CREATE TABLE posts(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,blog TEXT NOT NULL,timestamp INTEGER NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,url TEXT NOT NULL,raw TEXT NOT NULL);
 CREATE INDEX post_group ON posts(group_id);
 CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED,title,tags,body);
 CREATE TABLE membership(account TEXT NOT NULL,post TEXT NOT NULL REFERENCES posts(id),role TEXT NOT NULL,liked_at INTEGER,PRIMARY KEY(account,post,role)); CREATE INDEX membership_post ON membership(post,account);
 CREATE TABLE media(id INTEGER PRIMARY KEY,url TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,hash TEXT,path TEXT,thumb TEXT,bytes INTEGER DEFAULT 0,error TEXT,embedding BLOB,model TEXT);
 CREATE TABLE post_media(post TEXT NOT NULL REFERENCES posts(id),media INTEGER NOT NULL REFERENCES media(id),position INTEGER,PRIMARY KEY(post,media)); CREATE INDEX media_posts ON post_media(media,post);
 CREATE TABLE checkpoints(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`;
function legacyIngest(db: DatabaseSync, account: string, p: Raw) {
  const e = extract(p);
  db.prepare(
    "INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,tags=excluded.tags,raw=excluded.raw",
  ).run(
    p.id_string,
    e.groupId,
    p.blog_name,
    p.timestamp,
    e.type,
    e.title,
    e.text,
    JSON.stringify(p.tags),
    "",
    JSON.stringify(p),
  );
  db.prepare("DELETE FROM fts WHERE id=?").run(p.id_string);
  db.prepare("INSERT INTO fts VALUES(?,?,?,?)").run(
    p.id_string,
    e.title,
    p.tags.join(" "),
    e.text,
  );
  db.prepare("INSERT OR REPLACE INTO membership VALUES(?,?,?,?)").run(
    account,
    p.id_string,
    "like",
    null,
  );
}
test("1.0.0 vaults migrate in place: BM25 order kept, updates keyed by rowid, older writes reconciled", () => {
  const dir = temp();
  try {
    new Configuration(dir);
    const legacy = new DatabaseSync(join(dir, "archive.sqlite"));
    legacy.exec(LEGACY_SCHEMA);
    legacyIngest(
      legacy,
      "a",
      post("body", { title: "Other", tags: [], body: "harbor" }),
    );
    legacyIngest(
      legacy,
      "a",
      post("title", { title: "Harbor", tags: [], body: "x" }),
    );
    legacyIngest(
      legacy,
      "a",
      post("tag", { title: "Other", tags: ["harbor"], body: "x" }),
    );
    legacy.close();
    let db = new Archive(dir);
    const ids = (q: string) => db.search({ q }).entries.map((e) => e.id);
    assert.equal(db.db.prepare("PRAGMA user_version").get()!.user_version, 1);
    assert.deepEqual(ids("harbor"), ["title", "tag", "body"]);
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM fts_doc").get()!.n, 3);
    const plan = db.db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM fts WHERE rowid=?")
      .all(1)
      .map((r) => r.detail)
      .join(" ");
    assert.match(plan, /INDEX 0:=/); // rowid lookup, not the full scan "INDEX 0:"
    db.ingest(
      "a",
      "like",
      post("body", { title: "Other", tags: [], body: "lighthouse" }),
    );
    const rows = (id: string) =>
      db.db.prepare("SELECT COUNT(*) n FROM fts WHERE id=?").get(id)!.n;
    assert.equal(rows("body"), 1);
    assert.deepEqual(ids("harbor"), ["title", "tag"]);
    assert.deepEqual(ids("lighthouse"), ["body"]);
    // Rowids recorded by new ingests map to the right FTS row too.
    db.ingest(
      "a",
      "like",
      post("brand", { title: "Other", tags: [], body: "meadow" }),
    );
    db.ingest(
      "a",
      "like",
      post("brand", { title: "Other", tags: [], body: "orchard" }),
    );
    assert.equal(rows("brand"), 1);
    assert.deepEqual(ids("meadow"), []);
    assert.deepEqual(ids("orchard"), ["brand"]);
    assert.equal(
      db.db
        .prepare(
          "SELECT COUNT(*) n FROM fts_doc d JOIN fts ON fts.rowid=d.doc WHERE fts.id=d.post",
        )
        .get()!.n,
      4,
    );
    db.close();
    // A 1.0.0 process writing to a migrated vault (downgrade, then upgrade again).
    const older = new DatabaseSync(join(dir, "archive.sqlite"));
    legacyIngest(
      older,
      "a",
      post("title", { title: "Harbor again", tags: [], body: "x" }),
    );
    legacyIngest(
      older,
      "a",
      post("fresh", { title: "Harbor fresh", tags: [], body: "x" }),
    );
    older.close();
    db = new Archive(dir);
    db.ingest(
      "a",
      "like",
      post("title", { title: "Harbor", tags: [], body: "x" }),
    );
    assert.equal(rows("title"), 1);
    assert.deepEqual(ids("harbor").sort(), ["fresh", "tag", "title"]);
    assert.deepEqual(ids("orchard"), ["brand"]);
    assert.equal(
      db.db.prepare("SELECT COUNT(*) n FROM fts_doc").get()!.n,
      db.db.prepare("SELECT COUNT(*) n FROM fts").get()!.n,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-record ingest cost stays flat as the archive grows", () => {
  const f = fixture();
  try {
    const timed = (from: number) => {
      const began = performance.now();
      for (let i = from; i < from + 500; i++)
        f.db.ingest("a", "like", post("p" + i, { body: "record " + i }));
      return performance.now() - began;
    };
    const early = timed(0);
    f.db.transaction(() => {
      for (let i = 1000; i < 21000; i++)
        f.db.ingest("a", "like", post("p" + i, { body: "record " + i }));
    });
    const late = timed(30000);
    // 1.0.0 scanned the whole FTS table on every record: about 6x slower at this size.
    assert.ok(late < early * 2.5 + 250, `early ${early} ms, late ${late} ms`);
  } finally {
    f.close();
  }
});

// The 1.0.0 algorithm (rank every saved version, group, then page in JavaScript).
function referenceSearch(db: Archive, params: Record<string, string>) {
  const { where, binds } = db.filter(params);
  let from = "posts p";
  let condition = where;
  let select = "p.*";
  if (params.q) {
    from += " JOIN fts ON fts.id=p.id";
    condition += " AND fts MATCH ?";
    binds.push('"' + params.q + '"');
    select += ",bm25(fts,0,5,3,1) score";
  }
  const rows = db.db
    .prepare(`SELECT ${select} FROM ${from} WHERE ${condition}`)
    .all(...binds) as Raw[];
  rows.sort((a, b) =>
    params.sort === "oldest"
      ? a.timestamp - b.timestamp || a.id.localeCompare(b.id)
      : params.sort === "newest"
        ? b.timestamp - a.timestamp || b.id.localeCompare(a.id)
        : (a.score ?? 0) - (b.score ?? 0) ||
          b.timestamp - a.timestamp ||
          b.id.localeCompare(a.id),
  );
  const groups = new Map<string, Raw>();
  for (const r of rows) if (!groups.has(r.group_id)) groups.set(r.group_id, r);
  const all = [...groups.values()];
  const page = Number(params.page || 1);
  return {
    ids: all.slice((page - 1) * 24, page * 24).map((r) => r.id),
    total: all.length,
  };
}
test("SQL grouping and paging match the previous algorithm with a fixed number of queries", () => {
  const f = fixture();
  try {
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const words = ["harbor", "quiet", "lantern", "field"];
    f.db.transaction(() => {
      for (let i = 0; i < 400; i++) {
        const root = Math.floor(random() * 150);
        const id = "p" + String(i).padStart(4, "0");
        f.db.ingest(
          random() < 0.5 ? "a" : "b",
          random() < 0.5 ? "like" : "post",
          post(id, {
            reblogged_root_id: random() < 0.6 ? "r" + root : undefined,
            timestamp: 1767225600 + Math.floor(random() * 40) * 86400,
            title: words[Math.floor(random() * 4)],
            body:
              words[Math.floor(random() * 4)] +
              " " +
              words[Math.floor(random() * 4)],
            tags: [words[Math.floor(random() * 4)]],
          }),
        );
      }
    });
    const prepare = f.db.db.prepare.bind(f.db.db);
    let statements = 0;
    (f.db.db as any).prepare = (sql: string) => {
      statements++;
      return prepare(sql);
    };
    for (const sort of ["", "newest", "oldest"])
      for (const q of ["", "harbor"])
        for (const profile of ["", "a"])
          for (const page of ["1", "2", "3"]) {
            const params = { sort, q, profile, page };
            const expected = referenceSearch(f.db, params);
            statements = 0;
            const actual = f.db.search(params);
            assert.equal(actual.total, expected.total, JSON.stringify(params));
            assert.deepEqual(
              actual.entries.map((e) => e.id),
              expected.ids,
              JSON.stringify(params),
            );
            assert.ok(statements <= 8, `${statements} statements`);
          }
    const entry = f.db.search({ q: "harbor" }).entries[0];
    assert.equal(entry.versions, f.db.detail(entry.id)!.savedVersions.length);
  } finally {
    f.close();
  }
});

test("legacy import finds external originals, refuses silent loss and reports what is missing", async () => {
  const src = temp();
  const external = temp();
  const dests: string[] = [];
  const dest = () => {
    const d = temp();
    dests.push(d);
    return d;
  };
  try {
    mkdirSync(join(src, "data"));
    const old = new DatabaseSync(join(src, "data", "archive.sqlite"));
    old.exec(
      "CREATE TABLE accounts(id,profile,blogs,expected_posts,expected_likes,last_sync);CREATE TABLE posts(id,raw);CREATE TABLE membership(account,post,role,liked_at);CREATE TABLE media(url,kind,sha256,path,thumb,bytes,error,embedding,model)",
    );
    old
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run("a", "Imported", '["synthetic"]', 1, 1, null);
    const url = "https://64.media.tumblr.com/import.png";
    old
      .prepare("INSERT INTO posts VALUES(?,?)")
      .run("1", JSON.stringify(post("1", photo(url))));
    old
      .prepare("INSERT INTO membership VALUES(?,?,?,?)")
      .run("a", "1", "like", 123);
    const image = await png();
    old
      .prepare("INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        url,
        "image",
        "f".repeat(64),
        "f".repeat(64),
        "missing-preview.jpg",
        image.length,
        null,
        null,
        null,
      );
    old.close();
    writeFileSync(join(external, "f".repeat(64)), image);
    const before = readFileSync(join(src, "data", "archive.sqlite"));
    const refused = dest();
    await assert.rejects(
      importLegacy(src, refused),
      /1 recorded originals were not found.*--media-from.*--allow-missing.*Nothing was imported/,
    );
    assert.ok(!existsSync(join(refused, "archive.sqlite")));
    assert.ok(!existsSync(join(refused, "config.json")));
    const found = dest();
    const result = await importLegacy(src, found, { mediaFrom: external });
    assert.equal(result.missingOriginals, 0);
    assert.equal(result.missingThumbs, 1);
    assert.match(result.warnings.join(" "), /Keep the legacy archive/);
    assert.match(result.warnings.join(" "), /rebuilds previews/);
    const db = new Archive(found);
    try {
      assert.equal(db.detail("1")!.media[0].saved, true);
      const retry = previewsToRetry(db);
      assert.equal(retry.length, 1);
      assert.equal(await preview(db, retry[0]), true);
      assert.equal(db.detail("1")!.media[0].thumb, true);
    } finally {
      db.close();
    }
    const allowed = await importLegacy(src, dest(), { allowMissing: true });
    assert.equal(allowed.missingOriginals, 1);
    assert.match(
      allowed.warnings.join(" "),
      /1 recorded originals were not found/,
    );
    assert.deepEqual(before, readFileSync(join(src, "data", "archive.sqlite")));
    assert.deepEqual(readdirSync(external), ["f".repeat(64)]);
  } finally {
    for (const d of [src, external, ...dests])
      rmSync(d, { recursive: true, force: true });
  }
});

test("workflows pin every action to a full commit SHA and manual image runs always have a tag", () => {
  const dir = new URL("../.github/workflows/", import.meta.url);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), "utf8");
    for (const [, ref] of text.matchAll(/uses:\s*([^\s#]+)/g))
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, name + ": " + ref);
  }
  const release = readFileSync(new URL("release.yml", dir), "utf8");
  assert.match(release, /type=sha/);
  const versionRule = release
    .split("\n")
    .find((line) => line.includes("type=semver"))!;
  assert.ok(
    versionRule.includes("enable=${{ startsWith(github.ref, 'refs/tags/v') }}"),
    "only v-prefixed release tags may emit version images",
  );
  const branchRule = release
    .split("\n")
    .find((line) => line.includes("type=ref,event=branch"))!;
  const prefix = /prefix=([^,\s]+)/.exec(branchRule)?.[1] || "";
  for (const branch of ["main", "latest", "1.0.0"]) {
    const tag = prefix + branch;
    assert.ok(
      tag !== "latest" && !/^\d+\.\d+\.\d+$/.test(tag),
      "branch must not overwrite release tag: " + tag,
    );
  }
});

test("chunked image ranking scores every in-scope post exactly as a full scan does", async () => {
  const f = fixture();
  try {
    f.c.configure({ clip: "immich", mlUrl: "http://ml.invalid" });
    const clip = new Clip(f.c, f.db);
    const vector = (i: number) => {
      const v = new Float32Array(512);
      for (let k = 0; k < 512; k++) v[k] = Math.sin(i * 0.37 + k * 0.11);
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    };
    f.db.transaction(() => {
      for (let i = 0; i < 2300; i++) {
        // Every fifth post reuses an earlier image, across chunk boundaries.
        const image = i % 5 === 4 ? i - 2001 : i;
        f.db.ingest(
          i % 2 ? "a" : "b",
          "like",
          post(
            "v" + i,
            photo(
              "https://64.media.tumblr.com/v" + Math.max(0, image) + ".png",
            ),
          ),
        );
      }
      for (const m of f.db.db
        .prepare("SELECT id,url FROM media")
        .all() as Raw[])
        f.db.db
          .prepare("UPDATE media SET embedding=?,model=? WHERE id=?")
          .run(
            Buffer.from(vector(Number(/v(\d+)/.exec(m.url)![1])).buffer),
            clip.model,
            m.id,
          );
    });
    const similar = String(
      f.db.db.prepare("SELECT id FROM media WHERE url LIKE '%/v7.png'").get()!
        .id,
    );
    for (const profile of ["", "a"]) {
      const ranks = await clip.rank("", similar, profile);
      const target = vector(7);
      const expected = new Map<string, number>();
      for (const r of f.db.db
        .prepare(
          `SELECT pm.post,m.url FROM post_media pm JOIN media m ON m.id=pm.media WHERE EXISTS(SELECT 1 FROM membership a WHERE a.post=pm.post ${profile ? "AND a.account=?" : ""})`,
        )
        .all(...(profile ? [profile] : [])) as Raw[]) {
        const v = vector(Number(/v(\d+)/.exec(r.url)![1]));
        expected.set(
          r.post,
          target.reduce((s, x, k) => s + x * v[k], 0),
        );
      }
      assert.equal(ranks.size, expected.size, profile);
      for (const [id, score] of expected)
        assert.ok(Math.abs(ranks.get(id)! - score) < 1e-5, id);
      // The SQL search path orders by these scores and keeps only ranked posts.
      const result = f.db.search({ similar, profile }, ranks);
      assert.equal(result.total, expected.size);
      const best = [...expected].sort(
        (x, y) => y[1] - x[1] || (y[0] < x[0] ? -1 : 1),
      );
      assert.deepEqual(
        result.entries.slice(0, 3).map((e) => e.id),
        best.slice(0, 3).map(([id]) => id),
      );
    }
  } finally {
    f.close();
  }
});

test("reopening repairs interrupted older writes even when FTS rowids are reused", () => {
  const dir = temp();
  let db: Archive | undefined;
  try {
    new Configuration(dir);
    db = new Archive(dir);
    for (const id of ["a", "b", "c"]) db.ingest("account", "like", post(id));
    db.close();
    db = undefined;
    const old = new DatabaseSync(join(dir, "archive.sqlite"));
    try {
      old.prepare("DELETE FROM fts WHERE id=?").run("c");
      legacyIngest(old, "account", post("d", { body: "uniquedelta" }));
    } finally {
      old.close();
    }
    db = new Archive(dir);
    assert.deepEqual(
      db.db
        .prepare(
          "SELECT d.post FROM fts_doc d LEFT JOIN fts f ON f.rowid=d.doc WHERE f.id IS NULL OR f.id!=d.post",
        )
        .all(),
      [],
    );
    db.ingest("account", "like", post("c"));
    assert.deepEqual(
      db.search({ q: "uniquedelta" }).entries.map((e) => e.id),
      ["d"],
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("import refuses physical overlap through destination and source symlinks before writing", async () => {
  const root = temp();
  try {
    const src = join(root, "source");
    mkdirSync(join(src, "data"), { recursive: true });
    const old = new DatabaseSync(join(src, "data", "archive.sqlite"));
    old.exec(
      "CREATE TABLE accounts(id,profile,blogs,expected_posts,expected_likes,last_sync);CREATE TABLE posts(id,raw);CREATE TABLE membership(account,post,role,liked_at);CREATE TABLE media(url,kind,sha256,path,thumb,bytes,error,embedding,model)",
    );
    old.close();
    const alias = join(root, "alias");
    symlinkSync(src, alias, process.platform === "win32" ? "junction" : "dir");
    const before = readdirSync(src);
    const bytes = readFileSync(join(src, "data", "archive.sqlite"));
    for (const dest of [alias, join(alias, "new", "nested")]) {
      await assert.rejects(importLegacy(src, dest), /non-overlapping/);
      assert.deepEqual(readdirSync(src), before);
      assert.deepEqual(
        readFileSync(join(src, "data", "archive.sqlite")),
        bytes,
      );
    }
    await assert.rejects(
      importLegacy(alias, join(src, "new")),
      /non-overlapping/,
    );
    for (const option of ["mediaFrom", "thumbsFrom"] as const) {
      const external = join(root, option);
      mkdirSync(external);
      const link = join(root, option + "-alias");
      symlinkSync(
        external,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        importLegacy(src, join(link, "new"), { [option]: external }),
        /non-overlapping/,
      );
      assert.deepEqual(readdirSync(external), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durability failure is retried for an already-existing original before recording success", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  const { file, directory } = flush;
  try {
    f.db.ingest(
      "a",
      "like",
      post("1", { video_url: "https://64.media.tumblr.com/durable.mp4" }),
    );
    const row = () => f.db.db.prepare("SELECT * FROM media").get()!;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]));
    let files = 0,
      dirs = 0;
    flush.file = async (path) => {
      files++;
      await file(path);
    };
    flush.directory = () => {
      dirs++;
      throw Object.assign(new Error("synthetic durability EIO"), {
        code: "EIO",
      });
    };
    await download(f.db, row());
    assert.equal(row().path, null);
    await download(f.db, row());
    assert.equal(row().path, null);
    assert.equal(
      dirs,
      2,
      "retry must attempt directory flush even when target exists",
    );
    flush.directory = (path) => {
      dirs++;
      directory(path);
    };
    await download(f.db, row());
    assert.ok(row().path);
    assert.equal(row().error, null);
    assert.equal(dirs, 3);
    assert.equal(files, 3, "selected file must be flushed on every attempt");
  } finally {
    flush.file = file;
    flush.directory = directory;
    globalThis.fetch = original;
    f.close();
  }
});
