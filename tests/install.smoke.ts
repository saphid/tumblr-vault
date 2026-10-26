// A real fresh npm install of the distributable, independent of this checkout's dependencies.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
async function start() {
  child = spawn(
    process.execPath,
    [cli, "--demo", "--data-dir", data, "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (b) => (log += b));
  child.stderr?.on("data", (b) => (log += b));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Installed server failed to start: " + log);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise<void>((r) => child!.once("exit", () => r()));
  child.kill("SIGTERM");
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
  console.log(
    "PASS: fresh npm install, executable help, bundled UI, wizard setup, BM25 query, restart, locked session and persisted 8-entry archive.",
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
