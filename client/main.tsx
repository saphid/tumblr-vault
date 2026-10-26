import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Settings,
  SearchResult,
  Detail,
  Entry,
  Status,
} from "../src/contract";
import "./style.css";
async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-vault-request": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok)
    throw new Error(j.error || "The request could not complete. Please retry.");
  return j;
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    vault: (
      <>
        <path d="M4 4h16v16H4zM9 9h6v6H9z" />
        <path d="M4 9h5M15 15h5" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 1 2 4 3-1 3 1 2-4 3-1-1-4 2-2-2-3-3-1-1-3z" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    filter: (
      <>
        <path d="M3 6h18M3 12h18M3 18h18" />
        <circle cx="8" cy="6" r="2" />
        <circle cx="16" cy="12" r="2" />
        <circle cx="10" cy="18" r="2" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.vault}
    </svg>
  );
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Icon name="vault" size={25} />
      </span>
      <span>
        Tumblr <b>Vault</b>
      </span>
    </span>
  );
}
function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? (n / 1024 ** 3).toFixed(1) + " GB"
    : (n / 1024 ** 2).toFixed(1) + " MB";
const number = (n: number) => n.toLocaleString();
function App() {
  const [settings, setSettings] = useState<Settings>();
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(
    () => new URLSearchParams(location.search),
  );
  const refresh = async () => {
    try {
      const [s, session] = await Promise.all([
        api<Settings>("/api/setup"),
        api<{ authenticated: boolean }>("/api/session"),
      ]);
      setSettings(s);
      setUnlocked(session.authenticated);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    const pop = () => setRoute(new URLSearchParams(location.search));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function navigate(p: URLSearchParams, replace = false) {
    history[replace ? "replaceState" : "pushState"](
      {},
      "",
      p.size ? "?" + p.toString() : "/",
    );
    setRoute(new URLSearchParams(p));
  }
  if (!settings)
    return (
      <div className="loading">
        <Brand />
        {error ? (
          <>
            <ErrorBox error={error} />
            <button onClick={() => void refresh()}>Try again</button>
          </>
        ) : (
          <p>Opening your vault…</p>
        )}
      </div>
    );
  if (!settings.configured)
    return <Wizard settings={settings} onReady={refresh} />;
  if (!unlocked) return <Unlock onUnlock={refresh} />;
  const view = route.get("view") || "collection";
  const profile = route.get("profile") || "";
  const go = (view: string) => {
    const p = new URLSearchParams();
    if (view !== "collection") p.set("view", view);
    if (profile) p.set("profile", profile);
    navigate(p);
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              go("collection");
            }}
          >
            <Brand />
          </a>
          <div className="sidebar-caption">YOUR PERSONAL ARCHIVE</div>
          <nav aria-label="Main">
            {[
              ["collection", "grid", "Collection"],
              ["status", "download", "Backup status"],
              ["settings", "settings", "Settings"],
            ].map(([id, icon, label]) => (
              <button
                key={id}
                className={"nav-item " + (view === id ? "active" : "")}
                onClick={() => go(id)}
              >
                <Icon name={icon} />
                {label}
                {view === id && <span className="nav-dot" />}
              </button>
            ))}
          </nav>
          <div className="sidebar-profiles">
            <div className="sidebar-caption">
              PROFILES <span>{settings.profiles.length}</span>
            </div>
            <button
              className={"profile-row " + (!profile ? "selected" : "")}
              onClick={() => {
                const p = new URLSearchParams(route);
                p.delete("profile");
                p.delete("page");
                navigate(p);
              }}
            >
              <span className="avatar all">∞</span>All profiles
            </button>
            {settings.profiles.map((p, i) => (
              <button
                key={p.id}
                className={
                  "profile-row " + (profile === p.id ? "selected" : "")
                }
                onClick={() => {
                  const n = new URLSearchParams(route);
                  n.set("profile", p.id);
                  n.delete("page");
                  navigate(n);
                }}
              >
                <span className={"avatar shade" + (i % 3)}>
                  {p.label[0]?.toUpperCase()}
                </span>
                <span>
                  {p.label}
                  <small>@{p.username}</small>
                </span>
              </button>
            ))}
            <button className="add-profile" onClick={() => go("settings")}>
              ＋ Connect an account
            </button>
          </div>
          <div className="sidebar-bottom">
            <span className="local-dot" />{" "}
            {settings.demo ? "Synthetic demo" : "Stored on your device"}
            <small>Your history belongs to you.</small>
            <button
              className="text-button"
              onClick={async () => {
                await api("/api/logout", {});
                await refresh();
              }}
            >
              <Icon name="lock" size={15} /> Lock vault
            </button>
          </div>
        </aside>
        <main id="main" className="workspace" tabIndex={-1}>
          <header className="topbar">
            <span>YOUR TUMBLR, KEPT.</span>
            <div>
              {settings.demo && (
                <span className="badge">DEMO · SYNTHETIC CONTENT</span>
              )}
              <span className="badge subtle">LOCAL FIRST</span>
              <button
                className="top-lock"
                aria-label="Lock vault"
                onClick={async () => {
                  await api("/api/logout", {});
                  await refresh();
                }}
              >
                <Icon name="lock" size={16} />
              </button>
            </div>
          </header>
          <div className="mobile-profile">
            <Field label="Profile">
              <select
                value={profile}
                onChange={(e) => {
                  const p = new URLSearchParams(route);
                  e.target.value
                    ? p.set("profile", e.target.value)
                    : p.delete("profile");
                  p.delete("page");
                  navigate(p);
                }}
              >
                <option value="">All profiles</option>
                {settings.profiles.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {view === "settings" ? (
            <Preferences settings={settings} refresh={refresh} />
          ) : view === "status" ? (
            <Backup profile={profile} settings={settings} />
          ) : (
            <Collection route={route} navigate={navigate} settings={settings} />
          )}
        </main>
      </div>
    </>
  );
}
function Unlock({ onUnlock }: { onUnlock: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-screen">
      <Brand />
      <section className="auth-card">
        <span className="feature-icon">
          <Icon name="lock" size={28} />
        </span>
        <h1>Welcome back.</h1>
        <p>Your archive is right where you left it.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/api/login", { password });
              await onUnlock();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Vault password">
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorBox error={error} />
          <button className="primary full" disabled={busy}>
            {busy ? "Unlocking…" : "Unlock vault"}
            <Icon name="arrow" />
          </button>
        </form>
        <small>
          This is your local vault password, separate from your Tumblr password.
        </small>
      </section>
    </div>
  );
}
function Wizard({
  settings,
  onReady,
}: {
  settings: Settings;
  onReady: () => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [clip, setClip] = useState<Settings["clip"]>("off");
  const [url, setUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [label, setLabel] = useState("My Tumblr");
  const [schedule, setSchedule] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const next = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (step === 0 && (password.length < 12 || password !== confirm)) {
      setError(
        password.length < 12
          ? "Choose at least 12 characters."
          : "The passwords do not match.",
      );
      return;
    }
    if (step === 1 && clip === "immich" && !url) {
      setError("Enter the machine-learning URL, or choose another option.");
      return;
    }
    if (step === 2 && !!clientId !== !!clientSecret) {
      setError(
        "Enter both the application key and secret, or leave both blank to connect later.",
      );
      return;
    }
    setStep(step + 1);
  };
  async function finish() {
    setBusy(true);
    setError("");
    try {
      await api("/api/setup", {
        password,
        clip,
        mlUrl: url,
        scheduleHours: schedule,
        clientId,
        clientSecret,
      });
      if (clientId && !settings.demo) {
        const r = await api<{ url: string }>("/api/oauth/start", { label });
        location.assign(r.url);
      } else await onReady();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const steps = [
    "Make it yours",
    "Choose your search",
    "Connect Tumblr",
    "You’re all set",
  ];
  return (
    <div className="wizard-shell">
      <aside className="wizard-rail">
        <Brand />
        <div className="wizard-promise">
          <div className="eyebrow">A HOME FOR YOUR HISTORY</div>
          <h2>
            Keep the things
            <br />
            you kept.
          </h2>
          <p>
            Posts, likes, and all the moments in between. Saved in a place you
            control.
          </p>
        </div>
        <ol className="steps">
          {steps.map((s, i) => (
            <li
              key={s}
              className={step === i ? "current" : step > i ? "done" : ""}
            >
              <span>
                {step > i ? (
                  <Icon name="check" size={16} />
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </span>
              <div>
                {s}
                <small>
                  {
                    [
                      "A private space on your device",
                      "Keywords, images, or both",
                      "Read-only access. Always.",
                      "Your archive starts here",
                    ][i]
                  }
                </small>
              </div>
            </li>
          ))}
        </ol>
        <small className="rail-note">
          <Icon name="lock" size={15} /> No cloud account. No tracking. Your
          files.
        </small>
      </aside>
      <main className="wizard-main">
        <div className="wizard-top">
          <span>SETUP · {String(step + 1).padStart(2, "0")} / 04</span>
          <span>About 3 minutes</span>
        </div>
        <section className="wizard-content">
          <span className="feature-icon">
            <Icon name={["vault", "spark", "lock", "check"][step]} size={28} />
          </span>
          <h1 ref={heading} tabIndex={-1}>
            {
              [
                "Your Tumblr.\nYour own little corner.",
                "Find it the way\nyou remember it.",
                "Bring your history\nhome.",
                "A good place\nto start again.",
              ][step]
            }
          </h1>
          <p className="lead">
            {
              [
                "Let’s make a private home for your archive. A few simple choices, then you’re in.",
                "Search the words you saved. Or describe an image you can almost picture.",
                "Connect one account now, or get comfortable and add accounts later.",
                "Everything stays on your device. Connect Tumblr to start your first backup, or open your vault now.",
              ][step]
            }
          </p>
          <form onSubmit={next}>
            {step === 0 && (
              <>
                <Field
                  label="Create a vault password"
                  hint="At least 12 characters. This protects the app and account settings."
                >
                  <input
                    autoComplete="new-password"
                    type="password"
                    minLength={12}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Make it memorable, make it yours"
                  />
                </Field>
                <Field label="Confirm password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
                <div className="storage-note">
                  <Icon name="download" />
                  <div>
                    <b>Room to grow</b>
                    <span>
                      {bytes(settings.storageFree)} free on this device
                    </span>
                    <code>{settings.dataDir}</code>
                  </div>
                </div>
                <small>
                  To choose another drive, restart with{" "}
                  <code>--data-dir /your/archive</code> before continuing.
                </small>
              </>
            )}
            {step === 1 && (
              <>
                <div className="choices">
                  {(
                    [
                      [
                        "off",
                        "search",
                        "Start with text search",
                        "Fast, weighted BM25 search. No model download.",
                      ],
                      [
                        "local",
                        "spark",
                        "Add local image search",
                        "CLIP runs on your device. First use downloads a model; allow about 1 GB disk and 2 GB RAM.",
                      ],
                      [
                        "immich",
                        "image",
                        "Use an existing Immich ML server",
                        "Reuse a machine-learning service you already run.",
                      ],
                    ] as const
                  ).map(([id, icon, title, desc]) => (
                    <label
                      className={"choice " + (clip === id ? "chosen" : "")}
                      key={id}
                    >
                      <input
                        type="radio"
                        name="clip"
                        checked={clip === id}
                        onChange={() => setClip(id)}
                      />
                      <Icon name={icon} />
                      <span>
                        <b>{title}</b>
                        <small>{desc}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {clip === "immich" && (
                  <Field label="Immich machine-learning URL">
                    <input
                      type="url"
                      placeholder="http://your-server:3003"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      required
                    />
                  </Field>
                )}
                <p className="quiet">
                  You can change this later. Image search understands visual
                  meaning; it does not read text inside images.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <div className="callout">
                  <Icon name="lock" />
                  <div>
                    <b>Read-only, by design.</b>
                    <p>
                      Vault reads posts and likes. It cannot post, delete, or
                      change your Tumblr.
                    </p>
                  </div>
                </div>
                {!settings.demo && (
                  <>
                    <p className="body-copy">
                      Tumblr requires your own free API application.{" "}
                      <a
                        href="https://www.tumblr.com/oauth/apps"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Register an application ↗
                      </a>
                      , then paste its OAuth consumer key and secret below.
                    </p>
                    <Field
                      label="Callback URL"
                      hint="Copy this exact URL into your Tumblr application’s callback field."
                    >
                      <Copy value={settings.callbackUrl} />
                    </Field>
                    <div className="two-fields">
                      <Field label="Application key">
                        <input
                          autoComplete="off"
                          value={clientId}
                          onChange={(e) => setClientId(e.target.value)}
                        />
                      </Field>
                      <Field label="Application secret">
                        <input
                          type="password"
                          autoComplete="off"
                          value={clientSecret}
                          onChange={(e) => setClientSecret(e.target.value)}
                        />
                      </Field>
                    </div>
                    <Field label="Profile name">
                      <input
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        maxLength={100}
                      />
                    </Field>
                  </>
                )}
                {settings.demo && (
                  <p>
                    This demo uses generated images and invented posts. No
                    Tumblr connection is needed.
                  </p>
                )}
                <Field label="Automatic backups">
                  <select
                    value={schedule}
                    onChange={(e) => setSchedule(Number(e.target.value))}
                  >
                    <option value={24}>Every day while Vault is running</option>
                    <option value={6}>Every 6 hours while running</option>
                    <option value={0}>Manual backups only</option>
                  </select>
                </Field>
                <small>
                  Leave the app key blank to connect later. Your Tumblr password
                  is never entered here.
                </small>
              </>
            )}
            {step === 3 && (
              <>
                <div className="review-list">
                  {[
                    [
                      "Private by default",
                      "Your vault is protected by your own password.",
                    ],
                    [
                      "Search, your way",
                      clip === "off"
                        ? "Text search is ready. Add image search any time."
                        : clip === "local"
                          ? "Local CLIP is enabled. The model downloads when indexing starts."
                          : "Your Immich service will power image search.",
                    ],
                    [
                      "No content left behind",
                      "Available posts, likes, original media, and source JSON are retained.",
                    ],
                    [
                      "A clear picture",
                      "Backup status shows saved, pending, and unavailable sources.",
                    ],
                  ].map(([title, desc]) => (
                    <div key={title}>
                      <span className="review-check">
                        <Icon name="check" size={16} />
                      </span>
                      <div>
                        <b>{title}</b>
                        <p>{desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="quiet">
                  API access cannot recover deleted or inaccessible posts.
                  Unavailable external media is reported, never silently treated
                  as saved.
                </p>
              </>
            )}
            <ErrorBox error={error} />
            <div className="wizard-actions">
              {step > 0 ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </button>
              ) : (
                <span className="quiet">01 — A space of your own</span>
              )}
              {step < 3 ? (
                <button className="primary">
                  {step === 2 && !clientId ? "Connect later" : "Continue"}
                  <Icon name="arrow" />
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void finish()}
                >
                  {busy
                    ? "Getting ready…"
                    : clientId && !settings.demo
                      ? "Connect Tumblr & open vault"
                      : "Open my vault"}
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          </form>
        </section>
        <footer className="wizard-footer">
          BUILT FOR KEEPING. MADE FOR YOU.
          <span>TypeScript · SQLite · Local first</span>
        </footer>
      </main>
    </div>
  );
}
function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
function Collection({
  route,
  navigate,
  settings,
}: {
  route: URLSearchParams;
  navigate: (p: URLSearchParams, replace?: boolean) => void;
  settings: Settings;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries(route));
  const [data, setData] = useState<SearchResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(false);
  const opening = useRef<HTMLAnchorElement | null>(null);
  const lastScroll = useRef(0);
  const qref = useRef<HTMLInputElement>(null);
  const profile = route.get("profile") || "";
  const id = route.get("post");
  const queryKey = new URLSearchParams(route);
  queryKey.delete("post");
  const key = queryKey.toString();
  useEffect(() => {
    setDraft(Object.fromEntries(route));
  }, [route]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api<SearchResult>("/api/search?" + key)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setData(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  useEffect(() => {
    if (!id && opening.current) {
      opening.current.focus({ preventScroll: true });
      window.scrollTo(0, lastScroll.current);
    }
  }, [id]);
  const update = (name: string, value: string) =>
    setDraft((d) => ({ ...d, [name]: value }));
  const apply = (e?: FormEvent) => {
    e?.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(draft))
      if (v && !["page", "post", "view"].includes(k)) p.set(k, v);
    navigate(p);
  };
  const change = (k: string, v: string) => {
    const p = new URLSearchParams(route);
    v ? p.set(k, v) : p.delete(k);
    if (k !== "page") p.delete("page");
    p.delete("post");
    navigate(p);
  };
  const label =
    settings.profiles.find((p) => p.id === profile)?.label || "All profiles";
  return (
    <section className="page collection">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{label.toUpperCase()}</div>
          <h1>
            Your collection<span className="heading-dot">.</span>
          </h1>
          <p>A little of who you were. A lot worth keeping.</p>
        </div>
        <button
          className="soft"
          onClick={() => {
            const p = new URLSearchParams(route);
            p.set("view", "status");
            navigate(p);
          }}
        >
          <Icon name="download" />
          Backup status
        </button>
      </div>
      <form className="search-panel" onSubmit={apply}>
        <div className="search-tabs" role="group" aria-label="Search mode">
          <button
            type="button"
            className={(draft.mode || "text") === "text" ? "selected" : ""}
            onClick={() => update("mode", "text")}
          >
            <Icon name="search" size={16} />
            Keywords
          </button>
          <button
            type="button"
            className={draft.mode === "image" ? "selected" : ""}
            onClick={() => update("mode", "image")}
          >
            <Icon name="spark" size={16} />
            Image meaning
          </button>
        </div>
        <div className="search-line">
          <Icon name="search" size={22} />
          <input
            ref={qref}
            aria-label="Search your collection"
            placeholder={
              draft.mode === "image"
                ? "Describe an image — a quiet street at dusk…"
                : "A word, a tag, a half-remembered thought…"
            }
            value={draft.q || ""}
            onChange={(e) => update("q", e.target.value)}
          />
          <button className="primary">
            Search
            <Icon name="arrow" size={18} />
          </button>
        </div>
        <div className="search-bottom">
          <span>
            {draft.mode === "image"
              ? "Search by visual meaning with CLIP"
              : "Full-text search · ranked by BM25"}
          </span>
          <button
            className={"text-button " + (filters ? "selected" : "")}
            type="button"
            aria-expanded={filters}
            onClick={() => setFilters(!filters)}
          >
            <Icon name="filter" size={16} />
            Filters{" "}
            {Object.keys(draft).filter(
              (k) =>
                draft[k] &&
                [
                  "role",
                  "blog",
                  "type",
                  "tag",
                  "after",
                  "before",
                  "likedAfter",
                  "likedBefore",
                ].includes(k),
            ).length || ""}
          </button>
        </div>
        {filters && (
          <div className="filter-grid">
            <Field label="Collection">
              <select
                value={draft.role || ""}
                onChange={(e) => update("role", e.target.value)}
              >
                <option value="">Posts & likes</option>
                <option value="post">Posts</option>
                <option value="like">Likes</option>
              </select>
            </Field>
            <Field label="Blog">
              <select
                value={draft.blog || ""}
                onChange={(e) => update("blog", e.target.value)}
              >
                <option value="">All blogs</option>
                {[
                  ...new Set([
                    ...(data?.blogs || []),
                    ...(draft.blog ? [draft.blog] : []),
                  ]),
                ].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </Field>
            <Field label="Post type">
              <select
                value={draft.type || ""}
                onChange={(e) => update("type", e.target.value)}
              >
                <option value="">All types</option>
                {[
                  ...new Set([
                    ...(data?.types || []),
                    ...(draft.type ? [draft.type] : []),
                  ]),
                ].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </Field>
            <Field label="Tag">
              <input
                value={draft.tag || ""}
                onChange={(e) => update("tag", e.target.value)}
              />
            </Field>
            <Field label="Match">
              <select
                value={draft.match || "all"}
                onChange={(e) => update("match", e.target.value)}
              >
                <option value="all">All words</option>
                <option value="any">Any word</option>
                <option value="phrase">Exact phrase</option>
              </select>
            </Field>
            <Field label="Order">
              <select
                value={draft.sort || "relevance"}
                onChange={(e) => update("sort", e.target.value)}
              >
                <option value="relevance">Relevance</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </Field>
            {[
              ["after", "Published from"],
              ["before", "Published through"],
              ["likedAfter", "Liked from"],
              ["likedBefore", "Liked through"],
            ].map(([k, l]) => (
              <Field key={k} label={l}>
                <input
                  type="date"
                  value={draft[k] || ""}
                  onChange={(e) => update(k, e.target.value)}
                />
              </Field>
            ))}
            <small className="date-note">Dates cover the whole UTC day.</small>
            <button className="soft" type="submit">
              Apply filters
              <Icon name="check" size={16} />
            </button>
          </div>
        )}
      </form>
      <div className="active-filters">
        {[...route]
          .filter(
            ([k, v]) =>
              v &&
              ![
                "q",
                "mode",
                "page",
                "post",
                "view",
                "match",
                "sort",
                "profile",
              ].includes(k),
          )
          .map(([k, v]) => (
            <button key={k} onClick={() => change(k, "")}>
              {k === "similar" ? "Similar image" : k + ": " + v}
              <Icon name="close" size={13} />
            </button>
          ))}
      </div>
      <div className="collection-toolbar">
        <span>
          {loading
            ? "Looking through your archive…"
            : data
              ? `${number(data.total)} ${data.total === 1 ? "entry" : "entries"}`
              : "Search paused"}
          {!loading && data && <small> · {label}</small>}
        </span>
        <span className="view-label">
          <Icon name="grid" size={15} /> Gallery
        </span>
      </div>
      <ErrorBox error={error} />
      {data?.notice && <div className="callout">{data.notice}</div>}
      {!loading && !error && data?.entries.length === 0 && (
        <div className="empty">
          <Icon name="search" size={36} />
          <h2>
            {data.total === 0 && settings.profiles.length === 0
              ? "Your story starts here."
              : "Nothing here just yet."}
          </h2>
          <p>
            {settings.profiles.length === 0
              ? "Connect a Tumblr account in Settings, then start your first backup."
              : "Try a different search, remove a filter, or check backup coverage."}
          </p>
          <button
            onClick={() => {
              const p = new URLSearchParams();
              if (profile) p.set("profile", profile);
              navigate(p);
              qref.current?.focus();
            }}
          >
            Clear search & filters
          </button>
        </div>
      )}
      <div className={"cards " + (loading ? "busy" : "")} aria-busy={loading}>
        {data?.entries.map((entry) => (
          <article className="post-card" key={entry.groupId}>
            {entry.media.find((m) => m.thumb) && (
              <a
                href={
                  "?" +
                  new URLSearchParams({
                    ...Object.fromEntries(route),
                    post: entry.id,
                  })
                }
                tabIndex={-1}
                aria-hidden="true"
                onClick={(e) => {
                  e.preventDefault();
                  lastScroll.current = window.scrollY;
                  const p = new URLSearchParams(route);
                  p.set("post", entry.id);
                  navigate(p);
                }}
              >
                <img
                  src={
                    "/api/media/" +
                    entry.media.find((m) => m.thumb)!.id +
                    "?thumb=1"
                  }
                  alt=""
                  loading="lazy"
                />
              </a>
            )}
            <div className="card-body">
              <div className="card-byline">
                <span className="mini-avatar">
                  {entry.blog[0]?.toUpperCase()}
                </span>
                <span>{entry.blog}</span>
                <time>
                  {new Date(entry.timestamp * 1000).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric", year: "numeric" },
                  )}
                </time>
              </div>
              <h2>
                <a
                  href={
                    "?" +
                    new URLSearchParams({
                      ...Object.fromEntries(route),
                      post: entry.id,
                    })
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    opening.current = e.currentTarget;
                    lastScroll.current = window.scrollY;
                    const p = new URLSearchParams(route);
                    p.set("post", entry.id);
                    navigate(p);
                  }}
                >
                  {entry.title ||
                    entry.text.slice(0, 80) ||
                    "Saved " + entry.type}
                </a>
              </h2>
              <p>
                {entry.text.slice(0, 210)}
                {entry.text.length > 210 ? "…" : ""}
              </p>
              <div className="tags">
                {entry.tags.slice(0, 5).map((t) => (
                  <button key={t} onClick={() => change("tag", t)}>
                    #{t}
                  </button>
                ))}
              </div>
              <div className="card-actions">
                <span>{entry.actions.join(" · ")}</span>
                <span>
                  {entry.versions > 1
                    ? entry.versions + " saved versions"
                    : "Kept for you"}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
      {data && data.pages > 1 && (
        <div className="pagination">
          <button
            disabled={data.page <= 1}
            onClick={() => change("page", String(data.page - 1))}
          >
            Previous
          </button>
          <span>
            Page {data.page} of {data.pages}
          </span>
          <button
            disabled={data.page >= data.pages}
            onClick={() => change("page", String(data.page + 1))}
          >
            Next
          </button>
        </div>
      )}
      {id && (
        <Post
          id={id}
          profile={profile}
          close={() => {
            const p = new URLSearchParams(route);
            p.delete("post");
            navigate(p);
          }}
          onTag={(tag) => change("tag", tag)}
          onSimilar={(media) => {
            const p = new URLSearchParams(route);
            p.delete("post");
            p.delete("page");
            p.set("similar", String(media));
            navigate(p);
          }}
          onVersion={(id) => {
            const p = new URLSearchParams(route);
            p.set("post", id);
            navigate(p);
          }}
        />
      )}
    </section>
  );
}
function Post({
  id,
  profile,
  close,
  onTag,
  onSimilar,
  onVersion,
}: {
  id: string;
  profile: string;
  close: () => void;
  onTag: (tag: string) => void;
  onSimilar: (id: number) => void;
  onVersion: (id: string) => void;
}) {
  const [post, setPost] = useState<Detail>();
  const [error, setError] = useState("");
  const [gallery, setGallery] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const galleryElement = useRef<HTMLDivElement>(null);
  const imageOpeners = useRef<(HTMLButtonElement | null)[]>([]);
  const galleryOrigin = useRef<number | null>(null);
  useEffect(() => {
    if (gallery !== null) galleryElement.current?.focus();
    else if (galleryOrigin.current !== null) {
      imageOpeners.current[galleryOrigin.current]?.focus();
      galleryOrigin.current = null;
    }
  }, [gallery]);
  useEffect(() => {
    dialog.current?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);
  useEffect(() => {
    setPost(undefined);
    setError("");
    api<Detail>(
      "/api/posts/" +
        encodeURIComponent(id) +
        "?profile=" +
        encodeURIComponent(profile),
    )
      .then(setPost)
      .catch((e) => setError(e.message));
  }, [id, profile]);
  const images = post?.media.filter((m) => m.thumb) || [];
  return (
    <dialog
      ref={dialog}
      className="post-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (gallery !== null) setGallery(null);
        else close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="detail-shell">
        <div className="detail-top">
          <span>
            {gallery !== null
              ? "IMAGE " + (gallery + 1) + " / " + images.length
              : "SAVED POST"}
          </span>
          <button
            aria-label={gallery !== null ? "Close image" : "Back to collection"}
            onClick={() => (gallery !== null ? setGallery(null) : close())}
          >
            <Icon name="close" />
          </button>
        </div>
        <ErrorBox error={error} />
        {error && <button onClick={close}>Back to collection</button>}
        {post && gallery === null && (
          <>
            <div className="detail-meta">
              @{post.blog} ·{" "}
              {new Date(post.timestamp * 1000).toLocaleDateString()} ·{" "}
              {post.actions.join(" · ")}
            </div>
            <h1>{post.title || "Saved " + post.type}</h1>
            <div className="detail-images">
              {images.map((m, i) => (
                <button
                  key={m.id}
                  ref={(el) => {
                    imageOpeners.current[i] = el;
                  }}
                  onClick={() => {
                    galleryOrigin.current = i;
                    setGallery(i);
                  }}
                  aria-label={"Inspect image " + (i + 1)}
                >
                  <img
                    src={"/api/media/" + m.id + "?thumb=1"}
                    alt={"Saved image " + (i + 1)}
                  />
                </button>
              ))}
            </div>
            {post.blocks.length ? (
              post.blocks.map((b, i) => (
                <div className="trail-block" key={i}>
                  <b>@{b.author}</b>
                  <p>
                    {b.text || "This part of the reblog trail was unavailable."}
                  </p>
                </div>
              ))
            ) : (
              <p className="detail-text">{post.text}</p>
            )}
            <div className="tags">
              {post.tags.map((t) => (
                <button key={t} onClick={() => onTag(t)}>
                  #{t}
                </button>
              ))}
            </div>
            <div className="detail-links">
              {images[0] && (
                <button
                  className="soft"
                  onClick={() => onSimilar(images[0].id)}
                >
                  <Icon name="spark" />
                  Find similar images
                </button>
              )}
              {post.url.startsWith("https://") && (
                <a
                  className="button ghost"
                  href={post.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Tumblr ↗
                </a>
              )}
              <button
                className="ghost"
                onClick={() => {
                  const u = URL.createObjectURL(
                    new Blob([JSON.stringify(post.raw, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = u;
                  a.download = "tumblr-" + post.id + ".json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(u), 1000);
                }}
              >
                Save source JSON
              </button>
            </div>
            <details>
              <summary>
                Saved actions & versions ({post.savedVersions.length})
              </summary>
              {post.savedVersions.map((v) => (
                <button
                  className="version"
                  key={v.id}
                  onClick={() => onVersion(v.id)}
                >
                  @{v.blog} · {v.actions.join(", ")} ·{" "}
                  {new Date(v.timestamp * 1000).toLocaleDateString()}
                </button>
              ))}
            </details>
            <details>
              <summary>Original media ({post.media.length})</summary>
              {post.media.map((m) => (
                <div className="original-row" key={m.id}>
                  <span>
                    {m.kind} ·{" "}
                    {m.saved ? bytes(m.bytes) : m.error || "Not downloaded yet"}
                  </span>
                  {m.saved && (
                    <a
                      className="button ghost"
                      href={"/api/media/" + m.id}
                      download
                    >
                      Download
                    </a>
                  )}
                </div>
              ))}
            </details>
          </>
        )}
        {post && gallery !== null && (
          <div
            className="gallery"
            ref={galleryElement}
            role="group"
            aria-label="Image gallery. Use left and right arrow keys to navigate."
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                setGallery((gallery + 1) % images.length);
              }
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setGallery((gallery + images.length - 1) % images.length);
              }
            }}
          >
            <img
              src={"/api/media/" + images[gallery].id + "?thumb=1"}
              alt={"Saved image " + (gallery + 1)}
            />
            <div>
              <button
                aria-label="Previous image"
                onClick={() =>
                  setGallery((gallery + images.length - 1) % images.length)
                }
              >
                ←
              </button>
              <a
                className="button soft"
                href={"/api/media/" + images[gallery].id}
                download
              >
                Download original
              </a>
              <button
                aria-label="Next image"
                onClick={() => setGallery((gallery + 1) % images.length)}
              >
                →
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
function Backup({
  profile,
  settings,
}: {
  profile: string;
  settings: Settings;
}) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const load = () =>
    api<Status>("/api/status?profile=" + encodeURIComponent(profile))
      .then(setStatus)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [profile]);
  const busy = status && ["running", "waiting"].includes(status.progress.state);
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A COPY YOU CAN COUNT ON</div>
          <h1>Keep an eye on things.</h1>
          <p>Clear progress. Honest coverage. No guessing.</p>
        </div>
        <button
          className="primary"
          disabled={!!busy || settings.demo || !settings.profiles.length}
          onClick={async () => {
            try {
              await api("/api/sync", { profile });
              await load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Icon name="download" />
          {busy ? "Backup in progress" : "Back up now"}
        </button>
      </div>
      <ErrorBox error={error} />
      {status && (
        <>
          <div className="progress-card">
            <span className={"state-label " + (busy ? "pulse" : "")}>
              {status.progress.state.toUpperCase()}
            </span>
            <h2>{status.progress.message}</h2>
            <p>
              {status.progress.stage.replaceAll("_", " ")}
              {status.progress.processed
                ? " · " +
                  number(status.progress.processed) +
                  " processed this stage"
                : ""}
              {status.progress.resumeAt
                ? " · Resumes " +
                  new Date(status.progress.resumeAt).toLocaleString()
                : ""}
            </p>
            {busy && <div className="indeterminate" />}
            <small>
              Job progress covers the current run. Totals below reflect{" "}
              {profile
                ? settings.profiles.find((p) => p.id === profile)?.label
                : "all profiles"}
              .
            </small>
          </div>
          <div className="stats">
            {[
              ["Collection entries", status.entries],
              ["Saved source records", status.records],
              ["Originals downloaded", status.saved],
              ["Images indexed", status.indexed],
              ["Unavailable sources", status.unavailable],
              ["Total media discovered", status.media],
            ].map(([title, value]) => (
              <div key={title}>
                <span>{title}</span>
                <strong>{number(Number(value))}</strong>
              </div>
            ))}
          </div>
          <h2 className="section-title">Account coverage</h2>
          {status.profiles.map((p) => (
            <div className="coverage" key={p.id}>
              <div>
                <span className="avatar">{p.label[0]}</span>
                <div>
                  <h3>{p.label}</h3>
                  <small>@{p.username}</small>
                </div>
              </div>
              <p>
                {p.expectedPosts !== undefined
                  ? number(p.expectedPosts) + " posts reported by Tumblr"
                  : "No metadata count yet"}{" "}
                ·{" "}
                {p.expectedLikes !== undefined
                  ? number(p.expectedLikes) + " likes reported"
                  : "Likes not counted yet"}
              </p>
              <p>
                {p.lastSync
                  ? "Last completed metadata pass: " +
                    new Date(p.lastSync).toLocaleString()
                  : "No completed metadata pass yet."}
              </p>
              {p.error && <p className="warning">{p.error}</p>}
            </div>
          ))}
          <div className="callout">
            <Icon name="lock" />
            <div>
              <b>Know what you have.</b>
              <p>
                {bytes(status.bytes)} of saved media. Tumblr counts are a
                point-in-time reference, and can include content the API cannot
                return. External embeds, deleted or restricted posts may remain
                unavailable. A snapshot is kept in{" "}
                <code>exports/latest.sqlite</code>; copy the whole vault
                directory to another drive for an independent backup.
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function Preferences({
  settings,
  refresh,
}: {
  settings: Settings;
  refresh: () => Promise<void>;
}) {
  const [clip, setClip] = useState(settings.clip);
  const [mlUrl, setMlUrl] = useState(settings.mlUrl);
  const [schedule, setSchedule] = useState(settings.scheduleHours);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/settings", {
        clip,
        mlUrl,
        scheduleHours: schedule,
        clientId,
        clientSecret,
        password,
      });
      setClientId("");
      setClientSecret("");
      setPassword("");
      setMessage("Settings saved.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE YOURSELF AT HOME</div>
          <h1>Your vault, your way.</h1>
          <p>A few good defaults. Room to make them yours.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {location.search.includes("connection=success") && (
        <div className="notice">
          Account connected. Open Backup status to start your first backup.
        </div>
      )}
      {location.search.includes("connection=failed") && (
        <ErrorBox error="Tumblr connection failed. Check the application key, secret and exact callback URL, then try again." />
      )}
      {location.search.includes("connection=cancelled") && (
        <div className="notice">
          Connection cancelled. You can reconnect whenever you’re ready.
        </div>
      )}
      <form onSubmit={save}>
        <div className="settings-card">
          <h2>
            <Icon name="spark" />
            Search & backups
          </h2>
          <Field label="Image search">
            <select
              value={clip}
              onChange={(e) => setClip(e.target.value as Settings["clip"])}
            >
              <option value="off">Text search only</option>
              <option value="local">
                Local CLIP · model downloaded on first indexing
              </option>
              <option value="immich">
                Existing Immich machine-learning server
              </option>
            </select>
          </Field>
          {clip === "immich" && (
            <Field label="Machine-learning URL">
              <input
                type="url"
                required
                value={mlUrl}
                onChange={(e) => setMlUrl(e.target.value)}
              />
            </Field>
          )}
          <p className="quiet">
            Local CLIP runs in TypeScript through ONNX. The first run needs
            internet, about 1 GB of disk and 2 GB of available RAM. Switching
            models requires reindexing.
          </p>
          <Field label="Automatic backup interval">
            <select
              value={schedule}
              onChange={(e) => setSchedule(Number(e.target.value))}
            >
              <option value={24}>Every day</option>
              <option value={6}>Every 6 hours</option>
              <option value={0}>Manual only</option>
            </select>
          </Field>
          <small>
            Schedules run while the app is running. Docker restarts the app
            automatically.
          </small>
          <button
            type="button"
            className="soft"
            disabled={
              settings.demo ||
              clip === "off" ||
              clip !== settings.clip ||
              mlUrl !== settings.mlUrl
            }
            onClick={async () => {
              try {
                await api("/api/index", {});
                setMessage(
                  "Image indexing started. Follow progress in Backup status.",
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Build image index
            <Icon name="spark" size={16} />
          </button>
        </div>
        <div className="settings-card">
          <h2>
            <Icon name="lock" />
            Tumblr application
          </h2>
          <p>
            Register a free{" "}
            <a
              href="https://www.tumblr.com/oauth/apps"
              target="_blank"
              rel="noreferrer"
            >
              Tumblr API application ↗
            </a>{" "}
            with this exact callback URL. Access is limited to{" "}
            <code>basic offline_access</code>.
          </p>
          <Field label="Callback URL">
            <Copy value={settings.callbackUrl} />
          </Field>
          <div className="two-fields">
            <Field
              label="Replace application key"
              hint="Blank keeps the saved key."
            >
              <input
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </Field>
            <Field
              label="Replace application secret"
              hint="Blank keeps the saved secret."
            >
              <input
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Change vault password"
            hint="Leave blank to keep your current password."
          >
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
          <Icon name="check" size={18} />
        </button>
      </form>
      <div className="settings-card">
        <h2>Connected profiles</h2>
        {settings.profiles.map((p) => (
          <div className="connected" key={p.id}>
            <div>
              <b>{p.label}</b>
              <small>
                @{p.username} · {p.blogs.length} blogs
              </small>
              {p.error && <small>{p.error}</small>}
            </div>
            <button
              className="ghost"
              disabled={settings.demo}
              onClick={async () => {
                try {
                  await api("/api/profiles/" + p.id, {}, "DELETE");
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Disconnect
            </button>
          </div>
        ))}
        <Field label="New profile name">
          <input
            placeholder="e.g. Personal, Art blog, Old favourites"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={100}
          />
        </Field>
        <button
          className="soft"
          disabled={settings.demo || busy}
          onClick={async () => {
            setError("");
            try {
              const r = await api<{ url: string }>("/api/oauth/start", {
                label: label || "My Tumblr",
              });
              location.assign(r.url);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Connect Tumblr account
          <Icon name="arrow" size={18} />
        </button>
        <p className="quiet">
          Save application credentials above before connecting. To add another
          Tumblr account, switch accounts on Tumblr first. Disconnecting removes
          its local token and keeps the saved archive.
        </p>
      </div>
      <div className="settings-card">
        <h2>
          <Icon name="download" />
          Storage
        </h2>
        <Copy value={settings.dataDir} />
        <p>
          {bytes(settings.storageFree)} available. Originals, thumbnails, SQLite
          and model cache live here. Back up this whole folder, including the
          private config file. Keep it out of shared and public folders.
        </p>
        <small>
          To move your vault, stop the app, copy this folder, and restart with{" "}
          <code>--data-dir</code> pointing to the copy.
        </small>
      </div>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
