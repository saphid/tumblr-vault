import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { LOCAL_RUNTIME_MISSING, type Configuration } from "./config.js";
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
// The model or service itself is unusable, as opposed to one unreadable image.
export class ServiceError extends Error {}
const LOAD_FAILED =
  "The local CLIP model could not load. Check internet access for the first model download and available memory; text search still works.";
const RUN_FAILED =
  "The local CLIP model could not run. Check available memory; text search still works.";
// ONNX loading, decoding and inference cannot be cancelled; stop waiting so shutdown is
// not held hostage. Work is never started once stopped; work already running is still
// observed (no unhandled rejection) and its late result is discarded.
function abortable<T>(start: () => Promise<T>, stop?: AbortSignal): Promise<T> {
  if (stop?.aborted) return Promise.reject(new Error("Stopped."));
  const work = Promise.resolve().then(() => {
    if (stop?.aborted) throw new Error("Stopped.");
    return start();
  });
  if (!stop) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Stopped."));
    stop.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => stop.removeEventListener("abort", abort));
  });
}
// Views the stored bytes without copying when SQLite returns them 4-byte aligned.
function floats(b: Uint8Array) {
  if (b.byteLength !== 2048)
    throw new ServiceError("Image model returned an invalid vector.");
  return b.byteOffset % 4 === 0
    ? new Float32Array(b.buffer, b.byteOffset, 512)
    : new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + 2048));
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
        const t = await import("@huggingface/transformers").catch((error) => {
          // The runtime is an optional dependency; a text-only install may omit it.
          throw ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(
            error?.code,
          )
            ? new ServiceError(LOCAL_RUNTIME_MISSING)
            : error;
        });
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
  async predict(
    input: { text: string } | { path: string },
    stop?: AbortSignal,
  ) {
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
      if (stop?.aborted) throw new Error("Stopped.");
      const r = await fetch(this.config.value.mlUrl + "/predict", {
        method: "POST",
        body: form,
        redirect: "error",
        signal: stop
          ? AbortSignal.any([AbortSignal.timeout(180000), stop])
          : AbortSignal.timeout(180000),
      }).catch(() => {
        throw new ServiceError(
          "Image search service is unreachable. Check the Immich machine-learning URL; text search still works.",
        );
      });
      // 400/413/415/422 describe this one input; anything else means the service is unusable.
      if (!r.ok)
        throw new (
          [400, 413, 415, 422].includes(r.status) ? Error : ServiceError
        )(
          "Image search service is unavailable (HTTP " +
            r.status +
            "). Text search still works.",
        );
      const j = (await r.json().catch(() => undefined)) as any;
      try {
        return normalized(j?.clip);
      } catch (error) {
        throw new ServiceError((error as Error).message);
      }
    }
    // Only decoding/preprocessing a particular image is input-specific; load and
    // inference failures mean the model is unusable.
    const service = (message: string) => (error: unknown) => {
      throw stop?.aborted || error instanceof ServiceError
        ? error
        : new ServiceError(message);
    };
    const t = await abortable(() => this.local(), stop).catch(
      service(LOAD_FAILED),
    );
    if ("text" in input) {
      const out: any = await abortable(
        async () =>
          this.text(
            await this.tokenizer(input.text, {
              padding: true,
              truncation: true,
            }),
          ),
        stop,
      ).catch(service(RUN_FAILED));
      return normalized(Array.from(out.text_embeds.data));
    }
    const unreadable = (error: unknown) => {
      throw stop?.aborted
        ? error
        : new Error("This image could not be read for indexing.");
    };
    const image = await abortable(
      () => t.RawImage.read(input.path),
      stop,
    ).catch(unreadable);
    const pixels = await abortable(() => this.processor(image), stop).catch(
      unreadable,
    );
    const out: any = await abortable(() => this.visual(pixels), stop).catch(
      service(RUN_FAILED),
    );
    try {
      return normalized(Array.from(out.image_embeds.data));
    } catch (error) {
      throw new ServiceError((error as Error).message);
    }
  }
  // One unreadable image is skipped (and retried next run); repeated failures mean the
  // model or service itself is unavailable, so the run stops with that explanation.
  async index(onProgress: (n: number) => void, stop?: AbortSignal) {
    const rows = this.archive.db
      .prepare(
        "SELECT id,hash,thumb FROM media WHERE thumb IS NOT NULL AND (embedding IS NULL OR model IS NOT ?)",
      )
      .all(this.model) as Raw[];
    if (rows.length && this.config.value.clip === "local")
      await abortable(() => this.local(), stop).catch((error) => {
        if (stop?.aborted) return;
        throw error instanceof ServiceError
          ? error
          : new ServiceError(LOAD_FAILED);
      });
    let n = 0;
    let failures = 0;
    for (const r of rows) {
      if (stop?.aborted) break;
      const existing = this.archive.db
        .prepare(
          "SELECT embedding FROM media WHERE hash=? AND model=? AND embedding IS NOT NULL",
        )
        .get(r.hash, this.model);
      let vector = existing?.embedding as Uint8Array | undefined;
      if (!vector)
        try {
          vector = Buffer.from(
            new Float32Array(
              await this.predict(
                { path: join(this.archive.dir, "thumbs", r.thumb) },
                stop,
              ),
            ).buffer,
          );
          failures = 0;
        } catch (error) {
          if (stop?.aborted) break;
          if (error instanceof ServiceError || ++failures >= 3) throw error;
          continue;
        }
      this.archive.db
        .prepare("UPDATE media SET embedding=?,model=? WHERE id=?")
        .run(vector, this.model, r.id);
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
      vector = Array.from(floats(r.embedding as Uint8Array));
    } else vector = await this.predict({ text: query });
    const query32 = Float32Array.from(vector);
    // Exact cosine scan in bounded chunks: at most 2,000 vectors in memory at a time, and
    // an image shared by several saved posts is scored once.
    const chunk = this.archive.db.prepare(
      `SELECT pm.media,pm.post,m.embedding FROM post_media pm JOIN media m ON m.id=pm.media WHERE m.model=? AND m.embedding IS NOT NULL AND (pm.media,pm.post)>(?,?) AND EXISTS(SELECT 1 FROM membership a WHERE a.post=pm.post ${profile ? "AND a.account=?" : ""}) ORDER BY pm.media,pm.post LIMIT 2000`,
    );
    const ranks = new Map<string, number>();
    let after: [number, string] = [-1, ""];
    let media = -1;
    let score = 0;
    for (;;) {
      const rows = chunk.all(
        ...[this.model, ...after, ...(profile ? [profile] : [])],
      ) as Raw[];
      for (const row of rows) {
        if (row.media !== media) {
          media = row.media;
          const v = floats(row.embedding as Uint8Array);
          score = 0;
          for (let i = 0; i < 512; i++) score += query32[i] * v[i];
        }
        ranks.set(row.post, Math.max(score, ranks.get(row.post) ?? -Infinity));
      }
      if (rows.length < 2000) break;
      after = [rows.at(-1)!.media, rows.at(-1)!.post];
    }
    return ranks;
  }
}
