import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ExternalLink } from "lucide-react";
import { cn } from "../lib/utils";

export type GmailAttachment = { id: string; filename: string; mimeType: string; size?: number };
export type GmailEmail = {
  id: string;
  threadId: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  recipientNames: string[];
  subject: string;
  receivedAt: string;
  internalDate?: string;
  isUnread: boolean;
  isStarred: boolean;
  labels: string[];
  snippet: string;
  plainTextBody: string;
  attachments: GmailAttachment[];
  threadMessageCount: number;
};

export type GmailResultsPayload = { query: string; total: number; emails: GmailEmail[] };
export type WorkspaceResult = { kind: "docs" | "sheets" | "slides" | "drive" | "calendar" | "gmail"; title: string; subtitle: string; url: string };
export type GmailThread = { id: string; messages: GmailEmail[] };

const PRODUCT_ICON: Record<WorkspaceResult["kind"], string> = {
  gmail: "https://www.gstatic.com/images/branding/product/2x/gmail_48dp.png",
  calendar: "https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png",
  docs: "https://www.gstatic.com/images/branding/product/2x/docs_48dp.png",
  sheets: "https://www.gstatic.com/images/branding/product/2x/sheets_48dp.png",
  slides: "https://www.gstatic.com/images/branding/product/2x/slides_48dp.png",
  drive: "https://www.gstatic.com/images/branding/product/2x/drive_48dp.png",
};

type MaterialIconName =
  | "archive"
  | "attachment"
  | "auto_awesome"
  | "check"
  | "close"
  | "content_copy"
  | "delete"
  | "expand_less"
  | "expand_more"
  | "forum"
  | "mark_email_unread"
  | "more_vert"
  | "open_in_new"
  | "refresh"
  | "reply"
  | "schedule"
  | "send"
  | "star"
  | "star_border";

// These are the standard Material Symbols outlines rendered as inline SVGs.
// Keeping them here avoids loading a Google font or mixing icon families.
const MATERIAL_PATHS: Record<MaterialIconName, string> = {
  archive: "M20.54 5.23 19.15 3.55A1.99 1.99 0 0 0 17.61 3H6.39c-.59 0-1.15.26-1.54.71L3.46 5.23A1.99 1.99 0 0 0 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.46-.16-.91-.46-1.27ZM6.24 5h11.52l.81 1H5.43l.81-1ZM5 19V8h14v11H5Zm4-9v2h6v-2H9Z",
  attachment: "M16.5 6.5v9.79c0 2.07-1.68 3.75-3.75 3.75S9 18.36 9 16.29V5.5A2.5 2.5 0 0 1 14 5v10.79c0 .69-.56 1.25-1.25 1.25s-1.25-.56-1.25-1.25V6.5H10v9.29a2.75 2.75 0 0 0 5.5 0V5A4 4 0 0 0 7.5 5.5v10.79a5.25 5.25 0 0 0 10.5 0V6.5h-1.5Z",
  auto_awesome: "m19 9-1.25-2.75L15 5l2.75-1.25L19 1l1.25 2.75L23 5l-2.75 1.25L19 9Zm-7 4-2.5-5.5L4 5l5.5-2.5L12-3l2.5 5.5L20 5l-5.5 2.5L12 13Zm0 10-2.5-5.5L4 15l5.5-2.5L12 7l2.5 5.5L20 15l-5.5 2.5L12 23Z",
  check: "m9 16.17-3.88-3.88L3.71 13.7 9 18.99 20.29 7.7l-1.41-1.41z",
  close: "M18.3 5.71 16.89 4.3 12 9.17 7.11 4.3 5.7 5.71 10.59 10.6 5.7 15.49l1.41 1.41L12 12.01l4.89 4.89 1.41-1.41-4.89-4.89z",
  content_copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1Zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Zm0 16H8V7h11v14Z",
  delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12ZM8 9h8v10H8V9Zm7.5-5-1-1h-5l-1 1H5v2h14V4z",
  expand_less: "m7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  expand_more: "m7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  forum: "M20 2H4c-1.1 0-2 .9-2 2v15.59L5.59 16H20c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2ZM5 9h14v2H5V9Zm10 5H5v-2h10v2Zm4-6H5V6h14v2Z",
  mark_email_unread: "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 4-8 5-8-5V6l8 5 8-5v2Z",
  more_vert: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2Zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2Zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2Z",
  open_in_new: "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7ZM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Z",
  refresh: "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z",
  reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11Z",
  schedule: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7Z",
  send: "m2.01 21L23 12 2.01 3 2 10l15 2-15 2.01L2.01 21Z",
  star: "m12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z",
  star_border: "m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24ZM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4Z",
};

const GMAIL_MENU_ITEM_CLASS = "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-[#3c4043] transition hover:bg-[#f1f3f4]";

function MaterialIcon({ name, className, title }: { name: MaterialIconName; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("shrink-0 fill-current", className)} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={MATERIAL_PATHS[name]} />
    </svg>
  );
}

function ProductIcon({ kind, className = "h-6 w-6" }: { kind: WorkspaceResult["kind"]; className?: string }) {
  return <img src={PRODUCT_ICON[kind]} alt="" className={cn("object-contain", className)} />;
}

export function WorkspaceResultCard({ result }: { result: WorkspaceResult }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 7, filter: "blur(3px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
      className="mt-4 flex min-h-[92px] w-full max-w-[720px] items-center gap-3 rounded-[24px] border border-slate-200/80 bg-white px-4 py-3.5 shadow-[0_12px_32px_rgba(15,23,42,.055)]"
    >
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-[18px] bg-slate-50">
        <ProductIcon kind={result.kind} className="h-8 w-8" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold tracking-[-0.015em] text-slate-900" title={result.title}>{result.title}</span>
        <span className="mt-0.5 block text-[12px] font-medium text-slate-500">{result.subtitle}</span>
      </span>
      <a href={result.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 text-[12px] font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,.03)] transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400/50" aria-label={`Open ${result.title}`}>
        Open <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </motion.div>
  );
}

function initials(name: string) {
  const value = String(name || "?").trim();
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function formatDate(email: GmailEmail) {
  const date = email.internalDate ? new Date(Number(email.internalDate)) : new Date(email.receivedAt);
  if (Number.isNaN(date.getTime())) return email.receivedAt || "";
  return new Date().toDateString() === date.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function labelForResults(results: GmailResultsPayload) {
  const count = results.emails.length;
  if (!count) return "No matching emails";
  if (/is:unread/i.test(results.query)) return `${count} unread email${count === 1 ? "" : "s"}`;
  if (/newer_than:1d/i.test(results.query)) return `${count} email${count === 1 ? "" : "s"} from today`;
  if (results.total > count) return `${count} shown from ${results.total} results`;
  return `${count} matching email${count === 1 ? "" : "s"}`;
}

function cleanLabel(label: string) {
  return label
    .replace(/^CATEGORY_/i, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function labelTone(label: string) {
  const value = label.toLowerCase();
  if (/important|invoice|finance/.test(value)) return "bg-[#fce8e6] text-[#a50e0e]";
  if (/promotion|social/.test(value)) return "bg-[#fce8e6] text-[#a14200]";
  if (/update|work/.test(value)) return "bg-[#e8f0fe] text-[#0b57d0]";
  return "bg-[#e9eef6] text-[#5f6368]";
}

function cleanEmailPreview(value: string) {
  const lines = String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !/^>/.test(line) && !/^[*_\-]{5,}$/.test(line));
  const visible: string[] = [];
  for (const line of lines) {
    if (/^(unsubscribe|manage preferences|privacy policy|view in browser|this email and any attachments)/i.test(line)) break;
    if (/^(kind regards|warm regards|best regards|thanks,|thank you,|sent from my)/i.test(line) && visible.length > 2) break;
    visible.push(line);
  }
  return visible.join("\n\n") || String(value || "").replace(/\s+/g, " ").trim();
}

function formatBytes(value?: number) {
  if (!value || value < 1) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function GmailLabelChip({ label }: { label: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium leading-none", labelTone(label))}>{cleanLabel(label)}</span>;
}

function GmailRecipientDetails({ email }: { email: GmailEmail }) {
  const [open, setOpen] = useState(false);
  const recipient = email.recipientNames.length ? email.recipientNames.join(", ") : "me";
  return (
    <span className="relative mt-0.5 inline-flex">
      <button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex h-5 items-center gap-0.5 rounded px-0.5 text-left text-[12px] text-[#5f6368] transition hover:bg-[#f1f3f4] focus:outline-none focus:ring-2 focus:ring-[#0b57d0]/30" aria-expanded={open} aria-label={`Show delivery details for ${email.subject}`}>
        to me <MaterialIcon name={open ? "expand_less" : "expand_more"} className="h-3.5 w-3.5" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.dl initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.14 }} className="absolute left-0 top-[24px] z-30 w-[285px] rounded-xl border border-[#e3e7ec] bg-white px-3 py-2.5 text-[11px] leading-5 text-[#3c4043] shadow-[0_2px_8px_rgba(60,64,67,.14)]">
            <div className="grid grid-cols-[44px_1fr] gap-x-2"><dt className="text-[#80868b]">From</dt><dd className="truncate" title={email.senderEmail}>{email.senderEmail}</dd></div>
            <div className="grid grid-cols-[44px_1fr] gap-x-2"><dt className="text-[#80868b]">To</dt><dd className="truncate" title={recipient}>{recipient}</dd></div>
            <div className="grid grid-cols-[44px_1fr] gap-x-2"><dt className="text-[#80868b]">Date</dt><dd>{email.receivedAt || "Unknown date"}</dd></div>
            <div className="grid grid-cols-[44px_1fr] gap-x-2"><dt className="text-[#80868b]">Reply-to</dt><dd className="truncate" title={email.replyTo || email.senderEmail}>{email.replyTo || email.senderEmail}</dd></div>
          </motion.dl>
        ) : null}
      </AnimatePresence>
    </span>
  );
}

function EmailBodyPreview({ email, expanded, compact, single, onToggle }: { email: GmailEmail; expanded: boolean; compact: boolean; single: boolean; onToggle: () => void }) {
  const body = cleanEmailPreview(email.plainTextBody || email.snippet || "No readable text was included in this email.");
  const maximumLines = compact ? 5 : single ? 8 : 6;
  const needsClamp = body.length > (compact ? 430 : single ? 760 : 620) || body.split("\n").length > maximumLines + 2;
  return (
    <div className="gmail-message-preview mt-3 border-t border-[#e9edf1] pt-3">
      <div className="relative">
        <div
          className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.55] text-[#3c4043]"
          style={!expanded && needsClamp ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: maximumLines, overflow: "hidden" } : undefined}
        >
          {body}
        </div>
        {!expanded && needsClamp ? <span className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-b from-transparent to-[#f8fafd]" /> : null}
      </div>
      {needsClamp ? (
        <button type="button" onClick={onToggle} className="mt-2 inline-flex h-7 items-center gap-0.5 rounded px-0.5 text-[12px] font-medium text-[#0b57d0] transition hover:bg-[#eaf1fb] focus:outline-none focus:ring-2 focus:ring-[#0b57d0]/30">
          <MaterialIcon name={expanded ? "expand_less" : "expand_more"} className="h-4 w-4" /> {expanded ? "Collapse" : "Show full email"}
        </button>
      ) : null}
    </div>
  );
}

function AttachmentTiles({ attachments }: { attachments: GmailAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.slice(0, 4).map((attachment) => (
        <span key={`${attachment.id}-${attachment.filename}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[#e3e7ec] bg-[#f8fafd] px-2.5 py-1.5 text-[11px] text-[#3c4043]">
          <MaterialIcon name="attachment" className="h-3.5 w-3.5 text-[#5f6368]" />
          <span className="max-w-[138px] truncate font-medium">{attachment.filename}</span>
          {formatBytes(attachment.size) ? <span className="text-[#80868b]">{formatBytes(attachment.size)}</span> : null}
        </span>
      ))}
    </div>
  );
}

function ReplyComposer({ email, onGenerate, onSave, onSend, onCancel }: { email: GmailEmail; onGenerate: (email: GmailEmail) => Promise<string>; onSave: (email: GmailEmail, body: string) => Promise<void>; onSend: (email: GmailEmail, body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"draft" | "save" | "send" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invoke = async (mode: "draft" | "save" | "send") => {
    setBusy(mode);
    setNotice(null);
    try {
      if (mode === "draft") setBody(await onGenerate(email));
      if (mode === "save") { await onSave(email, body); setNotice("Draft saved to Gmail."); }
      if (mode === "send") { await onSend(email, body); setNotice("Reply sent."); }
    } catch {
      setNotice(mode === "send" ? "Clyra could not send this reply. Nothing was sent." : "Clyra could not save this draft.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="mt-3 overflow-hidden rounded-xl border border-[#e3e7ec] bg-white p-3">
      <div className="mb-2 flex items-start justify-between gap-3 text-[11px] leading-5 text-[#5f6368]">
        <span><b className="font-medium text-[#3c4043]">To</b> {email.replyTo || email.senderEmail}<br /><b className="font-medium text-[#3c4043]">Subject</b> Re: {email.subject.replace(/^\s*re:\s*/i, "")}</span>
        <button type="button" disabled={busy !== null} onClick={onCancel} className="grid h-7 w-7 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#f1f3f4]" aria-label="Close reply composer"><MaterialIcon name="close" className="h-4 w-4" /></button>
      </div>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write a reply…" className="min-h-[112px] w-full resize-y rounded-lg border border-[#e3e7ec] bg-white px-3 py-2.5 text-[13px] leading-5 text-[#3c4043] outline-none transition placeholder:text-[#80868b] focus:border-[#0b57d0] focus:ring-2 focus:ring-[#eaf1fb]" aria-label={`Reply to ${email.senderName}`} />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void invoke("draft")} className="inline-flex h-8 items-center gap-1.5 rounded-2xl bg-[#eaf1fb] px-3 text-[12px] font-medium text-[#0b57d0] transition hover:bg-[#dbe8fb] disabled:opacity-50"><MaterialIcon name="auto_awesome" className="h-3.5 w-3.5" /> Generate draft</button>
        <button type="button" disabled={!body.trim() || busy !== null} onClick={() => void invoke("save")} className="inline-flex h-8 items-center gap-1.5 rounded-2xl border border-[#dadce0] px-3 text-[12px] font-medium text-[#3c4043] transition hover:bg-[#f8fafd] disabled:opacity-50"><MaterialIcon name="content_copy" className="h-3.5 w-3.5" /> Save draft</button>
        <button type="button" disabled={!body.trim() || busy !== null} onClick={() => void invoke("send")} className="inline-flex h-8 items-center gap-1.5 rounded-2xl bg-[#0b57d0] px-3 text-[12px] font-medium text-white transition hover:bg-[#0842a0] disabled:opacity-50">{busy === "send" ? <MaterialIcon name="refresh" className="h-3.5 w-3.5 animate-spin" /> : <MaterialIcon name="send" className="h-3.5 w-3.5" />} Send reply</button>
      </div>
      {notice ? <p className={cn("mt-2 text-[11px]", /sent|saved/i.test(notice) ? "text-emerald-700" : "text-rose-600")}>{notice}</p> : null}
    </motion.div>
  );
}

function FollowUpPopover({ email, open, onClose, onSchedule, onCancel, scheduled, onScheduled }: { email: GmailEmail; open: boolean; onClose: () => void; onSchedule: (email: GmailEmail, when: string, note: string) => Promise<{ id:string; dueAt:string }>; onCancel: (id: string) => Promise<void>; scheduled: { id: string; label: string } | null; onScheduled: (value: { id: string; label: string } | null) => void }) {
  const [choice, setChoice] = useState("tomorrow");
  const [customWhen, setCustomWhen] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const schedule = async () => {
    setBusy(true);
    try {
      const result = await onSchedule(email, choice === "custom" ? customWhen : choice, note);
      const label = choice === "today" ? "later today" : choice === "three-days" ? "in three days" : choice === "next-week" ? "next week" : choice === "custom" ? "for the chosen time" : "tomorrow";
      onScheduled({ id: result.id, label });
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!scheduled) return;
    setBusy(true);
    try { await onCancel(scheduled.id); onScheduled(null); } finally { setBusy(false); }
  };
  return (
    <AnimatePresence>
      {open ? (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.14 }} className="absolute bottom-[38px] left-0 z-30 w-[252px] rounded-xl border border-[#e3e7ec] bg-white p-3 shadow-[0_2px_8px_rgba(60,64,67,.16)]">
          <div className="mb-2 flex items-center justify-between"><span className="text-[12px] font-medium text-[#1f1f1f]">Follow up</span><button type="button" onClick={onClose} className="grid h-6 w-6 place-items-center rounded-full text-[#5f6368] hover:bg-[#f1f3f4]" aria-label="Close follow-up"><MaterialIcon name="close" className="h-3.5 w-3.5" /></button></div>
          {scheduled ? <button type="button" disabled={busy} onClick={() => void cancel()} className="inline-flex h-8 items-center rounded-2xl border border-[#dadce0] px-3 text-[11px] font-medium text-[#3c4043] hover:bg-[#f8fafd]">Cancel follow-up</button> : <><select value={choice} onChange={(event) => setChoice(event.target.value)} className="h-8 w-full rounded-lg border border-[#dadce0] bg-white px-2 text-[11px] text-[#3c4043]"><option value="today">Later today</option><option value="tomorrow">Tomorrow</option><option value="three-days">In three days</option><option value="next-week">Next week</option><option value="custom">Custom date and time</option></select>{choice === "custom" ? <input type="datetime-local" value={customWhen} min={new Date().toISOString().slice(0, 16)} onChange={(event) => setCustomWhen(event.target.value)} className="mt-2 h-8 w-full rounded-lg border border-[#dadce0] px-2 text-[11px] outline-none focus:border-[#0b57d0]" aria-label="Custom follow-up time" /> : null}<input value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 h-8 w-full rounded-lg border border-[#dadce0] px-2 text-[11px] outline-none focus:border-[#0b57d0]" placeholder="Optional note" /><button type="button" disabled={busy || (choice === "custom" && !customWhen)} onClick={() => void schedule()} className="mt-2.5 inline-flex h-8 items-center rounded-2xl bg-[#0b57d0] px-3 text-[11px] font-medium text-white disabled:opacity-50">{busy ? "Scheduling…" : "Schedule"}</button></>}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

type EmailCardProps = {
  email: GmailEmail;
  compact: boolean;
  single: boolean;
  centeredAtMedium?: boolean;
  onSummarize: (email: GmailEmail) => Promise<string>;
  onGenerateReply: (email: GmailEmail) => Promise<string>;
  onSaveReply: (email: GmailEmail, body: string) => Promise<void>;
  onSendReply: (email: GmailEmail, body: string) => Promise<void>;
  onModify: (email: GmailEmail, change: "read" | "unread" | "star" | "unstar" | "archive" | "trash") => Promise<void>;
  onThread: (email: GmailEmail) => Promise<GmailThread>;
  onFollowUp: (email: GmailEmail, when: string, note: string) => Promise<{ id:string; dueAt:string }>;
  onCancelFollowUp: (id: string) => Promise<void>;
};

function EmailCard({ email, compact, single, centeredAtMedium, onSummarize, onGenerateReply, onSaveReply, onSendReply, onModify, onThread, onFollowUp, onCancelFollowUp }: EmailCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [reply, setReply] = useState(false);
  const [thread, setThread] = useState<GmailThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUp, setFollowUp] = useState<{ id: string; label: string } | null>(null);
  const [mutating, setMutating] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const modify = async (change: "read" | "unread" | "star" | "unstar" | "archive" | "trash") => {
    if (change === "trash" && !window.confirm("Move this email to Gmail trash?")) return;
    if (change === "archive" && !window.confirm("Archive this email from Clyra?")) return;
    setMutating(true);
    try { await onModify(email, change); } finally { setMutating(false); setMenuOpen(false); }
  };
  const openThread = async () => {
    setThreadLoading(true);
    try { setThread(await onThread(email)); } finally { setThreadLoading(false); }
  };
  const summarize = async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    try { setSummary(await onSummarize(email)); } catch { setSummaryError("Could not summarize this email. Try again."); } finally { setSummaryLoading(false); }
  };
  const copy = async (kind: "address" | "text") => {
    try {
      await navigator.clipboard?.writeText(kind === "address" ? email.senderEmail : (email.plainTextBody || email.snippet));
      setCopied(kind === "address" ? "Address copied" : "Email copied");
      setTimeout(() => setCopied(null), 1600);
    } finally { setMenuOpen(false); }
  };
  const labelList = email.labels.slice(0, 2);
  return (
    <motion.article
      initial={{ opacity: 0, y: reducedMotion ? 0 : 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.17, ease: [0.2, 0, 0, 1] }}
      className={cn(
        "gmail-message-card relative flex min-w-0 flex-col overflow-visible rounded-[15px] border border-[#e3e7ec] bg-[#f8fafd] p-[18px] text-[#1f1f1f] shadow-[0_1px_2px_rgba(60,64,67,.08)] transition-colors duration-150 hover:bg-[#f7f9fc]",
        email.isUnread && "bg-[#f5f8fe]",
        single ? "min-h-0" : compact ? "min-h-[366px]" : "min-h-[408px]",
        centeredAtMedium && "md:col-span-2 md:w-[calc(50%-8px)] md:justify-self-center xl:col-span-1 xl:w-auto",
      )}
    >
      <div className="gmail-sender-row flex min-w-0 items-start gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#eaf1fb] text-[12px] font-medium text-[#0b57d0]" aria-label={`${email.senderName} avatar`}>{initials(email.senderName)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5"><span className={cn("truncate text-[14px] leading-5 text-[#1f1f1f]", email.isUnread ? "font-semibold" : "font-medium")}>{email.senderName}</span>{email.isUnread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#0b57d0]" aria-label="Unread email" /> : null}</span>
          <GmailRecipientDetails email={email} />
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <span className="mr-0.5 text-[12px] text-[#5f6368]" title={email.receivedAt}>{formatDate(email)}</span>
          <button type="button" disabled={mutating} onClick={() => void modify(email.isStarred ? "unstar" : "star")} className="grid h-8 w-8 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#eef3f9] hover:text-[#3c4043] disabled:opacity-50" aria-label={email.isStarred ? "Unstar email" : "Star email"}><MaterialIcon name={email.isStarred ? "star" : "star_border"} className={cn("h-[19px] w-[19px]", email.isStarred && "text-[#f9ab00]")} /></button>
          <span className="relative"><button type="button" onClick={() => setMenuOpen((value) => !value)} className="grid h-8 w-8 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#eef3f9] hover:text-[#3c4043]" aria-label={`More actions for ${email.subject}`} aria-expanded={menuOpen}><MaterialIcon name="more_vert" className="h-[19px] w-[19px]" /></button>
            <AnimatePresence>{menuOpen ? <motion.div initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: reducedMotion ? 0 : 0.14 }} className="absolute right-0 top-9 z-40 w-[204px] rounded-xl border border-[#e3e7ec] bg-white p-1.5 text-[12px] text-[#3c4043] shadow-[0_2px_8px_rgba(60,64,67,.18)]">
              <button type="button" onClick={() => void modify(email.isUnread ? "read" : "unread")} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="mark_email_unread" className="h-4 w-4" />Mark as {email.isUnread ? "read" : "unread"}</button>
              <button type="button" onClick={() => void modify(email.isStarred ? "unstar" : "star")} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name={email.isStarred ? "star" : "star_border"} className="h-4 w-4" />{email.isStarred ? "Unstar" : "Star"}</button>
              <button type="button" onClick={() => { setMenuOpen(false); setFollowUpOpen(true); }} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="schedule" className="h-4 w-4" />Follow up</button>
              <button type="button" onClick={() => { setMenuOpen(false); void openThread(); }} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="forum" className="h-4 w-4" />Open thread</button>
              <span className="my-1 block border-t border-[#eceff1]" />
              <button type="button" onClick={() => void modify("archive")} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="archive" className="h-4 w-4" />Archive</button>
              <button type="button" onClick={() => void modify("trash")} className={cn(GMAIL_MENU_ITEM_CLASS, "text-[#b3261e]")}><MaterialIcon name="delete" className="h-4 w-4" />Move to trash</button>
              <span className="my-1 block border-t border-[#eceff1]" />
              <button type="button" onClick={() => void copy("address")} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="content_copy" className="h-4 w-4" />Copy sender address</button>
              <button type="button" onClick={() => void copy("text")} className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="content_copy" className="h-4 w-4" />Copy email text</button>
              <a href={`https://mail.google.com/mail/u/0/#all/${email.id}`} target="_blank" rel="noopener noreferrer" className={GMAIL_MENU_ITEM_CLASS}><MaterialIcon name="open_in_new" className="h-4 w-4" />Open in Gmail</a>
            </motion.div> : null}</AnimatePresence>
          </span>
        </span>
      </div>
      <div className="gmail-subject-row mt-4 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5"><h3 className={cn("line-clamp-2 text-[15px] leading-[1.35] tracking-[-0.005em] text-[#1f1f1f]", email.isUnread ? "font-semibold" : "font-medium")}>{email.subject}</h3>{email.threadMessageCount > 1 ? <button type="button" onClick={() => void openThread()} className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-[#eef1f4] px-1.5 text-[11px] font-medium text-[#5f6368]" aria-label={`Open ${email.threadMessageCount} message thread`}>{email.threadMessageCount}</button> : null}{email.attachments.length ? <MaterialIcon name="attachment" className="h-4 w-4 text-[#5f6368]" title="Has attachments" /> : null}</div>
        {labelList.length ? <div className="mt-2 flex flex-wrap gap-1.5">{labelList.map((label) => <GmailLabelChip key={label} label={label} />)}</div> : null}
      </div>
      <EmailBodyPreview email={email} expanded={expanded} compact={compact} single={single} onToggle={() => setExpanded((value) => !value)} />
      <AttachmentTiles attachments={email.attachments} />
      <AnimatePresence>{summary || summaryLoading || summaryError ? <motion.div initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 3 }} transition={{ duration: reducedMotion ? 0 : 0.16 }} className="mt-3 border-t border-[#d8e4f7] bg-[#eef5ff] px-3 py-2.5 text-[12px] leading-5 text-[#3c4043]"><div className="mb-1 flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5 font-medium"><MaterialIcon name="auto_awesome" className="h-4 w-4 text-[#0b57d0]" /> Clyra summary</span>{summary ? <button type="button" onClick={() => setSummary(null)} className="text-[11px] text-[#0b57d0] hover:underline">Hide</button> : null}</div>{summaryLoading ? <span className="inline-flex items-center gap-1.5 text-[#5f6368]"><MaterialIcon name="refresh" className="h-4 w-4 animate-spin" /> Summarizing…</span> : summaryError ? <button type="button" onClick={() => void summarize()} className="text-left text-[#b3261e] hover:underline">{summaryError}</button> : <span className="whitespace-pre-wrap">{summary}</span>}</motion.div> : null}</AnimatePresence>
      <div className="gmail-message-actions mt-auto flex flex-wrap items-center gap-1.5 border-t border-[#e3e7ec] pt-3.5">
        <button type="button" disabled={summaryLoading} onClick={() => void summarize()} className="inline-flex h-8 items-center gap-1.5 rounded-2xl bg-[#eaf1fb] px-3 text-[12px] font-medium text-[#0b57d0] transition hover:bg-[#dbe8fb] disabled:opacity-50"><MaterialIcon name="auto_awesome" className="h-3.5 w-3.5" /> {summary ? "Regenerate" : "Summarize"}</button>
        <button type="button" onClick={() => setReply((value) => !value)} className={cn("inline-flex h-8 items-center gap-1.5 rounded-2xl border px-3 text-[12px] font-medium transition", reply ? "border-[#0b57d0] bg-[#eaf1fb] text-[#0b57d0]" : "border-[#dadce0] bg-white text-[#3c4043] hover:bg-[#f8fafd]")}><MaterialIcon name="reply" className="h-3.5 w-3.5" /> Reply</button>
        {!compact ? <><span className="relative"><button type="button" onClick={() => setFollowUpOpen((value) => !value)} className="inline-flex h-8 items-center gap-1.5 rounded-2xl px-2.5 text-[12px] font-medium text-[#5f6368] transition hover:bg-[#eef3f9] hover:text-[#3c4043]"><MaterialIcon name="schedule" className="h-3.5 w-3.5" /> {followUp ? "Follow-up set" : "Follow up"}</button><FollowUpPopover email={email} open={followUpOpen} onClose={() => setFollowUpOpen(false)} onSchedule={onFollowUp} onCancel={onCancelFollowUp} scheduled={followUp} onScheduled={setFollowUp} /></span><button type="button" disabled={threadLoading} onClick={() => void openThread()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-2xl px-2.5 text-[12px] font-medium text-[#5f6368] transition hover:bg-[#eef3f9] hover:text-[#3c4043] disabled:opacity-50">{threadLoading ? <MaterialIcon name="refresh" className="h-3.5 w-3.5 animate-spin" /> : <MaterialIcon name="forum" className="h-3.5 w-3.5" />} Open thread</button></> : null}
        {compact ? <button type="button" onClick={() => setMenuOpen((value) => !value)} className="ml-auto grid h-8 w-8 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#eef3f9]" aria-label="More Gmail actions"><MaterialIcon name="more_vert" className="h-[18px] w-[18px]" /></button> : null}
      </div>
      <AnimatePresence>{reply ? <ReplyComposer email={email} onGenerate={onGenerateReply} onSave={onSaveReply} onSend={onSendReply} onCancel={() => setReply(false)} /> : null}</AnimatePresence>
      <AnimatePresence>{thread ? <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reducedMotion ? 0 : 0.2 }} className="mt-3 overflow-hidden rounded-xl border border-[#e3e7ec] bg-white p-3"><div className="mb-2 flex items-center justify-between"><span className="text-[12px] font-medium text-[#1f1f1f]">Full thread</span><button type="button" onClick={() => setThread(null)} className="text-[12px] text-[#0b57d0] hover:underline">Close</button></div><div className="space-y-2">{thread.messages.map((message) => <div key={message.id} className="border-t border-[#edf0f2] pt-2 text-[12px] leading-5 text-[#3c4043]"><span className="block font-medium text-[#1f1f1f]">{message.senderName}</span><span className="line-clamp-4 whitespace-pre-wrap">{cleanEmailPreview(message.plainTextBody || message.snippet)}</span></div>)}</div></motion.div> : null}</AnimatePresence>
      {mutating ? <span className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[#5f6368]"><MaterialIcon name="refresh" className="h-3.5 w-3.5 animate-spin" /> Updating Gmail…</span> : null}
      {copied ? <span className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-emerald-700"><MaterialIcon name="check" className="h-3.5 w-3.5" /> {copied}</span> : null}
    </motion.article>
  );
}

export function GmailEmailResults({ results, refreshing = false, onRefresh, onSummarize, onGenerateReply, onSaveReply, onSendReply, onModify, onThread, onFollowUp, onCancelFollowUp }: { results: GmailResultsPayload; refreshing?: boolean; onRefresh: () => Promise<void>; onSummarize: (email: GmailEmail) => Promise<string>; onGenerateReply: (email: GmailEmail) => Promise<string>; onSaveReply: (email: GmailEmail, body: string) => Promise<void>; onSendReply: (email: GmailEmail, body: string) => Promise<void>; onModify: (email: GmailEmail, change: "read" | "unread" | "star" | "unstar" | "archive" | "trash") => Promise<void>; onThread: (email: GmailEmail) => Promise<GmailThread>; onFollowUp: (email: GmailEmail, when: string, note: string) => Promise<{ id:string; dueAt:string }>; onCancelFollowUp: (id: string) => Promise<void> }) {
  const count = results.emails.length;
  const [refreshingLocally, setRefreshingLocally] = useState(false);
  const isRefreshing = refreshing || refreshingLocally;
  const refresh = async () => {
    setRefreshingLocally(true);
    try {
      // Keep the existing cards mounted until the real Gmail query completes.
      await onRefresh();
    } finally {
      setRefreshingLocally(false);
    }
  };
  const gridClass = useMemo(() => {
    if (count === 1) return "mx-auto max-w-[780px] grid-cols-1";
    if (count === 2 || count === 4) return "grid-cols-1 md:grid-cols-2";
    if (count === 3) return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
    return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
  }, [count]);
  if (!results.emails.length) return <section className="gmail-results-section mt-4 max-w-[720px] rounded-[15px] border border-[#e3e7ec] bg-[#f8fafd] px-5 py-4 text-[13px] text-[#5f6368]"><span className="font-medium text-[#1f1f1f]">No matching emails were found.</span><span className="mt-1 block">Try a different search, recent mail, or unread email.</span></section>;
  return (
    <section className="gmail-results-section mt-5 w-full max-w-[1080px]" aria-label="Gmail email results">
      <div className="gmail-results-header mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[#f1f3f4]"><img src={PRODUCT_ICON.gmail} alt="Gmail" className="h-[27px] w-[27px] object-contain" /></span>
          <span className="min-w-0"><span className="block text-[15px] font-medium leading-5 text-[#1f1f1f]">Synced inbox</span><span className="mt-0.5 block text-[12px] leading-4 text-[#5f6368]">{labelForResults(results)}</span></span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => void refresh()} disabled={isRefreshing} className="grid h-9 w-9 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#eaf1fb] hover:text-[#0b57d0] disabled:opacity-60" aria-label="Refresh email results">{isRefreshing ? <MaterialIcon name="refresh" className="h-[19px] w-[19px] animate-spin" /> : <MaterialIcon name="refresh" className="h-[19px] w-[19px]" />}</button>
          <a href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-[18px] border border-[#dadce0] bg-white px-3 text-[12px] font-medium text-[#0b57d0] transition hover:bg-[#f8fafd] focus:outline-none focus:ring-2 focus:ring-[#0b57d0]/30">Open Gmail <MaterialIcon name="open_in_new" className="h-3.5 w-3.5" /></a>
        </div>
      </div>
      <div className={cn("gmail-message-grid grid items-stretch gap-4", gridClass)}>
        {results.emails.map((email, index) => <EmailCard key={email.id} email={email} compact={count >= 3} single={count === 1} centeredAtMedium={count === 3 && index === 2} onSummarize={onSummarize} onGenerateReply={onGenerateReply} onSaveReply={onSaveReply} onSendReply={onSendReply} onModify={onModify} onThread={onThread} onFollowUp={onFollowUp} onCancelFollowUp={onCancelFollowUp} />)}
      </div>
    </section>
  );
}
