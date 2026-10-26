import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { existsSync, createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { Configuration, checkPassword } from "./config.js";
import { Archive } from "./store.js";
import { Clip } from "./ml.js";
import { Sync } from "./sync.js";
import { seedDemo } from "./demo.js";
import { lockVault } from "./lock.js";
export async function buildApp(
  options: { dataDir?: string; demo?: boolean; baseUrl?: string } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 16384, trustProxy: false });
  const baseUrl = (options.baseUrl || "http://localhost:4318").replace(
    /\/$/,
    "",
  );
  const expected = new URL(baseUrl);
  if (!["http:", "https:"].includes(expected.protocol))
    throw new Error("Base URL must be HTTP(S).");
  const config = new Configuration(options.dataDir, options.demo);
  const unlock = lockVault(config.dir);
  const archive = new Archive(config.dir);
  await seedDemo(config, archive);
  const clip = new Clip(config, archive);
  const sync = new Sync(config, archive, clip);
  const sessions = new Map<string, { expires: number }>();
  const pending = new Map<
    string,
    { label: string; session: string; expires: number }
  >();
  const attempts = new Map<string, { n: number; until: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cookie = (r: FastifyRequest) =>
    r.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("vault_session="))
      ?.slice(14) || "";
  const authenticated = (r: FastifyRequest) => {
    const s = sessions.get(cookie(r));
    return !!s && s.expires > Date.now();
  };
  const newSession = (reply: any) => {
    const id = randomBytes(32).toString("hex");
    sessions.set(id, { expires: Date.now() + 7 * 86400000 });
    reply.header(
      "Set-Cookie",
      `vault_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${expected.protocol === "https:" ? "; Secure" : ""}`,
    );
    return id;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (
      config.value.scheduleHours &&
      !config.value.demo &&
      config.value.password
    ) {
      timer = setTimeout(() => {
        if (!sync.active && config.value.accounts.some((a) => a.token))
          sync.start();
        schedule();
      }, config.value.scheduleHours * 3600000);
      timer.unref();
    }
  };
  app.addHook("onRequest", async (r, reply) => {
    const host = r.headers.host || "";
    const allowed = new Set([
      expected.host,
      ...(expected.hostname === "localhost" || expected.hostname === "127.0.0.1"
        ? [
            "localhost:" + expected.port,
            "127.0.0.1:" + expected.port,
            "[::1]:" + expected.port,
          ]
        : []),
    ]);
    if (
      r.url !== "/health" &&
      !allowed.has(host) &&
      !(host === "localhost" && expected.port === "")
    )
      return reply.code(403).send({
        error:
          "Host not allowed. Set VAULT_BASE_URL to the exact URL you use to open the app.",
      });
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    const path = r.url.split("?")[0];
    if (/%|\\|\/\/|\/\.\.?\//.test(path))
      return reply.code(400).send({ error: "Use a canonical URL path." });
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method)) {
      if (r.headers["x-vault-request"] !== "1")
        return reply
          .code(403)
          .send({ error: "Request protection missing. Reload the app." });
      if (r.headers.origin && r.headers.origin !== expected.origin)
        return reply
          .code(403)
          .send({ error: "Cross-origin writes are not allowed." });
    }
    if (
      path.startsWith("/api/") &&
      !["/api/setup", "/api/session", "/api/login"].includes(path) &&
      !authenticated(r)
    )
      return reply.code(401).send({ error: "Unlock your vault to continue." });
    if (path === "/api/setup" && r.method === "POST" && config.value.password)
      return reply
        .code(409)
        .send({ error: "Setup is already complete. Unlock your vault." });
  });
  app.setErrorHandler((error, r, reply) => {
    const message = error instanceof Error ? error.message : "Request failed.";
    const safe =
      /^(Use |Choose |Enter |Unknown |The start date|Image |This image|Tumblr |Save your|Reconnect |Backup |A backup|Demo mode|Setup |Local |Invalid |Source record)/.test(
        message,
      );
    reply
      .code(
        (error as any).statusCode >= 400
          ? (error as any).statusCode
          : safe
            ? 400
            : 500,
      )
      .send({
        error: safe
          ? message
          : "The request could not complete. Retry, or check Settings and available disk space.",
      });
  });
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/session", async (r) => ({
    authenticated: authenticated(r),
    needsPassword: !!config.value.password,
  }));
  app.get("/api/setup", async (r) => {
    const s = config.public(baseUrl);
    return !s.configured || authenticated(r)
      ? s
      : { ...s, dataDir: "", storageFree: 0, profiles: [], mlUrl: "" };
  });
  app.post<{ Body: Record<string, unknown> }>(
    "/api/setup",
    async (r, reply) => {
      config.configure(r.body, true);
      newSession(reply);
      schedule();
      return config.public(baseUrl);
    },
  );
  app.post<{ Body: { password?: string } }>("/api/login", async (r, reply) => {
    const key = r.ip;
    let a = attempts.get(key);
    if (a && a.until > Date.now() && a.n >= 10)
      return reply
        .code(429)
        .send({ error: "Too many unlock attempts. Try again in 15 minutes." });
    if (!a || a.until < Date.now()) {
      a = { n: 0, until: Date.now() + 900000 };
      attempts.set(key, a);
    }
    a.n++;
    if (
      !config.value.password ||
      !checkPassword(String(r.body?.password || ""), config.value.password)
    )
      return reply
        .code(401)
        .send({ error: "That password did not unlock the vault." });
    attempts.delete(key);
    newSession(reply);
    return { ok: true };
  });
  app.post("/api/logout", async (r, reply) => {
    sessions.delete(cookie(r));
    reply.header(
      "Set-Cookie",
      "vault_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { ok: true };
  });
  app.get("/api/settings", async () => config.public(baseUrl));
  app.post<{ Body: Record<string, unknown> }>(
    "/api/settings",
    async (r, reply) => {
      if (sync.active)
        throw new Error(
          "A backup or indexing run is already in progress. Wait before changing settings.",
        );
      config.configure(r.body);
      if (r.body.password) {
        sessions.clear();
        newSession(reply);
      }
      schedule();
      return config.public(baseUrl);
    },
  );
  app.get("/api/profiles", async () => ({
    profiles: config.public(baseUrl).profiles,
  }));
  app.post<{ Body: { label?: string } }>("/api/oauth/start", async (r) => {
    const label = String(r.body?.label || "My Tumblr")
      .trim()
      .slice(0, 100);
    const state = randomBytes(32).toString("hex");
    for (const [key, p] of pending)
      if (p.expires < Date.now()) pending.delete(key);
    pending.set(state, {
      label,
      session: cookie(r),
      expires: Date.now() + 600000,
    });
    return { url: sync.api.authorize(baseUrl + "/oauth/callback", state) };
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    "/oauth/callback",
    async (r, reply) => {
      const state = r.query.state || "";
      const p = pending.get(state);
      pending.delete(state); // SameSite=Strict cookies may be absent on the cross-site callback; state is the one-use bearer.
      if (!p || p.expires < Date.now() || !sessions.has(p.session))
        return reply
          .code(400)
          .type("text/plain")
          .send(
            "This connection link expired. Return to Settings and try again.",
          );
      if (!r.query.code || r.query.error)
        return reply.redirect("/?view=settings&connection=cancelled");
      try {
        await sync.api.connect(
          r.query.code,
          baseUrl + "/oauth/callback",
          p.label,
        );
        newSession(reply);
        return reply.redirect("/?view=settings&connection=success");
      } catch {
        return reply.redirect("/?view=settings&connection=failed");
      }
    },
  );
  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (r) => {
    if (sync.active)
      throw new Error("A backup or indexing run is already in progress.");
    const a = config.value.accounts.find((a) => a.id === r.params.id);
    if (!a) throw new Error("Choose an existing profile.");
    delete a.token;
    a.error = "Disconnected. Saved archive retained.";
    config.save();
    return { ok: true };
  });
  app.get<{ Querystring: Record<string, string> }>("/api/search", async (r) => {
    const p = r.query;
    if (p.profile && !config.value.accounts.some((a) => a.id === p.profile))
      throw new Error("Choose an existing profile.");
    const ranking =
      p.similar || (p.mode === "image" && p.q)
        ? await clip.rank(p.q || "", p.similar || "", p.profile || "")
        : undefined;
    const result = archive.search(p, ranking);
    if (ranking && !ranking.size)
      result.notice =
        "No indexed images in this scope. Back up images and build the image index in Settings.";
    return result;
  });
  app.get<{ Params: { id: string }; Querystring: { profile?: string } }>(
    "/api/posts/:id",
    async (r, reply) => {
      const detail = archive.detail(r.params.id, r.query.profile);
      return (
        detail ||
        reply.code(404).send({
          error:
            "This saved post is unavailable in this profile. Return to the collection or choose All profiles.",
        })
      );
    },
  );
  app.get<{ Params: { id: string }; Querystring: { thumb?: string } }>(
    "/api/media/:id",
    async (r, reply) => {
      const m = archive.media(r.params.id);
      const name = r.query.thumb ? m?.thumb : m?.path;
      const dir = join(config.dir, r.query.thumb ? "thumbs" : "media");
      if (
        !name ||
        !resolve(dir, name).startsWith(dir + sep) ||
        !existsSync(join(dir, name))
      )
        return reply
          .code(404)
          .send({ error: "This original is not saved. Check backup status." });
      reply.header("Cache-Control", "private, max-age=86400");
      if (r.query.thumb) reply.type("image/webp");
      else
        reply
          .type(
            m?.kind === "image"
              ? "application/octet-stream"
              : m?.kind === "video"
                ? "video/mp4"
                : m?.kind === "audio"
                  ? "audio/mpeg"
                  : "application/octet-stream",
          )
          .header(
            "Content-Disposition",
            'attachment; filename="' + r.params.id + '"',
          );
      return reply.send(createReadStream(join(dir, name)));
    },
  );
  app.get<{ Querystring: { profile?: string } }>("/api/status", async (r) =>
    archive.status(
      config.public(baseUrl).profiles,
      sync.progress,
      r.query.profile,
    ),
  );
  app.post<{ Body: { profile?: string } }>("/api/sync", async (r, reply) => {
    if (sync.active)
      return reply
        .code(409)
        .send({ error: "A backup or indexing run is already in progress." });
    sync.start(r.body?.profile);
    return reply.code(202).send(sync.progress);
  });
  app.post("/api/index", async (_r, reply) => {
    if (sync.active)
      return reply
        .code(409)
        .send({ error: "A backup or indexing run is already in progress." });
    sync.start("", true);
    return reply.code(202).send(sync.progress);
  });
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  if (existsSync(join(publicDir, "index.html"))) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((r, reply) =>
      r.url.startsWith("/api/")
        ? reply.code(404).send({ error: "This endpoint does not exist." })
        : reply.sendFile("index.html"),
    );
  }
  schedule();
  app.addHook("onClose", async () => {
    if (timer) clearTimeout(timer);
    await sync.active;
    archive.close();
    unlock();
  });
  app.decorate("vault", { config, archive, sync, clip });
  return app;
}
