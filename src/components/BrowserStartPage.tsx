import { Plus, Search, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useMemo, useState, type FormEvent } from "react";
import { cn } from "../lib/utils";
import { Bloub } from "./bloub/Bloub";

const ASK_CLYRA_USED_KEY = "clyra-browser-ask-clyra-used";

export function hasUsedAskClyra(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ASK_CLYRA_USED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAskClyraUsed() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ASK_CLYRA_USED_KEY, "1");
  } catch {
    // ignore
  }
}

function useLiveAccentColor(fallback = "#2563eb") {
  const [color] = useState(() => {
    if (typeof document === "undefined") return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue("--accent-600").trim();
    return value || fallback;
  });
  return color;
}

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
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

// A short, human label for a host — "Google" rather than "google.com" — so
// favourites and history never show raw domains or truncated URLs.
const KNOWN_SITE_LABELS: Record<string, string> = {
  "google.com": "Google",
  "youtube.com": "YouTube",
  "apple.com": "Apple",
  "github.com": "GitHub",
  "mail.google.com": "Gmail",
  "drive.google.com": "Drive",
  "calendar.google.com": "Calendar",
  "bing.com": "Bing",
  "bestbuy.com": "Best Buy",
  "ebay.com": "eBay",
  "reddit.com": "Reddit",
  "duckduckgo.com": "DuckDuckGo",
  "amazon.com": "Amazon",
};

function siteLabel(url: string) {
  const host = hostnameOf(url);
  return (
    KNOWN_SITE_LABELS[host]
    || host.split(".")[0]?.replace(/^./, (value) => value.toUpperCase())
    || "Site"
  );
}

// Turns a raw history entry into a readable line — e.g. a Google search
// results page becomes "Google Search — <query>" rather than the literal
// "https://www.google.com/search?q=..." URL.
function entryTitle(entry: BrowserStartHistoryEntry) {
  const raw = entry.title.trim();
  try {
    const parsed = new URL(entry.url);
    const host = hostnameOf(entry.url);
    if (host === "google.com" && parsed.pathname === "/search") {
      const query = (parsed.searchParams.get("q") || "").trim();
      return query ? `Google Search — ${query}` : "Google Search";
    }
  } catch {
    // fall through to the title/label below
  }
  if (!raw || /^https?:\/\//i.test(raw)) return siteLabel(entry.url);
  return raw;
}

/** True when the tab should show the Clyra start page instead of a live site. */
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
  { id: "google", label: "Google", url: "https://www.google.com/" },
  { id: "youtube", label: "YouTube", url: "https://www.youtube.com/" },
  { id: "apple", label: "Apple", url: "https://www.apple.com/" },
  { id: "github", label: "GitHub", url: "https://github.com/" },
  { id: "gmail", label: "Gmail", url: "https://mail.google.com/" },
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

export function BrowserStartPage({
  history = [],
  bookmarks = [],
  onNavigate,
  onAskAgent: _onAskAgent,
  onOpenSettings: _onOpenSettings,
  className,
}: BrowserStartPageProps) {
  const [query, setQuery] = useState("");
  const accentColor = useLiveAccentColor();
  const reduceMotion = useReducedMotion();
  const motionOff = reduceMotion ? { duration: 0 } : undefined;
  const [showAskHint] = useState(() => !hasUsedAskClyra());
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

  const shortcuts = useMemo(() => {
    if (bookmarks.length) {
      return bookmarks.slice(0, 6).map((bookmark) => ({
        id: bookmark.id,
        label: bookmark.title || siteLabel(bookmark.url),
        url: bookmark.url,
      }));
    }
    const hosts = new Map<string, { url: string; count: number }>();
    for (const entry of history) {
      const host = hostnameOf(entry.url);
      if (!host || isBrowserStartPageUrl(entry.url)) continue;
      const current = hosts.get(host);
      if (current) current.count += 1;
      else hosts.set(host, { url: entry.url, count: 1 });
    }
    const fromHistory = [...hosts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([, item]) => ({ id: hostnameOf(item.url), label: siteLabel(item.url), url: item.url }));
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
        "clyra-browser-start absolute inset-0 z-[15] flex flex-col overflow-auto bg-white text-[#1d1d1f]",
        className,
      )}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif' }}
    >
      <div className="relative mx-auto flex w-full max-w-[700px] flex-1 flex-col items-center px-6 pb-16 pt-[13vh]">
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={motionOff ?? { duration: 0.28, ease: EASE }}
        >
          <Bloub state="idle" size={50} color={accentColor} background="#ffffff" />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionOff ?? { duration: 0.26, ease: EASE, delay: 0.04 }}
          className="mt-4 text-[36px] font-semibold tracking-[-0.025em] text-[#1d1d1f]"
        >
          Clyra
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionOff ?? { duration: 0.26, ease: EASE, delay: 0.06 }}
          className="mt-2 text-[15px] text-[#6e6e73]"
        >
          Search the web or browse with Clyra
        </motion.p>

        <motion.form
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionOff ?? { duration: 0.26, ease: EASE, delay: 0.1 }}
          onSubmit={submitSearch}
          className="clyra-browser-search mt-8 flex h-[54px] w-full max-w-[660px] items-center gap-2.5 rounded-[17px] border border-black/[0.08] bg-white px-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow] duration-200"
        >
          <Search className="h-[17px] w-[17px] shrink-0 text-[#9a9a9f]" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or enter an address"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[#1d1d1f] outline-none placeholder:text-[#9a9a9f]"
            aria-label="Search or enter an address"
            autoFocus
          />
          {isMac ? (
            <span className="hidden shrink-0 items-center gap-0.5 rounded-[6px] border border-black/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-[#9a9a9f] sm:flex">
              ⌘L
            </span>
          ) : null}
        </motion.form>

        {showAskHint ? (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={motionOff ?? { duration: 0.24, ease: EASE, delay: 0.16 }}
            className="mt-3.5 flex items-center gap-1.5 text-[13.5px] text-[#9a9a9f]"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-[color:var(--clyra-accent)]" strokeWidth={1.75} />
            Want Clyra to browse with you? Press{" "}
            <span className="font-medium text-[#6e6e73]">Ask Clyra</span> in the top-right.
          </motion.p>
        ) : null}

        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionOff ?? { duration: 0.28, ease: EASE, delay: 0.22 }}
          className="mt-12 flex w-full max-w-[660px] flex-wrap justify-center gap-x-7 gap-y-4"
        >
          {shortcuts.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.url)}
              className="clyra-browser-favourite group flex w-[62px] flex-col items-center gap-2 text-center"
            >
              <span className="grid h-[46px] w-[46px] place-items-center overflow-hidden rounded-[13px] border border-black/[0.07] bg-[#f7f7f8] transition-[transform,box-shadow,background-color,border-color] duration-[180ms]">
                <img src={faviconFor(item.url)} alt="" className="h-[18px] w-[18px]" />
              </span>
              <span className="max-w-full truncate text-[11.5px] text-[#6e6e73] transition-colors duration-150 group-hover:text-[#1d1d1f]">
                {item.label}
              </span>
            </button>
          ))}
          <button
            type="button"
            aria-label="Add favourite"
            className="clyra-browser-favourite group flex w-[62px] flex-col items-center gap-2 text-center"
          >
            <span className="grid h-[46px] w-[46px] place-items-center rounded-[13px] border border-dashed border-black/[0.1] text-[#9a9a9f] transition-[transform,box-shadow,background-color,border-color] duration-[180ms] group-hover:border-black/[0.16] group-hover:text-[#6e6e73]">
              <Plus className="h-[15px] w-[15px]" strokeWidth={1.75} />
            </span>
            <span className="max-w-full truncate text-[11.5px] text-[#9a9a9f]">Add</span>
          </button>
        </motion.div>

        {recent.length ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={motionOff ?? { duration: 0.28, ease: EASE, delay: 0.28 }}
            className="mt-14 w-full max-w-[660px]"
          >
            <p className="mb-1.5 px-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[#9a9a9f]">
              Recent
            </p>
            <ul>
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(entry.url)}
                    className="clyra-browser-recent-row flex h-[44px] w-full items-center gap-3 rounded-[11px] px-2 text-left transition-colors duration-150"
                  >
                    <img src={faviconFor(entry.url)} alt="" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#1d1d1f]">
                      {entryTitle(entry)}
                    </span>
                    <span className="shrink-0 text-[12px] text-[#9a9a9f]">
                      {hostnameOf(entry.url)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </div>

      <style>{`
        .clyra-browser-search:hover { border-color: rgba(0,0,0,0.12); }
        .clyra-browser-search:focus-within {
          border-color: color-mix(in srgb, var(--clyra-accent) 55%, transparent);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--clyra-accent) 12%, transparent);
        }
        .clyra-browser-favourite:hover span:first-child {
          transform: translateY(-2px);
          background: #ffffff;
          border-color: rgba(0,0,0,0.1);
          box-shadow: 0 6px 14px rgba(0,0,0,0.06);
        }
        .clyra-browser-recent-row:hover { background: #f7f7f8; }
      `}</style>
    </div>
  );
}

export default BrowserStartPage;
