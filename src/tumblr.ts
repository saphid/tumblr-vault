import { randomBytes } from "node:crypto";
import type { Configuration, Account, Token } from "./config.js";
export function validateToken(t: Token) {
  if (
    !t.access_token ||
    !t.refresh_token ||
    !Number.isFinite(t.expires_in) ||
    t.expires_in <= 0 ||
    [...new Set(t.scope?.split(" "))].sort().join(" ") !==
      "basic offline_access"
  )
    throw new Error(
      "Tumblr must grant exactly basic offline_access (read-only, renewable access).",
    );
}
// Accepts a numeric string as well as a number; anything else fails validation.
function expiry(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
}
export function rateDelay(h: Headers) {
  const values = [60];
  const retry = h.get("retry-after");
  if (retry)
    values.push(
      Number.isFinite(Number(retry))
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000,
    );
  for (const p of ["perhour", "perday"])
    if (h.get("x-ratelimit-" + p + "-remaining") === "0")
      values.push(Number(h.get("x-ratelimit-" + p + "-reset")) + 1);
  return Math.min(
    86400,
    Math.max(...values.filter((n) => Number.isFinite(n) && n > 0)),
  );
}
export class Tumblr {
  private refreshes = new Map<string, Promise<string>>();
  // Set by the backup worker so shutdown interrupts in-flight reads.
  signal?: AbortSignal;
  private deadline(ms = 45000) {
    return this.signal
      ? AbortSignal.any([AbortSignal.timeout(ms), this.signal])
      : AbortSignal.timeout(ms);
  }
  constructor(
    readonly config: Configuration,
    readonly wait: (seconds: number) => Promise<void> = (seconds) =>
      new Promise((r) => setTimeout(r, seconds * 1000)),
  ) {}
  authorize(callback: string, state: string) {
    if (!this.config.value.clientId || !this.config.value.clientSecret)
      throw new Error(
        "Save your Tumblr application key and secret in Settings first.",
      );
    const url = new URL("https://www.tumblr.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.value.clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: "basic offline_access",
      state,
    }).toString();
    return url.toString();
  }
  async exchange(params: Record<string, string>): Promise<Token> {
    const c = this.config.value;
    const r = await fetch("https://api.tumblr.com/v2/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        ...params,
        client_id: c.clientId!,
        client_secret: c.clientSecret!,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok)
      throw new Error(
        "Tumblr token exchange failed (HTTP " +
          r.status +
          "). Check your app credentials and callback URL.",
      );
    const raw = (await r.json()) as any;
    const token = {
      ...raw,
      expires_in: expiry(raw?.expires_in),
      obtained: Date.now(),
    };
    validateToken(token);
    return token;
  }
  async access(account: Account, force = false): Promise<string> {
    if (!account.token) throw new Error("Reconnect this account in Settings.");
    if (
      !force &&
      account.token.access_token &&
      Date.now() <
        account.token.obtained + account.token.expires_in * 1000 - 120000
    )
      return account.token.access_token;
    let pending = this.refreshes.get(account.id);
    if (!pending) {
      pending = (async () => {
        const previous = account.token!;
        const c = this.config.value;
        const r = await fetch("https://api.tumblr.com/v2/oauth2/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: previous.refresh_token,
            client_id: c.clientId!,
            client_secret: c.clientSecret!,
          }),
          redirect: "error",
          signal: this.deadline(),
        });
        if (!r.ok)
          throw new Error(
            "Tumblr authorization expired. Reconnect the account in Settings.",
          );
        const raw = (await r.json()) as any;
        const token = {
          ...raw,
          refresh_token: raw?.refresh_token || previous.refresh_token,
          scope: raw?.scope || previous.scope,
          expires_in: expiry(raw?.expires_in),
          obtained: Date.now(),
        };
        try {
          validateToken(token);
        } catch (error) {
          // Tumblr may already have retired the old refresh token. Keep the rotated one so
          // the account can recover, but never keep or use the refused access token:
          // the stored access is cleared and marked expired, so every later call refreshes.
          if (
            typeof raw?.refresh_token === "string" &&
            raw.refresh_token &&
            raw.refresh_token !== previous.refresh_token
          ) {
            account.token = {
              ...previous,
              access_token: "",
              refresh_token: raw.refresh_token,
              obtained: 0,
            };
            this.config.save();
          } else if (previous.access_token) {
            account.token = { ...previous, access_token: "", obtained: 0 };
            this.config.save();
          }
          throw error;
        }
        account.token = token;
        this.config.save();
        return token.access_token;
      })().finally(() => this.refreshes.delete(account.id));
      this.refreshes.set(account.id, pending);
    }
    return pending;
  }
  async get(
    account: Account,
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<any> {
    if (!path.startsWith("/") || path.includes("..") || path.startsWith("//"))
      throw new Error("Invalid Tumblr API path.");
    let rates = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const url = new URL("https://api.tumblr.com/v2" + path);
      for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, String(v));
      const r = await fetch(url, {
        headers: {
          Authorization:
            "Bearer " + (await this.access(account, attempt === 1)),
        },
        redirect: "error",
        signal: this.deadline(),
      });
      if (r.status === 401 && attempt === 0) continue;
      if (r.status === 429 && rates++ < 3) {
        await this.wait(rateDelay(r.headers));
        attempt--;
        continue;
      }
      if (r.status >= 500 && attempt < 4) {
        await this.wait(2 ** attempt);
        continue;
      }
      if (!r.ok)
        throw new Error(
          "Tumblr read failed (HTTP " + r.status + "). Retry the backup later.",
        );
      const j = (await r.json()) as any;
      if (j.meta?.status !== 200)
        throw new Error("Tumblr did not accept this read.");
      return j.response;
    }
    throw new Error(
      "Tumblr retry limit reached. Retry later; saved pages are retained.",
    );
  }
  async connect(code: string, callback: string, label: string) {
    const token = await this.exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
    });
    const temporary: Account = {
      id: randomBytes(12).toString("hex"),
      label,
      username: "",
      blogs: [],
      token,
    };
    const info = (await this.get(temporary, "/user/info")).user;
    const existing = this.config.value.accounts.find(
      (a) => a.username === info.name,
    );
    const account: Account = {
      ...temporary,
      id: existing?.id || temporary.id,
      username: info.name,
      blogs: (info.blogs || []).map((b: any) => b.name),
      expectedPosts: (info.blogs || []).reduce(
        (n: number, b: any) => n + (b.posts || 0),
        0,
      ),
      expectedLikes: info.likes,
    };
    if (existing) Object.assign(existing, account);
    else this.config.value.accounts.push(account);
    this.config.save();
    return account;
  }
}
