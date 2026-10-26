#!/usr/bin/env node
import { importLegacy } from "./import.js";
import { parseArgs } from "node:util";
import { buildApp } from "./server.js";
import { defaultDir, Configuration } from "./config.js";
const { values, positionals } = parseArgs({
  options: {
    host: { type: "string", default: process.env.VAULT_HOST || "127.0.0.1" },
    port: { type: "string", default: process.env.PORT || "4318" },
    "data-dir": { type: "string", default: defaultDir() },
    "base-url": { type: "string", default: process.env.VAULT_BASE_URL },
    from: { type: "string" },
    demo: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(
    `Tumblr Vault — your Tumblr, kept.\n\nUsage: tumblr-vault [options]\n       tumblr-vault doctor [options]\n       tumblr-vault import-legacy --from <legacy-root> --data-dir <new-vault>\n\n  --host <address>    Bind address (default 127.0.0.1)\n  --port <number>     HTTP port (default 4318)\n  --data-dir <path>   Persistent archive directory\n  --base-url <url>    Exact browser URL for OAuth and request protection\n  --demo             Synthetic demo in a separate directory; no API calls\n  --help             Show this help\n\nOpen http://localhost:4318 to follow the setup wizard.\nUse HTTPS through Tailscale Serve for remote access.\nNode.js 24+ required. Stop with Ctrl+C; restart to keep saved content.`,
  );
} else if (values.version) {
  console.log("1.0.0");
} else if (positionals[0] === "import-legacy") {
  if (!values.from)
    throw new Error(
      "Use --from <legacy-directory> and --data-dir <new-vault-directory>.",
    );
  console.log(
    JSON.stringify(
      await importLegacy(values.from, values["data-dir"]),
      null,
      2,
    ),
  );
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
  });
  await app.listen({ host: values.host, port });
  console.log(
    `\n  Tumblr Vault\n  Open ${baseUrl}\n  Data: ${values["data-dir"]}\n${values.demo ? "  Synthetic demo — no Tumblr connection.\n" : ""}`,
  );
  const stop = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
