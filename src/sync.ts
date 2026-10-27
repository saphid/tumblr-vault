import type { Configuration, Account } from "./config.js";
import { Archive, type Raw } from "./store.js";
import { Tumblr } from "./tumblr.js";
import { Clip } from "./ml.js";
import { download, preview, previewsToRetry } from "./media.js";
import type { Progress } from "./contract.js";
// Messages our own code raises for the operator; anything else (sockets, SQLite) stays generic.
const OPERATOR =
  /^(Tumblr |Reconnect |Connect |Keep at least|Image |The local CLIP|disk_reserve)/;
export function failureMessage(error: unknown) {
  const text = error instanceof Error ? error.message : "";
  return OPERATOR.test(text)
    ? text.replace(/^disk_reserve:?\s*/, "") ||
        "Keep at least 1 GiB free for downloads."
    : "";
}
// Scheduled runs compare against the last backup start, so restarts neither postpone nor repeat them.
export function backupDue(
  last: string | undefined,
  hours: number,
  now = Date.now(),
) {
  if (!hours) return false;
  const started = Date.parse(last || "");
  return !Number.isFinite(started) || now - started >= hours * 3600000;
}
const retained = (message: string) =>
  /retained/.test(message)
    ? message
    : message + " Saved pages and originals are retained.";
class Stopped extends Error {}
export class Sync {
  progress: Progress;
  active?: Promise<void>;
  readonly api: Tumblr;
  private controller = new AbortController();
  constructor(
    readonly config: Configuration,
    readonly archive: Archive,
    readonly clip: Clip,
  ) {
    const old = archive.state("progress");
    // Vaults from before lastBackup existed: adopt the last recorded start exactly once,
    // so later index-only starts on a never-backed-up vault are never mistaken for backups.
    if (!archive.state("lastBackupMigrated")) {
      if (archive.state("lastBackup") === undefined && old?.started)
        archive.state("lastBackup", old.started);
      archive.state("lastBackupMigrated", true);
    }
    this.progress =
      old && ["running", "waiting"].includes(old.state)
        ? {
            ...old,
            state: "partial",
            message:
              "The previous run was interrupted. Start backup to resume saved pages.",
          }
        : old || {
            state: "idle",
            stage: "ready",
            message: "Ready for your first backup.",
            processed: 0,
          };
    this.api = new Tumblr(config, async (seconds) => {
      this.update({
        state: "waiting",
        message:
          "Tumblr rate limit. Backup resumes automatically; saved work is safe.",
        resumeAt: new Date(Date.now() + seconds * 1000).toISOString(),
      });
      await this.sleep(seconds);
      this.update({ state: "running", resumeAt: undefined });
    });
  }
  private sleep(seconds: number) {
    const signal = this.controller.signal;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Stopped());
      const done = () => {
        clearTimeout(timer);
        reject(new Stopped());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", done);
        resolve();
      }, seconds * 1000);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  private checkStopped() {
    if (this.controller.signal.aborted) throw new Stopped();
  }
  // Graceful shutdown: interrupts quota waits and in-flight reads, keeps checkpoints.
  async stop() {
    this.controller.abort();
    await this.active;
  }
  // Index-only runs do not count as backups for scheduling.
  get lastBackup(): string | undefined {
    return this.archive.state("lastBackup");
  }
  update(next: Partial<Progress>) {
    this.progress = { ...this.progress, ...next };
    this.archive.state("progress", this.progress);
  }
  start(profile = "", indexOnly = false) {
    if (this.active)
      throw new Error("A backup or indexing run is already in progress.");
    if (this.config.value.demo)
      throw new Error(
        "Demo mode never connects to Tumblr or downloads models.",
      );
    if (profile && !this.config.value.accounts.some((a) => a.id === profile))
      throw new Error("Choose an existing profile.");
    const resume =
      !indexOnly &&
      ["failed", "partial"].includes(this.progress.state) &&
      ["media", "previews", "image_index", "snapshot"].includes(
        this.progress.stage,
      ) &&
      this.archive.state("runProfile") === profile &&
      this.archive.state("runKind") === "backup" &&
      this.archive.state("runMetadataComplete") === true;
    // Only an interrupted full backup whose metadata pass read every account may skip it;
    // an index-only run never read Tumblr, so a backup after it must.
    this.archive.state("runProfile", profile);
    this.archive.state("runKind", indexOnly ? "index" : "backup");
    if (!indexOnly && !resume) this.archive.state("runMetadataComplete", false);
    if (!indexOnly) this.archive.state("lastBackup", new Date().toISOString());
    this.controller = new AbortController();
    this.api.signal = this.controller.signal;
    this.update({
      state: "running",
      stage: indexOnly ? "image_index" : "metadata",
      processed: 0,
      started: new Date().toISOString(),
      finished: undefined,
      message: indexOnly
        ? "Building the image index. The first local model download can take several minutes."
        : "Reading your Tumblr archive.",
    });
    this.active = this.run(profile, indexOnly, resume)
      .catch((error) =>
        this.update(
          error instanceof Stopped || this.controller.signal.aborted
            ? {
                state: "partial",
                resumeAt: undefined,
                finished: new Date().toISOString(),
                message:
                  "Backup paused because Vault stopped. Start backup to resume; saved pages and originals are retained.",
              }
            : {
                state: "failed",
                resumeAt: undefined,
                finished: new Date().toISOString(),
                message: retained(
                  failureMessage(error) ||
                    "Backup stopped. Check account connection, free disk space and image settings, then retry.",
                ),
              },
        ),
      )
      .finally(() => {
        this.active = undefined;
      });
  }
  private async pages(
    account: Account,
    key: string,
    path: string,
    role: string,
  ) {
    let cp = this.archive.checkpoint(key) || { offset: 0 };
    if (cp.done) {
      cp = { offset: 0 };
      this.archive.checkpoint(key, cp);
    }
    const seen = new Set<string>();
    for (let page = 0; page < 100000; page++) {
      this.checkStopped();
      const params: Record<string, string | number> = {
        limit: 20,
        npf: "true",
      };
      for (const key of ["offset", "before", "page_number"])
        if (cp[key] !== undefined) params[key] = cp[key];
      if (params.before !== undefined) delete params.offset;
      const data = await this.api.get(account, path, params);
      const posts: Raw[] = data.posts || data.liked_posts || [];
      if (!posts.length) {
        this.archive.checkpoint(key, { done: true });
        return;
      }
      const signature = posts.map((p) => String(p.id_string || p.id)).join(",");
      if (seen.has(signature))
        throw new Error(
          "Tumblr repeated a page. Saved pages are retained; retry later.",
        );
      seen.add(signature);
      this.archive.transaction(() => {
        for (const post of posts) this.archive.ingest(account.id, role, post);
      });
      this.update({
        processed: this.progress.processed + posts.length,
        message:
          "Saved " +
          (this.progress.processed + posts.length).toLocaleString() +
          " source records in this run.",
      });
      const link = data._links?.next;
      let next: Record<string, string | number> = {};
      if (link?.href) {
        const url = new URL(link.href, "https://api.tumblr.com");
        if (url.origin !== "https://api.tumblr.com")
          throw new Error("Tumblr returned an unexpected pagination URL.");
        for (const key of ["offset", "before", "page_number"]) {
          const v = url.searchParams.get(key);
          if (v !== null) next[key] = v;
        }
      } else if (link?.query_params) {
        for (const key of ["offset", "before", "page_number"])
          if (link.query_params[key] !== undefined)
            next[key] = link.query_params[key];
      }
      if (link && !Object.keys(next).length)
        throw new Error("Tumblr returned an unrecognized pagination cursor.");
      if (!link) {
        if (posts.length < 20) {
          this.archive.checkpoint(key, { done: true });
          return;
        }
        if (role === "like") {
          const last = posts.at(-1)?.liked_timestamp;
          if (!last || String(last) === String(cp.before))
            throw new Error("Tumblr likes cursor did not advance.");
          next = { before: last };
        } else next = { offset: Number(cp.offset || 0) + posts.length };
      }
      if (JSON.stringify(cp) === JSON.stringify(next))
        throw new Error("Tumblr pagination did not advance.");
      this.archive.checkpoint(key, next);
      cp = next;
    }
    throw new Error(
      "Tumblr pagination safety limit reached. Saved pages are retained.",
    );
  }

  private async account(a: Account) {
    const info = (await this.api.get(a, "/user/info")).user;
    a.blogs = (info.blogs || []).map((b: Raw) => b.name);
    a.expectedPosts = (info.blogs || []).reduce(
      (n: number, b: Raw) => n + (b.posts || 0),
      0,
    );
    a.expectedLikes = info.likes;
    this.config.save();
    for (const blog of a.blogs)
      await this.pages(
        a,
        a.id + ":posts:" + blog,
        "/blog/" + encodeURIComponent(blog) + "/posts",
        "post",
      );
    await this.pages(a, a.id + ":likes", "/user/likes", "like");
    a.lastSync = new Date().toISOString();
    a.error = undefined;
    this.config.save();
  }

  private async run(profile: string, indexOnly: boolean, resume = false) {
    // One account's failure never prevents the others or the downstream stages.
    const failed: string[] = [];
    let attempted = 0;
    if (!indexOnly) {
      const accounts = this.config.value.accounts.filter(
        (a) => a.token && (!profile || a.id === profile),
      );
      if (!accounts.length) throw new Error("Connect an account first.");
      if (!resume) {
        attempted = accounts.length;
        for (const a of accounts)
          try {
            await this.account(a);
          } catch (error) {
            if (error instanceof Stopped || this.controller.signal.aborted)
              throw error;
            a.error =
              failureMessage(error) ||
              "The last backup of this account stopped. Retry later.";
            this.config.save();
            failed.push(a.error);
          }
        this.archive.state("runMetadataComplete", !failed.length);
      }
      this.update({
        stage: "media",
        message: failed.length
          ? "Saving original media for the accounts that could be read."
          : "Saving original media.",
        processed: 0,
      });
      const rows = this.archive.db
        .prepare(
          `SELECT * FROM media WHERE path IS NULL ${profile ? "AND id IN (SELECT media FROM post_media pm JOIN membership m ON m.post=pm.post WHERE m.account=?)" : ""}`,
        )
        .all(...(profile ? [profile] : [])) as Raw[];
      let count = 0;
      for (const row of rows) {
        this.checkStopped();
        await download(this.archive, row, this.controller.signal);
        this.update({ processed: ++count });
      }
    }
    // Previews are rebuilt from saved originals, never downloaded again.
    const previews = previewsToRetry(this.archive, profile);
    if (previews.length) {
      this.update({
        stage: "previews",
        message: "Creating image previews from saved originals.",
        processed: 0,
      });
      let count = 0;
      for (const row of previews) {
        this.checkStopped();
        await preview(this.archive, row, this.controller.signal);
        this.update({ processed: ++count });
      }
    }
    if (this.config.value.clip !== "off") {
      this.update({
        stage: "image_index",
        processed: 0,
        message:
          "Indexing downloaded images. The first local model download can take several minutes.",
      });
      await this.clip.index(
        (n) => this.update({ processed: n }),
        this.controller.signal,
      );
      this.checkStopped();
    }
    this.update({
      stage: "snapshot",
      message: "Creating a consistent database snapshot.",
    });
    this.checkStopped();
    await this.archive.snapshot();
    // The snapshot itself is a short atomic step; a stop during it still ends as partial.
    this.checkStopped();
    const scope = profile
      ? "AND id IN (SELECT media FROM post_media pm JOIN membership m ON m.post=pm.post WHERE m.account=?)"
      : "";
    const counts = this.archive.db
      .prepare(
        `SELECT COALESCE(SUM(path IS NULL),0) missing,COALESCE(SUM(thumb_error=?),0) previews FROM media WHERE 1=1 ${scope}`,
      )
      .get("preview_storage", ...(profile ? [profile] : []))!;
    const missing = Number(counts.missing);
    const previewFailures = Number(counts.previews);
    const notes: string[] = [];
    const first = failed[0]?.replace(/\.?$/, ".");
    if (failed.length === attempted && attempted === 1) notes.push(first);
    else if (failed.length === attempted && attempted)
      notes.push(
        "None of the " + attempted + " accounts could be read: " + first,
      );
    else if (failed.length)
      notes.push(
        failed.length +
          " of " +
          attempted +
          " accounts could not be read: " +
          first +
          " The other accounts, saved pages and originals were still processed.",
      );
    if (missing)
      notes.push(
        missing.toLocaleString() + " media sources remain unavailable.",
      );
    if (previewFailures)
      notes.push(
        previewFailures.toLocaleString() +
          " previews could not be written to storage; they are retried from the saved originals next run.",
      );
    const finished = new Date().toISOString();
    if (attempted && failed.length === attempted)
      this.update({
        state: "failed",
        stage: "finished",
        finished,
        message: retained(notes.join(" ")),
      });
    else
      this.update({
        state: notes.length ? "partial" : "complete",
        stage: "finished",
        finished,
        message: notes.length
          ? notes.join(" ") + " Saved content is ready to browse."
          : "Backup finished. Your saved archive is ready to browse.",
      });
  }
}
