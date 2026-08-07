import {
  Briefcase,
  CalendarDays,
  Check,
  CirclePlus,
  FileText,
  Home,
  Mic,
  Plane,
  Plus,
  Search,
  Settings2,
  Sparkles,
  SquareStack,
} from "lucide-react";
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

function formatRelative(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function faviconFor(url: string) {
  const host = hostnameOf(url);
  if (!host) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
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

const SPACE_PRESETS = [
  { id: "personal", label: "Personal", icon: Home, query: "https://mail.google.com/" },
  { id: "work", label: "Work", icon: Briefcase, query: "https://docs.google.com/" },
  { id: "travel", label: "Travel Planning", icon: Plane, query: "travel itinerary ideas" },
  { id: "research", label: "Research", icon: SquareStack, query: "research latest developments" },
] as const;

export function BrowserStartPage({
  history = [],
  bookmarks = [],
  onNavigate,
  onAskAgent,
  onOpenSettings,
  className,
}: BrowserStartPageProps) {
  const [query, setQuery] = useState("");

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
      .slice(0, 6);
  }, [history]);

  const shortcuts = useMemo(() => {
    if (bookmarks.length) {
      return bookmarks.slice(0, 5).map((bookmark) => ({
        id: bookmark.id,
        label: bookmark.title || hostnameOf(bookmark.url) || "Bookmark",
        url: bookmark.url,
        icon: null as null | typeof Home,
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
    return [...hosts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 4)
      .map(([host, item]) => ({
        id: host,
        label: item.title.length > 28 ? host : item.title,
        url: item.url,
        icon: null as null | typeof Home,
      }));
  }, [bookmarks, history]);

  const suggestions = useMemo(() => {
    const hosts = [...new Set(recent.map((entry) => hostnameOf(entry.url)).filter(Boolean))].slice(0, 3);
    const built = [
      hosts[0] ? `Continue reading on ${hosts[0]}` : "Summarise my recent browsing",
      hosts[1] ? `Find related pages to ${hosts[1]}` : "Research a topic from my recent tabs",
      "Plan my day around open work",
      "Compare the last few sites I visited",
    ];
    return built.slice(0, 4);
  }, [recent]);

  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault();
    const next = query.trim();
    if (!next) return;
    onNavigate(next);
    setQuery("");
  };

  const quickActions = [
    {
      id: "agent",
      label: "Agent mode",
      icon: Sparkles,
      run: () => onAskAgent("Help me browse and complete my next task step by step."),
    },
    {
      id: "plan",
      label: "Plan my day",
      icon: CalendarDays,
      run: () => onAskAgent("Plan my day using my recent browsing context and suggest a focused schedule."),
    },
    {
      id: "summarise",
      label: "Summarise recent tabs",
      icon: FileText,
      run: () => onAskAgent("Summarise my recent tabs and highlight anything that needs follow-up."),
    },
    {
      id: "research",
      label: "Research a topic",
      icon: Search,
      run: () => onAskAgent("Research a topic for me. Ask one clarifying question if the subject is unclear, then browse and report findings."),
    },
  ] as const;

  return (
    <div
      className={cn(
        "clyra-browser-start absolute inset-0 z-[15] flex flex-col overflow-auto bg-[var(--atlas-window-bg)] text-[var(--atlas-text-primary)]",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -left-24 top-10 h-64 w-64 rounded-full bg-[var(--atlas-clyra-blue)]/[0.07] blur-3xl" />
        <div className="absolute -right-16 bottom-24 h-72 w-72 rounded-full bg-[var(--atlas-clyra-blue)]/[0.05] blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-[1180px] flex-1 flex-col px-6 pb-6 pt-12 sm:px-10 sm:pt-16">
        <div className="mx-auto flex w-full max-w-[720px] flex-col items-center text-center">
          <div className="mb-5 grid h-14 w-14 place-items-center rounded-full border border-[var(--atlas-divider)] bg-white shadow-[0_12px_32px_rgba(32,33,36,0.08)]">
            <Sparkles className="h-6 w-6 text-[var(--atlas-clyra-blue)]" strokeWidth={1.6} />
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.035em] text-[var(--atlas-text-primary)] sm:text-[34px]">
            AI Browser
          </h1>
          <p className="mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-[var(--atlas-text-secondary)] sm:text-[14.5px]">
            Search, navigate, and let Clyra work the web for you — one intelligent workspace.
          </p>

          <form
            onSubmit={submitSearch}
            className="mt-8 flex h-[52px] w-full items-center gap-2.5 rounded-full border border-[var(--atlas-divider)] bg-white px-3.5 shadow-[0_14px_40px_rgba(32,33,36,0.08)] sm:h-14"
          >
            <button
              type="button"
              aria-label="New search"
              onClick={() => setQuery("")}
              className="grid h-8 w-8 place-items-center rounded-full text-[var(--atlas-text-tertiary)] transition-colors hover:bg-black/[0.04] hover:text-[var(--atlas-text-primary)]"
            >
              <Plus className="h-4 w-4" />
            </button>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ask anything or enter a URL"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--atlas-text-primary)] outline-none placeholder:text-[var(--atlas-text-tertiary)] sm:text-[16px]"
              aria-label="Ask anything or enter a URL"
            />
            <button
              type="button"
              aria-label="Voice input coming soon"
              className="grid h-8 w-8 place-items-center rounded-full text-[var(--atlas-text-tertiary)] transition-colors hover:bg-black/[0.04] hover:text-[var(--atlas-text-primary)]"
            >
              <Mic className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={action.run}
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--atlas-divider)] bg-white px-3.5 text-[12.5px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:border-black/10 hover:bg-[#f3f4f4] hover:text-[var(--atlas-text-primary)]"
                >
                  <Icon className="h-3.5 w-3.5 text-[var(--atlas-clyra-blue)]" strokeWidth={1.75} />
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-14 grid flex-1 gap-8 md:grid-cols-3 md:gap-7">
          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-tertiary)]">
                Spaces
              </h2>
            </div>
            <ul className="space-y-1">
              {(shortcuts.length ? shortcuts : SPACE_PRESETS.map((space) => ({
                id: space.id,
                label: space.label,
                url: space.query,
                icon: space.icon,
              }))).map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onNavigate(item.url)}
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-black/[0.035]"
                    >
                      <span className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--atlas-divider)] bg-white text-[var(--atlas-text-secondary)]">
                        {Icon ? <Icon className="h-4 w-4" strokeWidth={1.75} /> : (
                          <img src={faviconFor(item.url)} alt="" className="h-4 w-4" />
                        )}
                      </span>
                      <span className="min-w-0 truncate text-[13.5px] font-medium text-[var(--atlas-text-primary)]">
                        {item.label}
                      </span>
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  onClick={() => onAskAgent("Help me create a new browsing space for an upcoming project.")}
                  className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-[13.5px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.035] hover:text-[var(--atlas-text-primary)]"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-lg border border-dashed border-[var(--atlas-divider)] bg-transparent">
                    <CirclePlus className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  New Space
                </button>
              </li>
            </ul>
          </section>

          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-tertiary)]">
                Recent
              </h2>
            </div>
            {recent.length ? (
              <ul className="space-y-1">
                {recent.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onNavigate(entry.url)}
                      className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-black/[0.035]"
                    >
                      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-[var(--atlas-divider)] bg-white">
                        <img src={faviconFor(entry.url)} alt="" className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium text-[var(--atlas-text-primary)]">
                          {entry.title || hostnameOf(entry.url) || "Untitled"}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--atlas-text-tertiary)]">
                          <span className="truncate">{hostnameOf(entry.url)}</span>
                          <span aria-hidden>·</span>
                          <span className="shrink-0">{formatRelative(entry.visitedAt)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-[var(--atlas-divider)] px-4 py-5 text-[13px] leading-relaxed text-[var(--atlas-text-tertiary)]">
                Pages you visit will appear here for quick return.
              </p>
            )}
          </section>

          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[var(--atlas-text-tertiary)]">
                Suggested
              </h2>
            </div>
            <div className="rounded-2xl border border-[var(--atlas-divider)] bg-white/85 p-2.5 shadow-[0_8px_24px_rgba(32,33,36,0.04)]">
              <ul className="space-y-0.5">
                {suggestions.map((item, index) => (
                  <li key={item}>
                    <button
                      type="button"
                      onClick={() => onAskAgent(item)}
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-black/[0.035]"
                    >
                      <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--atlas-divider)] text-[var(--atlas-text-tertiary)]">
                        {index === 0 ? <Check className="h-3.5 w-3.5 text-[var(--atlas-clyra-blue)]" strokeWidth={2} /> : (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--atlas-text-tertiary)]/50" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--atlas-text-primary)]">
                        {item}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => onAskAgent("Suggest three useful next browsing tasks based on my recent history.")}
                className="mt-1.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 text-[13px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.035] hover:text-[var(--atlas-text-primary)]"
              >
                <Plus className="h-4 w-4" />
                Add suggestion
              </button>
            </div>
          </section>
        </div>

        <div className="mt-8 flex items-center justify-end pt-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--atlas-divider)] bg-white px-3.5 text-[12px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-[#f3f4f4] hover:text-[var(--atlas-text-primary)]"
          >
            <Settings2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Customise
          </button>
        </div>
      </div>
    </div>
  );
}

export default BrowserStartPage;
