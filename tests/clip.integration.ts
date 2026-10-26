// Optional real-model smoke test. Downloads the public model once; never reads user data.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Configuration } from "../src/config.js";
import { Archive } from "../src/store.js";
import { Clip } from "../src/ml.js";
const dir =
  process.env.CLIP_TEST_DIR ||
  mkdtempSync(join(tmpdir(), "tumblr-vault-clip-"));
const c = new Configuration(dir);
c.value.clip = "local";
c.save();
const db = new Archive(dir);
const clip = new Clip(c, db);
console.log("Model cache:", join(dir, "models"));
const text = await clip.predict({ text: "a pale circle over dark mountains" });
assert.equal(text.length, 512);
assert(Math.abs(text.reduce((s, n) => s + n * n, 0) - 1) < 1e-5);
const image = join(dir, "thumbs", "synthetic.webp");
await sharp(
  Buffer.from(
    '<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="256" fill="#59535f"/><circle cx="128" cy="85" r="45" fill="#ddd8d1"/><path d="M0 256L70 130L150 230L200 140L256 256" fill="#242229"/></svg>',
  ),
)
  .webp()
  .toFile(image);
db.ingest("synthetic", "post", {
  id_string: "1",
  blog_name: "synthetic",
  type: "photo",
  photos: [
    { original_size: { url: "https://64.media.tumblr.com/clip-smoke.webp" } },
  ],
});
db.db.prepare("UPDATE media SET thumb=?").run("synthetic.webp");
await clip.index((n) => console.log("Indexed:", n));
const ranks = await clip.rank("mountains", "", "synthetic");
assert.equal(ranks.size, 1);
assert(Number.isFinite(ranks.get("1")));
const similar = await clip.rank("", "1", "synthetic");
assert(Math.abs(similar.get("1")! - 1) < 1e-5);
db.close();
writeFileSync(
  join(dir, "result.json"),
  JSON.stringify({
    model: clip.model,
    dimensions: text.length,
    indexed: 1,
    similarity: similar.get("1"),
    passed: true,
  }),
);
console.log(
  "PASS: real local CLIP text/image, 512D normalized vectors, persisted index and similarity.",
);
