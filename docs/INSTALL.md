# Install and settle in

## npm · macOS, Linux or Windows

Install **Node.js 24 LTS or newer** from [nodejs.org](https://nodejs.org/), then install the built release:

```sh
npm install --global https://github.com/saphid/tumblr-vault/releases/download/v1.0.1/tumblr-vault-1.0.1.tgz
tumblr-vault
```

Open **http://localhost:4318** and follow the wizard. You do not need Git, Python, a database server, an npm account, or Docker. The release includes the compiled server and web app. The longer URL is intentional: this release is distributed through GitHub rather than the npm registry.

For a project-local install:

```sh
npm install https://github.com/saphid/tumblr-vault/releases/download/v1.0.1/tumblr-vault-1.0.1.tgz
npx tumblr-vault
```

Local image search uses an optional ONNX runtime. npm installs it by default; on a platform without a prebuilt runtime, npm skips it and the install still succeeds with text search and Immich support. Settings marks local CLIP as not installed. To add it later, repeat the install command with `--include=optional`. Do not pass `--omit=optional`. sharp, which creates image previews, ships its platform binary as an optional package too, so omitting optional packages breaks every install.

If a global npm install reports a permissions error, use the local install above or a Node version manager. Keep the terminal running; Ctrl+C stops the app. Restarting with `tumblr-vault` retains your settings and archive. `tumblr-vault doctor` prints a credential-free environment check.

Try invented content without an account:

```sh
tumblr-vault --demo --data-dir ./vault-demo
```

Use a separate directory for demos. A real vault cannot be opened in demo mode.

## Docker · no Node installation needed

```sh
git clone https://github.com/saphid/tumblr-vault.git
cd tumblr-vault
docker compose up -d --build
```

Open **http://localhost:4318**. Inside the container Vault listens on all interfaces, so before setup it prints a **one-time setup code**. Run `docker compose logs` and open the printed link, or paste the code into the first wizard step. The code works once and is not needed after setup. Compose builds from the checked-out source; `docker compose pull && docker compose up -d` can use the published image when available. The named `vault-data` volume persists all data across container replacements. The container runs as the non-root `node` user. `docker compose logs -f` shows startup; `docker compose down` stops the app without deleting your vault. **Do not use `down -v` if you want to keep the data.**

For a prebuilt image:

```sh
docker run -d --name tumblr-vault --restart unless-stopped \
  -p 127.0.0.1:4318:4318 \
  -v tumblr-vault-data:/data \
  ghcr.io/saphid/tumblr-vault:1.0.1
```

Use `docker logs tumblr-vault` to read the one-time setup code. AMD64 and ARM64 builds are configured in the release workflow. Release tags publish `1.0.1` and `latest`. A manual workflow run from a branch publishes only branch and commit tags. The release verification page states which artifacts were actually built and tested. Docker Desktop provides Compose on macOS and Windows; on Linux install Docker Engine and the Compose plugin.

## The setup wizard

1. **Make it yours:** choose a vault password (at least 12 characters). This password is for the local app, separate from Tumblr. When Vault is reachable beyond this device (Docker, `--host 0.0.0.0` or a non-local `--base-url`), also enter the one-time setup code from the server log. Plain loopback installs never need it.
2. **Choose your search:** text-only needs no model. Local image search downloads CLIP on first indexing and runs on your CPU. Allow about 1 GB disk and 2 GB available RAM, in addition to your archive. Or reuse an existing Immich machine-learning server.
3. **Connect Tumblr:** register a free application at [Tumblr’s application page](https://www.tumblr.com/oauth/apps). Give it a name, the local app URL and the exact callback URL shown by the wizard. Copy its OAuth consumer key and secret into the wizard. Tumblr may require account verification or a CAPTCHA. You can leave both fields blank and connect later in Settings.
4. **Open your vault:** approve `basic offline_access` on Tumblr. Then open **Backup status → Back up now**. The first backup may take hours or days for a large account because Tumblr limits API calls. Saved pages persist; quota waits resume automatically while the app runs.

To connect another account, switch the signed-in account on Tumblr, then use **Settings → Connect Tumblr account** with a distinct profile label. Saved content remains when an account is disconnected. To revoke access at Tumblr as well, remove the app in Tumblr’s account settings.

Images become searchable only after they have downloaded and been indexed. Enabling CLIP later does not require downloading originals again: use **Build image index**. Model changes require reindexing. Local CLIP and Immich vectors are kept distinct.

## Storage and schedules

Defaults:

| System  | Data directory                                                 |
| ------- | -------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/tumblr-vault`                   |
| Linux   | `$XDG_DATA_HOME/tumblr-vault` or `~/.local/share/tumblr-vault` |
| Windows | `%LOCALAPPDATA%\tumblr-vault`                                  |
| Docker  | `/data` in the persistent volume                               |

Choose a drive before first setup with `tumblr-vault --data-dir /path/to/vault`, or `VAULT_DATA_DIR`. Keep SQLite on a local filesystem. Network storage semantics vary; this release does not supervise network mounts. Vault refuses downloads below a 2 GiB free-space reserve and checks during streaming. Individual media downloads are bounded to 1 GiB. Originals are deduplicated by SHA-256.

Automatic backups run only while Vault is running, at the interval selected in Settings. The interval is measured from the start of the last backup, which the vault records, so restarts neither postpone nor repeat a backup; a due backup starts within about ten minutes of startup. There is no separate OS scheduler. Docker’s restart policy keeps it running. On npm installs, use your normal process supervisor if you want unattended startup.

## Tailscale and other private devices

Start on loopback, then configure [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) on that machine. For example:

```sh
tailscale serve --bg http://127.0.0.1:4318
```

Read the HTTPS URL Tailscale prints. Restart Vault with that exact base URL:

```sh
tumblr-vault --base-url https://your-machine.your-tailnet.ts.net
```

For Docker set `VAULT_BASE_URL` to that HTTPS URL in Compose and recreate the container. Keep the port published on loopback. Update the Tumblr application callback to `https://your-machine.your-tailnet.ts.net/oauth/callback`; the Settings page shows the authoritative URL. Serve is tailnet-only; do not enable Funnel. Vault’s password still protects the shared app, and sessions use Secure cookies when the base URL is HTTPS.

Password attempts slow down after a few failures, by at most a minute per attempt, and never lock you out for long. Behind a reverse proxy every visitor can look like the proxy. If your proxy runs on this machine and sets `X-Forwarded-For`, start Vault with `--trust-proxy 127.0.0.1` (or `VAULT_TRUST_PROXY`) so the slow-down applies per visitor. Forwarded headers from any other address are ignored.

The app checks the exact browser Host and write Origin. With a local base URL, `localhost`, `127.0.0.1` and `[::1]` on the same port are treated as the same app. A **Host not allowed** response usually means you opened an IP/hostname different from `VAULT_BASE_URL`. Use the configured URL or restart with the correct base URL. A callback error usually means the Tumblr registration and Vault URL differ.

## Upgrade, back up, restore

Stop the app and copy the **whole data directory** to another drive before upgrades. It contains the SQLite database, originals, thumbnails, model cache and private credentials. `exports/latest.sqlite` is a consistent database snapshot after a successful pipeline, but is not a copy of original media or credentials and is not an independent backup.

For npm, install the new release URL and restart with the same data directory. Version 1.0.1 upgrades the database in place the first time it opens: it adds a search-index key map and preview status, and keeps every record, vector and BM25 result. Keep your folder copy until you have opened the upgraded vault. If you return to 1.0.0, it can still open the upgraded database. When you upgrade again, 1.0.1 checks the search index once and repairs any changes the older version made. For Docker, update the version/checkout and rebuild or pull, then run `docker compose up -d`. Retain the volume. To restore, stop the app, restore the whole folder/volume from your copy, and start the matching app version. Credentials in backups are sensitive; protect copies accordingly.

## Import the earlier Python archive

Stop the old writer or use a consistent source copy. Run the following with a **new empty destination**, while Vault is stopped:

```sh
tumblr-vault import-legacy --from /path/to/old-archive --data-dir /path/to/new-vault
tumblr-vault --data-dir /path/to/new-vault
```

The source must contain `data/archive.sqlite`. Originals and previews are read from `media/` and `thumbs/` beside it. If the earlier archive kept originals elsewhere (its `TUMBLR_MEDIA_ROOT`, often a separate drive), point to it:

```sh
tumblr-vault import-legacy --from /path/to/old-archive --media-from /mnt/old-originals --data-dir /path/to/new-vault
```

`--thumbs-from` does the same for previews. Before writing anything, the importer counts recorded originals and previews it cannot find. If any originals are missing, it stops and changes nothing. Then either fix the path, or add `--allow-missing` to import anyway. A later backup downloads missing originals again, but only those Tumblr still serves. Missing previews are only a warning: the next backup rebuilds them from imported originals. The result reports `missingOriginals`, `missingThumbs` and warnings. **Keep the earlier archive and its originals until you have checked the new vault.** The importer opens the source DB read-only, copies source records/memberships, available media and embeddings, and creates a destination snapshot. It does not import secrets or alter the source. Set a new vault password and reconnect accounts for future backups. Ensure enough space for a full copy. If an import fails, remove only the incomplete new destination and retry; it deliberately refuses a nonempty destination. This importer targets this project’s earlier schema, not arbitrary export ZIPs.
