// A real fresh npm install of the distributable, independent of this checkout's dependencies.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const dir = mkdtempSync(join(tmpdir(), "tumblr-vault-install-"));
const pack = JSON.parse(
  execFileSync(npm, ["pack", "--ignore-scripts", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }),
)[0];
const tarball = resolve(pack.filename);
assert(pack.files.some((f: { path: string }) => f.path === "dist/cli.js"));
assert(
  pack.files.some((f: { path: string }) => f.path === "public/index.html"),
);
assert(
  !pack.files.some((f: { path: string }) =>
    /\.py$|config\.json$|\.sqlite/.test(f.path),
  ),
);
console.log("Installing built package into fresh prefix…");
execFileSync(
  npm,
  ["install", "--global", "--prefix", dir, "--no-audit", "--no-fund", tarball],
  { stdio: "pipe", shell: process.platform === "win32" },
);
const packageDir =
  process.platform === "win32"
    ? join(dir, "node_modules", "tumblr-vault")
    : join(dir, "lib", "node_modules", "tumblr-vault");
const cli = join(packageDir, "dist", "cli.js");
assert(
  execFileSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
  }).includes("Tumblr Vault"),
);
assert.equal(
  execFileSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
  }).trim(),
  JSON.parse(readFileSync("package.json", "utf8")).version,
);
const port = await new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const address = s.address() as { port: number };
    s.close(() => res(address.port));
  });
});
const base = "http://localhost:" + port;
const data = join(dir, "vault-data");
let child: ChildProcess | undefined;
let log = "";
async function start(extra: string[] = [], dir = data) {
  log = "";
  child = spawn(
    process.execPath,
    [cli, "--demo", "--data-dir", dir, "--port", String(port), ...extra],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (b) => (log += b));
  child.stderr?.on("data", (b) => (log += b));
  // Windows forcibly terminates Node on SIGTERM. An unclean owner leaves the
  // 10-second filesystem lease; startup may need the full 12-second lock retry.
  const deadline = Date.now() + 30_000;
  let lastHealth = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        "Installed server exited before becoming healthy: " + log,
      );
    try {
      const health = await fetch(base + "/health", {
        signal: AbortSignal.timeout(1000),
      });
      await health.text();
      if (health.ok) return;
      lastHealth = "HTTP " + health.status;
    } catch (error) {
      lastHealth = String((error as Error).cause || error);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    "Installed server failed to start (" + lastHealth + "): " + log,
  );
}
async function stop(signal: NodeJS.Signals = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((r) => child!.once("exit", () => r()));
  child.kill(signal);
  await stopped;
}
try {
  await start();
  const html = await (await fetch(base)).text();
  assert(html.includes("Tumblr Vault"));
  const r = await fetch(base + "/api/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vault-request": "1",
      Origin: base,
    },
    body: JSON.stringify({
      password: "synthetic-install-password",
      clip: "off",
      scheduleHours: 0,
    }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  let cookie = r.headers.get("set-cookie")!.split(";")[0];
  let search = (await (
    await fetch(base + "/api/search?q=quiet", { headers: { cookie } })
  ).json()) as any;
  assert(search.total > 0);
  await stop();
  await start();
  assert.equal((await fetch(base + "/api/search")).status, 401);
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vault-request": "1",
      Origin: base,
    },
    body: JSON.stringify({ password: "synthetic-install-password" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  search = (await (
    await fetch(base + "/api/search", { headers: { cookie } })
  ).json()) as any;
  assert.equal(search.total, 8);
  assert(JSON.parse(readFileSync(join(data, "config.json"), "utf8")).password);
  await stop();
  // A text-only install: the optional local CLIP runtime is absent (npm skips an optional
  // dependency that cannot install). Text search works and the UI explains the option.
  const runtime = join(
    packageDir,
    "node_modules",
    "@huggingface",
    "transformers",
  );
  assert(existsSync(runtime), "optional runtime installed by default");
  rmSync(runtime, { recursive: true, force: true });
  await start();
  const write = {
    "Content-Type": "application/json",
    "x-vault-request": "1",
    Origin: base,
  };
  const unlock = await fetch(base + "/api/login", {
    method: "POST",
    headers: write,
    body: JSON.stringify({ password: "synthetic-install-password" }),
  });
  cookie = unlock.headers.get("set-cookie")!.split(";")[0];
  const settings = (await (
    await fetch(base + "/api/settings", { headers: { cookie } })
  ).json()) as any;
  assert.equal(settings.localClipAvailable, false);
  const local = await fetch(base + "/api/settings", {
    method: "POST",
    headers: { ...write, cookie },
    body: JSON.stringify({ clip: "local" }),
  });
  assert.equal(local.status, 400);
  assert.match(((await local.json()) as any).error, /--include=optional/);
  search = (await (
    await fetch(base + "/api/search?q=quiet", { headers: { cookie } })
  ).json()) as any;
  assert(search.total > 0);
  await stop();
  // Exercise stale-lease recovery everywhere, including platforms where SIGTERM
  // normally permits clean shutdown. The old ten-second startup budget fails here.
  await start();
  await stop("SIGKILL");
  await start();
  assert.equal((await fetch(base + "/api/search")).status, 401);
  const recovered = await fetch(base + "/api/login", {
    method: "POST",
    headers: write,
    body: JSON.stringify({ password: "synthetic-install-password" }),
  });
  assert.equal(recovered.status, 200);
  cookie = recovered.headers.get("set-cookie")!.split(";")[0];
  search = (await (
    await fetch(base + "/api/search", { headers: { cookie } })
  ).json()) as any;
  assert.equal(search.total, 8);
  await stop();
  // Reachable beyond loopback: the CLI prints a one-time setup code and setup needs it.
  const exposed = join(dir, "exposed-data");
  await start(["--base-url", "https://vault.example.test"], exposed);
  for (let i = 0; i < 50 && !log.includes("setup code"); i++)
    await new Promise((r) => setTimeout(r, 100));
  const code = /One-time setup code: ([A-Z2-9-]+)/.exec(log)?.[1];
  assert(code, log);
  assert(log.includes("https://vault.example.test/#setup=" + code));
  console.log(
    "PASS: fresh npm install, executable help/version, bundled UI, wizard setup, BM25 query, restart, locked session, persisted 8-entry archive, text-only install without the optional CLIP runtime, forced-kill lease recovery, and the exposed setup code.",
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
