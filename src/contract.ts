export interface Profile {
  id: string;
  label: string;
  username: string;
  blogs: string[];
  expectedPosts?: number;
  expectedLikes?: number;
  lastSync?: string;
  error?: string;
}
export interface Settings {
  configured: boolean;
  dataDir: string;
  storageFree: number;
  clip: "off" | "local" | "immich";
  mlUrl: string;
  scheduleHours: number;
  profiles: Profile[];
  callbackUrl: string;
  demo: boolean;
  /** False when the optional local CLIP runtime is not installed. */
  localClipAvailable: boolean;
  /** A one-time setup code from the server log is required (non-loopback exposure). */
  setupCodeRequired?: boolean;
}
export interface Media {
  id: number;
  kind: string;
  thumb: boolean;
  saved: boolean;
  bytes: number;
  error?: string;
  /** preview_unsupported (content) or preview_storage (retried next run). */
  previewError?: string;
}
export interface Entry {
  id: string;
  groupId: string;
  blog: string;
  title: string;
  text: string;
  timestamp: number;
  type: string;
  tags: string[];
  actions: string[];
  media: Media[];
  versions: number;
  score?: number;
}
export interface Detail extends Entry {
  raw: unknown;
  url: string;
  blocks: { author: string; text: string }[];
  savedVersions: {
    id: string;
    blog: string;
    timestamp: number;
    actions: string[];
  }[];
}
export interface SearchResult {
  entries: Entry[];
  total: number;
  page: number;
  pages: number;
  blogs: string[];
  types: string[];
  notice?: string;
}
export interface Progress {
  state: "idle" | "running" | "waiting" | "complete" | "partial" | "failed";
  stage: string;
  message: string;
  processed: number;
  started?: string;
  finished?: string;
  resumeAt?: string;
}
export interface Status {
  profiles: Profile[];
  entries: number;
  records: number;
  media: number;
  saved: number;
  unavailable: number;
  indexed: number;
  previewsFailed: number;
  bytes: number;
  progress: Progress;
}
