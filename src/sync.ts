import type { Configuration, Account } from "./config.js";
import { Archive, type Raw } from "./store.js";
import { Tumblr } from "./tumblr.js";
import { Clip } from "./ml.js";
import { download } from "./media.js";
import type { Progress } from "./contract.js";
export class Sync {
  progress: Progress;
  active?: Promise<void>;
  readonly api: Tumblr;
  constructor(
    readonly config: Configuration,
    readonly archive: Archive,
    readonly clip: Clip,
  ) {
    const old = archive.state("progress");
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
      await new Promise((r) => setTimeout(r, seconds * 1000));
      this.update({ state: "running", resumeAt: undefined });
    });
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
      ["failed", "partial"].includes(this.progress.state) &&
      ["media", "image_index", "snapshot"].includes(this.progress.stage) &&
      this.archive.state("runProfile") === profile;
    this.archive.state("runProfile", profile);
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
      .catch(() =>
        this.update({
          state: "failed",
          finished: new Date().toISOString(),
          message:
            "Backup stopped. Check account connection, free disk space and image settings, then retry. Saved pages and originals are retained.",
        }),
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
      for (const post of posts) this.archive.ingest(account.id, role, post);
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

  private async run(profile: string, indexOnly: boolean, resume = false) {
    if (!indexOnly) {
      const accounts = this.config.value.accounts.filter(
        (a) => a.token && (!profile || a.id === profile),
      );
      if (!accounts.length) throw new Error("Connect an account first.");
      if (!resume)
        for (const a of accounts) {
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
      this.update({
        stage: "media",
        message: "Saving original media.",
        processed: 0,
      });
      const rows = this.archive.db
        .prepare(
          `SELECT * FROM media WHERE path IS NULL ${profile ? "AND id IN (SELECT media FROM post_media pm JOIN membership m ON m.post=pm.post WHERE m.account=?)" : ""}`,
        )
        .all(...(profile ? [profile] : [])) as Raw[];
      let count = 0;
      for (const row of rows) {
        await download(this.archive, row);
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
      await this.clip.index((n) => this.update({ processed: n }));
    }
    this.update({
      stage: "snapshot",
      message: "Creating a consistent database snapshot.",
    });
    await this.archive.snapshot();
    const missing = Number(
      this.archive.db
        .prepare("SELECT COUNT(*) n FROM media WHERE path IS NULL")
        .get()!.n,
    );
    this.update({
      state: missing ? "partial" : "complete",
      stage: "finished",
      finished: new Date().toISOString(),
      message: missing
        ? missing.toLocaleString() +
          " media sources remain unavailable. Saved content is ready to browse."
        : "Backup finished. Your saved archive is ready to browse.",
    });
  }
}
