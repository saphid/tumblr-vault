# Release verification · 1.0.0

This is a clean TypeScript edition. The earlier private Python repository, its history and its running archive are not included in this public repository. All fixtures and screenshots here are synthetic.

## Performed checks

- TypeScript server/CLI and React type checks pass; production Vite/server build passes. [Cross-platform CI run 40266700745](https://github.com/saphid/tumblr-vault/actions/runs/40266700745) completed successfully on macOS, Linux and Windows, plus Docker build/start, for source commit `da2a9c6`. Every OS ran all 16 backend tests, the production dependency audit and a fresh package install/setup/restart check.
- 16 synthetic backend tests pass: grouped-entry pagination/actions, BM25 weights/matching, UTC boundaries/reversed dates, scoped facets/shared media counts, durable checkpoints/source JSON/snapshot, safe rendering/extraction, media redirects, exact OAuth scope/private config/password hashing, serialized token rotation/quota delay, vector validation, setup/login/origin/Host guards, short intermediate pagination, single-instance leases, read-only legacy import (including JPEG-to-WebP previews), one-use OAuth state, password-change session invalidation and container health probes with an external base URL.
- Fresh **macOS, Linux and Windows npm tarball installs** passed without using the source checkout’s runtime dependencies: CLI help, bundled UI, setup, keyword query, process restart, session locking and persisted eight-entry archive.
- **Docker on Linux** passed setup, BM25 search, eight saved media/entries, non-root UID 1000, external-base-URL health checks, graceful restart and forced SIGKILL/restart with the same persistent volume. The filesystem heartbeat lease recovered after an unclean exit. The isolated synthetic test container and volume were removed afterward. The final source also passes the CI Docker build/start job.
- **Real local CLIP** passed on macOS CPU through Transformers.js/ONNX: text and image inference, normalized 512D vectors, persistent indexing and self-similarity 0.99999997. First model cache used approximately 594 MB. This establishes runtime operation, not semantic relevance quality across a personal archive.
- `npm audit --omit=dev` reported zero known vulnerabilities for the resolved production dependencies on 2026-10-26.
- Collaborative Chromium preview exercised four-step setup, connect-later, keyword search, scoped profiles, tags/filter application, detail/Back, gallery, settings persistence, status, lock/unlock and error recovery at 1440/390/320 CSS pixels. Checked pages did not overflow horizontally. Only invented demo content was used.

## Browser findings and follow-up

The first pass found two actionable issues: the mobile layout hid the only lock action, and gallery subtree transitions lost keyboard focus. A universal topbar lock control and explicit gallery focus handoff were added. A fresh targeted follow-up completed PASS for both fixes: the mobile lock is visible, hit-testable and 44×44 px at 320/390 px; actual lock/unlock works at 320 px from Collection and Settings. Gallery entry focuses its named group, arrow keys are handled there, Escape restores the image opener, and a second Escape restores the collection title link at 320/1440 px. Final assets were `index-F2T0tskU.js` and `index-Cby9rdHA.css`. The closure task was `tumblr-vault-browser-closure-20261026-r1`, actual `codex` / `gpt-6-astra`, high, final completed with no actionable findings in those target paths. Multi-image navigation, physical devices, screen readers and exhaustive accessibility conformance were not established by the one-image demo.

Private detailed QA artifacts are intentionally not part of this repository. Public screenshots in `docs/images` contain only the generated demonstration archive.

## Independent source-review limitation

T3 task `tumblr-vault-source-review-20261026-r1` (full ID `node:delegated-task:command%3Amcp%3Af8d23120-605d-48ef-afe7-8b7ee6ec2dd4%3Adelegate-task%3Atumblr-vault-source-review-20261026-r1`) used actual provider `claudeAgent`, model `claude-opus-5-5`, high effort, inherited permissions with a read-only brief. Final status **failed** immediately: “Claude API rate limit reached. Try again later.” No source review occurred and no findings were produced. Browser QA used actual `codex` / `gpt-6-astra`, high; the initial task completed with the two findings above.

## What is not claimed

No real user OAuth authorization or full live Tumblr backup was run against the rewritten edition during release QA. Those paths have synthetic protocol/persistence tests and were adapted from the prior implementation; a personal archive remains subject to Tumblr availability and quota. No public-internet deployment, full restore drill, network filesystem reliability, Immich server interoperability pass, or guaranteed source-history completeness is claimed. macOS, Linux and Windows checks passed in the linked workflow. This does not establish every distribution, filesystem or hardware configuration.

The npm artifact is distributed as a compiled GitHub release tarball, not as a registry publication. Installation through `npm install` works without an npm account. Docker can always build from the public source; published-image availability is tracked by the release workflow.
