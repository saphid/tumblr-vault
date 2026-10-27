#!/usr/bin/env node
import { importLegacy } from "./import.js";
import { parseArgs } from "node:util";
import { buildApp } from "./server.js";
import { defaultDir, Configuration, localRuntime } from "./config.js";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const { values, positionals } = parseArgs({
  options: {
    host: { type: "string", default: process.env.VAULT_HOST || "127.0.0.1" },
    port: { type: "string", default: process.env.PORT || "4318" },
    "data-dir": { type: "string", default: defaultDir() },
    "base-url": { type: "string", default: process.env.VAULT_BASE_URL },
    from: { type: "string" },
    "media-from": { type: "string" },
    "thumbs-from": { type: "string" },
    "allow-missing": { type: "boolean", default: false },
    "trust-proxy": { type: "string", default: process.env.VAULT_TRUST_PROXY },
    demo: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(
    `Tumblr Vault — your Tumblr, kept.\n\nUsage: tumblr-vault [options]\n       tumblr-vault doctor [options]\n       tumblr-vault import-legacy --from <legacy-root> --data-dir <new-vault>\n         [--media-from <originals-dir>] [--thumbs-from <previews-dir>] [--allow-missing]\n\n  --host <address>    Bind address (default 127.0.0.1)\n  --port <number>     HTTP port (default 4318)\n  --data-dir <path>   Persistent archive directory\n  --base-url <url>    Exact browser URL for OAuth and request protection\n  --trust-proxy <ips> Believe X-Forwarded-For only from these proxy addresses\n  --demo             Synthetic demo in a separate directory; no API calls\n  --help             Show this help\n\nOpen http://localhost:4318 to follow the setup wizard.\nUse HTTPS through Tailscale Serve for remote access.\nNode.js 24+ required. Stop with Ctrl+C; restart to keep saved content.`,
  );
} else if (values.version) {
  console.log(version);
} else if (positionals[0] === "import-legacy") {
  if (!values.from)
    throw new Error(
      "Use --from <legacy-directory> and --data-dir <new-vault-directory>.",
    );
  try {
    const result = await importLegacy(values.from, values["data-dir"], {
      mediaFrom: values["media-from"],
      thumbsFrom: values["thumbs-from"],
      allowMissing: values["allow-missing"],
    });
    console.log(JSON.stringify(result, null, 2));
    for (const warning of result.warnings) console.warn("Warning: " + warning);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (positionals[0] === "doctor") {
  const c = new Configuration(values["data-dir"], values.demo);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        dataDir: c.dir,
        freeGiB: Math.round(c.free() / 1024 ** 3),
        configured: !!c.value.password,
        imageSearch: c.value.clip,
        localClipRuntime: localRuntime.available(),
      },
      null,
      2,
    ),
  );
} else {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Use a port between 1 and 65535.");
  const baseUrl = values["base-url"] || `http://localhost:${port}`;
  const app = await buildApp({
    dataDir: values["data-dir"],
    demo: values.demo,
    baseUrl,
    host: values.host,
    trustProxy: values["trust-proxy"],
  });
  await app.listen({ host: values.host, port });
  const code = (app as any).vault.setupCode as string;
  console.log(
    `\n  Tumblr Vault\n  Open ${code ? `${baseUrl}/#setup=${code}` : baseUrl}\n  Data: ${values["data-dir"]}\n${code ? `  One-time setup code: ${code}\n  (Required because Vault is reachable beyond this device.)\n` : ""}${values.demo ? "  Synthetic demo — no Tumblr connection.\n" : ""}`,
  );
  const stop = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
