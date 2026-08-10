import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Copy,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { VoiceTurn } from "../../hooks/useVoiceCall";

function formatTime(at: number) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(at));
  } catch {
    return "";
  }
}

function buildLocalSummary(turns: VoiceTurn[]) {
  const users = turns.filter((t) => t.role === "user").map((t) => t.content.trim());
  const ais = turns.filter((t) => t.role === "assistant").map((t) => t.content.trim());
  if (!users.length && !ais.length) return "No conversation yet — start speaking or type below.";
  const topics = users.slice(-3).map((t) => t.replace(/\s+/g, " "));
  const lastAi = ais[ais.length - 1]?.replace(/\s+/g, " ");
  const topicLine =
    topics.length === 1
      ? `You asked about “${topics[0]!.slice(0, 120)}${topics[0]!.length > 120 ? "…" : ""}”.`
      : `This call covered ${topics.length} things you said, including “${topics[0]!.slice(0, 80)}${topics[0]!.length > 80 ? "…" : ""}”.`;
  const replyLine = lastAi
    ? `Clyra’s latest reply: “${lastAi.slice(0, 160)}${lastAi.length > 160 ? "…" : ""}”.`
    : "Clyra hasn’t answered yet.";
  return `${topicLine} ${replyLine}`;
}

function MessageBubble({
  turn,
  expanded,
  query,
  onToggle,
  onCopy,
  onEdit,
  onResend,
}: {
  turn: VoiceTurn;
  expanded: boolean;
  query: string;
  onToggle: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onResend: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isYou = turn.role === "user";
  const long = turn.content.length > 160;
  const preview =
    !expanded && long ? `${turn.content.slice(0, 148).trim()}…` : turn.content;

  const highlighted = useMemo(() => {
    if (!query.trim()) return preview;
    const q = query.trim();
    const idx = preview.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return preview;
    return (
      <>
        {preview.slice(0, idx)}
        <mark className="rounded-sm bg-amber-200/80 px-0.5 text-slate-900">
          {preview.slice(idx, idx + q.length)}
        </mark>
        {preview.slice(idx + q.length)}
      </>
    );
  }, [preview, query]);

  return (
    <motion.article
      layout
      initial={isYou ? false : { opacity: 0, y: 0, scale: 0.994 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        type: "tween",
        ease: [0.22, 1, 0.36, 1],
        duration: isYou ? 0.88 : 0.52,
      }}
      className={cn(
        "flex w-full",
        isYou ? "justify-end clyra-user-message-entry" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[88%] px-3.5 py-2.5",
          isYou
            ? "rounded-[14px] rounded-br-md bg-[#aec7f1] text-[#18212f]"
            : "text-[#18212f]",
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-3">
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-[0.14em]",
              isYou ? "text-[#18212f]/55" : "text-[#8b939e]",
            )}
          >
            {isYou ? "You" : "Clyra"}
          </span>
          <span
            className={cn(
              "text-[10px] tabular-nums",
              isYou ? "text-[#18212f]/45" : "text-[#8b939e]",
            )}
          >
            {formatTime(turn.at)}
          </span>
        </div>

        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "w-full text-left text-[14px] leading-[1.55] tracking-[-0.01em]",
            isYou ? "text-[#18212f]" : "text-[#18212f]",
          )}
        >
          {highlighted}
          {long ? (
            <span
              className={cn(
                "mt-1 block text-[11px] font-medium",
                isYou ? "text-[#18212f]/55" : "text-[#8b939e]",
              )}
            >
              {expanded ? "Show less" : "Tap to expand"}
            </span>
          ) : null}
        </button>

        <div
          className={cn(
            "mt-2 flex items-center gap-1",
            isYou ? "justify-end" : "justify-start",
          )}
        >
          {!isYou ? (
            <button
              type="button"
              onClick={() => {
                onCopy();
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-[#697386] transition-colors hover:bg-[#f1f3f7] hover:text-[#18212f]"
              aria-label="Copy response"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-[#18212f]/65 transition-colors hover:bg-black/5 hover:text-[#18212f]"
                aria-label="Edit message"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
              <button
                type="button"
                onClick={onResend}
                className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-[#18212f]/65 transition-colors hover:bg-black/5 hover:text-[#18212f]"
                aria-label="Resend message"
              >
                <RefreshCw className="h-3 w-3" />
                Resend
              </button>
            </>
          )}
        </div>
      </div>
    </motion.article>
  );
}

export function VoiceTranscriptPanel({
  open,
  turns,
  liveUser,
  liveAssistant,
  onClose,
  onSend,
  onUpdateUser,
  onResendUser,
}: {
  open: boolean;
  turns: VoiceTurn[];
  liveUser: string;
  liveAssistant: string;
  onClose: () => void;
  onSend: (text: string) => boolean | void;
  onUpdateUser: (id: string, content: string) => void;
  onResendUser: (id: string, contentOverride?: string) => boolean | void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return turns;
    return turns.filter((t) => t.content.toLowerCase().includes(q));
  }, [turns, query]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, turns, liveUser, liveAssistant, summary]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 280);
    } else {
      setQuery("");
      setEditingId(null);
    }
  }, [open]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const ok = onSend(text);
    if (ok !== false) setDraft("");
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const refreshSummary = () => {
    setSummaryBusy(true);
    window.setTimeout(() => {
      setSummary(buildLocalSummary(turns));
      setSummaryBusy(false);
    }, 180);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="voice-transcript-sheet"
          className="absolute inset-x-0 bottom-0 z-[230] flex max-h-[78%] flex-col"
          initial={{ y: "108%" }}
          animate={{ y: 0 }}
          exit={{ y: "108%" }}
          transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="clyra-voice-transcript-sheet mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] border border-[#e7e7e4] bg-[#fbfbfa]/98 shadow-[0_-18px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl">
            <div className="flex items-center justify-between px-5 pb-2 pt-3">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#eef4ff] text-[#0052fb]">
                  <MessageSquareText className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[13px] font-semibold text-[#18212f]">Messages</p>
                  <p className="text-[11px] text-[#8b939e]">
                    Live transcript · type anytime
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e7e7e4] bg-white text-[#697386] transition-colors hover:bg-[#f1f3f7]"
                aria-label="Close conversation"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-4 pb-2">
              <div className="flex items-center gap-2 rounded-full border border-[#dfe7f1] bg-white px-3 py-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-[#8b939e]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this call…"
                  className="w-full bg-transparent text-[13px] text-[#18212f] outline-none placeholder:text-[#8b939e]"
                />
              </div>
            </div>

            <div className="px-4 pb-2">
              <div className="overflow-hidden rounded-2xl border border-[#e7e7e4] bg-white">
                <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b939e]">
                    <Sparkles className="h-3.5 w-3.5 text-[#0052fb]" />
                    Summary
                  </div>
                  <button
                    type="button"
                    onClick={refreshSummary}
                    disabled={summaryBusy}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-[#697386] transition-colors hover:bg-[#f1f3f7] disabled:opacity-50"
                  >
                    <RefreshCw
                      className={cn("h-3 w-3", summaryBusy && "animate-spin")}
                    />
                    {summary ? "Refresh" : "Generate"}
                  </button>
                </div>
                <AnimatePresence mode="wait" initial={false}>
                  {summary ? (
                    <motion.p
                      key={summary}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                      className="px-3.5 pb-3 text-[12.5px] leading-relaxed text-[#697386]"
                    >
                      {summary}
                    </motion.p>
                  ) : (
                    <motion.p
                      key="empty-summary"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="px-3.5 pb-3 text-[12px] text-[#8b939e]"
                    >
                      Generate a short overview of this call.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div
              ref={listRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-3 pt-1 scrollbar-thin"
            >
              {filtered.length === 0 && !liveUser && !liveAssistant ? (
                <p className="px-2 py-8 text-center text-[13px] text-[#8b939e]">
                  {query
                    ? "No matches in this conversation."
                    : "Your words and Clyra’s replies will appear here."}
                </p>
              ) : null}

              {filtered.map((turn) =>
                editingId === turn.id ? (
                  <div
                    key={`${turn.id}-edit`}
                    className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
                  >
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                      Edit message
                    </p>
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-800 outline-none focus:border-slate-300"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-full px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const text = editDraft.trim();
                          if (!text) return;
                          onUpdateUser(turn.id, text);
                          setEditingId(null);
                          onResendUser(turn.id, text);
                        }}
                        className="rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-slate-800"
                      >
                        Save & resend
                      </button>
                    </div>
                  </div>
                ) : (
                  <MessageBubble
                    key={turn.id}
                    turn={turn}
                    expanded={Boolean(expandedIds[turn.id])}
                    query={query}
                    onToggle={() =>
                      setExpandedIds((prev) => ({
                        ...prev,
                        [turn.id]: !prev[turn.id],
                      }))
                    }
                    onCopy={() => {
                      void navigator.clipboard?.writeText(turn.content);
                    }}
                    onEdit={() => {
                      setEditingId(turn.id);
                      setEditDraft(turn.content);
                    }}
                    onResend={() => onResendUser(turn.id)}
                  />
                ),
              )}

              {liveUser ? (
                <motion.div
                  initial={{ opacity: 0, y: 26, scale: 0.988 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.88, ease: [0.22, 1, 0.36, 1] }}
                  className="flex justify-end clyra-user-message-entry"
                >
                  <div className="max-w-[88%] rounded-[14px] rounded-br-md bg-[#aec7f1] px-3.5 py-2.5 text-[14px] leading-[1.55] text-[#18212f]">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#18212f]/55">
                      You · live
                    </p>
                    {liveUser}
                  </div>
                </motion.div>
              ) : null}

              {liveAssistant ? (
                <motion.div
                  initial={{ opacity: 0, y: 18, scale: 0.994 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
                  className="flex justify-start"
                >
                  <div className="max-w-[88%] px-1 py-1 text-[14px] leading-[1.55] text-[#18212f]">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8b939e]">
                      Clyra · live
                    </p>
                    {liveAssistant}
                  </div>
                </motion.div>
              ) : null}
            </div>

            <form
              onSubmit={submit}
              className="border-t border-[#e7e7e4] bg-[#fbfbfa] px-4 pb-[max(0.9rem,env(safe-area-inset-bottom))] pt-3"
            >
              <div className="flex items-end gap-2 rounded-[18px] border border-[#dfe7f1] bg-white p-2 pl-3">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onComposerKey}
                  rows={1}
                  placeholder="Message Clyra…"
                  className="max-h-28 min-h-[40px] w-full resize-none bg-transparent py-2 text-[14px] text-[#18212f] outline-none placeholder:text-[#8b939e]"
                />
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0052fb] text-white transition-transform enabled:hover:scale-[1.03] enabled:active:scale-95 disabled:bg-[#e8eaef] disabled:text-[#b0b5bf]"
                  aria-label="Send typed message"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </form>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
