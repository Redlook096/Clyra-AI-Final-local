import { ArrowUp, Mic, Search } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { cn } from "../lib/utils";
import { AiOrb } from "./AiOrb";

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

function siteLabel(url: string) {
  const host = hostnameOf(url);
  const known: Record<string, string> = {
    "google.com": "Google",
    "youtube.com": "YouTube",
    "apple.com": "Apple",
    "github.com": "GitHub",
    "mail.google.com": "Gmail",
    "drive.google.com": "Drive",
    "bing.com": "Bing",
    "bestbuy.com": "Best Buy",
    "ebay.com": "eBay",
    "duckduckgo.com": "DuckDuckGo",
  };
  return known[host] || host.split(".")[0]?.replace(/^./, (value) => value.toUpperCase()) || "Site";
}

function entryTitle(entry: BrowserStartHistoryEntry) {
  const raw = entry.title.trim();
  try {
    const parsed = new URL(entry.url);
    if (hostnameOf(entry.url) === "google.com" && parsed.pathname === "/search") {
      const query = (parsed.searchParams.get("q") || "").trim();
      return query && !/^[:\d./]+$/.test(query) ? query : "Google search";
    }
  } catch {
    // Keep the provider label below when malformed history is encountered.
  }
  if (!raw || /^https?:\/\//i.test(raw)) return siteLabel(entry.url);
  return raw;
}

function relativeVisit(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "Recent";
  const elapsed = Math.max(0, Date.now() - time);
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 2) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days}d`;
}

function shouldAskClyra(value: string) {
  if (/^https?:\/\//i.test(value) || /^[\w-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) return false;
  return /\b(compare|summari[sz]e|research|organise|organize|my open tabs|this page|find (?:the|my)|fill (?:this|the)|take control|do it for me)\b/i.test(value);
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

export function BrowserStartPage({
  history = [],
  bookmarks = [],
  onNavigate,
  onAskAgent,
  className,
}: BrowserStartPageProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  const shortcuts = useMemo(() => {
    if (bookmarks.length) {
      return bookmarks.slice(0, 6).map((bookmark) => ({
        id: bookmark.id,
        label: bookmark.title || siteLabel(bookmark.url),
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
      .map(([host, item]) => ({ id: host, label: siteLabel(item.url), url: item.url }));
    return fromHistory.length >= 4 ? fromHistory : [...DEFAULT_SHORTCUTS];
  }, [bookmarks, history]);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    return history.filter((entry) => {
      const host = hostnameOf(entry.url);
      if (!host || isBrowserStartPageUrl(entry.url)) return false;
      const key = entry.url.split("#")[0] || entry.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
  }, [history]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const next = query.trim();
    if (!next) return;
    if (shouldAskClyra(next)) onAskAgent(next);
    else onNavigate(next);
    setQuery("");
  };

  const suggestions = useMemo(() => {
    const first = recent[0];
    return [
      first ? `Continue exploring ${hostnameOf(first.url)}` : "Research something for me",
      "Summarise my open tabs",
    ];
  }, [recent]);

  return (
    <div className={cn("clyra-browser-start absolute inset-0 z-[15] overflow-auto bg-[#fafafa] text-[color:var(--clyra-text)]", className)}>
      <div className="clyra-browser-start__light" aria-hidden />
      <main className="relative mx-auto flex min-h-full w-full max-w-[760px] flex-col items-center justify-center px-7 py-16">
        <AiOrb className="h-8 w-8" state={focused ? "thinking" : "idle"} />
        <h1 className="mt-5 text-center text-[clamp(34px,4vw,42px)] font-semibold tracking-[-0.045em] text-[#202124]">
          Where do you want to go?
        </h1>
        <p className="mt-2 text-center text-[15px] text-[#74777d]">Search, browse, or ask Clyra.</p>

        <form onSubmit={submit} className={cn("clyra-browser-start__composer mt-8 flex h-[56px] w-full items-center gap-3 px-4", focused && "is-focused")}>
          <AiOrb className="h-[22px] w-[22px] shrink-0" state={focused ? "thinking" : "idle"} />
          <Search className="h-4 w-4 shrink-0 text-[#9a9ca2]" strokeWidth={1.65} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search the web or ask Clyra…"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[#24262a] outline-none placeholder:text-[#999ca2]"
            aria-label="Search the web or ask Clyra"
            autoFocus
          />
          {query.trim() ? (
            <button type="submit" className="grid h-7 w-7 place-items-center rounded-full bg-[#1f2022] text-white transition-transform duration-100 active:scale-[0.94]" aria-label="Go">
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          ) : (
            <button type="button" className="grid h-7 w-7 place-items-center rounded-[9px] text-[#8b8e94] transition-colors duration-150 hover:bg-black/[0.04] hover:text-[#33363a]" aria-label="Voice search">
              <Mic className="h-4 w-4" strokeWidth={1.65} />
            </button>
          )}
        </form>

        <div className="mt-7 flex flex-wrap justify-center gap-3">
          {shortcuts.map((item) => (
            <button key={item.id} type="button" onClick={() => onNavigate(item.url)} className="group flex w-[64px] flex-col items-center gap-2 text-center">
              <span className="grid h-[52px] w-[52px] place-items-center overflow-hidden rounded-[15px] border border-black/[0.055] bg-white shadow-[0_1px_2px_rgba(0,0,0,.035)] transition-[transform,box-shadow,background-color] duration-150 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-y-px group-hover:bg-[#fefefe] group-hover:shadow-[0_5px_16px_rgba(0,0,0,.07)] group-active:translate-y-0">
                <img src={faviconFor(item.url)} alt="" className="h-5 w-5" />
              </span>
              <span className="max-w-full truncate text-[11.5px] text-[#686b70] group-hover:text-[#27292d]">{item.label}</span>
            </button>
          ))}
        </div>

        <section className="mt-11 w-full max-w-[640px]">
          <p className="mb-2.5 text-[11px] font-medium text-[#8c8f95]">For you</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {suggestions.map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => onAskAgent(suggestion)} className="flex h-10 items-center gap-2 rounded-[11px] px-2.5 text-left text-[12.5px] text-[#56595f] transition-colors duration-150 hover:bg-black/[0.032] hover:text-[#222428]">
                <AiOrb className="h-[18px] w-[18px] shrink-0" />
                <span className="truncate">{suggestion}</span>
              </button>
            ))}
          </div>
        </section>

        {recent.length ? (
          <section className="mt-7 w-full max-w-[640px]">
            <p className="mb-1.5 text-[11px] font-medium text-[#8c8f95]">Recent</p>
            <ul>
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button type="button" onClick={() => onNavigate(entry.url)} className="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors duration-150 hover:bg-black/[0.032]">
                    <img src={faviconFor(entry.url)} alt="" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#303237]">{entryTitle(entry)}</span>
                    <span className="shrink-0 text-[11px] text-[#989ba0]">{hostnameOf(entry.url)} · {relativeVisit(entry.visitedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}

export default BrowserStartPage;
