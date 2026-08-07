import { Search } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { cn } from "../lib/utils";

export type BrowserStartHistoryEntry = {
  id: string;
  title: string;
  url: string;
  visitedAt: string;
};

export type BrowserStartBookmark = {
  id: string;
  title: string;
  url: string;
};

type BrowserStartPageProps = {
  history?: BrowserStartHistoryEntry[];
  bookmarks?: BrowserStartBookmark[];
  onNavigate: (target: string) => void;
  onAskAgent: (prompt: string) => void;
  onOpenSettings?: () => void;
  className?: string;
};

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function faviconFor(url: string) {
  const host = hostnameOf(url);
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIDomain(host)}&sz=64`;
}

function encodeURIDomain(host: string) {
  return encodeURIComponent(host);
}

/** True when the tab should show the Atlas start page instead of a live site. */
export function isBrowserStartPageUrl(url?: string | null) {
  const value = String(url || "").trim();
  if (!value || value === "about:blank") return true;
  if (/\/api\/openbrowser\/new-tab/i.test(value)) return true;
  if (/^(chrome|edge|devtools|chrome-error|chromewebdata):/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    if (/^(chrome|edge|devtools|chrome-error|chromewebdata):/i.test(parsed.protocol)) return true;
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "google.com") return false;
    const path = parsed.pathname || "/";
    if (path !== "/" && path !== "/webhp") return false;
    return !parsed.searchParams.get("q");
  } catch {
    return true;
  }
}

const DEFAULT_SHORTCUTS = [
  { id: "gmail", label: "Gmail", url: "https://mail.google.com/" },
  { id: "youtube", label: "YouTube", url: "https://www.youtube.com/" },
  { id: "drive", label: "Drive", url: "https://drive.google.com/" },
  { id: "github", label: "GitHub", url: "https://github.com/" },
  { id: "reddit", label: "Reddit", url: "https://www.reddit.com/" },
  { id: "calendar", label: "Calendar", url: "https://calendar.google.com/" },
] as const;

export function BrowserStartPage({
  history = [],
  bookmarks = [],
  onNavigate,
  onAskAgent: _onAskAgent,
  onOpenSettings: _onOpenSettings,
  className,
}: BrowserStartPageProps) {
  const [query, setQuery] = useState("");

  const shortcuts = useMemo(() => {
    if (bookmarks.length) {
      return bookmarks.slice(0, 6).map((bookmark) => ({
        id: bookmark.id,
        label: bookmark.title || hostnameOf(bookmark.url) || "Bookmark",
        url: bookmark.url,
      }));
    }
    const hosts = new Map<string, { url: string; title: string; count: number }>();
    for (const entry of history) {
      const host = hostnameOf(entry.url);
      if (!host || isBrowserStartPageUrl(entry.url)) continue;
      const current = hosts.get(host);
      if (current) current.count += 1;
      else hosts.set(host, { url: entry.url, title: entry.title || host, count: 1 });
    }
    const fromHistory = [...hosts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([host, item]) => ({
        id: host,
        label: item.title.length > 22 ? host : item.title,
        url: item.url,
      }));
    return fromHistory.length >= 4 ? fromHistory : [...DEFAULT_SHORTCUTS];
  }, [bookmarks, history]);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    return history
      .filter((entry) => {
        const host = hostnameOf(entry.url);
        if (!host || isBrowserStartPageUrl(entry.url)) return false;
        const key = entry.url.split("#")[0] || entry.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
  }, [history]);

  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault();
    const next = query.trim();
    if (!next) return;
    onNavigate(next);
    setQuery("");
  };

  return (
    <div
      className={cn(
        "clyra-browser-start absolute inset-0 z-[15] flex flex-col overflow-auto bg-[color:var(--clyra-canvas)] text-[color:var(--clyra-text)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute left-1/2 top-[18%] h-[420px] w-[520px] -translate-x-1/2 rounded-full bg-[color:var(--clyra-accent)]/[0.045] blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[560px] flex-1 flex-col items-center justify-center px-6 pb-16 pt-10">
        <h1 className="text-[28px] font-medium tracking-[-0.04em] text-[color:var(--clyra-text)] sm:text-[32px]">
          Clyra
        </h1>
        <p className="mt-2 text-[13.5px] text-[color:var(--clyra-text-secondary)]">
          Search the web or ask anything
        </p>

        <form
          onSubmit={submitSearch}
          className="mt-8 flex h-11 w-full items-center gap-2.5 rounded-[10px] border border-[color:var(--clyra-border)] bg-white px-3.5 transition-[border-color,box-shadow] duration-150 focus-within:border-[color:var(--clyra-accent)]/35 focus-within:shadow-[0_0_0_3px_rgba(0,82,251,0.08)]"
        >
          <Search className="h-4 w-4 shrink-0 text-[color:var(--clyra-text-tertiary)]" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or enter address…"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--clyra-text)] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]"
            aria-label="Search or enter address"
            autoFocus
          />
        </form>

        <div className="mt-8 grid w-full grid-cols-3 gap-x-4 gap-y-4 sm:grid-cols-6">
          {shortcuts.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.url)}
              className="group flex flex-col items-center gap-2 rounded-[8px] px-1 py-2 transition-colors hover:bg-[color:var(--clyra-hover)]"
            >
              <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-[8px] border border-[color:var(--clyra-border)] bg-white">
                <img src={faviconFor(item.url)} alt="" className="h-4 w-4" />
              </span>
              <span className="max-w-full truncate text-[11.5px] text-[color:var(--clyra-text-secondary)] group-hover:text-[color:var(--clyra-text)]">
                {item.label}
              </span>
            </button>
          ))}
        </div>

        {recent.length ? (
          <div className="mt-10 w-full">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">
              Recent
            </p>
            <ul className="space-y-0.5">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(entry.url)}
                    className="flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-left transition-colors hover:bg-[color:var(--clyra-hover)]"
                  >
                    <img src={faviconFor(entry.url)} alt="" className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[color:var(--clyra-text)]">
                      {entry.title || hostnameOf(entry.url)}
                    </span>
                    <span className="shrink-0 text-[11px] text-[color:var(--clyra-text-tertiary)]">
                      {hostnameOf(entry.url)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default BrowserStartPage;
