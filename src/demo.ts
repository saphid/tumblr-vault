import sharp from "sharp";
import { join } from "node:path";
import { Configuration } from "./config.js";
import { Archive } from "./store.js";
const stories = [
  [
    "Night train to somewhere",
    "A window seat, a notebook, and the last light on the hills.",
    "travel",
    "dusk",
  ],
  [
    "Small things worth keeping",
    "A collection of ordinary moments: warm coffee, rain, a book left open.",
    "journal",
    "still life",
  ],
  [
    "The shape of a quiet afternoon",
    "There is a whole world in the space between plans.",
    "photography",
    "architecture",
  ],
  [
    "Notes from the coast",
    "Salt on the windows. The sea was the same colour as the sky.",
    "ocean",
    "travel",
  ],
  [
    "A little further north",
    "Following the mountains until the road runs out.",
    "landscape",
    "adventure",
  ],
  [
    "Things that made me stop scrolling",
    "A reminder to pay attention to the places we call familiar.",
    "inspiration",
    "journal",
  ],
  [
    "Light through the glass",
    "A study in soft edges and borrowed light.",
    "design",
    "architecture",
  ],
  [
    "For a slower Sunday",
    "No rush. No destination. Just the long way home.",
    "journal",
    "weekend",
  ],
];
export async function seedDemo(config: Configuration, archive: Archive) {
  if (
    !config.value.demo ||
    archive.db.prepare("SELECT 1 FROM posts LIMIT 1").get()
  )
    return;
  config.value.accounts = [
    {
      id: "demo-june",
      label: "June",
      username: "junes-notebook",
      blogs: ["junes-notebook"],
    },
    {
      id: "demo-studio",
      label: "Studio notes",
      username: "studio-notes",
      blogs: ["studio-notes"],
    },
  ];
  config.save();
  for (let i = 0; i < stories.length; i++) {
    const [title, text, tag, tag2] = stories[i];
    const colors = [
      ["#b5a39a", "#443c4d"],
      ["#a5a2b3", "#494354"],
      ["#8f939d", "#41434d"],
      ["#97a3b6", "#414957"],
    ][i % 4];
    const image = await sharp(
      Buffer.from(
        `<svg width="800" height="650" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x2="0.9" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="800" height="650" fill="url(#g)"/><circle cx="${170 + i * 40}" cy="180" r="100" fill="#eee8e5" opacity=".38"/><path d="M0 510L220 ${260 + i * 20}L470 500L640 310L800 450V650H0Z" fill="#25252c" opacity=".65"/><path d="M0 570L320 430L540 560L800 470V650H0Z" fill="#17171d" opacity=".55"/></svg>`,
      ),
    )
      .webp()
      .toBuffer();
    const post = {
      id_string: String(1000 + i),
      blog_name: i % 3 === 0 ? "studio-notes" : "junes-notebook",
      timestamp: 1770000000 + i * 86400,
      type: "photo",
      title,
      body: "<p>" + text + "</p>",
      tags: [tag, tag2],
      photos: [
        {
          original_size: {
            url: "https://64.media.tumblr.com/synthetic-demo-" + i + ".webp",
          },
        },
      ],
      post_url: "https://example.invalid/demo",
    };
    archive.ingest(i % 3 === 0 ? "demo-studio" : "demo-june", "like", post);
    if (i % 2 === 0) archive.ingest("demo-june", "post", post);
    const row = archive.db
      .prepare("SELECT id FROM media WHERE url=?")
      .get(post.photos[0].original_size.url)!;
    const file = "demo-" + i + ".webp";
    await sharp(image).toFile(join(archive.dir, "media", file));
    await sharp(image)
      .resize(700)
      .toFile(join(archive.dir, "thumbs", file));
    archive.db
      .prepare("UPDATE media SET path=?,thumb=?,bytes=? WHERE id=?")
      .run(file, file, image.length, row.id as number);
  }
  archive.state("progress", {
    state: "complete",
    stage: "demo",
    processed: 8,
    message:
      "Synthetic demo archive. No Tumblr accounts or models are connected.",
  });
}
