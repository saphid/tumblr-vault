# Changelog

## 1.0.1

Reliability, scaling and security fixes from the delayed 1.0.0 reviews ([#1](https://github.com/saphid/tumblr-vault/issues/1), [#2](https://github.com/saphid/tumblr-vault/issues/2)). Existing vaults upgrade in place on first open.

- **Backups:** one account's failure no longer stops the others, media downloads, previews or the snapshot; the run reports `partial` and names the account. A run stopped part-way resumes metadata only if every account was read. Scheduling uses the recorded last backup start, so restarts neither postpone nor repeat backups and long intervals no longer overflow Node's timer. With the default daily schedule, the first backup starts within about ten minutes of connecting an account. Shutdown no longer waits for quota sleeps, downloads, previews or model work.
- **Tokens:** if Tumblr rotates a refresh token but grants an unexpected scope or expiry, the rotated refresh token is saved so the account can recover, and the refused access token is never used. A numeric-string expiry is accepted.
- **Media:** originals and their directory entries are flushed before they are recorded as saved. Previews are built from the saved original. Storage failures are reported and retried without downloading again; unsupported or corrupt images are reported once. Temporary files left by a crash are removed at startup while the vault lock is held.
- **Search at scale:** search updates no longer scan the whole FTS index for each record, so the time to save a record stays flat as the archive grows. Results are ranked, grouped and paged in SQL, and only the visible page is loaded in full. Image search streams vectors and scores each image once. BM25 weights and ordering are unchanged.
- **Setup and sign-in:** concurrent first-run requests have exactly one winner. A vault reachable beyond loopback needs a one-time setup code from the server log. `localhost`, `127.0.0.1` and `[::1]` work for both reading and writing. Password failures back off for at most a minute instead of a 15-minute lockout, and old attempt records expire. `--trust-proxy` is opt-in. Changing the password requires the current one. An OAuth callback requires the starting session to still be valid.
- **Legacy import:** `--media-from` and `--thumbs-from` locate originals and previews stored outside the old archive folder. Missing originals stop the import before anything is written, unless `--allow-missing` is given. The result reports missing counts and a reminder to keep the old archive.
- **Install:** local CLIP's Transformers.js/ONNX runtime is an optional dependency, so text-only installs work where it cannot install, and the app explains how to add it. `tumblr-vault --version` reads the package version.
- **Release workflow:** actions are pinned to full commit SHAs. A manual run from a branch publishes namespaced branch and commit image tags instead of failing with no tags.

## 1.0.0

The first public TypeScript edition.

- Guided browser setup with a local vault password and read-only Tumblr OAuth.
- npm package and Docker Compose installation, with a single persistent directory.
- Multiple profiles, blog posts, likes, raw JSON and content-addressed original media.
- Weighted BM25 keyword search, UTC date filters, tags and scoped facets.
- Local CLIP image-meaning search and find-similar, with optional Immich ML support.
- Grouped original/reblog entries, saved actions and version inspection.
- Responsive charcoal reader, image gallery, keyboard focus and clear backup coverage.
- Resumable metadata pages and downloads, quota waits, disk reserve and SQLite snapshots.
- Synthetic demo and an explicit offline importer from the earlier Python archive.

See [verification](docs/VERIFICATION.md) for the exact checks and current limits.
