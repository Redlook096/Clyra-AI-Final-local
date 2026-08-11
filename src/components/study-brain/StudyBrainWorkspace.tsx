/**
 * Clyra Study Brain — XYFlow canvas workspace.
 * Reuses chat YouTube analysis + Google desktop execute + /api/study/*.
 */
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  FileText,
  Film,
  FolderOpen,
  Globe,
  GraduationCap,
  Image as ImageIcon,
  Link2,
  Link as LinkIcon,
  Loader2,
  Mic,
  MessageCircle,
  MousePointer2,
  Network,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Maximize2,
  Redo2,
  Search,
  Undo2,
  Upload,
  ClipboardCheck,
  Lightbulb,
  Paperclip,
  Plus,
  Presentation,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Volume2,
  ZoomIn,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn, formatApiError } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "../ShiningText";
import { GoogleProductIcon, YouTubeBrandIcon } from "../brand/ProductIcons";
import { getElectronDesktop } from "../../lib/electron-runtime";
import {
  connectedSources,
  emptySource,
  emptyBrain,
  findSourceByCitation,
  hasDuplicateOrigin,
  layoutSourcesAroundBrain,
  loadStudyBrainStore,
  positionAroundBrain,
  saveStudyBrainStore,
  toAskContext,
  uid,
} from "../../lib/study-brain/storage";
import { ingestAnyUrl, ingestPaste, ingestTextFile } from "../../lib/study-brain/ingest";
import type {
  BrainAction,
  StudyBrain,
  StudyBrainStore,
  StudyChatMessage,
  StudySourceNode,
} from "../../lib/study-brain/types";
import { BrainCanvas, type StudyCanvasApi } from "./BrainCanvas";
import { ChatComposerShell } from "../../features/chat/ChatComposer";
import { StudyDock, StudyDockGroup, StudyDockItem, StudyDockSeparator, StudyDockSpacer } from "./StudyDock";

function softenStudyError(raw: string): string {
  if (/api key|authentication|401|invalid/i.test(raw)) {
    return "Study Brain needs a valid DeepSeek API key in server settings to answer. Your sources and canvas are still saved.";
  }
  if (/unavailable on this server/i.test(raw)) {
    return "Study intelligence is not configured on this server yet. Sources and the canvas still autosave.";
  }
  return raw;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(softenStudyError(formatApiError(payload?.error, `Request failed (${response.status})`)));
  }
  return payload as T;
}

type WelcomeIntent = {
  kind: "topic" | "youtube" | "document" | "website" | "note";
  action: string;
  url?: string;
};

function inferWelcomeIntent(value: string): WelcomeIntent {
  const trimmed = value.trim();
  const likelyUrl = /^(?:https?:\/\/)?(?:www\.)?(?:youtu\.be|youtube\.com|docs\.google\.com|drive\.google\.com|[a-z0-9-]+\.[a-z]{2,})(?:[\/?#]|$)/i.test(trimmed);
  const url = likelyUrl ? (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) : undefined;
  const hostname = url ? new URL(url).hostname.toLowerCase() : "";

  if (hostname === "youtu.be" || hostname.endsWith("youtube.com")) return { kind: "youtube", action: "Add video", url };
  if (hostname === "docs.google.com" || hostname === "drive.google.com") return { kind: "document", action: "Add document", url };
  if (url) return { kind: "website", action: "Add website", url };
  if (trimmed.length > 280 || trimmed.includes("\n")) return { kind: "note", action: "Create note" };
  return { kind: "topic", action: "Create study space" };
}

type StudyGoogleTool = "docs" | "slides" | "sheets" | "drive" | "gmail" | "calendar";

type WelcomeResearchProgress = {
  phase: 0 | 1 | 2 | 3 | 4;
  topic: string;
  sources: string[];
};

function extractStudyYoutubeUrl(text: string): string | null {
  const match = text.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)[\w\-?=&%.]+/i);
  if (!match?.[0]) return null;
  return match[0].startsWith("http") ? match[0] : `https://${match[0]}`;
}

function wantsStudyWebResearch(text: string): boolean {
  const value = text.trim();
  // Google workspace requests should stay inside the connected, read-only Google
  // integration rather than also issuing an unrelated public-web search.
  if (detectStudyGoogleTool(value)) return false;
  const withoutYoutube = value.replace(extractStudyYoutubeUrl(value) || "", "").trim();
  return /^(?:\/search\s+|search|look\s*up|find|research|google)\b/i.test(withoutYoutube)
    || /\b(?:search the web|look online|from the (?:web|internet)|web search)\b/i.test(withoutYoutube)
    || /\b(?:latest|current|today'?s|this week'?s|breaking)\b.+\b(?:news|price|score|release|update|headline)s?\b/i.test(withoutYoutube);
}

function detectStudyGoogleTool(text: string): StudyGoogleTool | null {
  const value = text.toLowerCase();
  if (/\b(?:gmail|inbox|unread (?:email|mail)|check (?:my )?(?:email|mail))\b/.test(value)) return "gmail";
  if (/\b(?:google calendar|calendar|schedule|upcoming events)\b/.test(value)) return "calendar";
  if (/\b(?:google docs?|docs? file)\b/.test(value)) return "docs";
  if (/\b(?:google sheets?|sheets? file|spreadsheet)\b/.test(value)) return "sheets";
  if (/\b(?:google slides?|slides? file|presentation)\b/.test(value)) return "slides";
  if (/\b(?:google drive|drive file)\b/.test(value)) return "drive";
  return null;
}

function studyGoogleKind(tool: StudyGoogleTool): StudySourceNode["kind"] {
  if (tool === "docs") return "gdoc";
  if (tool === "slides") return "gslides";
  if (tool === "sheets") return "gsheet";
  return "gdrive";
}

function studyProjectUpdatedLabel(updatedAt: number): string {
  const elapsed = Math.max(0, Date.now() - updatedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Updated yesterday" : `Updated ${days}d ago`;
}

/**
 * The Study API returns a completed answer, so this paints its first arrival
 * with the same restrained word-paced stream as the launcher Chat. Old
 * persisted messages deliberately render as normal Markdown.
 */
function StudyTypingAnswer({
  content,
  active,
  onComplete,
}: {
  content: string;
  active: boolean;
  onComplete: () => void;
}) {
  const [shown, setShown] = useState(active ? "" : content);
  const shownRef = useRef(active ? "" : content);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      shownRef.current = content;
      setShown(content);
      return;
    }
    shownRef.current = "";
    setShown("");
    const paint = () => {
      const current = shownRef.current;
      if (current.length >= content.length) {
        frameRef.current = null;
        onComplete();
        return;
      }
      let next = current;
      // Reveal 1–3 natural word fragments each frame. It feels like the
      // primary Chat stream without rerendering on every source token.
      let fragments = content.length - current.length > 170 ? 3 : 2;
      while (fragments-- > 0 && next.length < content.length) {
        const remaining = content.slice(next.length);
        next += remaining.match(/^(?:\s*\S{1,18}|\s+|[\s\S]{1,12})/)?.[0] ?? remaining.slice(0, 8);
      }
      shownRef.current = next;
      setShown(next);
      frameRef.current = window.requestAnimationFrame(paint);
    };
    frameRef.current = window.requestAnimationFrame(paint);
    return () => {
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [active, content, onComplete]);

  if (!active) return <MarkdownMessageContent content={content} />;
  return <div className="clyra-stream-paint whitespace-pre-wrap font-medium leading-relaxed" role="status">{shown}<span className="clyra-stream-paint__caret" aria-hidden /></div>;
}

/** The Study chat shares the primary Chat's expandable favicon sources rather
 * than leaving citations as anonymous numeric buttons. */
function StudySourceFaviconChips({ brain, citations, onOpen }: { brain: StudyBrain; citations: string[]; onOpen: (citation: string) => void }) {
  const [hoveredCitation, setHoveredCitation] = useState<string | null>(null);
  const items = citations.map((citation) => {
    const source = findSourceByCitation(brain, citation);
    const url = source?.origin && /^https?:\/\//i.test(source.origin) ? source.origin : /^https?:\/\//i.test(citation) ? citation : "";
    let host = source?.title || citation;
    try { host = new URL(url).hostname.replace(/^www\./i, ""); } catch { /* local sources keep their title */ }
    return { citation, host: host.replace(/^www\./i, ""), url, source };
  }).filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url && candidate.host === item.host) === index).slice(0, 8);
  if (!items.length) return null;
  return <div className="clyra-message-source-chips" aria-label="Answer sources">
    {items.map((item) => {
      const expanded = hoveredCitation === item.citation;
      return <button key={item.citation} type="button" className={cn("clyra-message-source-chip", expanded && "is-expanded")} aria-label={`Open ${item.host}`} title={item.host} onClick={() => onOpen(item.citation)} onMouseEnter={() => setHoveredCitation(item.citation)} onMouseLeave={() => setHoveredCitation((value) => value === item.citation ? null : value)} onFocus={() => setHoveredCitation(item.citation)} onBlur={() => setHoveredCitation((value) => value === item.citation ? null : value)}>
        <span className="clyra-message-source-chip__icon">{item.url ? <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.host)}&sz=64`} alt="" /> : item.source?.kind === "youtube" ? <YouTubeBrandIcon className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" strokeWidth={1.7} />}</span>
        <span className="clyra-message-source-chip__bullet" aria-hidden={!expanded}><span className="clyra-message-source-chip__dot" /><span className="clyra-message-source-chip__label">{item.host}</span></span>
      </button>;
    })}
  </div>;
}

function StudyChatWorkspace({
  brain,
  busy,
  composer,
  onComposerChange,
  onSubmit,
  onCitation,
  onAttach,
  typingMessageId,
  onTypingComplete,
  onRegenerate,
}: {
  brain: StudyBrain;
  busy: boolean;
  composer: string;
  onComposerChange: (value: string) => void;
  onSubmit: () => void;
  onCitation: (citation: string) => void;
  onAttach: () => void;
  typingMessageId: string | null;
  onTypingComplete: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
}) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ messageId: string; sentiment: "up" | "down" } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestions = [
    "Summarise the connected sources",
    "What should I revise first?",
    "Explain the key ideas simply",
  ];
  const sourceCount = connectedSources(brain).length;
  return (
    <div className="study-centre-chat clyra-chat-page relative flex min-h-0 flex-1 flex-col bg-[color:var(--clyra-canvas)]">
      <div className="relative mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden px-5 pt-8 sm:px-8 sm:pt-10">
        {/* Use the primary Chat rail contract deliberately: the shared id is
            scoped to the active workspace and gives Study Chat the exact same
            width, gutter, scrollbar, and message geometry. */}
        <div className="clyra-visible-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-28" id="chat-container">
        {!brain.messages.length && !busy ? (
          <motion.div initial={false} className="mx-auto flex w-full max-w-[720px] flex-col px-5 sm:px-8">
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .26, ease: [0.16, 1, 0.3, 1] }} className="flex flex-col items-center pt-24 pb-4 text-center">
              <span className="clyra-chat-welcome__identity mb-5 flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-[11px] bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]"><ShiningBrainIcon className="h-4 w-4" /></span><span className="text-[15px] font-semibold text-[color:var(--clyra-text-secondary)]">Clyra</span></span>
              <h1 className="text-[40px] font-semibold tracking-[-.04em] text-[color:var(--clyra-text)] sm:text-[48px]">Good evening, <span className="text-[color:var(--clyra-accent)]">Luke</span></h1>
              <p className="mt-2 text-[17px] text-[color:var(--clyra-text-secondary)]">What would you like to understand today?</p>
              <p className="mt-3 text-[11.5px] text-[color:var(--clyra-text-tertiary)]">Grounded in {sourceCount ? `${sourceCount} connected ${sourceCount === 1 ? "source" : "sources"}` : "the resources you add"}.</p>
              <div className="study-chat-source-strip mt-6" aria-label="Available source types"><GoogleProductIcon product="drive" className="h-4 w-4" /><GoogleProductIcon product="docs" className="h-4 w-4" /><YouTubeBrandIcon className="h-4 w-4" /><Globe className="h-4 w-4 text-[color:var(--clyra-accent)]" strokeWidth={1.7} /><span>Use a source from your canvas</span></div>
            </motion.div>
            <div className="mx-auto mt-6 w-full max-w-[540px] text-left">
              <p className="mb-1 px-3 text-[10.5px] font-medium uppercase tracking-[.08em] text-[color:var(--clyra-text-tertiary)]">Try asking</p>
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => onComposerChange(suggestion)} className="study-chat-suggestion flex h-10 w-full items-center justify-between rounded-[8px] px-3 text-[13px] text-[color:var(--clyra-text-secondary)]">
                  {suggestion}<ChevronRight className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </motion.div>
        ) : (
          <div className="mx-auto max-w-[760px] space-y-6 pb-7">
            {brain.messages.map((message) => {
              const isLatestAssistant = message.role === "assistant" && [...brain.messages].reverse().find((item) => item.role === "assistant")?.id === message.id;
              const isTyping = message.id === typingMessageId;
              return (
              <motion.div initial={message.role === "user" ? false : { opacity: 0, y: 0, scale: .994 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "tween", duration: message.role === "user" ? .88 : .52, ease: [0.16, 1, 0.3, 1] }} key={message.id} className={cn("flex w-full", message.role === "user" ? "clyra-user-message-entry justify-end" : "justify-start")}>
                {message.role === "assistant" ? <ShiningBrainIcon className="mr-3 mt-1 h-4 w-4 shrink-0" /> : null}
                <div className={cn("text-[15px] leading-relaxed sm:text-[16px]", message.role === "user" ? "clyra-chat-user-bubble rounded-[24px] border border-slate-200/70 bg-[color:var(--clyra-selected)] px-5 py-3.5 text-slate-800 max-w-[85%] sm:max-w-[75%] whitespace-pre-wrap" : cn("clyra-assistant-message max-w-[92%] px-1 py-1 text-[color:var(--clyra-text)]", isLatestAssistant && "clyra-assistant-message--latest"))}>
                  {message.role === "assistant" ? <StudyTypingAnswer content={message.content} active={isTyping} onComplete={() => onTypingComplete(message.id)} /> : <span className="clyra-chat-user-text">{message.content}</span>}
                  {message.role === "assistant" && !isTyping ? <div className="clyra-message-actions" aria-label="Assistant message actions">
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(message.content); setCopiedMessageId(message.id); window.setTimeout(() => setCopiedMessageId((value) => value === message.id ? null : value), 1800); }} aria-label="Copy response" title="Copy response">{copiedMessageId === message.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</button>
                    <button type="button" onClick={() => onRegenerate(message.id)} aria-label="Regenerate response" title="Regenerate response"><RotateCcw className="h-3.5 w-3.5" /></button>
                    <button type="button" className={cn(feedback?.messageId === message.id && feedback.sentiment === "up" && "is-active")} onClick={() => setFeedback({ messageId: message.id, sentiment: "up" })} aria-label="Helpful response" title="Helpful"><ThumbsUp className="h-3.5 w-3.5" /></button>
                    <button type="button" className={cn(feedback?.messageId === message.id && feedback.sentiment === "down" && "is-active")} onClick={() => setFeedback({ messageId: message.id, sentiment: "down" })} aria-label="Needs improvement" title="Needs improvement"><ThumbsDown className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => { if ("speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(message.content)); } }} aria-label="Read response aloud" title="Read aloud"><Volume2 className="h-3.5 w-3.5" /></button>
                    {message.citations?.length ? <><span className="clyra-message-actions__divider" aria-hidden /><button type="button" onClick={() => onCitation(message.citations![0])} aria-label="Open answer sources" title="Open sources"><Link2 className="h-3.5 w-3.5" /></button></> : null}
                    {message.citations?.length ? <StudySourceFaviconChips brain={brain} citations={message.citations} onOpen={onCitation} /> : null}
                  </div> : null}
                </div>
              </motion.div>
              );
            })}
            {busy ? <div className="flex items-center gap-2 text-[12px] text-[color:var(--clyra-text-secondary)]"><ShiningText text="Thinking" play className="font-medium" /><ThinkingDots /></div> : null}
          </div>
        )}
        </div>
      </div>
      <ChatComposerShell mode="thread" className="study-chat-clyra-composer clyra-composer-transition">
        <div className="relative mx-auto w-[min(760px,calc(100%-32px))]">
          <AnimatePresence initial={false}>
            {toolMenuOpen ? (
              <motion.div initial={{ opacity: 0, y: 8, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 5, scale: .99 }} transition={{ type: "tween", duration: .24, ease: [0.16, 1, 0.3, 1] }} className="clyra-command-palette absolute bottom-[calc(100%+16px)] -left-2 -right-2 z-50 max-h-[min(278px,42vh)] overflow-y-auto origin-bottom">
                <div className="py-2.5">
                  <div className="clyra-command-palette__header flex items-center justify-between px-4 pb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-slate-400"><span>Commands</span><span className="normal-case tracking-normal">Choose a focused action</span></div>
                {[
                  { label: "Web search", detail: "Search trusted sources", icon: <Globe />, prompt: "/search " },
                  { label: "Analyse YouTube", detail: "Use the transcript engine", icon: <YouTubeBrandIcon />, prompt: "/youtube " },
                  { label: "Google Drive", detail: "Read-only study context", icon: <GoogleProductIcon product="drive" />, prompt: "Search my Google Drive for " },
                  { label: "Google Docs", detail: "Read-only study context", icon: <GoogleProductIcon product="docs" />, prompt: "Search my Google Docs for " },
                  { label: "Google Sheets", detail: "Read-only study context", icon: <GoogleProductIcon product="sheets" />, prompt: "Search my Google Sheets for " },
                  { label: "Google Slides", detail: "Read-only study context", icon: <GoogleProductIcon product="slides" />, prompt: "Search my Google Slides for " },
                  { label: "Gmail", detail: "Read-only study context", icon: <GoogleProductIcon product="gmail" />, prompt: "Check my Gmail for " },
                  { label: "Google Calendar", detail: "Read-only study context", icon: <GoogleProductIcon product="calendar" />, prompt: "Check my Google Calendar for " },
                ].map((item) => <motion.button key={item.label} type="button" onClick={() => { onComposerChange(item.prompt); setToolMenuOpen(false); requestAnimationFrame(() => { setInputExpanded(true); textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(item.prompt.length, item.prompt.length); }); }} className="clyra-command-option flex w-full items-center gap-3 border-0 bg-transparent text-left text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-slate-50/50 text-slate-500">{item.icon}</span><span className="min-w-0 flex-1"><strong className="block truncate text-[12px] font-medium">{item.label}</strong><small className="block truncate text-[11px] text-slate-400">{item.detail}</small></span></motion.button>)}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {brain.messages.length ? <motion.div initial={{ opacity: 0, y: 10, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: 8, filter: "blur(3px)" }} transition={{ duration: .56, ease: [0.16, 1, 0.3, 1] }} className="clyra-composer-tools study-chat-tools"><button type="button" onClick={() => onComposerChange("/search ")}><Globe className="h-4 w-4" /> Web search</button><button type="button" onClick={() => onComposerChange("/youtube ")}><YouTubeBrandIcon className="h-4 w-4" /> YouTube</button></motion.div> : null}
          </AnimatePresence>
          <motion.form layout="position" className={cn("study-chat-composer input-wrapper relative mx-auto z-[3] cursor-text overflow-visible border border-slate-200/60 bg-white/80 backdrop-blur-xl transition-[background-color,border-color,padding,box-shadow,border-radius] duration-[560ms] ease-[cubic-bezier(0.16,1,0.3,1)]", inputExpanded && "clyra-composer-expanded", inputExpanded ? "rounded-[25px] p-2 sm:p-3" : "rounded-[25px] p-1.5 sm:p-2")} transition={{ layout: { duration: .56, ease: [0.16, 1, 0.3, 1] } }} onSubmit={(event) => { event.preventDefault(); setToolMenuOpen(false); onSubmit(); }}>
            <motion.div className="relative z-10 h-full w-full" initial={false}><div className="flex items-end gap-1.5">
            {!inputExpanded ? <motion.button type="button" onClick={onAttach} whileHover={{ scale: 1.05 }} whileTap={{ scale: .95 }} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800" aria-label="Attach files" title="Attach files"><Paperclip className="h-4 w-4" strokeWidth={1.65} /></motion.button> : null}
            <textarea ref={textareaRef} value={composer} rows={1} placeholder="Ask Clyra about this study space…" onFocus={() => setInputExpanded(true)} onBlur={() => window.setTimeout(() => setInputExpanded(brain.messages.length > 0 || Boolean(composer.trim())), 100)} onChange={(event) => { onComposerChange(event.target.value); setInputExpanded(Boolean(event.target.value)); }} onKeyDown={(event) => { if (toolMenuOpen && event.key === "Escape") { event.preventDefault(); setToolMenuOpen(false); return; } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (composer.trim() && !busy) event.currentTarget.form?.requestSubmit(); } }} className={cn("flex-1 resize-none overflow-y-auto bg-transparent px-1 outline-none placeholder:text-slate-400 clyra-visible-scrollbar transition-[height,min-height,max-height,padding,opacity,transform] duration-[560ms] ease-[cubic-bezier(0.16,1,0.3,1)]", inputExpanded ? "min-h-[46px] max-h-[160px] py-2.5 text-[15px] leading-relaxed sm:text-lg" : "min-h-[42px] max-h-[160px] py-2 text-[15px] leading-relaxed sm:text-lg")} />
            {!inputExpanded && !composer.trim() ? <button type="button" onClick={() => { const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; if (!Recognition) return; const recognition = new Recognition(); recognition.onstart = () => setDictating(true); recognition.onend = () => setDictating(false); recognition.onresult = (event: any) => { const transcript = Array.from(event.results).map((result: any) => result[0]?.transcript || "").join(" ").trim(); onComposerChange(`${composer}${composer && transcript ? " " : ""}${transcript}`); setInputExpanded(Boolean(transcript || composer)); }; recognition.start(); }} className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full text-[color:var(--clyra-text-secondary)] transition-colors hover:bg-[color:var(--clyra-hover)]", dictating && "bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]")} aria-label="Dictate a prompt" title="Dictate a prompt"><Mic className="h-4 w-4" strokeWidth={1.65} /></button> : null}
            <button type="submit" disabled={busy || !composer.trim()} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#0052fb] text-white transition-all duration-200 hover:bg-[#0048e0] active:scale-[.95] disabled:bg-[color:var(--clyra-surface-muted)] disabled:text-[color:var(--clyra-text-tertiary)]" aria-label="Send question">↑</button>
            </div>
            <AnimatePresence initial={false}>{inputExpanded ? <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ height: { duration: .56, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: .44, ease: [0.16, 1, 0.3, 1] } }} className="clyra-composer-expanded-content overflow-hidden"><div className="flex items-center justify-between px-2 pb-1 pt-0"><div className="flex items-center gap-1"><motion.button type="button" onClick={onAttach} whileHover={{ scale: 1.05 }} whileTap={{ scale: .95 }} className="grid h-10 w-10 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800" aria-label="Attach files"><Paperclip className="h-[18px] w-[18px]" /></motion.button><motion.button type="button" onClick={() => { const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; if (!Recognition) return; const recognition = new Recognition(); recognition.onstart = () => setDictating(true); recognition.onend = () => setDictating(false); recognition.onresult = (event: any) => onComposerChange(`${composer}${composer ? " " : ""}${Array.from(event.results).map((result: any) => result[0]?.transcript || "").join(" ").trim()}`); recognition.start(); }} whileHover={{ scale: 1.05 }} whileTap={{ scale: .95 }} className={cn("grid h-10 w-10 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800", dictating && "bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]")} aria-label="Dictate a prompt"><Mic className="h-[18px] w-[18px]" /></motion.button></div><AnimatePresence mode="wait">{composer.trim() ? <motion.span key="send" initial={{ opacity: 0, x: 5 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 5 }} className="hidden text-[10px] font-medium text-slate-400 sm:inline">Enter to send</motion.span> : <motion.button key="commands" type="button" onClick={() => setToolMenuOpen(true)} initial={{ opacity: 0, x: 5 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 5 }} className="hidden items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] font-medium text-slate-400/80 transition-colors hover:bg-slate-100/80 hover:text-slate-600 sm:flex"><kbd className="rounded-sm border border-slate-200/50 bg-slate-100/50 px-1 py-[1.5px] font-sans text-slate-400">/</kbd> Commands</motion.button>}</AnimatePresence></div></motion.div> : null}</AnimatePresence>
            </motion.div>
          </motion.form>
        </div>
      </ChatComposerShell>
    </div>
  );
}

function StudyMaterialsWorkspace({
  brain,
  busy,
  onGenerate,
}: {
  brain: StudyBrain;
  busy: boolean;
  onGenerate: (action: BrainAction) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "quiz" | "flashcards" | "notes" | "plans">("all");
  const generators: Array<{ action: BrainAction; title: string; detail: string; icon: typeof BookOpen }> = [
    { action: "quiz", title: "Quiz", detail: "Test your understanding", icon: GraduationCap },
    { action: "flashcards", title: "Flashcards", detail: "Review key concepts", icon: BookOpen },
    { action: "guide", title: "Notes", detail: "Create structured notes", icon: NotebookPen },
    { action: "summary", title: "Summary", detail: "Condense your sources", icon: FileText },
    { action: "plan", title: "Revision plan", detail: "Build a study schedule", icon: Network },
  ];
  const hasMaterials = Boolean(brain.materials.quiz || brain.materials.flashcards || brain.materials.guide);
  const visibleGenerators = generators.filter((item) => (filter === "all" || (filter === "notes" ? item.action === "guide" : filter === "plans" ? item.action === "plan" : item.action === filter)) && `${item.title} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="study-materials-workspace min-h-0 flex-1 overflow-y-auto bg-[color:var(--clyra-canvas)] px-8 py-8">
      <div className="mx-auto max-w-[740px]">
        <div className="flex items-start justify-between gap-4"><div><h1 className="text-[21px] font-semibold tracking-[-0.03em]">Study materials</h1><p className="mt-1 text-[13px] text-[color:var(--clyra-text-secondary)]">Create and revisit learning tools from your connected sources.</p></div><span className="text-[11px] text-[color:var(--clyra-text-tertiary)]">{brain.sources.length} sources</span></div>
        <div className="mt-6 flex items-center gap-2"><label className="flex h-9 flex-1 items-center gap-2 rounded-[10px] border border-[color:var(--clyra-border)] bg-white px-3"><Search className="h-3.5 w-3.5 text-[color:var(--clyra-text-tertiary)]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search materials…" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]" /></label><div className="flex rounded-[9px] bg-[color:var(--clyra-surface-muted)] p-0.5">{(["all", "quiz", "flashcards", "notes", "plans"] as const).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={cn("h-7 rounded-[7px] px-2 text-[10.5px] font-medium capitalize", filter === item ? "bg-white text-[color:var(--clyra-text)] shadow-[0_1px_2px_rgba(0,0,0,.05)]" : "text-[color:var(--clyra-text-secondary)]")}>{item}</button>)}</div></div>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {visibleGenerators.map((item) => { const Icon = item.icon; return <button key={item.action} type="button" disabled={busy} onClick={() => onGenerate(item.action)} className="study-material-row flex min-h-[82px] items-center gap-3 rounded-[14px] border border-[color:var(--clyra-border)] bg-white px-3.5 text-left disabled:opacity-50"><span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[color:var(--clyra-surface-muted)]"><Icon className="h-4 w-4 text-[color:var(--clyra-text-secondary)]" strokeWidth={1.65} /></span><span className="min-w-0 flex-1"><strong className="block text-[13px] font-medium text-[color:var(--clyra-text)]">{item.title}</strong><span className="mt-0.5 block text-[11.5px] text-[color:var(--clyra-text-secondary)]">{item.detail}</span></span><Plus className="h-3.5 w-3.5 text-[color:var(--clyra-text-tertiary)]" /></button>; })}
        </div>
        {hasMaterials ? <div className="mt-7"><p className="text-[10px] font-medium uppercase tracking-[.08em] text-[color:var(--clyra-text-tertiary)]">Recent</p><div className="mt-2 space-y-1 text-[12.5px] text-[color:var(--clyra-text-secondary)]">{brain.materials.quiz ? <p>{brain.materials.quiz.topic} quiz · {brain.materials.quiz.questions.length} questions</p> : null}{brain.materials.flashcards ? <p>{brain.materials.flashcards.topic} flashcards · {brain.materials.flashcards.cards.length} cards</p> : null}{brain.materials.guide ? <p>{brain.materials.guide.title} · Updated just now</p> : null}</div></div> : null}
      </div>
    </div>
  );
}

export default function StudyBrainWorkspace({
  agentPrompt = "",
}: {
  globalTabsVisible?: boolean;
  agentPrompt?: string;
}) {
  const desktop = getElectronDesktop();
  const [store, setStore] = useState<StudyBrainStore>(() => loadStudyBrainStore());
  const [urlDraft, setUrlDraft] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [workspaceView, setWorkspaceView] = useState<"nodes" | "chat" | "materials">("nodes");
  const [typingAssistantId, setTypingAssistantId] = useState<string | null>(null);
  const [canvasTool, setCanvasTool] = useState<"select" | "connect">("select");
  const [canvasMenuOpen, setCanvasMenuOpen] = useState<"add" | "study" | "view" | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"nodes" | "source" | "chat" | "materials">("nodes");
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHint, setLinkHint] = useState("Paste a YouTube, website, or Google link");
  const [linkTitle, setLinkTitle] = useState("Add link");
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [welcomePrompt, setWelcomePrompt] = useState("");
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [welcomeMoreOpen, setWelcomeMoreOpen] = useState(false);
  const [welcomeResearchChoiceOpen, setWelcomeResearchChoiceOpen] = useState(false);
  const [welcomeResearching, setWelcomeResearching] = useState(false);
  const [welcomeResearchProgress, setWelcomeResearchProgress] = useState<WelcomeResearchProgress | null>(null);
  const [connectionDropMenu, setConnectionDropMenu] = useState<{ x: number; y: number } | null>(null);
  const [resourceSearch, setResourceSearch] = useState("");
  const [studySpaceSearch, setStudySpaceSearch] = useState("");
  const [dockPanel, setDockPanel] = useState<"none" | "spaces" | "study">("none");
  const [dockPanelTop, setDockPanelTop] = useState(120);
  const [undoStack, setUndoStack] = useState<StudyBrain[]>([]);
  const [redoStack, setRedoStack] = useState<StudyBrain[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const welcomeInputRef = useRef<HTMLInputElement>(null);
  const welcomeMoreRef = useRef<HTMLDivElement>(null);
  const canvasApiRef = useRef<StudyCanvasApi | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const seeded = useRef(false);

  const brain = useMemo(() => {
    const active = store.brains.find((item) => item.id === store.activeBrainId) || store.brains[0] || null;
    return active;
  }, [store]);

  const persist = useCallback((next: StudyBrainStore) => {
    setStore(next);
    saveStudyBrainStore(next);
  }, []);

  const storeRef = useRef(store);
  storeRef.current = store;
  const brainRef = useRef(brain);
  brainRef.current = brain;
  const undoRef = useRef<StudyBrain[]>([]);
  const redoRef = useRef<StudyBrain[]>([]);

  const recordHistory = useCallback((snapshot: StudyBrain) => {
    const next = [...undoRef.current, snapshot].slice(-30);
    undoRef.current = next;
    redoRef.current = [];
    setUndoStack(next);
    setRedoStack([]);
  }, []);

  const updateBrain = useCallback((nextBrain: StudyBrain, record = true) => {
    const latestStore = storeRef.current;
    const current = latestStore.brains.find((item) => item.id === nextBrain.id);
    if (record && current && current !== nextBrain) recordHistory(current);
    persist({ ...latestStore, brains: latestStore.brains.map((item) => item.id === nextBrain.id ? nextBrain : item), activeBrainId: nextBrain.id });
  }, [persist, recordHistory]);

  useEffect(() => {
    if (dockPanel === "none") return;
    const closeDockPanel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDockPanel("none");
    };
    window.addEventListener("keydown", closeDockPanel);
    return () => window.removeEventListener("keydown", closeDockPanel);
  }, [dockPanel]);

  const restoreHistory = useCallback((direction: "undo" | "redo") => {
    const source = direction === "undo" ? undoRef.current : redoRef.current;
    const current = brainRef.current;
    const target = source[source.length - 1];
    if (!current || !target) return;
    const remaining = source.slice(0, -1);
    const opposite = [...(direction === "undo" ? redoRef.current : undoRef.current), current].slice(-30);
    if (direction === "undo") { undoRef.current = remaining; redoRef.current = opposite; setUndoStack(remaining); setRedoStack(opposite); }
    else { redoRef.current = remaining; undoRef.current = opposite; setRedoStack(remaining); setUndoStack(opposite); }
    persist({ ...storeRef.current, brains: storeRef.current.brains.map((item) => item.id === target.id ? { ...target, updatedAt: Date.now() } : item), activeBrainId: target.id });
  }, [persist]);

  useEffect(() => {
    // Keep Chat/Vibe/Clip rail from overlapping the Study canvas.
    window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (!store.brains.length) {
      const created = emptyBrain(agentPrompt.trim() ? agentPrompt.trim().slice(0, 60) : "Biology");
      persist({ version: 4, brains: [created], activeBrainId: created.id });
    } else if (!store.activeBrainId && store.brains[0]) {
      persist({ ...store, activeBrainId: store.brains[0].id });
    }
  }, [agentPrompt, persist, store]);

  const ensureBrain = useCallback(() => {
    if (brain) return brain;
    const created = emptyBrain("New study space");
    persist({ version: 4, brains: [created, ...store.brains], activeBrainId: created.id });
    return created;
  }, [brain, persist, store.brains]);

  const addSource = useCallback(
    async (factory: () => Promise<StudySourceNode> | StudySourceNode, dropIndex = 0) => {
      const latestStore = storeRef.current;
      const current =
        latestStore.brains.find((item) => item.id === latestStore.activeBrainId) ||
        latestStore.brains[0] ||
        ensureBrain();
      setError(null);
      setBusy(true);
      setStatus(dropIndex > 0 ? `Uploading ${dropIndex + 1}…` : "Uploading…");
      try {
        setStatus("Reading document…");
        const source = await factory();
        if (hasDuplicateOrigin(current, source.origin)) {
          throw new Error("That source is already on this study space.");
        }
        setStatus("Processing…");
        const brainPos = current.positions.brain || { x: 420, y: 280 };
        const index = current.sources.length;
        const positioned: StudyBrain = {
          ...current,
          sources: [...current.sources, source],
          positions: {
            ...current.positions,
            [source.id]: positionAroundBrain(brainPos, index + dropIndex),
          },
          connections: [...current.connections, source.id],
          updatedAt: Date.now(),
        };
        positioned.sources = positioned.sources.map((item) =>
          item.id === source.id ? { ...item, connected: true, status: "ready", statusDetail: "Connected" } : item,
        );
        const nextStore: StudyBrainStore = {
          ...latestStore,
          brains: latestStore.brains.some((item) => item.id === positioned.id)
            ? latestStore.brains.map((item) => (item.id === positioned.id ? positioned : item))
            : [positioned, ...latestStore.brains],
          activeBrainId: positioned.id,
        };
        recordHistory(current);
        persist(nextStore);
        setSelectedSourceId(source.id);
        setInspectorTab("source");
        setStatus("Ready");
        return source;
      } catch (cause) {
        setError(cause instanceof Error ? softenStudyError(cause.message) : "Could not add source");
        setStatus(null);
        return null;
      } finally {
        setBusy(false);
        window.setTimeout(() => setStatus(null), 1200);
      }
    },
    [ensureBrain, persist, recordHistory],
  );

  const addBlankNote = useCallback(() => {
    // The active space is created in an effect on first mount. Resolve it
    // lazily here so the initial render never dereferences a transient null
    // active brain while the shell is switching from the launcher.
    const current = ensureBrain();
    const noteCount = current.sources.filter((source) => /^Blank note(?: \d+)?$/i.test(source.title)).length;
    const title = noteCount ? `Blank note ${noteCount + 1}` : "Blank note";
    return addSource(() => ingestPaste("Blank study note — replace with your own notes.", title));
  }, [addSource, ensureBrain]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.closest("input, textarea, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "v") setCanvasTool("select");
      if (event.key.toLowerCase() === "c") setCanvasTool("connect");
      if (event.key.toLowerCase() === "a") setAddOpen(true);
      if (event.key.toLowerCase() === "n") void addBlankNote();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        restoreHistory(event.shiftKey ? "redo" : "undo");
      }
      if (event.key === "Escape") { setCanvasTool("select"); setCanvasMenuOpen(null); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addBlankNote, restoreHistory]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      setAddOpen(false);
      for (let i = 0; i < list.length; i += 1) {
        const file = list[i];
        await addSource(() => ingestTextFile(file), i);
      }
    },
    [addSource],
  );

  useEffect(() => {
    if (!addOpen) { setResourceSearch(""); return; }
    const onPointer = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    // Defer so the opening click does not immediately dismiss the menu.
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onPointer);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [addOpen]);

  const openCitation = useCallback(
    (citation: string) => {
      if (!brain) return;
      const match = findSourceByCitation(brain, citation);
      if (match) {
        setSelectedSourceId(match.id);
        setInspectorOpen(true);
        setInspectorTab("source");
        const origin = match.origin.trim();
        if (/^https?:\/\//i.test(origin)) {
          window.open(origin, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (/^https?:\/\//i.test(citation.trim())) {
        window.open(citation.trim(), "_blank", "noopener,noreferrer");
      }
    },
    [brain],
  );

  const askBrain = useCallback(
    async (
      question: string,
      mode: "answer" | "summary" | "plan" | "explain" = "answer",
      regeneratingMessageId?: string,
    ) => {
      if (!brain) return;
      const clean = question.trim();
      if (!clean) return;
      setError(null);
      setBusy(true);
      setInspectorTab("chat");
      setWorkspaceView("chat");
      setStatus("Preparing grounded context…");
      const userMessage: StudyChatMessage = {
        id: uid(),
        role: "user",
        content: clean,
        at: Date.now(),
      };
      const prior = regeneratingMessageId
        ? brain.messages.slice(0, Math.max(0, brain.messages.findIndex((message) => message.id === regeneratingMessageId)))
        : brain.messages;
      // Regeneration retains the original user prompt immediately before the
      // response, rather than inserting an identical second message.
      const hasPromptAlready = prior.at(-1)?.role === "user" && prior.at(-1)?.content === clean;
      const pendingMessages = hasPromptAlready ? prior : [...prior, userMessage];
      try {
        let prepared = brain;
        const additions: StudySourceNode[] = [];
        const addPreparedSource = (source: StudySourceNode) => {
          if (!hasDuplicateOrigin(prepared, source.origin) && !additions.some((item) => item.origin === source.origin)) additions.push(source);
        };

        const directUrl = clean.match(/https?:\/\/[^\s)\]}>,]+/i)?.[0] || extractStudyYoutubeUrl(clean);
        if (directUrl && !hasDuplicateOrigin(prepared, directUrl)) {
          setStatus(/youtu\.be|youtube\.com/i.test(directUrl) ? "Analysing YouTube transcript…" : "Reading linked source…");
          const imported = await ingestAnyUrl(directUrl, desktop?.google?.execute ? (payload) => desktop.google.execute(payload as any) : undefined);
          addPreparedSource({ ...imported, connected: true, status: imported.status === "error" ? "error" : "ready" });
        }

        const googleTool = detectStudyGoogleTool(clean);
        if (googleTool && !desktop?.google && !directUrl) {
          throw new Error("Google study context is available in the Clyra desktop app after you connect Google in Chat.");
        }
        if (googleTool && desktop?.google?.execute && !directUrl) {
          setStatus(`Reading Google ${googleTool}…`);
          // The generic Docs/Sheets/Slides tool workflow is allowed to create
          // output files. For Study Pal discovery we deliberately use the
          // existing Drive search operation instead, which only reads file
          // metadata. Direct file links still use ingestAnyUrl below and are
          // read through the normal linked-source pipeline.
          const google = ["docs", "sheets", "slides", "drive"].includes(googleTool)
            ? await desktop.google.execute({
                service: "drive",
                action: "search",
                args: { query: clean, limit: 10 },
              } as any)
            : await desktop.google.execute({
                tool: googleTool,
                prompt: `Read-only study context request. Do not create, modify, send, schedule, or delete anything. Return concise accessible text relevant to: ${clean}`,
              } as any);
          if (google.needsAuth) throw new Error("Connect Google in Clyra chat first, then retry this study request.");
          if (!google.ok) throw new Error(google.text || `Google ${googleTool} could not provide study context.`);
          const text = String(google.text || "").trim();
          if (text.length >= 24) {
            addPreparedSource(emptySource({
              kind: studyGoogleKind(googleTool),
              title: `Google ${googleTool} context`,
              origin: `Clyra Google ${googleTool}: ${clean.slice(0, 120)}`,
              body: text.slice(0, 120_000),
              connected: true,
              status: "ready",
              statusDetail: "Read via Clyra Google",
              meta: { tool: googleTool, mode: "read-only" },
            }));
          }
        }

        if (wantsStudyWebResearch(clean) && !directUrl) {
          setStatus("Searching the web for study sources…");
          const query = clean.replace(/^\/search\s*/i, "").trim();
          const response = await fetch("/api/research/web-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, maxResults: 4, fetchTop: 3 }),
          });
          const research = await response.json().catch(() => ({})) as { ok?: boolean; pages?: Array<{ url?: string; excerpt?: string; blocked?: boolean }> };
          if (!response.ok || !research.ok) throw new Error("Web search was unavailable. Try again in a moment.");
          for (const page of (research.pages || []).filter((item) => item.url && item.excerpt && !item.blocked).slice(0, 3)) {
            const url = String(page.url);
            let title = url;
            try { title = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep URL as the title */ }
            addPreparedSource(emptySource({ kind: "web", title, origin: url, body: String(page.excerpt).slice(0, 8_000), connected: true, status: "ready", statusDetail: "Found by Clyra web search", meta: { discovery: "web-search", query } }));
          }
        }

        if (additions.length) {
          const brainPos = prepared.positions.brain || { x: 420, y: 280 };
          const positions = { ...prepared.positions };
          Object.assign(positions, layoutSourcesAroundBrain(brainPos, additions.map((source) => source.id)));
          prepared = {
            ...prepared,
            sources: [...prepared.sources, ...additions],
            positions,
            connections: [...new Set([...prepared.connections, ...additions.map((source) => source.id)])],
            updatedAt: Date.now(),
          };
          setSelectedSourceId(additions[0]?.id || null);
        }

        const sources = connectedSources(prepared);
        if (!sources.length) throw new Error("Add a source, paste a URL, or ask Clyra to search the web before studying this topic.");
        updateBrain({ ...prepared, messages: pendingMessages, updatedAt: Date.now() });
        setStatus("Clyra is thinking…");
        const prompt =
          mode === "explain"
            ? `Teach me this using Socratic tutoring, then give a clear explanation:\n${clean}`
            : clean;
        const data = await postJson<{ answer: string; citations: string[] }>("/api/study/ask", {
          question: prompt,
          mode: mode === "explain" ? "answer" : mode,
          context: toAskContext(sources),
        });
        const assistant: StudyChatMessage = {
          id: uid(),
          role: "assistant",
          content: data.answer,
          citations: data.citations,
          at: Date.now(),
        };
        setTypingAssistantId(assistant.id);
        updateBrain({
          ...prepared,
          messages: [...pendingMessages, assistant],
          updatedAt: Date.now(),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Ask failed");
      } finally {
        setBusy(false);
        window.setTimeout(() => setStatus(null), 900);
      }
    },
    [brain, desktop?.google, updateBrain],
  );

  const generateMaterial = useCallback(
    async (action: BrainAction) => {
      if (!brain) return;
      const sources = connectedSources(brain);
      if (!sources.length) {
        setError("Connect sources before generating materials.");
        return;
      }
      setBusy(true);
      setError(null);
      setInspectorTab("materials");
      setWorkspaceView("materials");
      setStatus(
        action === "quiz"
          ? "Building quiz…"
          : action === "flashcards"
            ? "Building flashcards…"
            : "Building study guide…",
      );
      try {
        const context = toAskContext(sources);
        const topic = brain.title;
        if (action === "quiz") {
          const data = await postJson<{ topic: string; questions: any[] }>("/api/study/quiz", {
            topic,
            count: 6,
            context,
          });
          updateBrain({
            ...brain,
            materials: {
              ...brain.materials,
              quiz: { topic: data.topic, questions: data.questions },
            },
            updatedAt: Date.now(),
          });
        } else if (action === "flashcards") {
          const data = await postJson<{ topic: string; cards: any[] }>("/api/study/flashcards", {
            topic,
            count: 10,
            context,
          });
          updateBrain({
            ...brain,
            materials: {
              ...brain.materials,
              flashcards: {
                topic: data.topic,
                cards: data.cards.map((card: any, index: number) => ({
                  id: `c${index + 1}`,
                  front: card.front,
                  back: card.back,
                  tag: card.tag || "",
                  confidence: 3,
                  dueAt: Date.now(),
                })),
              },
            },
            updatedAt: Date.now(),
          });
        } else {
          const data = await postJson<any>("/api/study/notes", { focus: topic, context });
          updateBrain({
            ...brain,
            materials: {
              ...brain.materials,
              guide: {
                title: data.title,
                sections: data.sections,
                summary: data.summary,
                questions: data.questions,
              },
            },
            updatedAt: Date.now(),
          });
        }
        setStatus("Ready");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Generation failed");
        setStatus(null);
      } finally {
        setBusy(false);
        window.setTimeout(() => setStatus(null), 1000);
      }
    },
    [brain, updateBrain],
  );

  const onBrainAction = useCallback(
    (action: BrainAction) => {
      if (action === "ask") {
        setInspectorOpen(true);
        setInspectorTab("nodes");
        setWorkspaceView("chat");
        return;
      }
      if (action === "summary" || action === "explain" || action === "plan") {
        void askBrain(
          action === "summary"
            ? "Summarise the connected sources for revision."
            : action === "plan"
              ? "Create a personalised revision plan from the connected sources."
              : "Teach me the most important ideas from the connected sources.",
          action === "explain" ? "explain" : action === "plan" ? "plan" : "summary",
        );
        return;
      }
      void generateMaterial(action === "notes" || action === "guide" ? "guide" : action);
    },
    [askBrain, generateMaterial],
  );

  const selectedSource = brain?.sources.find((source) => source.id === selectedSourceId) || null;
  // An empty named project is still a real project and should return to its
  // canvas hub. Only the deliberately unnamed new-space shell gets welcome.
  // Study Pal always opens on its new-project welcome surface. Existing study
  // spaces remain available from the dock and resume once the user chooses to
  // enter or create a workspace.
  const isNewStudy = Boolean(brain && !welcomeDismissed);
  const recentStudySpaces = useMemo(
    () => store.brains
      .filter((item) => item.id !== brain?.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3),
    [store.brains, brain?.id],
  );
  const welcomeIntent = useMemo(() => inferWelcomeIntent(welcomePrompt), [welcomePrompt]);
  const researchPhase = welcomeResearchProgress?.phase ?? 0;
  const researchPercent = [12, 38, 66, 88, 100][researchPhase] ?? 12;

  const beginStudy = useCallback(async (mode?: "manual" | "clyra") => {
    const topic = welcomePrompt.trim();
    if (!topic) return;
    const intent = inferWelcomeIntent(topic);
    if (intent.kind === "topic" && !mode) {
      setWelcomeResearchChoiceOpen(true);
      return;
    }
    const title = intent.kind === "topic" ? topic.slice(0, 80) : intent.kind === "note" ? "Study notes" : intent.kind === "youtube" ? "Video study" : intent.kind === "document" ? "Document study" : "Web study";
    const current = brain;
    if (!current) return;
    updateBrain({ ...current, title, updatedAt: Date.now() });
    setWelcomeResearchChoiceOpen(false);
    setAddOpen(false);
    if (mode === "clyra" && intent.kind === "topic") {
      setWelcomeResearching(true);
      setWelcomeResearchProgress({ phase: 0, topic, sources: [] });
      setBusy(true);
      setError(null);
      setStatus("Understanding your study topic…");
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        setWelcomeResearchProgress({ phase: 1, topic, sources: [] });
        setStatus("Searching trusted study sources…");
        const response = await fetch("/api/research/web-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `${topic} study guide`, maxResults: 5, fetchTop: 4 }),
        });
        const research = await response.json().catch(() => ({})) as { ok?: boolean; pages?: Array<{ url?: string; excerpt?: string; blocked?: boolean }>; urls?: string[]; error?: { message?: string } | string };
        if (!response.ok || !research.ok) throw new Error(typeof research.error === "string" ? research.error : research.error?.message || "Web research was unavailable");
        const pages = (research.pages || []).filter((page) => page.url && page.excerpt && !page.blocked).slice(0, 4);
        if (!pages.length) throw new Error("No readable research sources were found. Try a more specific topic.");
        const sourceHosts = pages.map((page) => {
          try { return new URL(String(page.url)).hostname.replace(/^www\./, ""); } catch { return "Study source"; }
        });
        setWelcomeResearchProgress({ phase: 2, topic, sources: sourceHosts });
        setStatus("Reading selected study materials…");
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        setWelcomeResearchProgress({ phase: 3, topic, sources: sourceHosts });
        setStatus("Building your connected canvas…");
        const refreshed = brainRef.current || current;
        const brainPos = refreshed.positions.brain || { x: 420, y: 280 };
        const researchedSources = pages.map((page, index) => {
          const url = String(page.url);
          let host = url;
          try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep URL */ }
          return emptySource({
            kind: "web",
            title: host,
            origin: url,
            body: String(page.excerpt).slice(0, 3_500),
            status: "ready",
            statusDetail: "Found by Clyra research",
            connected: true,
            enabled: true,
            meta: { discovery: "clyra-web-research", topic },
          });
        });
        const positions = { ...refreshed.positions };
        Object.assign(positions, layoutSourcesAroundBrain(brainPos, researchedSources.map((source) => source.id)));
        updateBrain({
          ...refreshed,
          title,
          sources: [...refreshed.sources, ...researchedSources],
          positions,
          connections: [...new Set([...refreshed.connections, ...researchedSources.map((source) => source.id)])],
          updatedAt: Date.now(),
        });
        setSelectedSourceId(researchedSources[0]?.id || null);
        setWorkspaceView("nodes");
        setInspectorTab("nodes");
        setWelcomePrompt("");
        setWelcomeResearchProgress({ phase: 4, topic, sources: sourceHosts });
        setStatus("Your study space is ready");
        await new Promise((resolve) => window.setTimeout(resolve, 360));
        setWelcomeDismissed(true);
      } catch (cause) {
        setError(cause instanceof Error ? softenStudyError(cause.message) : "Clyra research failed");
      } finally {
        setBusy(false);
        setWelcomeResearching(false);
        setWelcomeResearchProgress(null);
        window.setTimeout(() => setStatus(null), 1_200);
      }
      return;
    }
    setWelcomePrompt("");
    setWelcomeDismissed(true);
    setStatus(null);
    if (intent.url) {
      await addSource(() =>
        ingestAnyUrl(
          intent.url!,
          desktop?.google?.execute ? (payload) => desktop.google.execute(payload as any) : undefined,
        ),
      );
    } else if (intent.kind === "note") {
      await addSource(() => ingestPaste(topic, "Study note"));
    }
  }, [addSource, brain, desktop?.google, updateBrain, welcomePrompt]);

  useEffect(() => {
    if (!welcomeMoreOpen) return;
    const close = (event: MouseEvent) => {
      if (!welcomeMoreRef.current?.contains(event.target as Node)) setWelcomeMoreOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [welcomeMoreOpen]);

  useEffect(() => {
    if (!addOpen) setConnectionDropMenu(null);
  }, [addOpen]);

  const createStudySpace = useCallback(() => {
    const created = emptyBrain("New study space");
    persist({ version: 4, brains: [created, ...storeRef.current.brains], activeBrainId: created.id });
    setWorkspaceView("nodes");
    setInspectorTab("nodes");
    setWelcomeDismissed(false);
    setCanvasMenuOpen(null);
    setAddOpen(false);
  }, [persist]);

  if (!brain) {
    return (
      <div className="grid h-full place-items-center bg-[#fbfbfa] text-[13px] text-[#8b939e]">
        Preparing Study Brain…
      </div>
    );
  }

  return (
    <div className="study-brain-shell flex h-full min-h-0 bg-[color:var(--clyra-canvas)] text-[color:var(--clyra-text)]">
      {/* Legacy rail stays mounted only to preserve its existing action bindings. */}
      <aside className="hidden" aria-hidden="true">
        <div className="flex items-center gap-2.5 border-b border-[color:var(--clyra-border)] px-3.5 py-3.5">
          <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]">
            <GraduationCap className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-[-0.02em]">Study Pal</p>
            <p className="text-[11px] text-[color:var(--clyra-text-tertiary)]">Your study spaces</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            const created = emptyBrain("New study space");
            persist({
              version: 4,
              brains: [created, ...store.brains],
              activeBrainId: created.id,
            });
            setWorkspaceView("nodes");
            setInspectorTab("nodes");
            setWelcomeDismissed(false);
            setCanvasMenuOpen(null);
            setAddOpen(false);
          }}
          className="mx-3 mt-2 flex h-[34px] items-center justify-center gap-1.5 rounded-[8px] border border-transparent text-[12.5px] font-medium text-[color:var(--clyra-text)] transition-colors duration-150 hover:bg-[color:var(--clyra-hover)] active:scale-[0.985]"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> New study space
        </button>
        <div className="mt-3 px-3">
          <p className="px-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">Study spaces</p>
        </div>
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {store.brains.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => persist({ ...store, activeBrainId: item.id })}
              className={cn(
                "flex w-full items-center justify-between rounded-[8px] px-2.5 py-[7px] text-left text-[12.5px] transition-colors",
                item.id === brain.id
                  ? "bg-[color:var(--clyra-selected)] font-medium text-[color:var(--clyra-text)]"
                  : "text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]",
              )}
            >
              <span className="truncate">{item.title}</span>
              <span className="text-[10.5px] text-[color:var(--clyra-text-tertiary)]">{item.sources.length}</span>
            </button>
          ))}
          <div className="mx-1 my-3 border-t border-[color:var(--clyra-border)]" />
          <p className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">Workspace</p>
          <div className="space-y-0.5">
            <button type="button" onClick={() => { setInspectorTab("nodes"); setWorkspaceView("nodes"); }} className={cn("flex h-[33px] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[12.5px] transition-colors", workspaceView === "nodes" && inspectorTab !== "source" ? "bg-[color:var(--clyra-selected)] font-medium text-[color:var(--clyra-text)]" : "text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]")}><Network className="h-3.5 w-3.5" strokeWidth={1.7} /> Nodes</button>
            <button type="button" onClick={() => { setInspectorTab("chat"); setWorkspaceView("chat"); }} className={cn("flex h-[33px] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[12.5px] transition-colors", workspaceView === "chat" ? "bg-[color:var(--clyra-selected)] font-medium text-[color:var(--clyra-text)]" : "text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]")}><MessageCircle className="h-3.5 w-3.5" strokeWidth={1.7} /> Ask Clyra</button>
            <button type="button" onClick={() => { setInspectorTab("materials"); setWorkspaceView("materials"); }} className={cn("flex h-[33px] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[12.5px] transition-colors", workspaceView === "materials" ? "bg-[color:var(--clyra-selected)] font-medium text-[color:var(--clyra-text)]" : "text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]")}><BookOpen className="h-3.5 w-3.5" strokeWidth={1.7} /> Materials</button>
          </div>

          <div className="study-left-project-panel mt-4 border-t border-[color:var(--clyra-border)] pt-3">
            <div className="flex items-center justify-between px-2">
              <p className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">Project</p>
              <button type="button" onClick={() => setAddOpen(true)} className="text-[11px] font-medium text-[color:var(--clyra-accent)] hover:opacity-75">Add</button>
            </div>
            <button type="button" onClick={() => { setWorkspaceView("nodes"); canvasApiRef.current?.center(); }} className="mt-1 flex w-full items-center gap-2 rounded-[8px] px-2 py-2 text-left transition-colors hover:bg-[color:var(--clyra-hover)]" title="Focus project node">
              <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]"><GraduationCap className="h-3.5 w-3.5" strokeWidth={1.7} /></span>
              <span className="min-w-0"><span className="block truncate text-[12px] font-medium text-[color:var(--clyra-text)]">{brain.title}</span><span className="block text-[10.5px] text-[color:var(--clyra-text-tertiary)]">{brain.sources.length} connected</span></span>
            </button>
            {brain.sources.length ? <div className="mt-1 space-y-0.5">{brain.sources.slice(0, 4).map((source) => <button key={source.id} type="button" onClick={() => { setWorkspaceView("nodes"); setInspectorTab("source"); setSelectedSourceId(source.id); canvasApiRef.current?.focusNode(source.id); }} className={cn("flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--clyra-hover)]", selectedSourceId === source.id && "bg-[color:var(--clyra-accent-soft)]")}><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", source.status === "ready" ? "bg-emerald-500" : "bg-amber-400")} /><span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--clyra-text-secondary)]">{source.title}</span></button>)}</div> : <button type="button" onClick={() => setAddOpen(true)} className="mt-1 w-full rounded-[8px] px-2 py-2 text-left text-[11px] text-[color:var(--clyra-text-tertiary)] transition-colors hover:bg-[color:var(--clyra-hover)] hover:text-[color:var(--clyra-text-secondary)]">Add your first resource</button>}
            {selectedSource && inspectorTab === "source" ? <div className="mt-2 rounded-[9px] bg-[color:var(--clyra-surface-muted)] p-2"><p className="truncate text-[11px] font-medium text-[color:var(--clyra-text)]">{selectedSource.title}</p><p className="mt-1 line-clamp-3 text-[10.5px] leading-4 text-[color:var(--clyra-text-tertiary)]">{selectedSource.body || selectedSource.origin}</p><button type="button" onClick={() => { updateBrain({ ...brain, sources: brain.sources.filter((source) => source.id !== selectedSource.id), connections: brain.connections.filter((id) => id !== selectedSource.id), updatedAt: Date.now() }); setSelectedSourceId(null); }} className="mt-2 text-[10.5px] font-medium text-rose-600 hover:opacity-75">Remove source</button></div> : null}
          </div>
        </div>
      </aside>

      <StudyDock>
        <StudyDockGroup>
          <StudyDockItem label="Study Pal" icon={GraduationCap} active={false} accent onClick={() => { setWorkspaceView("nodes"); setInspectorTab("nodes"); setWelcomeDismissed(false); setDockPanel("none"); }} />
          <StudyDockItem label="New study space" icon={Plus} onClick={() => createStudySpace()} />
          <StudyDockSeparator />
          <StudyDockItem label="Study spaces" icon={FolderOpen} hasPopup expanded={dockPanel === "spaces"} active={dockPanel === "spaces"} onClick={(event) => { setDockPanelTop(event.currentTarget.getBoundingClientRect().top); setDockPanel((panel) => panel === "spaces" ? "none" : "spaces"); }} />
          <StudyDockItem label="Nodes" icon={Network} shortcut="⌘1" active={workspaceView === "nodes" && dockPanel === "none"} onClick={() => { setWelcomeDismissed(true); setWorkspaceView("nodes"); setInspectorTab("nodes"); setDockPanel("none"); }} />
          <StudyDockItem label="Ask Clyra" icon={MessageCircle} shortcut="⌘2" active={workspaceView === "chat"} onClick={() => { setWorkspaceView("chat"); setInspectorTab("chat"); setDockPanel("none"); }} />
          <StudyDockItem label="Materials" icon={BookOpen} shortcut="⌘3" active={workspaceView === "materials"} onClick={() => { setWorkspaceView("materials"); setInspectorTab("materials"); setDockPanel("none"); }} />
          <StudyDockSeparator />
          <StudyDockItem label={`${brain.title} · ${brain.sources.length} ${brain.sources.length === 1 ? "source" : "sources"}`} icon={GraduationCap} hasPopup expanded={dockPanel === "study"} active={dockPanel === "study"} onClick={(event) => { setDockPanelTop(event.currentTarget.getBoundingClientRect().top); setDockPanel((panel) => panel === "study" ? "none" : "study"); }} />
        </StudyDockGroup>
        <StudyDockSpacer />
        <StudyDockGroup>
          <StudyDockItem label="Search study spaces" icon={Search} onClick={(event) => { setDockPanelTop(event.currentTarget.getBoundingClientRect().top); setDockPanel("spaces"); }} />
        </StudyDockGroup>
      </StudyDock>

      <AnimatePresence initial={false}>
        {dockPanel === "spaces" ? (
          <motion.section
            initial={{ opacity: 0, x: -7, scale: .985 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -5, scale: .985 }}
            transition={{ duration: .16, ease: [0.16, 1, 0.3, 1] }}
            className="study-dock-popover fixed left-[86px] z-40 flex w-[286px] max-w-[calc(100vw-104px)] flex-col overflow-hidden rounded-[14px] border border-[color:var(--clyra-border)] bg-white/95 p-2 shadow-[0_16px_42px_rgba(15,23,42,.12)] backdrop-blur-xl"
            style={{ top: `min(calc(100vh - 420px), max(16px, ${dockPanelTop - 22}px))`, maxHeight: "min(400px, calc(100vh - 32px))" }}
            role="dialog" aria-label="Study spaces"
          >
            <div className="flex items-center justify-between px-1.5 py-1"><div><p className="text-[12px] font-semibold text-[color:var(--clyra-text)]">Study spaces</p><p className="text-[10.5px] text-[color:var(--clyra-text-tertiary)]">Switch or create a workspace</p></div><button type="button" onClick={() => createStudySpace()} className="grid h-7 w-7 place-items-center rounded-[8px] text-[color:var(--clyra-accent)] transition-colors hover:bg-[color:var(--clyra-accent-soft)]" aria-label="New study space"><Plus className="h-4 w-4" strokeWidth={1.75} /></button></div>
            <label className="mt-1 flex h-8 items-center gap-2 rounded-[9px] bg-[color:var(--clyra-surface-muted)] px-2.5"><Search className="h-3.5 w-3.5 text-[color:var(--clyra-text-tertiary)]" /><input autoFocus value={studySpaceSearch} onChange={(event) => setStudySpaceSearch(event.target.value)} placeholder="Search study spaces…" className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]" /></label>
            <p className="px-1.5 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[.08em] text-[color:var(--clyra-text-tertiary)]">Recent</p>
            <div className="min-h-0 flex-1 overflow-y-auto pb-1">{store.brains.filter((item) => item.title.toLowerCase().includes(studySpaceSearch.trim().toLowerCase())).map((item) => <button key={item.id} type="button" onClick={() => { persist({ ...store, activeBrainId: item.id }); setDockPanel("none"); setWorkspaceView("nodes"); setInspectorTab("nodes"); }} className={cn("flex min-h-10 w-full items-center gap-2 rounded-[9px] px-2 text-left transition-colors", item.id === brain.id ? "bg-[color:var(--clyra-selected)]" : "hover:bg-[color:var(--clyra-hover)]")}><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.id === brain.id ? "bg-[color:var(--clyra-accent)]" : "bg-[color:var(--clyra-text-tertiary)]/60")} /><span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] font-medium text-[color:var(--clyra-text)]">{item.title}</span><span className="block text-[10px] text-[color:var(--clyra-text-tertiary)]">{item.sources.length} {item.sources.length === 1 ? "source" : "sources"}</span></span></button>)}</div>
          </motion.section>
        ) : null}
        {dockPanel === "study" ? (
          <motion.section
            initial={{ opacity: 0, x: -7, scale: .985 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -5, scale: .985 }}
            transition={{ duration: .16, ease: [0.16, 1, 0.3, 1] }}
            className="study-dock-popover fixed left-[86px] z-40 flex w-[294px] max-w-[calc(100vw-104px)] flex-col overflow-hidden rounded-[14px] border border-[color:var(--clyra-border)] bg-white/95 p-2 shadow-[0_16px_42px_rgba(15,23,42,.12)] backdrop-blur-xl"
            style={{ top: `min(calc(100vh - 420px), max(16px, ${dockPanelTop - 22}px))`, maxHeight: "min(400px, calc(100vh - 32px))" }}
            role="dialog" aria-label="Current study space"
          >
            <div className="flex items-center gap-2 px-1.5 py-1.5"><span className="grid h-8 w-8 place-items-center rounded-[10px] bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]"><GraduationCap className="h-4 w-4" strokeWidth={1.7} /></span><span className="min-w-0"><strong className="block truncate text-[12px] text-[color:var(--clyra-text)]">{brain.title}</strong><span className="block text-[10.5px] text-[color:var(--clyra-text-tertiary)]">{brain.sources.length} source{brain.sources.length === 1 ? "" : "s"} connected</span></span></div>
            <div className="my-2 border-t border-[color:var(--clyra-border)]" />
            <p className="px-1.5 pb-1 text-[10px] font-medium uppercase tracking-[.08em] text-[color:var(--clyra-text-tertiary)]">Canvas</p>
            <div className="min-h-0 flex-1 overflow-y-auto">{brain.sources.length ? brain.sources.map((source) => <button key={source.id} type="button" onClick={() => { setWorkspaceView("nodes"); setInspectorTab("source"); setSelectedSourceId(source.id); setDockPanel("none"); canvasApiRef.current?.focusNode(source.id); }} className="flex min-h-10 w-full items-center gap-2 rounded-[9px] px-2 text-left transition-colors hover:bg-[color:var(--clyra-hover)]"><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", source.status === "ready" ? "bg-emerald-500" : "bg-amber-400")} /><span className="min-w-0 flex-1"><span className="block truncate text-[11.5px] font-medium text-[color:var(--clyra-text)]">{source.title}</span><span className="block text-[10px] text-[color:var(--clyra-text-tertiary)]">{source.kind}</span></span></button>) : <button type="button" onClick={() => { setDockPanel("none"); setAddOpen(true); }} className="w-full rounded-[9px] px-2 py-4 text-left text-[11px] text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]">Add your first resource</button>}</div>
            <div className="mt-2 border-t border-[color:var(--clyra-border)] pt-2"><button type="button" onClick={() => { setDockPanel("none"); setAddOpen(true); }} className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[11px] font-medium text-[color:var(--clyra-accent)] transition-colors hover:bg-[color:var(--clyra-accent-soft)]"><Plus className="h-3.5 w-3.5" /> Add to study space</button></div>
          </motion.section>
        ) : null}
      </AnimatePresence>

      {/* Canvas column */}
      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="study-brain-toolbar flex h-[50px] shrink-0 items-center justify-between border-b border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface)] px-4">
          <div className="min-w-0">
            {renaming ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => {
                  const next = titleDraft.trim() || brain.title;
                  updateBrain({ ...brain, title: next, updatedAt: Date.now() });
                  setRenaming(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(false);
                }}
                className="h-8 w-[220px] rounded-[8px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)] px-2 text-[14px] font-medium outline-none focus:border-black/[.18]"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={() => {
                  setTitleDraft(brain.title);
                  setRenaming(true);
                }}
                className="truncate text-[14px] font-medium tracking-[-0.015em] text-[color:var(--clyra-text)]"
                title="Double-click to rename"
              >
                {brain.title}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <div className="relative" ref={addMenuRef}>
              {addOpen && connectionDropMenu ? (
                <div className="study-resource-menu fixed z-50 w-[286px] overflow-y-auto rounded-[14px] border border-[color:var(--clyra-border)] bg-white py-2 shadow-[var(--clyra-shadow-popover)]" style={{ left: Math.min(window.innerWidth - 302, Math.max(12, connectionDropMenu.x)), top: Math.min(window.innerHeight - 420, Math.max(12, connectionDropMenu.y)) }}>
                  <div className="sticky top-0 z-10 bg-white px-2.5 pb-2">
                    <label className="flex h-[34px] items-center gap-2 rounded-[9px] bg-[color:var(--clyra-surface-muted)] px-2.5"><Search className="h-3.5 w-3.5 text-[color:var(--clyra-text-tertiary)]" /><input autoFocus value={resourceSearch} onChange={(event) => setResourceSearch(event.target.value)} placeholder="Search sources and nodes" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]" /></label>
                    <div className="mt-2 grid grid-cols-2 gap-1"><button type="button" onClick={() => { setAddOpen(false); fileRef.current?.click(); }} className="!min-h-[30px] justify-center !rounded-[8px] !bg-[color:var(--clyra-surface-muted)] !px-2 text-[11px] font-medium"><Upload className="h-3.5 w-3.5" />Upload file</button><button type="button" onClick={() => { setAddOpen(false); setLinkTitle("Add link"); setLinkHint("Paste a YouTube, website, or Google link"); setLinkOpen(true); }} className="!min-h-[30px] justify-center !rounded-[8px] !bg-[color:var(--clyra-surface-muted)] !px-2 text-[11px] font-medium"><LinkIcon className="h-3.5 w-3.5" />Paste link</button></div>
                  </div>
                  <p className="px-3 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[color:var(--clyra-text-tertiary)]">
                    Upload
                  </p>
                  {(
                    [
                      { label: "PDF or document", icon: FileText, run: () => fileRef.current?.click() },
                      { label: "Slides", icon: Presentation, run: () => fileRef.current?.click() },
                      { label: "Image", icon: ImageIcon, run: () => fileRef.current?.click() },
                      { label: "Audio", icon: Film, run: () => fileRef.current?.click() },
                    ] as const
                  ).filter((item) => item.label.toLowerCase().includes(resourceSearch.trim().toLowerCase())).map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        setAddOpen(false);
                        item.run();
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                    >
                      <span className="grid h-5 w-5 place-items-center text-[color:var(--clyra-text-secondary)]">
                        <item.icon className="h-[14px] w-[14px] text-[color:var(--clyra-text-secondary)]" strokeWidth={1.75} />
                      </span>
                      {item.label}
                    </button>
                  ))}
                  <div className="my-1.5 border-t border-[color:var(--clyra-border)]" />
                  <p className="px-3 pb-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[color:var(--clyra-text-tertiary)]">
                    Link
                  </p>
                  {(
                    [
                      {
                        id: "youtube",
                        label: "YouTube",
                        icon: <YouTubeBrandIcon className="h-4 w-4" />,
                        title: "Add YouTube video",
                        hint: "Paste a YouTube URL",
                      },
                      {
                        id: "web",
                        label: "Website",
                        icon: <Globe className="h-[15px] w-[15px] text-[color:var(--clyra-text-secondary)]" strokeWidth={1.75} />,
                        title: "Add website",
                        hint: "Paste a website URL",
                      },
                      {
                        id: "docs",
                        label: "Google Docs",
                        icon: <GoogleProductIcon product="docs" className="h-4 w-4" />,
                        title: "Add Google Doc",
                        hint: "Paste a docs.google.com link",
                      },
                      {
                        id: "sheets",
                        label: "Google Sheets",
                        icon: <GoogleProductIcon product="sheets" className="h-4 w-4" />,
                        title: "Add Google Sheet",
                        hint: "Paste a sheets.google.com link",
                      },
                      {
                        id: "slides",
                        label: "Google Slides",
                        icon: <GoogleProductIcon product="slides" className="h-4 w-4" />,
                        title: "Add Google Slides",
                        hint: "Paste a slides.google.com link",
                      },
                      {
                        id: "drive",
                        label: "Google Drive",
                        icon: <GoogleProductIcon product="drive" className="h-4 w-4" />,
                        title: "Add Google Drive file",
                        hint: "Paste a drive.google.com link",
                      },
                    ] as Array<{ id: string; label: string; icon: ReactNode; title: string; hint: string }>
                  ).filter((item) => item.label.toLowerCase().includes(resourceSearch.trim().toLowerCase())).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setAddOpen(false);
                        setLinkTitle(item.title);
                        setLinkHint(item.hint);
                        setLinkOpen(true);
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                    >
                      <span className="grid h-5 w-5 place-items-center">
                        {item.icon}
                      </span>
                      {item.label}
                    </button>
                  ))}
                  <div className="my-1.5 border-t border-[color:var(--clyra-border)]" />
                  <p className="px-3 pb-1 text-[10.5px] font-medium uppercase tracking-[0.07em] text-[color:var(--clyra-text-tertiary)]">
                    Create
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setAddOpen(false);
                      setPasteOpen(true);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                  >
                    <span className="grid h-5 w-5 place-items-center text-[color:var(--clyra-text-secondary)]">
                      <NotebookPen className="h-[14px] w-[14px] text-[color:var(--clyra-text-secondary)]" strokeWidth={1.75} />
                    </span>
                    Paste text
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddOpen(false);
                      void addBlankNote();
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                  >
                    <span className="grid h-5 w-5 place-items-center text-[color:var(--clyra-text-secondary)]">
                      <FilePlus2 className="h-[14px] w-[14px] text-[color:var(--clyra-text-secondary)]" strokeWidth={1.75} />
                    </span>
                    Blank note
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {(status || error) && (
          <div className="pointer-events-none absolute left-4 top-[52px] z-20">
            <div
              className={cn(
                "rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-medium shadow-[0_6px_16px_rgba(15,23,42,0.06)]",
                error
                  ? "border-rose-200/80 bg-white text-rose-600"
                  : "border-[color:var(--clyra-border)] bg-white text-[color:var(--clyra-text-secondary)]",
              )}
            >
              {error || status}
            </div>
          </div>
        )}

        {workspaceView === "chat" ? (
          <StudyChatWorkspace
            brain={brain}
            busy={busy}
            composer={composer}
            onComposerChange={setComposer}
            onCitation={openCitation}
            onAttach={() => fileRef.current?.click()}
            typingMessageId={typingAssistantId}
            onTypingComplete={(messageId) => setTypingAssistantId((current) => current === messageId ? null : current)}
            onRegenerate={(messageId) => {
              const answerIndex = brain.messages.findIndex((message) => message.id === messageId);
              const prompt = answerIndex > 0
                ? [...brain.messages.slice(0, answerIndex)].reverse().find((message) => message.role === "user")?.content
                : null;
              if (!prompt || busy) return;
              setComposer("");
              void askBrain(prompt, "answer", messageId);
            }}
            onSubmit={() => {
              const value = composer.trim();
              if (!value) return;
              setComposer("");
              void askBrain(value);
            }}
          />
        ) : workspaceView === "materials" ? (
          <StudyMaterialsWorkspace brain={brain} busy={busy} onGenerate={onBrainAction} />
        ) : (
        <div
          className="relative min-h-0 flex-1"
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            const files = event.dataTransfer.files;
            if (files?.length) void addFiles(files);
            const uri = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
            if (uri && /^https?:\/\//i.test(uri.trim())) {
              void addSource(() =>
                ingestAnyUrl(
                  uri.trim(),
                  desktop?.google?.execute ? (payload) => desktop.google.execute(payload as any) : undefined,
                ),
              );
            }
          }}
        >
          {!isNewStudy ? (
            <BrainCanvas
              brain={brain}
              processing={busy}
              onBrainChange={(next, record = true) => updateBrain(next, record)}
              onAction={onBrainAction}
              onSelectSource={setSelectedSourceId}
              tool={canvasTool}
              onCanvasApi={(api) => { canvasApiRef.current = api; }}
              onConnectionDrop={setConnectionDropMenu}
            />
          ) : (
            <div className="absolute inset-0 bg-[color:var(--clyra-canvas)]" />
          )}
          {isNewStudy && !dragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 overflow-y-auto px-6">
              <div className="flex min-h-full justify-center pt-[clamp(112px,19vh,178px)] pb-12">
                <div className="study-welcome pointer-events-auto relative w-full max-w-[640px] text-center">
                  <span className="study-welcome-icon mx-auto grid h-9 w-9 place-items-center rounded-[10px] border border-[#dce9fb] bg-[#f0f6ff] text-[#0a6ff2]">
                    <GraduationCap className="h-[17px] w-[17px]" strokeWidth={1.65} />
                  </span>
                  <h1 className="mt-[18px] text-[27px] font-semibold tracking-[-0.04em] leading-[1.15] text-[color:var(--clyra-text)]">What are you studying?</h1>
                  <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-[1.5] text-[color:var(--clyra-text-secondary)]">
                    Enter a topic, question, or resource to begin.
                  </p>

                  <form
                    className="study-welcome-command mx-auto mt-[22px] flex h-[52px] w-full max-w-[620px] items-center gap-2 rounded-[14px] border border-black/[.08] bg-white p-1.5"
                    onSubmit={(event) => { event.preventDefault(); void beginStudy(); }}
                  >
                    <Search className="ml-2 h-4 w-4 shrink-0 text-[color:var(--clyra-text-tertiary)]" strokeWidth={1.7} />
                    <input
                      ref={welcomeInputRef}
                      autoFocus
                      value={welcomePrompt}
                      onChange={(event) => setWelcomePrompt(event.target.value)}
                      placeholder="Enter a topic, question, or class…"
                      className="min-w-0 flex-1 bg-transparent px-1 text-[13.5px] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]"
                    />
                    <button
                      type="submit"
                      disabled={!welcomePrompt.trim() || busy}
                      title={welcomePrompt.trim() ? welcomeIntent.action : "Start studying"}
                      aria-label={welcomePrompt.trim() ? welcomeIntent.action : "Start studying"}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[color:var(--clyra-accent)] text-white transition-all duration-150 hover:bg-[color:var(--clyra-accent-hover)] active:scale-[.96] disabled:bg-[color:var(--clyra-surface-muted)] disabled:text-[color:var(--clyra-text-tertiary)]"
                    >
                      <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                  </form>

                  <AnimatePresence initial={false}>
                    {welcomeResearchChoiceOpen ? (
                      <motion.div
                        initial={{ opacity: 0, height: 0, y: -4 }}
                        animate={{ opacity: 1, height: "auto", y: 0 }}
                        exit={{ opacity: 0, height: 0, y: -4 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="mx-auto mt-3 w-full max-w-[620px] overflow-hidden text-left"
                      >
                        <div className="study-research-choice rounded-[13px] border border-[color:var(--clyra-border)] bg-white p-1.5 shadow-[0_7px_22px_rgba(15,23,42,.055)]">
                          <p className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[.09em] text-[color:var(--clyra-text-tertiary)]">Choose how to begin</p>
                          <div className="grid grid-cols-2 gap-1">
                            <button type="button" onClick={() => void beginStudy("manual")} className="study-research-choice__option text-left"><span className="study-research-choice__icon"><NotebookPen strokeWidth={1.65} /></span><span><strong>Start manually</strong><small>Add the resources you already have.</small></span></button>
                            <button type="button" onClick={() => void beginStudy("clyra")} className="study-research-choice__option study-research-choice__option--ai text-left"><span className="study-research-choice__icon"><Sparkles strokeWidth={1.65} /></span><span><strong>Let Clyra research</strong><small>Find and connect useful study sources.</small></span></button>
                          </div>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  <section className="mt-[25px]">
                    <p className="text-[11.5px] font-medium text-[color:var(--clyra-text-secondary)]">Add a resource</p>
                    <div className="mt-2.5 flex items-start justify-center gap-1.5">
                      {[
                        { label: "Drive", icon: <GoogleProductIcon product="drive" className="h-5 w-5" />, run: () => { setLinkTitle("Add Google Drive file"); setLinkHint("Paste a drive.google.com link"); setLinkOpen(true); } },
                        { label: "Docs", icon: <GoogleProductIcon product="docs" className="h-5 w-5" />, run: () => { setLinkTitle("Add Google Doc"); setLinkHint("Paste a docs.google.com link"); setLinkOpen(true); } },
                        { label: "YouTube", icon: <YouTubeBrandIcon className="h-5 w-5" />, run: () => { setLinkTitle("Add YouTube video"); setLinkHint("Paste a YouTube URL"); setLinkOpen(true); } },
                        { label: "Website", icon: <Globe className="h-5 w-5 text-[#0a6ff2]" strokeWidth={1.65} />, run: () => { setLinkTitle("Add website"); setLinkHint("Paste a website URL"); setLinkOpen(true); } },
                      ].map((item) => (
                        <button key={item.label} type="button" onClick={item.run} className="study-welcome-shortcut grid h-[52px] w-[60px] place-items-center rounded-[10px] py-1.5 text-[11.5px] font-medium text-[color:var(--clyra-text-secondary)]">
                          <span className="grid h-5 place-items-center">{item.icon}</span><span>{item.label}</span>
                        </button>
                      ))}
                      <div ref={welcomeMoreRef} className="relative">
                        <button type="button" onClick={() => setWelcomeMoreOpen((open) => !open)} className={cn("study-welcome-shortcut grid h-[52px] w-[60px] place-items-center rounded-[10px] py-1.5 text-[11.5px] font-medium text-[color:var(--clyra-text-secondary)]", welcomeMoreOpen && "bg-[color:var(--clyra-hover)] text-[color:var(--clyra-text)]")} aria-expanded={welcomeMoreOpen}>
                          <span className="text-[20px] leading-none">•••</span><span>More</span>
                        </button>
                        <AnimatePresence>
                          {welcomeMoreOpen ? (
                            <motion.div initial={{ opacity: 0, y: -3, scale: .99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -2, scale: .99 }} transition={{ duration: .15, ease: [0.16, 1, 0.3, 1] }} className="study-welcome-more absolute left-[calc(100%+8px)] top-[-4px] z-30 w-[280px] overflow-y-auto rounded-[13px] border border-[color:var(--clyra-border)] bg-white p-1.5 text-left shadow-[0_14px_40px_rgba(15,23,42,.12)]">
                              <p>Upload</p>
                              <button type="button" onClick={() => { setWelcomeMoreOpen(false); fileRef.current?.click(); }}><FileText /> PDF or document</button>
                              <button type="button" onClick={() => { setWelcomeMoreOpen(false); fileRef.current?.click(); }}><Presentation /> Slides</button>
                              <button type="button" onClick={() => { setWelcomeMoreOpen(false); fileRef.current?.click(); }}><ImageIcon /> Image or audio</button>
                              <p>Google</p>
                              <button type="button" onClick={() => { setWelcomeMoreOpen(false); setLinkTitle("Add Google file"); setLinkHint("Paste a Google Sheets, Slides, or Drive link"); setLinkOpen(true); }}><GoogleProductIcon product="drive" /> Google file</button>
                              <p>Create</p>
                              <button type="button" onClick={() => { setWelcomeMoreOpen(false); setPasteOpen(true); }}><NotebookPen /> Paste text</button>
                              <button type="button" onClick={() => { setWelcomeMoreOpen(false); setWelcomeDismissed(true); void addBlankNote(); }}><FilePlus2 /> Blank note</button>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>
                      </div>
                    </div>
                  </section>

                  <section className="mt-[20px]">
                    <p className="text-[10px] font-medium uppercase tracking-[.08em] text-[color:var(--clyra-text-tertiary)]">Suggested</p>
                    <div className="mt-2 flex items-center justify-center gap-1 text-[12px] font-medium text-[color:var(--clyra-text-secondary)]">
                      {[
                        ["Exam revision", ClipboardCheck, "Help me revise for an exam"],
                        ["Learn a topic", Lightbulb, "Help me learn a topic"],
                        ["Create notes", NotebookPen, "Create study notes"],
                      ].map(([label, Icon, prompt], index) => {
                        const ItemIcon = Icon as typeof BookOpen;
                        return <span key={String(label)} className="flex items-center gap-1">{index ? <span className="mr-1 text-[color:var(--clyra-text-tertiary)]">·</span> : null}<button type="button" onClick={() => { setWelcomePrompt(String(prompt)); requestAnimationFrame(() => welcomeInputRef.current?.focus()); }} className="study-welcome-suggestion inline-flex items-center gap-1 rounded-[7px] px-1.5 py-1"><ItemIcon className="h-3.5 w-3.5" strokeWidth={1.6} />{String(label)}</button></span>;
                      })}
                    </div>
                  </section>

                  {recentStudySpaces.length ? (
                    <section className="study-welcome-projects mx-auto mt-[34px] w-full max-w-[540px] text-left" aria-label="Recent study projects">
                      <div className="flex items-center justify-between px-1.5">
                        <p className="text-[10px] font-medium uppercase tracking-[.08em] text-[color:var(--clyra-text-tertiary)]">Recent projects</p>
                        <span className="text-[10.5px] text-[color:var(--clyra-text-tertiary)]">Resume where you left off</span>
                      </div>
                      <div className="mt-2 space-y-1">
                        {recentStudySpaces.map((item, index) => (
                          <motion.button
                            key={item.id}
                            type="button"
                            initial={{ opacity: 0, y: 5 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: .18, delay: index * .035, ease: [0.16, 1, 0.3, 1] }}
                            onClick={() => { persist({ ...store, activeBrainId: item.id }); setWelcomeDismissed(true); }}
                            className="study-welcome-recent flex min-h-[54px] w-full items-center gap-3 rounded-[11px] px-2.5 text-left"
                          >
                            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[color:var(--clyra-surface-muted)] text-[color:var(--clyra-text-secondary)]"><BookOpen className="h-3.5 w-3.5" strokeWidth={1.65} /></span>
                            <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-[color:var(--clyra-text)]">{item.title}</span><span className="mt-0.5 block text-[11px] text-[color:var(--clyra-text-tertiary)]">{item.sources.length} {item.sources.length === 1 ? "source" : "sources"} · {studyProjectUpdatedLabel(item.updatedAt)}</span></span>
                            <ChevronRight className="study-welcome-recent-arrow h-3.5 w-3.5 shrink-0 text-[color:var(--clyra-text-tertiary)]" />
                          </motion.button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <AnimatePresence>
                    {welcomeResearching ? (
                      <motion.div initial={{ opacity: 0, scale: .99 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .995 }} transition={{ duration: .24, ease: [0.16, 1, 0.3, 1] }} className="absolute inset-[-16px] z-40 grid place-items-center rounded-[18px] bg-[#fcfcfd]/[.96] px-5 backdrop-blur-[2px]">
                        <section className="study-research-progress w-full max-w-[452px] text-left" aria-live="polite" aria-label="Building your study space">
                          <div className="flex items-start gap-3.5">
                            <span className="study-research-progress__identity grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[#eef5ff] text-[color:var(--clyra-accent)]"><motion.span animate={{ scale: researchPhase === 4 ? 1 : [1, 1.055, 1] }} transition={{ duration: 1.8, repeat: researchPhase === 4 ? 0 : Infinity, ease: "easeInOut" }}><ShiningBrainIcon className="h-[18px] w-[18px]" /></motion.span></span>
                            <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-semibold tracking-[-.018em]">Preparing {welcomeResearchProgress?.topic || brain.title}</p><p className="mt-1 text-[11.5px] leading-4 text-[color:var(--clyra-text-secondary)]">Finding clear, relevant material for this study space.</p></div>
                            <span className="pt-0.5 font-mono text-[10px] tabular-nums text-[color:var(--clyra-text-tertiary)]">{researchPercent}%</span>
                          </div>
                          <div className="study-research-progress__bar mt-4" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={researchPercent}><motion.span initial={false} animate={{ width: `${researchPercent}%` }} transition={{ type: "spring", stiffness: 150, damping: 24, mass: .5 }} /></div>
                          <div className="study-research-progress__source-kinds mt-3.5" aria-label="Research sources"><span><Globe className="h-3.5 w-3.5" strokeWidth={1.7} />Web sources</span><span><YouTubeBrandIcon className="h-3.5 w-3.5" />YouTube when relevant</span></div>
                          <div className="mt-4 space-y-0.5">
                            {[
                              { label: "Understanding your topic", detail: `Looking up ${welcomeResearchProgress?.topic || brain.title}`, icon: Lightbulb },
                              { label: "Searching trusted sources", detail: "Finding readable explanations and study guides", icon: Search },
                              { label: "Reading study materials", detail: welcomeResearchProgress?.sources.length ? `Reviewing ${welcomeResearchProgress.sources.join(" · ")}` : "Selecting the most useful source excerpts", icon: BookOpen },
                              { label: "Connecting your canvas", detail: "Adding sources as organised study nodes", icon: Network },
                            ].map((step, index) => {
                              const Icon = step.icon;
                              const complete = researchPhase > index || researchPhase === 4;
                              const active = researchPhase === index;
                              return <motion.div key={step.label} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .18, delay: index * .04 }} className="study-research-progress__step"><span className={cn("study-research-progress__mark", complete && "study-research-progress__mark--complete", active && "study-research-progress__mark--active")}>{complete ? <Check className="h-3 w-3" strokeWidth={2.2} /> : active ? <Icon className="h-3 w-3" strokeWidth={1.9} /> : <span />}</span><span className="min-w-0"><strong>{step.label}</strong><small>{step.detail}</small></span></motion.div>;
                            })}
                          </div>
                          {welcomeResearchProgress?.sources.length ? <div className="study-research-progress__found mt-4">{welcomeResearchProgress.sources.map((source) => <span key={source}><img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(source)}&sz=32`} alt="" />{source}</span>)}</div> : null}
                        </section>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          ) : null}
          {dragging ? (
            <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[color:var(--clyra-accent-soft)]/35">
              <div className="rounded-[10px] border border-[color:var(--clyra-border)] bg-white px-4 py-3 text-center shadow-[0_8px_24px_rgba(0,0,0,.07)]">
                <p className="text-[12.5px] font-semibold text-[color:var(--clyra-text)]">Drop to add to {brain.title}</p>
                <p className="mt-1 text-[11px] text-[color:var(--clyra-text-secondary)]">PDFs, notes, media, links and Google files</p>
              </div>
            </div>
          ) : null}
          <AnimatePresence>
            {connectionDropMenu && !addOpen && !isNewStudy ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.98, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 3 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                className="study-canvas-popover fixed z-50 w-[200px]"
                style={{ left: Math.min(window.innerWidth - 216, Math.max(12, connectionDropMenu.x)), top: Math.min(window.innerHeight - 244, Math.max(12, connectionDropMenu.y)) }}
              >
                <p className="study-canvas-popover-label">Add to this study space</p>
                <button type="button" onClick={() => setAddOpen(true)}><Plus /> Add a source</button>
                <button type="button" onClick={() => { setConnectionDropMenu(null); setLinkTitle("Add a link"); setLinkHint("Paste a website, YouTube, or Google link"); setLinkOpen(true); }}><LinkIcon /> Add a link</button>
                <button type="button" onClick={() => { setConnectionDropMenu(null); setPasteOpen(true); }}><FileText /> Paste text</button>
                <button type="button" onClick={() => { setConnectionDropMenu(null); void addBlankNote(); }}><NotebookPen /> Blank note</button>
              </motion.div>
            ) : null}
          </AnimatePresence>
          {!dragging && !isNewStudy ? (
            <div className="study-canvas-toolbar absolute bottom-5 left-1/2 z-20 flex h-11 -translate-x-1/2 items-center rounded-[16px] border border-[color:var(--clyra-border)] bg-white/90 p-1.5 shadow-[0_1px_2px_rgba(0,0,0,.05),0_8px_24px_rgba(0,0,0,.06)] backdrop-blur-sm">
              <div className="flex items-center gap-0.5">
                <button type="button" onClick={() => void addBlankNote()} className="study-canvas-tool" data-tooltip="Add note · N" aria-label="Add note"><NotebookPen className="h-4 w-4" strokeWidth={1.65} /></button>
                <button type="button" onClick={() => setCanvasTool("connect")} className={cn("study-canvas-tool", canvasTool === "connect" && "study-canvas-tool--active")} data-tooltip="Connect nodes · C" aria-label="Connect nodes"><LinkIcon className="h-4 w-4" strokeWidth={1.65} /></button>
              </div>
              <span className="study-canvas-divider" />
              <div className="relative">
                <button type="button" onClick={() => setCanvasMenuOpen(canvasMenuOpen === "study" ? null : "study")} className={cn("study-canvas-tool", canvasMenuOpen === "study" && "study-canvas-tool--active")} data-tooltip="Study tools" aria-label="Study tools"><Sparkles className="h-4 w-4" strokeWidth={1.65} /></button>
                {canvasMenuOpen === "study" ? <div className="study-canvas-popover absolute bottom-[calc(100%+8px)] left-1/2 w-[210px] -translate-x-1/2"><p className="study-canvas-popover-label">{selectedSource ? `Use ${selectedSource.title}` : brain.sources.length ? "Use connected sources" : "Study tools"}</p><button onClick={() => { setCanvasMenuOpen(null); onBrainAction("ask"); }}><MessageCircle /> Ask Clyra</button><button disabled={!brain.sources.length} onClick={() => { setCanvasMenuOpen(null); onBrainAction("summary"); }}><FileText /> Summarise</button><button disabled={!brain.sources.length} onClick={() => { setCanvasMenuOpen(null); onBrainAction("explain"); }}><Sparkles /> Explain simply</button><button disabled={!brain.sources.length} onClick={() => { setCanvasMenuOpen(null); onBrainAction("quiz"); }}><GraduationCap /> Generate quiz</button><button disabled={!brain.sources.length} onClick={() => { setCanvasMenuOpen(null); onBrainAction("flashcards"); }}><BookOpen /> Generate flashcards</button><button disabled={!brain.sources.length} onClick={() => { setCanvasMenuOpen(null); onBrainAction("guide"); }}><NotebookPen /> Generate notes</button></div> : null}
              </div>
              <span className="study-canvas-divider" />
              <div className="flex items-center gap-0.5">
                <button type="button" onClick={() => restoreHistory("undo")} disabled={!undoStack.length} className="study-canvas-tool disabled:cursor-not-allowed disabled:opacity-35" data-tooltip="Undo · ⌘Z" aria-label="Undo"><Undo2 className="h-4 w-4" strokeWidth={1.65} /></button>
                <button type="button" onClick={() => restoreHistory("redo")} disabled={!redoStack.length} className="study-canvas-tool disabled:cursor-not-allowed disabled:opacity-35" data-tooltip="Redo · ⇧⌘Z" aria-label="Redo"><Redo2 className="h-4 w-4" strokeWidth={1.65} /></button>
              </div>
              <span className="study-canvas-divider" />
              <div className="relative flex items-center">
                <button type="button" onClick={() => setCanvasMenuOpen(canvasMenuOpen === "view" ? null : "view")} className={cn("study-canvas-view", canvasMenuOpen === "view" && "study-canvas-tool--active")} data-tooltip="Canvas view" aria-label="Canvas view"><span>100%</span><ChevronDown className="h-2.5 w-2.5" /></button>
                <button type="button" onClick={() => canvasApiRef.current?.fitView()} className="study-canvas-tool" data-tooltip="Fit canvas · F" aria-label="Fit canvas"><Maximize2 className="h-4 w-4" strokeWidth={1.65} /></button>
                {canvasMenuOpen === "view" ? <div className="study-canvas-popover absolute bottom-[calc(100%+8px)] right-0 w-[170px]"><button onClick={() => canvasApiRef.current?.zoomIn()}><ZoomIn /> Zoom in</button><button onClick={() => canvasApiRef.current?.zoomOut()}><ZoomIn className="-scale-y-100" /> Zoom out</button><button onClick={() => canvasApiRef.current?.fitView()}><Maximize2 /> Zoom to fit</button><button onClick={() => canvasApiRef.current?.center()}><MousePointer2 /> Centre canvas</button></div> : null}
              </div>
            </div>
          ) : null}
        </div>
        )}
      </section>

      {/* The old inspector remains mounted in source for state compatibility,
          but Study Pal now presents its project context in the left rail. */}
      {false && inspectorOpen ? (
        <aside className="study-brain-inspector flex w-[320px] shrink-0 flex-col border-l border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface)]">
          <div className="border-b border-[color:var(--clyra-border)] px-3 py-3">
            <p className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">Study tools</p>
            <div className="flex items-center gap-1 rounded-[9px] bg-[color:var(--clyra-surface-muted)] p-1">
            {(["nodes", "chat", "source", "materials"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setInspectorTab(tab)}
                className={cn(
                  "h-7 flex-1 rounded-[7px] px-1.5 text-[10.5px] font-medium capitalize transition-colors duration-150",
                  inspectorTab === tab
                    ? "bg-white text-[color:var(--clyra-text)] shadow-[0_1px_2px_rgba(15,23,42,0.05)]"
                    : "text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]",
                )}
              >
                {tab === "source" ? "Sources" : tab}
              </button>
            ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {inspectorTab === "nodes" ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3 px-1 py-1">
                  <div>
                    <p className="text-[12.5px] font-semibold tracking-[-0.015em]">{brain.title}</p>
                    <p className="mt-0.5 text-[11px] text-[color:var(--clyra-text-tertiary)]">{brain.sources.length} {brain.sources.length === 1 ? "source" : "sources"} connected</p>
                  </div>
                  <span className="mt-1 h-[6px] w-[6px] rounded-full bg-[color:var(--clyra-accent)]" aria-label="Study space ready" />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between px-1">
                    <p className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">Canvas nodes</p>
                    <button type="button" onClick={() => setAddOpen(true)} className="text-[11px] font-medium text-[color:var(--clyra-accent)] hover:opacity-75">Add</button>
                  </div>
                  {brain.sources.length ? (
                    <div className="space-y-1">
                      {brain.sources.map((source) => (
                        <button
                          key={source.id}
                          type="button"
                          onClick={() => {
                            setSelectedSourceId(source.id);
                            setInspectorTab("source");
                            setWorkspaceView("nodes");
                            canvasApiRef.current?.focusNode(source.id);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-[8px] border border-transparent px-2.5 py-2 text-left transition-colors duration-150",
                            selectedSourceId === source.id
                              ? "bg-[color:var(--clyra-accent-soft)]"
                              : "border-transparent hover:bg-[color:var(--clyra-hover)]",
                          )}
                        >
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", source.status === "ready" ? "bg-emerald-500" : "bg-amber-400")} />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--clyra-text)]">{source.title}</span>
                          <span className="text-[10.5px] text-[color:var(--clyra-text-tertiary)]">{source.kind}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button type="button" onClick={() => setAddOpen(true)} className="w-full rounded-[8px] px-3 py-4 text-center text-[12px] text-[color:var(--clyra-text-secondary)] transition-colors duration-150 hover:bg-[color:var(--clyra-hover)] hover:text-[color:var(--clyra-text)]">
                      Add your first resource
                    </button>
                  )}
                </div>
              </div>
            ) : null}
            {inspectorTab === "chat" ? (
              <div className="flex min-h-full flex-col">
                {!brain.messages.length && !busy ? (
                  <div className="mx-auto flex min-h-[280px] w-full max-w-[280px] flex-1 flex-col items-center justify-center px-2 text-center">
                    <div className="mb-4 grid h-11 w-11 place-items-center rounded-[14px] border border-[color:var(--clyra-border)] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
                      <ShiningBrainIcon className="h-5 w-5" />
                    </div>
                    <p className="text-[15px] font-semibold tracking-[-0.03em] text-[color:var(--clyra-text)]">
                      Ask about your sources
                    </p>
                    <p className="mt-1.5 text-[12.5px] leading-5 text-[color:var(--clyra-text-tertiary)]">
                      {connectedSources(brain).length
                        ? `${connectedSources(brain).length} connected · ask a grounded question`
                        : "Connect a resource, then ask anything about it"}
                    </p>
                    <div className="mt-5 w-full space-y-1 text-left">
                      {[
                        "Summarise the connected sources",
                        "What should I revise first?",
                        "Explain the key ideas simply",
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => {
                            setComposer(prompt);
                            void askBrain(prompt);
                          }}
                          className="flex min-h-8 w-full items-center justify-between rounded-[7px] px-2.5 py-1.5 text-left text-[12px] font-medium text-[color:var(--clyra-text-secondary)] transition-colors duration-150 hover:bg-[color:var(--clyra-hover)] hover:text-[color:var(--clyra-text)]"
                        >
                          <span>{prompt}</span><span aria-hidden className="text-[13px] text-[color:var(--clyra-text-tertiary)]">→</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3.5 pb-2">
                    {brain.messages.map((message) => (
                      <div
                        key={message.id}
                        className={cn(
                          "flex",
                          message.role === "user" && "clyra-user-message-entry justify-end",
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[95%] text-[13px] leading-[1.55] tracking-[-0.01em]",
                            message.role === "user"
                              ? "rounded-[14px] bg-[color:var(--clyra-selected)] px-3.5 py-2.5 text-[color:var(--clyra-text)]"
                              : "pr-1 text-[color:var(--clyra-text)]",
                          )}
                        >
                          {message.role === "assistant" ? (
                            <MarkdownMessageContent content={message.content} />
                          ) : (
                            message.content
                          )}
                          {message.citations?.length ? (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              {message.citations.map((citation) => (
                                <button
                                  key={citation}
                                  type="button"
                                  onClick={() => openCitation(citation)}
                                  className="rounded-[8px] border border-[color:var(--clyra-border)] bg-white px-2 py-0.5 text-[10.5px] text-[color:var(--clyra-text-secondary)] transition-colors hover:border-[color:var(--clyra-accent)]/30 hover:text-[color:var(--clyra-accent)]"
                                  title="Open source"
                                >
                                  {citation}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {busy ? (
                      <div className="flex items-center gap-2 py-1">
                        <ShiningBrainIcon className="h-4 w-4" />
                        <ShiningText text="Thinking" play className="text-[12.5px] font-medium" />
                        <ThinkingDots />
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {inspectorTab === "source" ? (
              selectedSource ? (
                <div className="space-y-4">
                  <div className="rounded-[14px] border border-[color:var(--clyra-border)] bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                    <p className="text-[14px] font-semibold tracking-[-0.02em]">{selectedSource.title}</p>
                    <p className="mt-1 truncate text-[11.5px] text-[color:var(--clyra-text-tertiary)]">
                      {selectedSource.origin}
                    </p>
                    <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--clyra-surface-muted)] px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--clyra-text-secondary)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--clyra-accent)]" aria-hidden />
                      {selectedSource.statusDetail || selectedSource.status}
                    </p>
                  </div>
                  <div>
                    <p className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">
                      Preview
                    </p>
                    <pre className="max-h-[380px] overflow-auto whitespace-pre-wrap rounded-[14px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)] p-3.5 text-[11.5px] leading-5 text-[color:var(--clyra-text-secondary)]">
                      {selectedSource.body.slice(0, 6000)}
                    </pre>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      updateBrain({
                        ...brain,
                        sources: brain.sources.filter((source) => source.id !== selectedSource.id),
                        connections: brain.connections.filter((id) => id !== selectedSource.id),
                        updatedAt: Date.now(),
                      });
                      setSelectedSourceId(null);
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-[10px] border border-[color:var(--clyra-border)] px-3 text-[12px] text-rose-600 transition-colors hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove from canvas
                  </button>
                </div>
              ) : (
                <div className="mx-auto flex min-h-[240px] max-w-[240px] flex-col items-center justify-center text-center">
                  <p className="text-[14px] font-semibold tracking-[-0.02em] text-[color:var(--clyra-text)]">
                    Inspect a resource
                  </p>
                  <p className="mt-1.5 text-[12.5px] leading-5 text-[color:var(--clyra-text-tertiary)]">
                    Select a node on the canvas to preview its content.
                  </p>
                </div>
              )
            ) : null}

            {inspectorTab === "materials" ? (
              <div className="space-y-4">
                <div>
                  <p className="text-[14px] font-semibold tracking-[-0.02em] text-[color:var(--clyra-text)]">
                    Study materials
                  </p>
                  <p className="mt-1 text-[12px] leading-5 text-[color:var(--clyra-text-tertiary)]">
                    Generate from connected resources.
                  </p>
                </div>
                <div className="space-y-0.5">
                  {(
                    [
                      { id: "quiz" as const, label: "Quiz", run: () => void generateMaterial("quiz") },
                      { id: "flashcards" as const, label: "Flashcards", run: () => void generateMaterial("flashcards") },
                      { id: "guide" as const, label: "Notes", run: () => void generateMaterial("guide") },
                      {
                        id: "summary" as const,
                        label: "Summary",
                        run: () => void askBrain("Summarise the connected sources for revision.", "summary"),
                      },
                      {
                        id: "explain" as const,
                        label: "Teach me",
                        run: () =>
                          void askBrain("Teach me the most important ideas from the connected sources.", "explain"),
                      },
                      {
                        id: "plan" as const,
                        label: "Revision plan",
                        run: () =>
                          void askBrain("Create a personalised revision plan from the connected sources.", "plan"),
                      },
                    ] as const
                  ).map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={action.run}
                      className="flex h-9 w-full items-center rounded-[10px] px-2.5 text-left text-[12.5px] font-medium text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                {brain.materials.quiz ? (
                  <div className="space-y-2 rounded-[14px] border border-[color:var(--clyra-border)] bg-white p-3.5">
                    <p className="text-[12.5px] font-semibold">{brain.materials.quiz.topic}</p>
                    <p className="text-[11px] text-[color:var(--clyra-text-tertiary)]">
                      {brain.materials.quiz.questions.length} questions
                    </p>
                    <ol className="list-decimal space-y-2 pl-4 text-[12px] text-[color:var(--clyra-text-secondary)]">
                      {brain.materials.quiz.questions.slice(0, 4).map((q) => (
                        <li key={q.id}>{q.question}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                {brain.materials.flashcards ? (
                  <div className="space-y-2 border-t border-[color:var(--clyra-border)] pt-3">
                    <p className="text-[12.5px] font-medium">{brain.materials.flashcards.topic}</p>
                    <p className="text-[11px] text-[color:var(--clyra-text-tertiary)]">
                      {brain.materials.flashcards.cards.length} cards · rate confidence to schedule review
                    </p>
                    <div className="space-y-2">
                      {brain.materials.flashcards.cards.slice(0, 5).map((card) => (
                        <div key={card.id} className="rounded-[8px] bg-[color:var(--clyra-surface-muted)] px-2.5 py-2 text-[12px]">
                          <p className="font-medium text-[color:var(--clyra-text)]">{card.front}</p>
                          <p className="mt-1 text-[color:var(--clyra-text-secondary)]">{card.back}</p>
                          <div className="mt-2 flex items-center gap-1">
                            {[1, 2, 3, 4, 5].map((level) => (
                              <button
                                key={level}
                                type="button"
                                title={`Confidence ${level}`}
                                onClick={() => {
                                  const dueMs =
                                    level <= 2
                                      ? 1000 * 60 * 60 * 4
                                      : level === 3
                                        ? 1000 * 60 * 60 * 24
                                        : level === 4
                                          ? 1000 * 60 * 60 * 24 * 3
                                          : 1000 * 60 * 60 * 24 * 7;
                                  updateBrain({
                                    ...brain,
                                    materials: {
                                      ...brain.materials,
                                      flashcards: brain.materials.flashcards
                                        ? {
                                            ...brain.materials.flashcards,
                                            cards: brain.materials.flashcards.cards.map((item) =>
                                              item.id === card.id
                                                ? { ...item, confidence: level, dueAt: Date.now() + dueMs }
                                                : item,
                                            ),
                                          }
                                        : null,
                                    },
                                    updatedAt: Date.now(),
                                  });
                                }}
                                className={cn(
                                  "grid h-6 w-6 place-items-center rounded-[6px] border text-[10px] font-medium",
                                  (card.confidence || 0) === level
                                    ? "border-[color:var(--clyra-accent)]/35 bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]"
                                    : "border-[color:var(--clyra-border)] text-[color:var(--clyra-text-tertiary)] hover:bg-white",
                                )}
                              >
                                {level}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {brain.materials.guide ? (
                  <div className="space-y-2 border-t border-[color:var(--clyra-border)] pt-3">
                    <div className="flex items-center gap-1.5">
                      <BookOpen className="h-3.5 w-3.5 text-[color:var(--clyra-accent)]" />
                      <p className="text-[12.5px] font-medium">{brain.materials.guide.title}</p>
                    </div>
                    <p className="text-[12px] leading-5 text-[color:var(--clyra-text-secondary)]">{brain.materials.guide.summary}</p>
                  </div>
                ) : null}
                {!brain.materials.quiz && !brain.materials.flashcards && !brain.materials.guide ? (
                  <p className="text-[12.5px] text-[color:var(--clyra-text-tertiary)]">
                    Select the centre node or use the buttons above to generate notes, flashcards, or a quiz from connected resources.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </aside>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".txt,.md,.markdown,.pdf,.ppt,.pptx,.doc,.docx,text/plain,text/markdown,application/pdf,image/*,audio/*"
        className="hidden"
        onChange={(event) => {
          const files = event.target.files;
          event.target.value = "";
          if (!files?.length) return;
          setWelcomeDismissed(true);
          void addFiles(files);
        }}
      />

      {linkOpen ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[color:var(--clyra-text)]/15 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-[14px] border border-[color:var(--clyra-border)] bg-white p-4 shadow-[var(--clyra-shadow-popover)]">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-medium">{linkTitle}</p>
              <button
                type="button"
                onClick={() => {
                  setLinkOpen(false);
                  setLinkTitle("Add link");
                  setLinkHint("Paste a YouTube, website, or Google link");
                }}
                className="grid h-7 w-7 place-items-center rounded-[8px] hover:bg-[color:var(--clyra-hover)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = urlDraft.trim();
                if (!value) return;
                setLinkOpen(false);
                setWelcomeDismissed(true);
                void addSource(() =>
                  ingestAnyUrl(
                    value,
                    desktop?.google?.execute ? (payload) => desktop.google.execute(payload as any) : undefined,
                  ),
                );
                setUrlDraft("");
                setLinkTitle("Add link");
                setLinkHint("Paste a YouTube, website, or Google link");
              }}
            >
              <div className="flex h-9 flex-1 items-center gap-1.5 rounded-[8px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)] px-2.5">
                <Link2 className="h-3.5 w-3.5 text-[color:var(--clyra-text-tertiary)]" strokeWidth={1.75} />
                <input
                  autoFocus
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder={linkHint}
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !urlDraft.trim()}
                className="flex h-9 items-center rounded-[8px] bg-[color:var(--clyra-accent)] px-3 text-[12.5px] font-medium text-white disabled:bg-[color:var(--clyra-surface-muted)] disabled:text-[color:var(--clyra-text-tertiary)]"
              >
                Add
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {pasteOpen ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[color:var(--clyra-text)]/15 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-lg rounded-[14px] border border-[color:var(--clyra-border)] bg-white p-4 shadow-[var(--clyra-shadow-popover)]">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-medium">Paste notes</p>
              <button type="button" onClick={() => setPasteOpen(false)} className="grid h-7 w-7 place-items-center rounded-[8px] hover:bg-[color:var(--clyra-hover)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={8}
              placeholder="Paste lecture notes or extracted PDF text…"
              className="w-full resize-none rounded-[10px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)] px-3 py-2 text-[13px] outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setPasteOpen(false)} className="h-8 rounded-[8px] px-3 text-[12px] text-[color:var(--clyra-text-secondary)]">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    const source = ingestPaste(pasteText);
                    setPasteOpen(false);
                    setPasteText("");
                    setWelcomeDismissed(true);
                    void addSource(async () => source);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Paste failed");
                  }
                }}
                className="h-8 rounded-[8px] bg-[color:var(--clyra-accent)] px-3 text-[12px] font-medium text-white"
              >
                Add to canvas
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
