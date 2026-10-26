# Security and privacy

Vault is a personal, self-hosted application for one trusted household or operator. Profiles organize an archive; they are not separate authorization boundaries. Anyone with the vault password can read all connected profiles.

Default listeners and Compose ports are loopback-only. For remote access, use an authenticated private network such as Tailscale with HTTPS. Do not forward the HTTP port directly to the internet. Use a reverse proxy only with an exact `VAULT_BASE_URL`; proxy-supplied host headers must match it. See [installation](docs/INSTALL.md).

The local password is salted and scrypt-hashed. Browser sessions are HttpOnly and SameSite=Strict, and expire on server restart. Mutating requests require a non-simple same-origin header; cross-origin writes and unexpected Host headers are rejected. OAuth states are random, expiring and one-use. Tumblr scopes are checked on authorization and refresh. Tokens and application secrets are stored in a private local config file so unattended backups can refresh access. Encryption of the disk and backups is the operator’s responsibility. On Windows, protect the data directory using the user’s filesystem ACLs.

Original downloads accept only HTTPS Tumblr hosts, including every redirect. External embeds are retained as source metadata but are not fetched. User post content is rendered as text, never inserted as HTML. Model files download from Hugging Face only when local image indexing/search is enabled and used.

If you find a vulnerability, use the repository’s private vulnerability reporting if available. Otherwise open an issue asking for a private contact without including exploit details or credentials. Never attach a personal database or raw account export.
