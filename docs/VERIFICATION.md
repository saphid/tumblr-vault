# Release verification

## 1.0.1

This version fixes the delayed review findings in [#1](https://github.com/saphid/tumblr-vault/issues/1) and [#2](https://github.com/saphid/tumblr-vault/issues/2). These checks ran locally on macOS (Apple Silicon, Node.js 24.12.0) on 2026-10-27, using synthetic fixtures only.

- Server and client type checks pass, and Prettier reports no changes.
- **50 automated tests pass:** the 29 backend tests and 21 new robustness tests. The new tests cover:
  - concurrent setup and the one-time setup code;
  - loopback alias Host and Origin rules;
  - bounded password backoff, expiry and the opt-in proxy;
  - current-password confirmation and OAuth session expiry;
  - account failure isolation;
  - refresh-token rotation after a refused grant;
  - preview storage failures and corrupt content;
  - flushing before an original is recorded, and the crash temporary-file sweep;
  - migrating a database written with the exact 1.0.0 schema, including a later 1.0.0 write;
  - flat per-record ingest cost at 20,000 records;
  - SQL grouping and paging against the previous algorithm, with a fixed query count;
  - chunked image ranking against a full scan;
  - legacy import from external originals;
  - SHA-pinned workflow actions and branch image tags isolated from release names;
  - interrupted older FTS writes with rowid reuse;
  - import overlap through source, destination and parent-directory symlinks;
  - durable file/directory flush retries after storage errors.
- **Fresh npm package install** (`npm run test:install`) passes: help and version, bundled UI, setup, keyword search, restart, locked session and an 8-entry archive. With the optional CLIP runtime removed, Vault still starts and searches text, and Settings explains how to add the runtime. Started with a non-local base URL, it prints a one-time setup code. `npm install --omit=optional` is not a supported mode: it also omits sharp's platform binary, which 1.0.0 needed as well.
- **Real local CLIP** (`tests/clip.integration.ts`) passes with the public model from a local cache. It produced normalized 512D vectors, and an image scored 0.99999997 against itself.
- The same synthetic scenarios ran against the 1.0.0 source (`24f295f`) and the 1.0.1 source:

| Scenario                                                | 1.0.0                                         | 1.0.1                                                       |
| ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Two concurrent first-run setups                         | 200 and 200; first owner then gets 401        | 200 and 409; first owner unlocks                            |
| Write from `http://127.0.0.1:4318`                      | 403                                           | 200                                                         |
| One of two accounts fails metadata                      | run `failed`, healthy account not read        | run `partial`, healthy account saved                        |
| Refresh rotates the token but grants a disallowed scope | old, retired refresh token kept               | rotated refresh token kept, access token cleared            |
| Previews directory refuses writes once                  | preview never retried                         | `preview_storage`, rebuilt next backup with no new download |
| Ten wrong passwords, then the right one                 | locked out for 15 minutes                     | 1-second wait, then unlocked                                |
| Changing the password without the current one           | 200                                           | 403                                                         |
| Plan for updating a search row                          | `SCAN fts VIRTUAL TABLE INDEX 0:` (full scan) | `INDEX 0:=` (rowid lookup)                                  |
| Legacy import with originals outside `media/`           | reports success with no originals             | stops before writing, asks for `--media-from`               |

- Scaling on 20,000–21,000 synthetic records, each with about 5 KB of source JSON (median of 9 runs unless noted):

| Measure                                         | 1.0.0     | 1.0.1   |
| ----------------------------------------------- | --------- | ------- |
| 1,000 record saves, empty archive               | 1,138 ms  | 227 ms  |
| 1,000 record saves, at 20,000 records           | 35,830 ms | 333 ms  |
| Browse, first page                              | 221 ms    | 55 ms   |
| Browse, page 40                                 | 154 ms    | 55 ms   |
| Keyword search matching every record            | 199 ms    | 106 ms  |
| Keyword search in one profile                   | 406 ms    | 118 ms  |
| Image ranking over 21,000 vectors (median of 5) | 60 ms     | 43 ms   |
| Memory growth on first image ranking (RSS)      | 49.8 MB   | 30.7 MB |
| Similar-image results page                      | 224 ms    | 75 ms   |

Image ranking is still an exact linear scan; it is faster and uses less memory, but it is not an index.

The independent source review (`codex` / `gpt-6.1-sol`, high; parent-recorded T3 task ID
`node:delegated-task:command%3Amcp%3A2b19377d-f9ac-4d5e-a264-1bc810a3d435%3Adelegate-task%3Atumblr-vault-fix-all-review-20261027-r1`) completed and identified four medium
findings: interrupted legacy FTS rowid reuse, symlink import overlap, skipped
flushes on an existing original, and branch/release image tag collisions.
Each reproduced in a focused regression before its fix and passes afterward.
The follow-up review (actual provider `claudeAgent`, model `claude-opus-5-5`,
high; parent-recorded T3 task ID
`node:delegated-task:command%3Amcp%3A2b19377d-f9ac-4d5e-a264-1bc810a3d435%3Adelegate-task%3Atumblr-vault-fix-all-review-20261027-r2`)
completed with all four findings closed and nothing blocking shipping. It passed
50 tests, typechecks, formatting and diff checks. Its low-severity version-tag
suggestion was also applied: manual runs from tags without the `v` prefix cannot
emit version or latest image tags. A focused configuration regression covers
that guard. These dispatch IDs were recorded by the parent; the reviewers were
not supplied their own T3 task IDs in their briefs.

The final focused review (actual `claudeAgent` / `claude-opus-5-5`, high;
parent-recorded T3 task ID
`node:delegated-task:command%3Amcp%3A2b19377d-f9ac-4d5e-a264-1bc810a3d435%3Adelegate-task%3Atumblr-vault-fix-all-review-20261027-r3`)
found **no actionable issues in the r2→r3 change or regressions it introduces**.
It verified frozen patch SHA-256
`f29cd5af4a6492f483369d70b248c1721629406e85daf5df32b9205dddfc53d6`
and passed all 50 tests, typechecks, formatting and whitespace checks.

**Linux Docker candidate:** the production Dockerfile built successfully on
Linux amd64. An isolated synthetic container passed exposed setup-code
requirement/refusal/acceptance, bundled UI, BM25, eight saved originals,
non-root UID 1000, graceful restart and forced SIGKILL/restart with the same
volume. Sessions were locked after both restarts; the filesystem lease and
saved content recovered. The test container and volume were removed. This
checks the source candidate; the separate registry-image checks below establish published-image behavior.

**Cross-platform CI:** [run 40462916102](https://github.com/saphid/tumblr-vault/actions/runs/40462916102)
passed on source [d39af0f](https://github.com/saphid/tumblr-vault/commit/d39af0f43b4b8f489498b50746a1a2591591774f).
Windows, macOS and Linux each passed all 50 tests, both typechecks, production
build, dependency audit and fresh npm install/setup/search/restart checks.
The Linux Docker build/start job also passed. The production dependency audit
reported zero known vulnerabilities on 2026-10-27.

**Restart-test correction after publication:** the duplicate tag-triggered
[CI run 40463138993](https://github.com/saphid/tumblr-vault/actions/runs/40463138993)
failed its Windows fresh-install startup check twice, despite the earlier pass
on the identical source. Windows terminates Node forcibly on SIGTERM, leaving
the filesystem lease until expiry. The smoke test allowed roughly ten seconds
for startup, shorter than the lease plus lock retry window. A local installed
package reproduced the timeout after SIGKILL at 10.26 seconds. The test now
allows thirty seconds, bounds each health request, reports the last health
error or early process exit, and checks forced-kill recovery explicitly on all
platforms. This changes test coverage rather than the released runtime or its
lease settings. Follow-up cross-platform CI is recorded after it completes.

The combined test/workflow delta was independently reviewed read-only on actual
`claudeAgent` / `claude-opus-5-5`, high, final status completed, with no
introduced bugs found. Parent-recorded task ID:
`node:delegated-task:command%3Amcp%3A2b19377d-f9ac-4d5e-a264-1bc810a3d435%3Adelegate-task%3Atumblr-vault-install-lease-review-20261027-r1`.
The frozen executable/config/test patch SHA-256 was
`f75feb6677d657f2cc950bc46d4ddc049c0dad647bf091c55113a886cc521955`.
The reviewer passed strict TypeScript checking of the install smoke script,
Prettier and the focused workflow regression. The parent separately passed
all 50 tests, both project typechecks and the complete corrected fresh-install
smoke, including forced-kill recovery. Windows execution of the corrected test passed in the
[follow-up push run](https://github.com/saphid/tumblr-vault/actions/runs/40464900674).
That run's Linux job failed an existing wall-clock ingest assertion (229 ms
versus 2,374 ms); its macOS and Docker jobs passed. The concurrent
[PR run](https://github.com/saphid/tumblr-vault/actions/runs/40464937953) passed
Linux and macOS, illustrating why wall-clock thresholds are unsuitable as the
only regression signal here.

The ingest test now captures the DELETE statement actually issued by ingest
and checks SQLite's rowid-equality query plan at both small and 20,000-record
archive sizes. It also verifies that updating leaves exactly one FTS row.
In an isolated source copy, restoring the old `id=?` full-scan deletion makes
this regression fail; the current rowid deletion passes. The complete 50-test
suite, typechecks and formatting pass locally. The published performance
benchmarks above remain measurements rather than CI timing requirements.

Read-only review of the deterministic regression (actual `claudeAgent` /
`claude-opus-5-5`, high, completed; parent-recorded task ID
`node:delegated-task:command%3Amcp%3A2b19377d-f9ac-4d5e-a264-1bc810a3d435%3Adelegate-task%3Atumblr-vault-queryplan-test-review-20261027-r1`)
passed the focused test and found no blocking issues in frozen patch
`4e42901f4113ca6f8adf2ec9a9fc998bd9a0b71d26f423004e28e6a2954f070e`.
It identified a test-strength gap: rowid equality in one plan node could hide
a full FTS scan in a subquery. The parent added the reviewer's suggested
rejection for those scan nodes and verified both proposed subquery forms fail
while the production query passes. This test covers FTS update plans, not the
performance of every ingest statement; the measurements above remain useful
for broader performance evaluation.

**Post-release workflow hardening:** semver prerelease tags such as
`v1.1.0-rc.1` no longer explicitly publish `latest`; stable and manual branch
rules retain their behavior. Read-only independent review (actual
`claudeAgent` / `claude-opus-5-5`, high, completed; parent-recorded task ID
`node:delegated-task:command%3Amcp%3A2b19377d-f9ac-4d5e-a264-1bc810a3d435%3Adelegate-task%3Atumblr-vault-prerelease-latest-review-20261027-r1`)
found no introduced bugs in frozen patch
`6bfbd739d1028394b4c39747bd2da1936663ab236793767af321eead55643083`.
The review used pinned-action source inspection; no prerelease publication was
performed. Existing release tags and artifacts were not changed.

**Published npm artifact:** [v1.0.1](https://github.com/saphid/tumblr-vault/releases/tag/v1.0.1)
contains the compiled tarball and SHA256SUMS. Anonymous downloads matched
SHA-256 `919b958d04e127ae89b54a80e5926dbd269cf7e9fd630d245b53066d0326c02c`.
A fresh global install from the public download URL passed the complete
setup/search/restart smoke check, including operation without the optional CLIP
runtime and an exposed setup code. The exact tarball also installed on Linux.
Real local CLIP inference from the compiled installed package passed with
normalized 512D vectors, persisted indexing and image self-similarity. The model
came from an existing public-model cache; a fresh model download was not tested.

**Published container:** [release workflow 40463138999](https://github.com/saphid/tumblr-vault/actions/runs/40463138999)
passed. Anonymous OCI inspection found `linux/amd64` and `linux/arm64` manifests
at image index digest
`sha256:9269012b4b60c5e715fc07c11d9044a21b01ab9e4b27f94c0ddf21005f85135c`.
Both `1.0.1` and `latest` point to that digest. A Linux amd64 pull with an empty
Docker credential configuration passed setup-code refusal/acceptance, bundled
UI, BM25, eight saved originals, non-root UID 1000, graceful restart and forced
SIGKILL/restart with persisted data and locked sessions. The test container and
volume were removed. ARM64 publication is verified; ARM64 execution is not.
Existing 1.0.0 image and release artifacts were preserved.

Real Tumblr OAuth, a full live backup and Immich interoperability remain
untested for this release, as for 1.0.0. No new browser QA was performed for the
1.0.1 setup/password fields.

## 1.0.0

This is a clean TypeScript edition. The earlier private Python repository, its history and its running archive are not included in this public repository. All fixtures and screenshots here are synthetic.

### Performed checks

- TypeScript server/CLI and React type checks pass; production Vite/server build passes. [Cross-platform CI run 40266700745](https://github.com/saphid/tumblr-vault/actions/runs/40266700745) completed successfully on macOS, Linux and Windows, plus Docker build/start, for source commit `da2a9c6`. Every OS ran all 16 backend tests, the production dependency audit and a fresh package install/setup/restart check.
- 16 synthetic backend tests pass: grouped-entry pagination/actions, BM25 weights/matching, UTC boundaries/reversed dates, scoped facets/shared media counts, durable checkpoints/source JSON/snapshot, safe rendering/extraction, media redirects, exact OAuth scope/private config/password hashing, serialized token rotation/quota delay, vector validation, setup/login/origin/Host guards, short intermediate pagination, single-instance leases, read-only legacy import (including JPEG-to-WebP previews), one-use OAuth state, password-change session invalidation and container health probes with an external base URL.
- Fresh **macOS, Linux and Windows npm tarball installs** passed without using the source checkout’s runtime dependencies: CLI help, bundled UI, setup, keyword query, process restart, session locking and persisted eight-entry archive.
- **Docker on Linux** passed setup, BM25 search, eight saved media/entries, non-root UID 1000, external-base-URL health checks, graceful restart and forced SIGKILL/restart with the same persistent volume. The filesystem heartbeat lease recovered after an unclean exit. The isolated synthetic test container and volume were removed afterward. The final source also passes the CI Docker build/start job.
- **Real local CLIP** passed on macOS CPU through Transformers.js/ONNX: text and image inference, normalized 512D vectors, persistent indexing and self-similarity 0.99999997. First model cache used approximately 594 MB. This establishes runtime operation, not semantic relevance quality across a personal archive.
- `npm audit --omit=dev` reported zero known vulnerabilities for the resolved production dependencies on 2026-10-26.
- Collaborative Chromium preview exercised four-step setup, connect-later, keyword search, scoped profiles, tags/filter application, detail/Back, gallery, settings persistence, status, lock/unlock and error recovery at 1440/390/320 CSS pixels. Checked pages did not overflow horizontally. Only invented demo content was used.

### Browser findings and follow-up

The first pass found two actionable issues: the mobile layout hid the only lock action, and gallery subtree transitions lost keyboard focus. A universal topbar lock control and explicit gallery focus handoff were added. A fresh targeted follow-up completed PASS for both fixes: the mobile lock is visible, hit-testable and 44×44 px at 320/390 px; actual lock/unlock works at 320 px from Collection and Settings. Gallery entry focuses its named group, arrow keys are handled there, Escape restores the image opener, and a second Escape restores the collection title link at 320/1440 px. Final assets were `index-F2T0tskU.js` and `index-Cby9rdHA.css`. The closure task was `tumblr-vault-browser-closure-20261026-r1`, actual `codex` / `gpt-6-astra`, high, final completed with no actionable findings in those target paths. Multi-image navigation, physical devices, screen readers and exhaustive accessibility conformance were not established by the one-image demo.

Private detailed QA artifacts are intentionally not part of this repository. Public screenshots in `docs/images` contain only the generated demonstration archive.

### Independent source-review limitation

T3 task `tumblr-vault-source-review-20261026-r1` (full ID `node:delegated-task:command%3Amcp%3Af8d23120-605d-48ef-afe7-8b7ee6ec2dd4%3Adelegate-task%3Atumblr-vault-source-review-20261026-r1`) used actual provider `claudeAgent`, model `claude-opus-5-5`, high effort, inherited permissions with a read-only brief. Final status **failed** immediately: “Claude API rate limit reached. Try again later.” No source review occurred and no findings were produced. Browser QA used actual `codex` / `gpt-6-astra`, high; the initial task completed with the two findings above.

### What is not claimed

No real user OAuth authorization or full live Tumblr backup was run against the rewritten edition during release QA. Those paths have synthetic protocol/persistence tests and were adapted from the prior implementation; a personal archive remains subject to Tumblr availability and quota. No public-internet deployment, full restore drill, network filesystem reliability, Immich server interoperability pass, or guaranteed source-history completeness is claimed. macOS, Linux and Windows checks passed in the linked workflow. This does not establish every distribution, filesystem or hardware configuration.

The npm artifact is distributed as a compiled GitHub release tarball, not as a registry publication. Installation through `npm install` works without an npm account. Docker can always build from the public source; published-image availability is tracked by the release workflow.
