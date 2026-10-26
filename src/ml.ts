import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Configuration } from "./config.js";
import type { Archive, Raw } from "./store.js";
export const LOCAL_MODEL = "Xenova/clip-vit-base-patch32";
export const IMMICH_MODEL = "ViT-B-32__openai";
export function normalized(values: unknown): number[] {
  const vector = typeof values === "string" ? JSON.parse(values) : values;
  if (
    !Array.isArray(vector) ||
    vector.length !== 512 ||
    vector.some((n) => typeof n !== "number" || !Number.isFinite(n))
  )
    throw new Error("Image model returned an invalid vector.");
  const norm = Math.sqrt(vector.reduce((n: number, v: number) => n + v * v, 0));
  if (!norm) throw new Error("Image model returned an empty vector.");
  return vector.map((n: number) => n / norm);
}
export class Clip {
  private loading?: Promise<any>;
  private text: any;
  private visual: any;
  private tokenizer: any;
  private processor: any;
  constructor(
    readonly config: Configuration,
    readonly archive: Archive,
  ) {}
  get model() {
    return this.config.value.clip === "immich" ? IMMICH_MODEL : LOCAL_MODEL;
  }
  private async local() {
    if (!this.loading)
      this.loading = (async () => {
        const t = await import("@huggingface/transformers");
        t.env.cacheDir = join(this.archive.dir, "models");
        [this.tokenizer, this.processor, this.text, this.visual] =
          await Promise.all([
            t.AutoTokenizer.from_pretrained(LOCAL_MODEL),
            t.AutoProcessor.from_pretrained(LOCAL_MODEL),
            t.CLIPTextModelWithProjection.from_pretrained(LOCAL_MODEL, {
              dtype: "fp32",
              device: "cpu",
            }),
            t.CLIPVisionModelWithProjection.from_pretrained(LOCAL_MODEL, {
              dtype: "fp32",
              device: "cpu",
            }),
          ]);
        return t;
      })().catch((e) => {
        this.loading = undefined;
        throw e;
      });
    return this.loading;
  }
  async predict(input: { text: string } | { path: string }) {
    if (this.config.value.clip === "off")
      throw new Error(
        "Image search is turned off. Enable it in Settings, then build the image index.",
      );
    if (this.config.value.clip === "immich") {
      const form = new FormData();
      form.set(
        "entries",
        JSON.stringify({
          clip: {
            ["text" in input ? "textual" : "visual"]: {
              modelName: IMMICH_MODEL,
            },
          },
        }),
      );
      if ("text" in input) form.set("text", input.text);
      else
        form.set(
          "image",
          new Blob([new Uint8Array(await readFile(input.path))], {
            type: "image/webp",
          }),
          "image.webp",
        );
      const r = await fetch(this.config.value.mlUrl + "/predict", {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok)
        throw new Error(
          "Image search service is unavailable (HTTP " +
            r.status +
            "). Text search still works.",
        );
      const j = (await r.json()) as any;
      return normalized(j.clip);
    }
    try {
      const t = await this.local();
      if ("text" in input) {
        const out = await this.text(
          await this.tokenizer(input.text, { padding: true, truncation: true }),
        );
        return normalized(Array.from(out.text_embeds.data));
      }
      const image = await t.RawImage.read(input.path);
      const out = await this.visual(await this.processor(image));
      return normalized(Array.from(out.image_embeds.data));
    } catch {
      throw new Error(
        "The local CLIP model could not load or run. Check internet access for the first model download and available memory; text search still works.",
      );
    }
  }
  async index(onProgress: (n: number) => void) {
    const rows = this.archive.db
      .prepare(
        "SELECT * FROM media WHERE thumb IS NOT NULL AND (embedding IS NULL OR model!=?)",
      )
      .all(this.model) as Raw[];
    let n = 0;
    for (const r of rows) {
      const existing = this.archive.db
        .prepare(
          "SELECT embedding FROM media WHERE hash=? AND model=? AND embedding IS NOT NULL",
        )
        .get(r.hash, this.model);
      const vector =
        existing?.embedding ||
        Buffer.from(
          new Float32Array(
            await this.predict({
              path: join(this.archive.dir, "thumbs", r.thumb),
            }),
          ).buffer,
        );
      this.archive.db
        .prepare("UPDATE media SET embedding=?,model=? WHERE id=?")
        .run(vector as Uint8Array, this.model, r.id);
      onProgress(++n);
    }
    return n;
  }
  async rank(query: string, similar: string, profile: string) {
    let vector: number[];
    if (similar) {
      const r = this.archive.db
        .prepare(
          `SELECT embedding FROM media WHERE id=? AND model=? AND EXISTS(SELECT 1 FROM post_media pm JOIN membership m ON m.post=pm.post WHERE pm.media=media.id ${profile ? "AND m.account=?" : ""})`,
        )
        .get(...[similar, this.model, ...(profile ? [profile] : [])]);
      if (!r?.embedding)
        throw new Error(
          "This image has no searchable embedding in the selected profile. Build the image index or choose another image.",
        );
      const b = r.embedding as Uint8Array;
      vector = Array.from(
        new Float32Array(
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        ),
      );
    } else vector = await this.predict({ text: query });
    const rows = this.archive.db
      .prepare(
        `SELECT pm.post,m.embedding FROM media m JOIN post_media pm ON pm.media=m.id WHERE model=? AND embedding IS NOT NULL AND EXISTS(SELECT 1 FROM membership a WHERE a.post=pm.post ${profile ? "AND a.account=?" : ""})`,
      )
      .all(...[this.model, ...(profile ? [profile] : [])]) as Raw[];
    const ranks = new Map<string, number>();
    for (const row of rows) {
      const b = row.embedding as Uint8Array;
      const v = new Float32Array(
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      );
      const score = vector.reduce((s, n, i) => s + n * v[i], 0);
      ranks.set(row.post, Math.max(score, ranks.get(row.post) ?? -Infinity));
    }
    return ranks;
  }
}
