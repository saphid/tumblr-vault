# Make keeping things better

Thanks for helping. A clear bug report, a small fix, or a thoughtful UX improvement all count.

## Development

Use Node.js 24 LTS or newer and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev -- --demo --data-dir ./demo-data
```

Open http://localhost:4318. Demo mode creates invented posts and locally generated images; it never connects to Tumblr. Keep demo data outside Git (use a temporary directory, or add your chosen folder to your local excludes).

`npm run test:install` builds a package and tests a fresh npm install, setup, locking, restart and persisted search. It also tests a text-only install without the optional local CLIP runtime, and the one-time setup code printed for an exposed vault. `npm run test:clip` downloads the public CLIP model and tests real local inference; allow roughly 1 GB disk and 2 GB memory. The normal suite is deterministic and uses synthetic fixtures, without contacting Tumblr or downloading models.

Runtime/server/CLI code is in `src/`; the React client is in `client/`. `src/contract.ts` describes the API types. SQLite uses FTS5 with BM25. Native media handling uses sharp, and local CLIP uses Transformers.js with ONNX Runtime.

## Pull requests

Keep changes focused. Describe the user-visible behavior, run the relevant checks, and attach synthetic screenshots for UI changes. Preserve these invariants:

- Source JSON, saved actions and versions are retained. Shared images do not establish post identity.
- No tokens, credentials, private media, database files or personal archive details in code, fixtures, screenshots, logs or issues.
- Tumblr access stays read-only: exactly `basic offline_access`.
- Media download redirects are checked at every hop; arbitrary hosts remain blocked.
- Search, profile and return context survive navigation. Empty results and errors stay distinct.
- Mobile controls have useful targets, focus is visible, and reduced motion is respected.

Run `npm run format` before submitting. Please discuss significant schema or retrieval changes in an issue first. Schema changes go through `migrate()` in `src/store.ts`: bump `SCHEMA_VERSION`, keep existing vaults readable, and add a test that opens a database written by the previous release. GitHub Actions are pinned to full commit SHAs, with the version in a comment; update both together.
