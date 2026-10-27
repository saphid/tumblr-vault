import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { existsSync, createReadStream } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Configuration, checkPassword } from "./config.js";
import { Archive } from "./store.js";
import { Clip } from "./ml.js";
import { Sync, backupDue } from "./sync.js";
import { seedDemo } from "./demo.js";
import { lockVault } from "./lock.js";
import { sweepTemporary } from "./durable.js";
import { Throttle } from "./throttle.js";
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const loopbackHost = (host = "127.0.0.1") =>
  /^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i.test(host);
// Parses a Host header or Origin into scheme-normalized hostname and port, so that
// localhost:80 equals localhost for HTTP. Anything but a bare host[:port] is refused.
function authority(protocol: string, value: string) {
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(value)) return;
  try {
    const u = new URL(protocol + "//" + value);
    return u.hostname + ":" + u.port;
  } catch {
    return;
  }
}
// Short enough to type from a terminal or container log: 20 characters, about 99 bits.
function setupCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let code = "";
  for (let i = 0; i < 20; i++) {
    if (i && i % 5 === 0) code += "-";
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}
export async function buildApp(
  options: {
    dataDir?: string;
    demo?: boolean;
    baseUrl?: string;
    /** Bind address; any non-loopback address requires a one-time setup code. */
    host?: string;
    /** Proxy addresses whose X-Forwarded-For is believed (Fastify trustProxy). */
    trustProxy?: string;
  } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    trustProxy: options.trustProxy || false,
  });
  const baseUrl = (options.baseUrl || "http://localhost:4318").replace(
    /\/$/,
    "",
  );
  const expected = new URL(baseUrl);
  if (!["http:", "https:"].includes(expected.protocol))
    throw new Error("Base URL must be HTTP(S).");
  const config = new Configuration(options.dataDir, options.demo);
  const unlock = await lockVault(config.dir);
  // Holding the lock, no other process can own an interrupted temporary file.
  sweepTemporary(config.dir);
  const archive = new Archive(config.dir);
  await seedDemo(config, archive);
  const clip = new Clip(config, archive);
  const sync = new Sync(config, archive, clip);
  const sessions = new Map<string, { expires: number }>();
  const pending = new Map<
    string,
    { label: string; session: string; expires: number }
  >();
  const throttle = new Throttle();
  // Before setup, anyone who can reach the server could claim it. When it is reachable
  // beyond loopback, setup needs a one-time code printed to the server log.
  let code =
    !config.value.password &&
    (!loopbackHost(options.host) || !LOOPBACK_NAMES.has(expected.hostname))
      ? setupCode()
      : "";
  const aliases = new Set(
    LOOPBACK_NAMES.has(expected.hostname)
      ? [...LOOPBACK_NAMES].map((name) => name + ":" + expected.port)
      : [expected.hostname + ":" + expected.port],
  );
  const allowedHost = (value: string) => {
    const a = authority(expected.protocol, value);
    return !!a && aliases.has(a);
  };
  const allowedOrigin = (value: string) => {
    try {
      const u = new URL(value);
      return (
        u.origin === value &&
        u.protocol === expected.protocol &&
        allowedHost(u.host)
      );
    } catch {
      return false;
    }
  };
  // Password checks share one bounded backoff; never a long lockout of the owner.
  const guarded = (r: FastifyRequest, reply: any) => {
    const wait = Math.ceil(throttle.check(r.ip) / 1000);
    if (!wait) return false;
    reply
      .code(429)
      .header("Retry-After", String(wait))
      .send({
        error:
          "Too many password attempts. Wait " +
          (wait === 1 ? "1 second" : wait + " seconds") +
          ", then try again.",
      });
    return true;
  };
  const same = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  let timer: ReturnType<typeof setInterval> | undefined;
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
  // A periodic due-check (not one long timer) survives restarts, settings changes and
  // intervals beyond setTimeout's 24.8-day ceiling.
  const tick = () => {
    if (
      sync.active ||
      config.value.demo ||
      !config.value.password ||
      !config.value.accounts.some((a) => a.token) ||
      !backupDue(sync.lastBackup, config.value.scheduleHours)
    )
      return;
    try {
      sync.start();
    } catch {
      // Progress records the reason; the next tick retries after the interval.
    }
  };
  const schedule = () => {
    if (!timer) timer = setInterval(tick, 10 * 60000).unref();
  };
  app.addHook("onRequest", async (r, reply) => {
    if (r.url !== "/health" && !allowedHost(r.headers.host || ""))
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
      // The same loopback aliases the Host check accepts, and nothing else.
      if (r.headers.origin !== undefined && !allowedOrigin(r.headers.origin))
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
      /^(Use |Choose |Enter |Unknown |The start date|Image |This image|Tumblr |Save your|Reconnect |Backup |A backup|Demo mode|Setup |Local |The local CLIP |Invalid |Source record)/.test(
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
    return !s.configured
      ? { ...s, setupCodeRequired: !!code }
      : authenticated(r)
        ? s
        : { ...s, dataDir: "", storageFree: 0, profiles: [], mlUrl: "" };
  });
  app.post<{ Body: Record<string, unknown> }>(
    "/api/setup",
    async (r, reply) => {
      if (code) {
        if (guarded(r, reply)) return reply;
        if (
          !same(
            String(r.body?.setupCode || "")
              .trim()
              .toUpperCase(),
            code,
          )
        ) {
          throttle.fail(r.ip);
          return reply.code(403).send({
            error:
              "Enter the setup code shown in the Tumblr Vault server log (for Docker: docker compose logs).",
          });
        }
      }
      // configure() rechecks synchronously: a concurrent loser gets 409 and no session.
      config.configure(r.body, true);
      code = "";
      throttle.succeed(r.ip);
      newSession(reply);
      schedule();
      return config.public(baseUrl);
    },
  );
  app.post<{ Body: { password?: string } }>("/api/login", async (r, reply) => {
    if (guarded(r, reply)) return reply;
    if (
      !config.value.password ||
      !checkPassword(String(r.body?.password || ""), config.value.password)
    ) {
      throttle.fail(r.ip);
      return reply
        .code(401)
        .send({ error: "That password did not unlock the vault." });
    }
    throttle.succeed(r.ip);
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
      // A session alone cannot replace the password; the current one is required.
      if (r.body.password) {
        if (guarded(r, reply)) return reply;
        if (
          !checkPassword(
            String(r.body.currentPassword || ""),
            config.value.password!,
          )
        ) {
          throttle.fail(r.ip);
          return reply.code(403).send({
            error: "Enter your current vault password to set a new one.",
          });
        }
        throttle.succeed(r.ip);
      }
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
      const session = p && sessions.get(p.session);
      if (
        !p ||
        p.expires < Date.now() ||
        !session ||
        session.expires <= Date.now()
      )
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
            'attachment; filename="' + String(m!.id) + '"',
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
    if (timer) clearInterval(timer);
    await sync.stop();
    archive.close();
    await unlock();
  });
  app.decorate("vault", {
    config,
    archive,
    sync,
    clip,
    throttle,
    sessions,
    get setupCode() {
      return code;
    },
  });
  return app;
}
