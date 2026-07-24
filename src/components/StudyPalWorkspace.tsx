import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  FilePlus2,
  History,
  Layers,
  Lightbulb,
  Link2,
  ListChecks,
  MessageSquare,
  NotebookPen,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { MarkdownMessageContent } from "./MarkdownMessageContent";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "./ShiningText";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type StudySource = {
  id: string;
  title: string;
  source: string;
  body: string;
  selected: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: string[];
};

type QuizQuestion = {
  id: string;
  question: string;
  options: string[];
  correct: number; // 1-based
  hint: string;
  explanation: string;
};

type QuizState = {
  topic: string;
  questions: QuizQuestion[];
  answers: Record<string, number>; // questionId -> chosen 1-based option
  current: number;
  finished: boolean;
};

type Flashcard = { front: string; back: string; tag: string };

type FlashDeck = {
  id: string;
  topic: string;
  cards: Flashcard[];
  createdAt: number;
};

type NotesDoc = {
  title: string;
  sections: { heading: string; cue: string; points: string[] }[];
  summary: string;
  questions: { q: string; a: string }[];
};

type TabId = "chat" | "quiz" | "flashcards" | "notes" | "sources";

type StudySession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sources: StudySource[];
  messages: ChatMessage[];
  decks: FlashDeck[];
  notes: NotesDoc | null;
};

type WorkspaceStore = {
  sessions: StudySession[];
  activeSessionId: string | null;
};

const STORAGE_KEY_V2 = "clyra.study-pal.v2";
const STORAGE_KEY = "clyra.study-pal.v3";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function emptySession(partial?: Partial<StudySession>): StudySession {
  const now = Date.now();
  return {
    id: partial?.id || uid(),
    title: partial?.title || "New study",
    createdAt: partial?.createdAt || now,
    updatedAt: partial?.updatedAt || now,
    sources: partial?.sources || [],
    messages: partial?.messages || [],
    decks: partial?.decks || [],
    notes: partial?.notes ?? null,
  };
}

function titleFromSession(session: StudySession) {
  const fromMessage = session.messages.find((message) => message.role === "user")?.content?.trim();
  if (fromMessage) return fromMessage.length > 42 ? `${fromMessage.slice(0, 39).trim()}…` : fromMessage;
  const fromSource = session.sources[0]?.title?.trim();
  if (fromSource) return fromSource.length > 42 ? `${fromSource.slice(0, 39).trim()}…` : fromSource;
  return session.title || "New study";
}

function loadWorkspace(): WorkspaceStore {
  const empty: WorkspaceStore = { sessions: [], activeSessionId: null };
  try {
    const rawV3 = localStorage.getItem(STORAGE_KEY);
    if (rawV3) {
      const parsed = JSON.parse(rawV3) as Partial<WorkspaceStore>;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((session) => ({
            ...emptySession(),
            ...session,
            sources: Array.isArray(session.sources) ? session.sources : [],
            messages: Array.isArray(session.messages) ? session.messages : [],
            decks: Array.isArray(session.decks) ? session.decks : [],
            notes: session.notes && typeof session.notes === "object" ? session.notes : null,
          }))
        : [];
      const activeSessionId =
        typeof parsed.activeSessionId === "string" && sessions.some((session) => session.id === parsed.activeSessionId)
          ? parsed.activeSessionId
          : sessions[0]?.id || null;
      return { sessions, activeSessionId };
    }

    // Migrate single-workspace v2 blob into one session.
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
    if (!rawV2) return empty;
    const legacy = JSON.parse(rawV2) as {
      sources?: StudySource[];
      messages?: ChatMessage[];
      decks?: FlashDeck[];
      notes?: NotesDoc | null;
    };
    const hasWork =
      (legacy.sources?.length || 0) > 0 ||
      (legacy.messages?.length || 0) > 0 ||
      (legacy.decks?.length || 0) > 0 ||
      Boolean(legacy.notes);
    if (!hasWork) return empty;
    const session = emptySession({
      title: legacy.sources?.[0]?.title || legacy.messages?.[0]?.content?.slice(0, 42) || "Previous study",
      sources: Array.isArray(legacy.sources) ? legacy.sources : [],
      messages: Array.isArray(legacy.messages) ? legacy.messages : [],
      decks: Array.isArray(legacy.decks) ? legacy.decks : [],
      notes: legacy.notes && typeof legacy.notes === "object" ? legacy.notes : null,
    });
    return { sessions: [session], activeSessionId: session.id };
  } catch {
    return empty;
  }
}

function saveWorkspace(store: WorkspaceStore) {
  try {
    const payload: WorkspaceStore = {
      activeSessionId: store.activeSessionId,
      sessions: store.sessions.slice(0, 40).map((session) => ({
        ...session,
        title: titleFromSession(session),
        sources: session.sources.map((source) => ({ ...source, body: source.body.slice(0, 120_000) })).slice(0, 32),
        messages: session.messages.slice(-80),
        decks: session.decks.slice(0, 20),
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage may be full or unavailable; the UI keeps working in-memory.
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!response.ok || !payload || payload.ok === false) {
    throw new Error(payload?.error || `The request failed (${response.status})`);
  }
  return payload;
}

const toContext = (sources: StudySource[]) =>
  sources.map(({ id, title, source, body }) => ({ id, title, source, body }));

function formatChars(count: number) {
  if (count >= 10_000) return `${Math.round(count / 1_000)}k chars`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k chars`;
  return `${count} chars`;
}

function formatSessionTime(value: number) {
  const delta = Date.now() - value;
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ */
/* Small shared UI pieces                                              */
/* ------------------------------------------------------------------ */

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700"
      role="alert"
    >
      <span className="leading-snug">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-0.5 shrink-0 rounded-md p-0.5 text-red-400 transition-colors hover:bg-red-100 hover:text-red-600"
        aria-label="Dismiss error"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

function StudyThinkingStatus({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="inline-flex flex-wrap items-center gap-2 text-[13px] font-medium text-slate-500" aria-live="polite">
      <ShiningBrainIcon />
      <ShiningText text={label} preset="thinkingChat" className="!text-[13px]" />
      <ThinkingDots />
    </div>
  );
}

function GeneratingCard({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-6">
      <StudyThinkingStatus label={label} />
      <div className="mt-5 space-y-2.5" aria-hidden>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-3 animate-pulse rounded-full bg-slate-100"
            style={{ width: `${86 - index * 16}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof BookOpen;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-md border border-slate-200 bg-white text-slate-500">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <p className="text-[14px] font-semibold text-slate-900">{title}</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-slate-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-[12px] font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-slate-800 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

function CitationChips({ citations }: { citations: string[] }) {
  if (!citations.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {citations.map((citation, index) => (
        <span
          key={`${citation}-${index}`}
          className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600"
          title={citation}
        >
          <Link2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{citation.replace(/^https?:\/\//, "")}</span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sources panel                                                       */
/* ------------------------------------------------------------------ */

function SourcesPanel({
  sources,
  onAdd,
  onRemove,
  onToggle,
}: {
  sources: StudySource[];
  onAdd: (source: Omit<StudySource, "id" | "selected">) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importUrl = useCallback(async () => {
    const value = url.trim();
    if (!value || fetching) return;
    setFetching(true);
    setError("");
    try {
      const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      const data = await postJson<{ title: string; text: string; url: string }>("/api/study/fetch", { url: normalized });
      onAdd({ title: data.title, source: data.url, body: data.text });
      setUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The source could not be imported");
    } finally {
      setFetching(false);
    }
  }, [url, fetching, onAdd]);

  const importFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        if (!/\.(txt|md|markdown)$/i.test(file.name)) {
          setError(`"${file.name}" is not a supported file — upload .txt or .md files.`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || "").trim();
          if (text) onAdd({ title: file.name.replace(/\.(txt|md|markdown)$/i, ""), source: file.name, body: text.slice(0, 120_000) });
        };
        reader.readAsText(file);
      }
    },
    [onAdd],
  );

  const addPasted = useCallback(() => {
    const body = pasteBody.trim();
    if (!body) return;
    onAdd({
      title: pasteTitle.trim() || `Pasted text ${new Date().toLocaleDateString()}`,
      source: "Pasted text",
      body: body.slice(0, 120_000),
    });
    setPasteTitle("");
    setPasteBody("");
    setPasteOpen(false);
  }, [pasteTitle, pasteBody, onAdd]);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Nodes</p>
        <h2 className="mt-1.5 text-[22px] font-semibold tracking-[-0.03em] text-slate-950">Resource graph</h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Every source is a node you can add, pin into grounding, or remove. Chat, quizzes, cards, and notes only use selected nodes.
        </p>
      </div>

      <AnimatePresence>{error && <ErrorBanner message={error} onDismiss={() => setError("")} />}</AnimatePresence>

      <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-[0_10px_28px_rgba(15,23,42,.04)]">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-slate-400 focus-within:bg-white">
            <Link2 className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importUrl();
              }}
              placeholder="Paste an article, docs, or lecture URL…"
              className="w-full bg-transparent text-[13px] text-slate-800 outline-none placeholder:text-slate-400"
              disabled={fetching}
            />
          </div>
          <PrimaryButton onClick={() => void importUrl()} disabled={!url.trim() || fetching}>
            {fetching ? "Importing…" : "Add"}
          </PrimaryButton>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            <Upload className="h-3.5 w-3.5" /> Upload file
          </button>
          <button
            type="button"
            onClick={() => setPasteOpen((open) => !open)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12px] font-medium transition-colors",
              pasteOpen
                ? "border-slate-900 bg-slate-950 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900",
            )}
          >
            <FilePlus2 className="h-3.5 w-3.5" /> Paste text
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            multiple
            className="hidden"
            onChange={(event) => {
              importFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        <AnimatePresence initial={false}>
          {pasteOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                <input
                  value={pasteTitle}
                  onChange={(event) => setPasteTitle(event.target.value)}
                  placeholder="Title (optional)"
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-400 focus:bg-white"
                />
                <textarea
                  value={pasteBody}
                  onChange={(event) => setPasteBody(event.target.value)}
                  placeholder="Paste study material here…"
                  rows={5}
                  className="w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-400 focus:bg-white"
                />
                <div className="flex justify-end">
                  <PrimaryButton onClick={addPasted} disabled={!pasteBody.trim()}>
                    <Plus className="h-3.5 w-3.5" /> Add source
                  </PrimaryButton>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {sources.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No nodes yet"
          description="Add a URL, upload notes, or paste text. Each item becomes a node in this study graph."
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {sources.map((source, index) => (
            <motion.div
              key={source.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "flex items-start gap-3 rounded-2xl border bg-white px-3.5 py-3.5 shadow-[0_6px_18px_rgba(15,23,42,.03)] transition-[border-color,box-shadow,opacity]",
                source.selected ? "border-slate-300 shadow-[0_10px_24px_rgba(15,23,42,.06)]" : "border-slate-200/90 opacity-75",
              )}
            >
              <button
                type="button"
                onClick={() => onToggle(source.id)}
                className={cn(
                  "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[10px] font-bold transition-colors",
                  source.selected
                    ? "border-slate-900 bg-slate-950 text-white"
                    : "border-slate-300 bg-white text-transparent",
                )}
                aria-label={source.selected ? "Deselect node" : "Select node"}
              >
                <Check className="h-3 w-3" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                    N{index + 1}
                  </span>
                  <p className="truncate text-[13px] font-semibold text-slate-900">{source.title}</p>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-slate-400">
                  {source.source} · {formatChars(source.body.length)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onRemove(source.id)}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                aria-label="Remove node"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chat panel                                                          */
/* ------------------------------------------------------------------ */

function ChatPanel({
  sources,
  messages,
  setMessages,
  initialPrompt,
  goToSources,
}: {
  sources: StudySource[];
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  initialPrompt?: string;
  goToSources: () => void;
}) {
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoSubmittedRef = useRef(false);

  const selectedSources = useMemo(() => sources.filter((source) => source.selected), [sources]);

  const send = useCallback(
    async (raw?: string) => {
      const question = (raw ?? input).trim();
      if (!question || thinking) return;
      if (!selectedSources.length) {
        setError("Add and select at least one source before asking Study Pal.");
        return;
      }
      setError("");
      setInput("");
      setThinking(true);
      setMessages((prev) => [...prev, { id: uid(), role: "user", content: question }]);
      try {
        const data = await postJson<{ answer: string; citations: string[] }>("/api/study/ask", {
          question,
          mode: "answer",
          context: toContext(selectedSources),
        });
        setMessages((prev) => [
          ...prev,
          { id: uid(), role: "assistant", content: data.answer, citations: Array.isArray(data.citations) ? data.citations : [] },
        ]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Study Pal could not answer right now.");
      } finally {
        setThinking(false);
      }
    },
    [input, thinking, selectedSources, setMessages],
  );

  useEffect(() => {
    const prompt = (initialPrompt || "").trim();
    if (!prompt || autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    setInput(prompt);
    if (selectedSources.length) void send(prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, thinking]);

  return (
    <div className="mx-auto flex h-full w-full max-w-[720px] flex-col">
      <div ref={scrollRef} className="clyra-visible-scrollbar flex-1 space-y-5 overflow-y-auto pb-4 pr-1">
        {messages.length === 0 && !thinking ? (
          <EmptyState
            icon={MessageSquare}
            title="Ask about your material"
            description={
              selectedSources.length
                ? "Questions stay grounded in the sources you selected."
                : "Add a resource first, then ask anything about it."
            }
            action={
              selectedSources.length ? undefined : (
                <PrimaryButton onClick={goToSources}>
                  <Plus className="h-3.5 w-3.5" /> Add resources
                </PrimaryButton>
              )
            }
          />
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((message, index) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
              >
                {message.role === "user" ? (
                  <div
                    className={cn(
                      "clyra-chat-user-bubble max-w-[85%] rounded-[24px] border border-slate-200/70 bg-[#f4f4f4] px-5 py-3.5 sm:max-w-[75%]",
                      index === 0 && "clyra-chat-user-bubble--first",
                    )}
                    style={{ ["--delay" as string]: "0.02" }}
                  >
                    <div className="clyra-chat-user-text text-[14px] font-medium leading-relaxed">{message.content}</div>
                  </div>
                ) : (
                  <div className="max-w-[92%] text-[14px] leading-relaxed text-slate-800">
                    <div className="prose prose-sm prose-slate max-w-none [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5">
                      <MarkdownMessageContent content={message.content} codePresentation="soft" />
                    </div>
                    <CitationChips citations={message.citations || []} />
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
        {thinking ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="flex justify-start"
          >
            <StudyThinkingStatus label="Reading your sources" />
          </motion.div>
        ) : null}
      </div>

      <div className="shrink-0 pt-2">
        <AnimatePresence>{error && <ErrorBanner message={error} onDismiss={() => setError("")} />}</AnimatePresence>
        <div className="mt-2 flex items-end gap-2 rounded-[22px] border border-slate-200 bg-white py-2 pl-4 pr-2 shadow-[0_8px_28px_rgba(15,23,42,0.05)] focus-within:border-slate-300">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={selectedSources.length ? "Ask about your sources…" : "Add a resource first…"}
            className="max-h-28 min-h-[24px] w-full resize-none bg-transparent py-1.5 text-[14px] text-slate-800 outline-none placeholder:text-slate-400"
            disabled={thinking}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || thinking || !selectedSources.length}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white transition-all hover:bg-slate-800 disabled:opacity-30"
            aria-label="Send"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-slate-400">
          {selectedSources.length
            ? `Grounded in ${selectedSources.length} selected source${selectedSources.length === 1 ? "" : "s"}`
            : "No sources selected"}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quiz panel                                                          */
/* ------------------------------------------------------------------ */

function QuizPanel({ sources }: { sources: StudySource[] }) {
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(6);
  const [useSources, setUseSources] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [hintShown, setHintShown] = useState(false);

  const selectedSources = useMemo(() => sources.filter((source) => source.selected), [sources]);
  const canGenerate = topic.trim().length > 0 || (useSources && selectedSources.length > 0);

  const generate = useCallback(async () => {
    if (!canGenerate || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await postJson<{ topic: string; questions: QuizQuestion[] }>("/api/study/quiz", {
        topic: topic.trim() || undefined,
        count,
        context: useSources && selectedSources.length ? toContext(selectedSources) : undefined,
      });
      setQuiz({ topic: data.topic, questions: data.questions, answers: {}, current: 0, finished: false });
      setHintShown(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Quiz generation failed.");
    } finally {
      setLoading(false);
    }
  }, [canGenerate, loading, topic, count, useSources, selectedSources]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl pt-4">
        <GeneratingCard label="Writing your quiz…" />
      </div>
    );
  }

  if (!quiz) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <div>
          <h2 className="text-[17px] font-semibold text-slate-900">Practice quiz</h2>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Generate a multiple-choice quiz from a topic, your selected sources, or both.
          </p>
        </div>
        <AnimatePresence>{error && <ErrorBanner message={error} onDismiss={() => setError("")} />}</AnimatePresence>
        <div className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
          <input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void generate();
            }}
            placeholder="Topic — e.g. Photosynthesis, The French Revolution…"
            className="w-full rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-[13.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[13px] text-slate-600">
              Questions
              <select
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 outline-none focus:border-slate-300"
              >
                {[4, 6, 8, 10, 12].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-600">
              <button
                type="button"
                role="switch"
                aria-checked={useSources}
                onClick={() => setUseSources((value) => !value)}
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors",
                  useSources && selectedSources.length ? "bg-slate-500" : "bg-slate-200",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                    useSources && selectedSources.length ? "left-[18px]" : "left-0.5",
                  )}
                />
              </button>
              Use my sources
              <span className="text-slate-400">({selectedSources.length} selected)</span>
            </label>
          </div>
          <PrimaryButton onClick={() => void generate()} disabled={!canGenerate} className="w-full py-2.5">
            <Sparkles className="h-4 w-4" /> Generate quiz
          </PrimaryButton>
          {!canGenerate && (
            <p className="text-center text-[12px] text-slate-400">Enter a topic or select sources in the Sources tab.</p>
          )}
        </div>
      </div>
    );
  }

  /* Results screen */
  if (quiz.finished) {
    const total = quiz.questions.length;
    const correctCount = quiz.questions.filter((question) => quiz.answers[question.id] === question.correct).length;
    const pct = Math.round((correctCount / total) * 100);
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-md border border-slate-200 bg-white p-6 text-center"
        >
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-600">{quiz.topic}</p>
          <p className="mt-2 text-4xl font-bold text-slate-900">
            {correctCount}
            <span className="text-xl font-semibold text-slate-400"> / {total}</span>
          </p>
          <p className="mt-1 text-[13px] text-slate-500">
            {pct >= 80 ? "Excellent work — you know this material." : pct >= 50 ? "Solid effort — review the misses below." : "Keep going — the review below will help."}
          </p>
          <div className="mx-auto mt-4 h-2 w-full max-w-xs overflow-hidden rounded-full bg-slate-100">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className={cn("h-full rounded-full", pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-slate-500" : "bg-amber-500")}
            />
          </div>
          <div className="mt-5 flex justify-center gap-2">
            <PrimaryButton onClick={() => setQuiz({ ...quiz, answers: {}, current: 0, finished: false })}>
              <RotateCcw className="h-3.5 w-3.5" /> Retake
            </PrimaryButton>
            <button
              type="button"
              onClick={() => setQuiz(null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> New quiz
            </button>
          </div>
        </motion.div>

        <div className="space-y-2.5">
          {quiz.questions.map((question, index) => {
            const chosen = quiz.answers[question.id];
            const right = chosen === question.correct;
            return (
              <div key={question.id} className="rounded-md border border-slate-200 bg-white p-4">
                <div className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white",
                      right ? "bg-emerald-500" : "bg-red-400",
                    )}
                  >
                    {right ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-slate-800">
                      {index + 1}. {question.question}
                    </p>
                    {!right && chosen ? (
                      <p className="mt-1 text-[12.5px] text-red-500">Your answer: {question.options[chosen - 1]}</p>
                    ) : null}
                    <p className="mt-1 text-[12.5px] text-emerald-600">Correct: {question.options[question.correct - 1]}</p>
                    {question.explanation && <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-500">{question.explanation}</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* Question flow */
  const question = quiz.questions[quiz.current];
  const chosen = quiz.answers[question.id];
  const answered = typeof chosen === "number";
  const isLast = quiz.current === quiz.questions.length - 1;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-600">{quiz.topic}</p>
          <p className="text-[13px] text-slate-500">
            Question {quiz.current + 1} of {quiz.questions.length}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setQuiz(null)}
          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-50"
        >
          Exit quiz
        </button>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <motion.div
          animate={{ width: `${((quiz.current + (answered ? 1 : 0)) / quiz.questions.length) * 100}%` }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="h-full rounded-full bg-slate-800"
        />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={question.id}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.22 }}
          className="rounded-md border border-slate-200 bg-white p-6"
        >
          <p className="text-[15px] font-semibold leading-relaxed text-slate-900">{question.question}</p>

          <div className="mt-4 space-y-2">
            {question.options.map((option, index) => {
              const optionNumber = index + 1;
              const isChosen = chosen === optionNumber;
              const isCorrect = question.correct === optionNumber;
              return (
                <button
                  key={index}
                  type="button"
                  disabled={answered}
                  onClick={() => {
                    setQuiz((prev) => (prev ? { ...prev, answers: { ...prev.answers, [question.id]: optionNumber } } : prev));
                    setHintShown(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-[13.5px] transition-all",
                    answered && isCorrect
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : answered && isChosen
                        ? "border-red-300 bg-red-50 text-red-700"
                        : answered
                          ? "border-slate-100 bg-slate-50/50 text-slate-400"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold",
                      answered && isCorrect
                        ? "border-emerald-400 bg-emerald-500 text-white"
                        : answered && isChosen
                          ? "border-red-400 bg-red-400 text-white"
                          : "border-slate-300 text-slate-500",
                    )}
                  >
                    {String.fromCharCode(65 + index)}
                  </span>
                  {option}
                </button>
              );
            })}
          </div>

          <AnimatePresence initial={false}>
            {hintShown && !answered && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800">
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {question.hint || "No hint available for this one — trust your gut."}
                </div>
              </motion.div>
            )}
            {answered && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div
                  className={cn(
                    "mt-3 rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-relaxed",
                    chosen === question.correct
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-red-200 bg-red-50 text-red-700",
                  )}
                >
                  <p className="font-semibold">{chosen === question.correct ? "Correct!" : "Not quite."}</p>
                  {question.explanation && <p className="mt-0.5">{question.explanation}</p>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setHintShown(true)}
              disabled={answered || hintShown}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-slate-600 transition-colors hover:bg-amber-50 hover:text-amber-700 disabled:opacity-30"
            >
              <Lightbulb className="h-3.5 w-3.5" /> Hint
            </button>
            <PrimaryButton
              onClick={() =>
                setQuiz((prev) =>
                  prev ? (isLast ? { ...prev, finished: true } : { ...prev, current: prev.current + 1 }) : prev,
                )
              }
              disabled={!answered}
            >
              {isLast ? "See results" : "Next question"} <ChevronRight className="h-3.5 w-3.5" />
            </PrimaryButton>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Flashcards panel                                                    */
/* ------------------------------------------------------------------ */

function FlashcardsPanel({
  sources,
  decks,
  setDecks,
}: {
  sources: StudySource[];
  decks: FlashDeck[];
  setDecks: React.Dispatch<React.SetStateAction<FlashDeck[]>>;
}) {
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(10);
  const [useSources, setUseSources] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [reviewQueue, setReviewQueue] = useState<Set<number>>(new Set());

  const selectedSources = useMemo(() => sources.filter((source) => source.selected), [sources]);
  const canGenerate = topic.trim().length > 0 || (useSources && selectedSources.length > 0);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId) || null;

  const openDeck = useCallback((id: string) => {
    setActiveDeckId(id);
    setIndex(0);
    setFlipped(false);
    setKnown(new Set());
    setReviewQueue(new Set());
  }, []);

  const generate = useCallback(async () => {
    if (!canGenerate || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await postJson<{ topic: string; cards: Flashcard[] }>("/api/study/flashcards", {
        topic: topic.trim() || undefined,
        count,
        context: useSources && selectedSources.length ? toContext(selectedSources) : undefined,
      });
      const deck: FlashDeck = { id: uid(), topic: data.topic, cards: data.cards, createdAt: Date.now() };
      setDecks((prev) => [deck, ...prev].slice(0, 20));
      openDeck(deck.id);
      setTopic("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Flashcard generation failed.");
    } finally {
      setLoading(false);
    }
  }, [canGenerate, loading, topic, count, useSources, selectedSources, setDecks, openDeck]);

  const mark = useCallback(
    (kind: "known" | "review") => {
      if (!activeDeck) return;
      if (kind === "known") {
        setKnown((prev) => new Set(prev).add(index));
        setReviewQueue((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      } else {
        setReviewQueue((prev) => new Set(prev).add(index));
        setKnown((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
      setFlipped(false);
      if (index < activeDeck.cards.length - 1) setIndex(index + 1);
    },
    [activeDeck, index],
  );

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl pt-4">
        <GeneratingCard label="Building your flashcards…" />
      </div>
    );
  }

  /* Deck study view */
  if (activeDeck) {
    const card = activeDeck.cards[Math.min(index, activeDeck.cards.length - 1)];
    const done = known.size + reviewQueue.size >= activeDeck.cards.length && index === activeDeck.cards.length - 1 && (known.has(index) || reviewQueue.has(index));
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-slate-900">{activeDeck.topic}</p>
            <p className="text-[12.5px] text-slate-500">
              Card {index + 1} of {activeDeck.cards.length} · {known.size} known · {reviewQueue.size} to review
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActiveDeckId(null)}
            className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-50"
          >
            All decks
          </button>
        </div>

        {/* 3D flip card */}
        <div style={{ perspective: 1400 }} className="select-none">
          <motion.div
            key={`${activeDeck.id}-${index}`}
            onClick={() => setFlipped((value) => !value)}
            animate={{ rotateY: flipped ? 180 : 0 }}
            transition={{ duration: 0.45, ease: [0.32, 0.72, 0.22, 1] }}
            style={{ transformStyle: "preserve-3d" }}
            className="relative h-72 w-full cursor-pointer"
          >
            <div
              style={{ backfaceVisibility: "hidden" }}
              className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-[0_8px_30px_rgba(15,23,42,0.08)]"
            >
              {card.tag && (
                <span className="mb-3 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  {card.tag}
                </span>
              )}
              <p className="text-[17px] font-semibold leading-relaxed text-slate-900">{card.front}</p>
              <p className="mt-4 text-[11.5px] text-slate-400">Click to reveal</p>
            </div>
            <div
              style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
              className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-slate-50/70 p-8 text-center shadow-[0_8px_30px_rgba(15,23,42,0.08)]"
            >
              <p className="text-[15px] leading-relaxed text-slate-800">{card.back}</p>
            </div>
          </motion.div>
        </div>

        {/* progress dots */}
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {activeDeck.cards.map((_, dotIndex) => (
            <button
              key={dotIndex}
              type="button"
              aria-label={`Go to card ${dotIndex + 1}`}
              onClick={() => {
                setIndex(dotIndex);
                setFlipped(false);
              }}
              className={cn(
                "h-2 w-2 rounded-full transition-all",
                dotIndex === index
                  ? "w-5 bg-slate-800"
                  : known.has(dotIndex)
                    ? "bg-emerald-400"
                    : reviewQueue.has(dotIndex)
                      ? "bg-amber-400"
                      : "bg-slate-200 hover:bg-slate-300",
              )}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setIndex(Math.max(0, index - 1));
              setFlipped(false);
            }}
            disabled={index === 0}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 disabled:opacity-30"
            aria-label="Previous card"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => mark("review")}
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-[13px] font-semibold text-amber-700 transition-colors hover:bg-amber-100"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Review again
            </button>
            <button
              type="button"
              onClick={() => mark("known")}
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-[13px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
            >
              <Check className="h-3.5 w-3.5" /> Know it
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setIndex(Math.min(activeDeck.cards.length - 1, index + 1));
              setFlipped(false);
            }}
            disabled={index === activeDeck.cards.length - 1}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 disabled:opacity-30"
            aria-label="Next card"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {done && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-[13px] text-emerald-700"
          >
            Deck complete — {known.size} known, {reviewQueue.size} marked for review.
          </motion.div>
        )}
      </div>
    );
  }

  /* Deck list + generator */
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold text-slate-900">Flashcards</h2>
        <p className="mt-0.5 text-[13px] text-slate-500">Generate a deck from a topic or your selected sources, then flip through it.</p>
      </div>
      <AnimatePresence>{error && <ErrorBanner message={error} onDismiss={() => setError("")} />}</AnimatePresence>

      <div className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
        <input
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void generate();
          }}
          placeholder="Deck topic — e.g. Cell biology key terms…"
          className="w-full rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-[13.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
        />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-slate-600">
            Cards
            <select
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 outline-none focus:border-slate-300"
            >
              {[6, 8, 10, 14, 18, 24].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-600">
            <button
              type="button"
              role="switch"
              aria-checked={useSources}
              onClick={() => setUseSources((value) => !value)}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                useSources && selectedSources.length ? "bg-slate-500" : "bg-slate-200",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                  useSources && selectedSources.length ? "left-[18px]" : "left-0.5",
                )}
              />
            </button>
            Use my sources <span className="text-slate-400">({selectedSources.length} selected)</span>
          </label>
        </div>
        <PrimaryButton onClick={() => void generate()} disabled={!canGenerate} className="w-full py-2.5">
          <Layers className="h-4 w-4" /> Generate deck
        </PrimaryButton>
      </div>

      {decks.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No decks yet"
          description="Your generated decks are saved here so you can revisit them any time."
        />
      ) : (
        <div className="space-y-2">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">Saved decks</p>
          {decks.map((deck) => (
            <div
              key={deck.id}
              className="flex items-center gap-3 rounded-md border border-slate-200 bg-white p-3.5"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500">
                <Layers className="h-4 w-4" />
              </span>
              <button type="button" onClick={() => openDeck(deck.id)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-[13.5px] font-semibold text-slate-800 transition-colors hover:text-slate-600">{deck.topic}</p>
                <p className="text-[12px] text-slate-400">
                  {deck.cards.length} cards · {new Date(deck.createdAt).toLocaleDateString()}
                </p>
              </button>
              <button
                type="button"
                onClick={() => setDecks((prev) => prev.filter((entry) => entry.id !== deck.id))}
                className="shrink-0 rounded-full p-2 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500"
                aria-label="Delete deck"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notes panel                                                         */
/* ------------------------------------------------------------------ */

function notesToMarkdown(notes: NotesDoc): string {
  const lines: string[] = [`# ${notes.title}`, ""];
  for (const section of notes.sections) {
    lines.push(`## ${section.heading}`);
    if (section.cue) lines.push(`> ${section.cue}`, "");
    for (const point of section.points) lines.push(`- ${point}`);
    lines.push("");
  }
  if (notes.summary) lines.push("## Summary", "", notes.summary, "");
  if (notes.questions.length) {
    lines.push("## Self-test", "");
    for (const question of notes.questions) lines.push(`**Q: ${question.q}**`, "", `A: ${question.a}`, "");
  }
  return lines.join("\n");
}

function NotesPanel({
  sources,
  notes,
  setNotes,
  goToSources,
}: {
  sources: StudySource[];
  notes: NotesDoc | null;
  setNotes: (notes: NotesDoc | null) => void;
  goToSources: () => void;
}) {
  const [focus, setFocus] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [openQuestion, setOpenQuestion] = useState<number | null>(null);

  const selectedSources = useMemo(() => sources.filter((source) => source.selected), [sources]);

  const generate = useCallback(async () => {
    if (!selectedSources.length || loading) return;
    setLoading(true);
    setError("");
    try {
      const data = await postJson<NotesDoc>("/api/study/notes", {
        focus: focus.trim() || undefined,
        context: toContext(selectedSources),
      });
      setNotes({ title: data.title, sections: data.sections, summary: data.summary, questions: data.questions });
      setOpenQuestion(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notes generation failed.");
    } finally {
      setLoading(false);
    }
  }, [selectedSources, loading, focus, setNotes]);

  const copyMarkdown = useCallback(() => {
    if (!notes) return;
    void navigator.clipboard.writeText(notesToMarkdown(notes)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [notes]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[720px] pt-4">
        <GeneratingCard label="Distilling your sources into notes" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-slate-900">Smart notes</h2>
          <p className="mt-0.5 text-[13px] text-slate-500">Cornell-style notes generated from your selected sources.</p>
        </div>
        {notes && (
          <button
            type="button"
            onClick={copyMarkdown}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-slate-600 transition-colors hover:border-slate-200 hover:bg-slate-50 hover:text-slate-700"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy as Markdown"}
          </button>
        )}
      </div>

      <AnimatePresence>{error && <ErrorBanner message={error} onDismiss={() => setError("")} />}</AnimatePresence>

      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white p-3">
        <input
          value={focus}
          onChange={(event) => setFocus(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void generate();
          }}
          placeholder="Optional focus — e.g. exam definitions, chapter 3…"
          className="w-full rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
        />
        <PrimaryButton onClick={() => void generate()} disabled={!selectedSources.length}>
          <NotebookPen className="h-3.5 w-3.5" /> {notes ? "Regenerate" : "Generate"}
        </PrimaryButton>
      </div>

      {!notes ? (
        <EmptyState
          icon={NotebookPen}
          title="No notes yet"
          description={
            selectedSources.length
              ? "Generate structured Cornell notes — cues on the left, key points on the right, plus a summary and self-test."
              : "Select at least one source first, then generate notes from it."
          }
          action={
            selectedSources.length ? undefined : (
              <PrimaryButton onClick={goToSources}>
                <Plus className="h-3.5 w-3.5" /> Add sources
              </PrimaryButton>
            )
          }
        />
      ) : (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-6 py-4">
              <h3 className="text-[16px] font-semibold text-slate-900">{notes.title}</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {notes.sections.map((section, index) => (
                <div key={index} className="grid grid-cols-[minmax(120px,200px)_1fr] gap-4 px-6 py-4 max-sm:grid-cols-1">
                  <div>
                    <p className="text-[13px] font-semibold text-slate-800">{section.heading}</p>
                    {section.cue && <p className="mt-1 text-[12px] italic leading-relaxed text-slate-600">{section.cue}</p>}
                  </div>
                  <ul className="space-y-1.5">
                    {section.points.map((point, pointIndex) => (
                      <li key={pointIndex} className="flex gap-2 text-[13px] leading-relaxed text-slate-700">
                        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {notes.summary && (
              <div className="border-t border-slate-100 bg-slate-50/60 px-6 py-4">
                <p className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-400">Summary</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-slate-700">{notes.summary}</p>
              </div>
            )}
          </div>

          {notes.questions.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-6 py-3.5">
                <p className="text-[13.5px] font-semibold text-slate-800">Self-test</p>
              </div>
              <div className="divide-y divide-slate-100">
                {notes.questions.map((question, index) => {
                  const open = openQuestion === index;
                  return (
                    <div key={index}>
                      <button
                        type="button"
                        onClick={() => setOpenQuestion(open ? null : index)}
                        className="flex w-full items-center justify-between gap-3 px-6 py-3.5 text-left transition-colors hover:bg-slate-50/70"
                      >
                        <span className="text-[13px] font-medium text-slate-700">{question.q}</span>
                        <ChevronDown className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-180")} />
                      </button>
                      <AnimatePresence initial={false}>
                        {open && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <p className="px-6 pb-4 text-[13px] leading-relaxed text-slate-500">{question.a}</p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Welcome                                                             */
/* ------------------------------------------------------------------ */

function StudyWelcome({
  sessions,
  onStartTopic,
  onAddResource,
  onOpenSession,
  onDeleteSession,
}: {
  sessions: StudySession[];
  onStartTopic: (topic: string) => void;
  onAddResource: (source: Omit<StudySource, "id" | "selected">) => void;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"study" | "resource">("study");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importUrl = async () => {
    const value = url.trim();
    if (!value || fetching) return;
    setFetching(true);
    setError("");
    try {
      const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      const data = await postJson<{ title: string; text: string; url: string }>("/api/study/fetch", { url: normalized });
      onAddResource({ title: data.title, source: data.url, body: data.text });
      setUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The source could not be imported");
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#f8fafc]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(15,23,42,0.04),transparent_55%)]" />
      <div className="relative mx-auto flex w-full max-w-[720px] flex-1 flex-col items-center justify-center px-5 py-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
          className="w-full text-center"
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Study Pal</p>
          <h1 className="mt-3 text-[clamp(32px,5vw,48px)] font-semibold tracking-[-0.04em] text-slate-950">
            What do you want to study?
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-slate-500">
            Start with a topic, or add a resource first. Clyra keeps each study session separate.
          </p>

          <div className="mx-auto mt-8 flex w-full max-w-xl items-center justify-center gap-1 rounded-md border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setMode("study")}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-[12px] font-semibold transition-colors",
                mode === "study" ? "bg-slate-950 text-white" : "text-slate-500 hover:text-slate-800",
              )}
            >
              Start studying
            </button>
            <button
              type="button"
              onClick={() => setMode("resource")}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-[12px] font-semibold transition-colors",
                mode === "resource" ? "bg-slate-950 text-white" : "text-slate-500 hover:text-slate-800",
              )}
            >
              Add a resource
            </button>
          </div>

          <AnimatePresence>{error ? <div className="mx-auto mt-4 w-full max-w-xl text-left"><ErrorBanner message={error} onDismiss={() => setError("")} /></div> : null}</AnimatePresence>

          {mode === "study" ? (
            <div className="mx-auto mt-5 w-full max-w-xl">
              <div className="flex items-center gap-2 rounded-[22px] border border-slate-200 bg-white px-4 py-2.5 shadow-[0_16px_48px_rgba(15,23,42,0.06)] focus-within:border-slate-400">
                <BookOpen className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && topic.trim()) onStartTopic(topic.trim());
                  }}
                  placeholder="e.g. Organic chemistry mechanisms…"
                  className="w-full bg-transparent text-[15px] text-slate-800 outline-none placeholder:text-slate-400"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => topic.trim() && onStartTopic(topic.trim())}
                  disabled={!topic.trim()}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white transition-opacity disabled:opacity-30"
                  aria-label="Start study session"
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </button>
              </div>
              <p className="mt-3 text-[12px] text-slate-400">You can add resources after the session opens.</p>
            </div>
          ) : (
            <div className="mx-auto mt-5 w-full max-w-xl text-left">
              <div className="flex items-center gap-2 rounded-[22px] border border-slate-200 bg-white px-4 py-2.5 shadow-[0_16px_48px_rgba(15,23,42,0.06)] focus-within:border-slate-400">
                <Link2 className="h-4 w-4 shrink-0 text-slate-400" />
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void importUrl();
                  }}
                  placeholder="Paste an article, docs, or lecture URL…"
                  className="w-full bg-transparent text-[14px] text-slate-800 outline-none placeholder:text-slate-400"
                  disabled={fetching}
                />
                <PrimaryButton onClick={() => void importUrl()} disabled={!url.trim() || fetching} className="shrink-0">
                  {fetching ? "Importing…" : "Add"}
                </PrimaryButton>
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:border-slate-300"
                >
                  <Upload className="h-3.5 w-3.5" /> Upload file
                </button>
                <button
                  type="button"
                  onClick={() => setPasteOpen((open) => !open)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium",
                    pasteOpen ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-600",
                  )}
                >
                  <FilePlus2 className="h-3.5 w-3.5" /> Paste text
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.markdown,text/plain,text/markdown"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = event.target.files;
                    if (!files) return;
                    for (const file of Array.from(files)) {
                      if (!/\.(txt|md|markdown)$/i.test(file.name)) {
                        setError(`"${file.name}" is not supported — use .txt or .md.`);
                        continue;
                      }
                      const reader = new FileReader();
                      reader.onload = () => {
                        const body = String(reader.result || "").trim();
                        if (body) {
                          onAddResource({
                            title: file.name.replace(/\.(txt|md|markdown)$/i, ""),
                            source: file.name,
                            body: body.slice(0, 120_000),
                          });
                        }
                      };
                      reader.readAsText(file);
                    }
                    event.target.value = "";
                  }}
                />
              </div>
              <AnimatePresence initial={false}>
                {pasteOpen ? (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="mt-3 space-y-2 rounded-md border border-slate-200 bg-white p-3">
                      <input value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="Title (optional)" className="w-full rounded-md border border-slate-200 px-3 py-2 text-[13px] outline-none" />
                      <textarea value={pasteBody} onChange={(event) => setPasteBody(event.target.value)} rows={4} placeholder="Paste study material…" className="w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-[13px] outline-none" />
                      <div className="flex justify-end">
                        <PrimaryButton
                          disabled={!pasteBody.trim()}
                          onClick={() => {
                            const body = pasteBody.trim();
                            if (!body) return;
                            onAddResource({
                              title: pasteTitle.trim() || `Pasted text ${new Date().toLocaleDateString()}`,
                              source: "Pasted text",
                              body: body.slice(0, 120_000),
                            });
                            setPasteBody("");
                            setPasteTitle("");
                            setPasteOpen(false);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" /> Add resource
                        </PrimaryButton>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          )}

          {sessions.length > 0 ? (
            <div className="mx-auto mt-10 w-full max-w-xl text-left">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                  <History className="h-3.5 w-3.5" /> Previous sessions
                </div>
                <span className="text-[11px] font-medium text-slate-400">Auto-saved · {sessions.length}</span>
              </div>
              <div className="max-h-[240px] space-y-1.5 overflow-y-auto pr-1">
                {sessions.slice(0, 12).map((session) => (
                  <div key={session.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenSession(session.id)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-[12px] border border-slate-200/80 bg-white px-3.5 py-3 text-left transition-colors duration-150 hover:border-slate-300 hover:bg-[#f8fafc]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-slate-900">{titleFromSession(session)}</span>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          {session.sources.length} resource{session.sources.length === 1 ? "" : "s"} · {formatSessionTime(session.updatedAt)}
                        </span>
                      </span>
                      <Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSession(session.id)}
                      className="rounded-[10px] p-2 text-slate-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                      aria-label="Delete session"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </motion.div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Root component                                                      */
/* ------------------------------------------------------------------ */

const NAV_ITEMS: { id: TabId; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "quiz", label: "Quiz", icon: ListChecks },
  { id: "flashcards", label: "Cards", icon: Layers },
  { id: "notes", label: "Notes", icon: NotebookPen },
  { id: "sources", label: "Nodes", icon: FileText },
];

export default function StudyPalWorkspace({
  globalTabsVisible = false,
  agentPrompt = "",
}: {
  globalTabsVisible?: boolean;
  agentPrompt?: string;
}) {
  const boot = useRef(loadWorkspace());
  const [sessions, setSessions] = useState<StudySession[]>(boot.current.sessions);
  // Always land on the welcome screen when Study Pal opens. Sessions stay
  // loaded for history; the user (or agentPrompt) chooses what to resume.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [tab, setTab] = useState<TabId>("chat");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hoveredNav, setHoveredNav] = useState<TabId | "new" | "history" | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const sources = activeSession?.sources || [];
  const messages = activeSession?.messages || [];
  const decks = activeSession?.decks || [];
  const notes = activeSession?.notes || null;

  useEffect(() => {
    saveWorkspace({ sessions, activeSessionId });
  }, [sessions, activeSessionId]);

  const patchActive = useCallback((mutator: (session: StudySession) => StudySession) => {
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== activeSessionId) return session;
        const next = mutator(session);
        return { ...next, title: titleFromSession(next), updatedAt: Date.now() };
      }),
    );
  }, [activeSessionId]);

  const setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> = useCallback((update) => {
    patchActive((session) => ({
      ...session,
      messages: typeof update === "function" ? update(session.messages) : update,
    }));
  }, [patchActive]);

  const setDecks: React.Dispatch<React.SetStateAction<FlashDeck[]>> = useCallback((update) => {
    patchActive((session) => ({
      ...session,
      decks: typeof update === "function" ? update(session.decks) : update,
    }));
  }, [patchActive]);

  const setNotes: React.Dispatch<React.SetStateAction<NotesDoc | null>> = useCallback((update) => {
    patchActive((session) => ({
      ...session,
      notes: typeof update === "function" ? update(session.notes) : update,
    }));
  }, [patchActive]);

  const createSession = useCallback((seed?: Partial<StudySession>) => {
    const session = emptySession(seed);
    setSessions((prev) => [session, ...prev].slice(0, 40));
    setActiveSessionId(session.id);
    setShowWelcome(false);
    return session;
  }, []);

  useEffect(() => {
    const prompt = (agentPrompt || "").trim();
    if (!prompt) return;
    createSession({ title: prompt.slice(0, 60) });
    setTab("chat");
  }, [agentPrompt, createSession]);

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setShowWelcome(false);
    setTab("chat");
    setHistoryOpen(false);
  }, []);

  const startTopic = useCallback((topic: string) => {
    createSession({
      title: topic.slice(0, 60),
      messages: [
        {
          id: uid(),
          role: "assistant",
          content: `Ready to study **${topic}**. Add a resource (article, notes, or lecture text), then ask anything about it.`,
        },
      ],
    });
    setTab("sources");
  }, [createSession]);

  const addResourceFromWelcome = useCallback((source: Omit<StudySession["sources"][number], "id" | "selected">) => {
    const session = createSession({
      title: source.title.slice(0, 60),
      sources: [{ ...source, id: uid(), selected: true }],
    });
    setActiveSessionId(session.id);
    setTab("chat");
  }, [createSession]);

  const addSource = useCallback((source: Omit<StudySource, "id" | "selected">) => {
    if (!activeSessionId) {
      addResourceFromWelcome(source);
      return;
    }
    patchActive((session) => ({
      ...session,
      sources: [...session.sources, { ...source, id: uid(), selected: true }].slice(0, 32),
    }));
  }, [activeSessionId, addResourceFromWelcome, patchActive]);

  const removeSource = useCallback((id: string) => {
    patchActive((session) => ({
      ...session,
      sources: session.sources.filter((source) => source.id !== id),
    }));
  }, [patchActive]);

  const toggleSource = useCallback((id: string) => {
    patchActive((session) => ({
      ...session,
      sources: session.sources.map((source) => (source.id === id ? { ...source, selected: !source.selected } : source)),
    }));
  }, [patchActive]);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== id);
      if (activeSessionId === id) {
        const fallback = next[0]?.id || null;
        setActiveSessionId(fallback);
        setShowWelcome(!fallback);
      }
      return next;
    });
  }, [activeSessionId]);

  const orderedSessions = useMemo(
    () => [...sessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions],
  );

  if (showWelcome || !activeSession) {
    return (
      <StudyWelcome
        sessions={orderedSessions}
        onStartTopic={startTopic}
        onAddResource={addResourceFromWelcome}
        onOpenSession={openSession}
        onDeleteSession={deleteSession}
      />
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full bg-[#f8fafc]", globalTabsVisible && "pt-1")}>
      <nav
        className="relative z-10 flex w-[64px] shrink-0 flex-col items-center border-r border-slate-200/70 bg-transparent py-3"
        aria-label="Study tools"
      >
        <div className="mb-3 grid h-10 w-10 place-items-center" title={titleFromSession(activeSession)}>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-900 text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)]">
            <BookOpen className="h-3.5 w-3.5" />
          </span>
        </div>

        <div
          className="clyra-workflow-tabs clyra-workflow-tabs--vertical relative flex flex-col items-center gap-1 p-1"
          onMouseLeave={() => setHoveredNav(null)}
        >
          {hoveredNav && NAV_ITEMS.some((item) => item.id === hoveredNav) && tab !== hoveredNav ? (
            <motion.div
              layoutId="study-nav-hover"
              className="clyra-workflow-tab__hover pointer-events-none absolute left-1 right-1"
              style={{
                top: 4 + Math.max(0, NAV_ITEMS.findIndex((item) => item.id === hoveredNav)) * 44,
                height: 40,
                translate: "0 0",
              }}
              transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.35 }}
            />
          ) : null}
          {NAV_ITEMS.map((item) => {
            const active = tab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                onMouseEnter={() => setHoveredNav(item.id)}
                onFocus={() => setHoveredNav(item.id)}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                title={item.label}
                className={cn(
                  "clyra-workflow-tab relative z-[1] !h-10 !w-10 !min-w-0 !rounded-full !p-0",
                  active && "clyra-workflow-tab--active",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="study-nav-active"
                    className="absolute inset-[2px] rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/80"
                    transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.35 }}
                  />
                ) : null}
                <Icon className="relative h-4 w-4" strokeWidth={active ? 2.15 : 1.9} />
              </button>
            );
          })}
        </div>

        <div className="mt-auto flex flex-col items-center gap-1 pb-1">
          <button
            type="button"
            onClick={() => {
              setShowWelcome(true);
              setActiveSessionId(null);
            }}
            className="clyra-workflow-tab relative !h-10 !w-10 !min-w-0 !rounded-full !p-0"
            aria-label="New study"
            title="New study"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className={cn(
              "clyra-workflow-tab relative !h-10 !w-10 !min-w-0 !rounded-full !p-0",
              historyOpen && "clyra-workflow-tab--active",
            )}
            aria-label="Previous sessions"
            title="Previous sessions"
            aria-expanded={historyOpen}
          >
            <History className="h-4 w-4" />
          </button>
          <AnimatePresence initial={false}>
            {historyOpen ? (
              <motion.div
                initial={{ opacity: 0, x: -8, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -6, scale: 0.98 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="absolute bottom-16 left-[72px] z-30 w-64 overflow-hidden rounded-[12px] border border-slate-200/80 bg-white p-2 shadow-[0_16px_40px_rgba(15,23,42,0.10)]"
              >
                <p className="px-2 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                  Auto-saved sessions
                </p>
                <div className="max-h-56 space-y-1 overflow-y-auto">
                  {orderedSessions.length === 0 ? (
                    <p className="px-2 py-3 text-[12px] text-slate-400">No sessions yet.</p>
                  ) : (
                    orderedSessions.map((session) => (
                      <div key={session.id} className="group flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openSession(session.id)}
                          className={cn(
                            "min-w-0 flex-1 rounded-[10px] px-2.5 py-2 text-left transition-colors duration-150",
                            session.id === activeSessionId ? "bg-slate-100" : "hover:bg-[#f8fafc]",
                          )}
                        >
                          <span className="block truncate text-[12.5px] font-semibold text-slate-800">
                            {titleFromSession(session)}
                          </span>
                          <span className="block text-[10.5px] text-slate-400">{formatSessionTime(session.updatedAt)}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteSession(session.id)}
                          className="rounded-md p-1.5 text-slate-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                          aria-label="Delete session"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={cn("h-full px-6 py-6 max-md:px-4", tab === "chat" && "flex flex-col")}>
          <AnimatePresence mode="wait">
            <motion.div
              key={`${activeSessionId}-${tab}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className={cn(tab === "chat" ? "flex min-h-0 flex-1 flex-col" : "")}
            >
              {tab === "sources" && (
                <SourcesPanel sources={sources} onAdd={addSource} onRemove={removeSource} onToggle={toggleSource} />
              )}
              {tab === "chat" && (
                <ChatPanel
                  sources={sources}
                  messages={messages}
                  setMessages={setMessages}
                  initialPrompt={agentPrompt}
                  goToSources={() => setTab("sources")}
                />
              )}
              {tab === "quiz" && <QuizPanel sources={sources} />}
              {tab === "flashcards" && <FlashcardsPanel sources={sources} decks={decks} setDecks={setDecks} />}
              {tab === "notes" && (
                <NotesPanel sources={sources} notes={notes} setNotes={setNotes} goToSources={() => setTab("sources")} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
