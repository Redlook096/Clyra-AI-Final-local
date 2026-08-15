import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Bug, CheckCircle2, Clipboard, File as FileIcon, FileSearch, Folder, Globe2, Image, ListChecks, Mic, MousePointer2, Plus, Square, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type ComposerContext = {
  id: string;
  label: string;
  detail: string;
};

export type ComposerAttachment = {
  id: string;
  file: File;
  preview?: string;
  kind: "image" | "file" | "folder";
};

export type ComposerCommand = "browser" | "plan" | "test" | "debug" | "explain";

const CODING_COMMANDS: Array<{ id: ComposerCommand; name: string; description: string; icon: typeof Globe2 }> = [
  { id: "browser", name: "Browser", description: "Use the live preview autonomously", icon: MousePointer2 },
  { id: "plan", name: "Plan", description: "Plan the task before changing files", icon: ListChecks },
  { id: "test", name: "Test", description: "Test the current implementation", icon: CheckCircle2 },
  { id: "debug", name: "Debug", description: "Find and fix a problem", icon: Bug },
  { id: "explain", name: "Explain", description: "Analyse selected project code", icon: FileSearch },
];

const readableSize = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** A compact, bottom-anchored coding composer. Attachments remain real File
 * objects until submit so image previews never become placeholder UI. */
export function Composer({
  running,
  model: _model,
  contexts,
  onRemoveContext,
  onSubmit,
  onStop,
  placeholder = "Ask Clyra to make a change…",
  welcome = false,
  suggestion,
  onCommandChange,
}: {
  running: boolean;
  model: string | null;
  contexts: ComposerContext[];
  onRemoveContext: (id: string) => void;
  onSubmit: (text: string, attachments: ComposerAttachment[], command?: ComposerCommand) => Promise<boolean> | boolean;
  onStop: () => void;
  placeholder?: string;
  welcome?: boolean;
  suggestion?: { text: string; nonce: number };
  onCommandChange?: (command: ComposerCommand | null) => void;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [command, setCommand] = useState<ComposerCommand | null>(null);
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);

  useEffect(() => {
    const input = folderInputRef.current;
    if (input) input.setAttribute("webkitdirectory", "");
  }, []);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => attachment.preview && URL.revokeObjectURL(attachment.preview));
  }, []);

  useEffect(() => {
    if (!suggestion?.text) return;
    setValue(suggestion.text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [suggestion]);

  const addFiles = useCallback((files: FileList | File[], kind: "image" | "file" | "folder" = "file") => {
    const next = Array.from(files).map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      kind: file.type.startsWith("image/") ? "image" as const : kind,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setAttachments((previous) => [...previous, ...next]);
    setAttachmentMenu(false);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => {
      const removed = previous.find((attachment) => attachment.id === id);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return previous.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const pasteClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          addFiles([new File([blob], `clipboard-image.${imageType.split("/")[1] || "png"}`, { type: imageType })], "image");
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (text) setValue((previous) => previous ? `${previous}\n${text}` : text);
    } catch {
      textareaRef.current?.focus();
    } finally {
      setAttachmentMenu(false);
    }
  }, [addFiles]);

  const submit = useCallback(async () => {
    const text = value.trim();
    // Context chips are real request metadata. In particular, "Add error to
    // chat" must be sendable without forcing the user to type filler text.
    if (!text && attachments.length === 0 && contexts.length === 0) return;
    const contextBlock = contexts.length ? `${contexts.map((context) => `[${context.label}] ${context.detail}`).join("\n")}\n\n` : "";
    const submitted = await Promise.resolve(onSubmit(contextBlock + text, attachments, command ?? undefined));
    if (!submitted) return;
    attachments.forEach((attachment) => attachment.preview && URL.revokeObjectURL(attachment.preview));
    setAttachments([]);
    setValue("");
    setCommand(null);
    onCommandChange?.(null);
    contexts.forEach((context) => onRemoveContext(context.id));
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [attachments, command, contexts, onCommandChange, onRemoveContext, onSubmit, value]);

  const visibleCommands = commandQuery === null ? [] : CODING_COMMANDS.filter((item) => item.id.includes(commandQuery.toLowerCase()) || item.name.toLowerCase().includes(commandQuery.toLowerCase()));
  const selectCommand = useCallback((next: ComposerCommand) => {
    setCommand(next);
    onCommandChange?.(next);
    setValue((current) => current.replace(/(^|\s)\/[a-z]*$/i, "$1").replace(/^\s+/, ""));
    setCommandQuery(null);
    setCommandIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [onCommandChange]);

  const onValueChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(next);
    const match = next.match(/(?:^|\s)\/([a-z]*)$/i);
    setCommandQuery(match ? match[1] : null);
    setCommandIndex(0);
    event.currentTarget.style.height = "auto";
    event.currentTarget.style.height = `${Math.min(140, event.currentTarget.scrollHeight)}px`;
  };

  const attached = attachments.length > 0 || contexts.length > 0;
  return (
    <div className={cn("relative px-3", welcome ? "pt-0" : "pb-2 pt-1")}>
      <div className={cn("relative mx-auto overflow-visible rounded-[14px] border border-black/[0.08] bg-white transition-[height,border-color,box-shadow] duration-200 ease-out", welcome ? "max-w-[620px] shadow-[0_4px_18px_rgba(0,0,0,0.025)] focus-within:border-black/[0.15] focus-within:shadow-[0_4px_18px_rgba(0,0,0,0.035)]" : "max-w-[680px] shadow-[0_1px_2px_rgba(0,0,0,0.025),0_5px_18px_rgba(0,0,0,0.025)] focus-within:border-black/[0.14] focus-within:shadow-[0_0_0_1px_rgba(57,119,246,0.12),0_5px_18px_rgba(0,0,0,0.03)]")}>
        <AnimatePresence initial={false}>
          {attached ? <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="flex max-h-[86px] gap-1.5 overflow-x-auto px-2.5 pt-2 [scrollbar-width:none]">
              {contexts.map((context) => <span key={context.id} title={context.detail} className="flex h-6 shrink-0 items-center gap-1 rounded-[7px] bg-[#F5F5F4] px-1.5 text-[10.5px] text-[#5F6368]">{context.label}<button type="button" aria-label="Remove context" onClick={() => onRemoveContext(context.id)} className="text-[#96989D] hover:text-[#202124]"><X className="h-2.5 w-2.5" /></button></span>)}
              {attachments.map((attachment) => attachment.kind === "image" && attachment.preview ? <div key={attachment.id} className="relative h-[68px] w-[84px] shrink-0 overflow-visible"><img src={attachment.preview} alt={attachment.file.name} className="h-[68px] w-[84px] rounded-[8px] border border-black/[0.08] object-cover" /><button type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)} className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#28292C] text-white shadow-sm"><X className="h-2.5 w-2.5" /></button></div> : <div key={attachment.id} className="relative flex h-[44px] min-w-[150px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-[8px] bg-[#F6F6F5] px-2 pr-5"><FileIcon className="h-3.5 w-3.5 shrink-0 text-[#73757A]" /><span className="min-w-0"><span className="block truncate text-[10.5px] font-medium text-[#505258]">{attachment.file.name}</span><span className="block text-[9.5px] text-[#96989D]">{attachment.kind === "folder" ? "Folder" : `${attachment.file.name.split(".").pop()?.toUpperCase() || "File"} · ${readableSize(attachment.file.size)}`}</span></span><button type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)} className="absolute right-1.5 top-1.5 text-[#8F9196] hover:text-[#25262A]"><X className="h-3 w-3" /></button></div>)}
            </div>
          </motion.div> : null}
        </AnimatePresence>
        {command ? (() => { const item = CODING_COMMANDS.find((candidate) => candidate.id === command)!; const Icon = item.icon; return <div className="px-3 pt-2"><span className="inline-flex h-5 items-center gap-1 rounded-[6px] bg-[#3977F6]/[0.08] px-1.5 text-[10.5px] font-medium text-[#3977F6]"><Icon className="h-3 w-3" strokeWidth={1.7} />{item.name}<button type="button" aria-label={`Remove ${item.name} command`} onClick={() => { setCommand(null); onCommandChange?.(null); }} className="ml-0.5 rounded text-[#3977F6]/70 hover:text-[#3977F6]"><X className="h-2.5 w-2.5" /></button></span></div>; })() : null}
        <textarea ref={textareaRef} value={value} rows={1} placeholder={placeholder} onChange={onValueChange} onKeyDown={(event) => { if (commandQuery !== null) { if (event.key === "ArrowDown") { event.preventDefault(); setCommandIndex((index) => Math.min(visibleCommands.length - 1, index + 1)); return; } if (event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((index) => Math.max(0, index - 1)); return; } if (event.key === "Escape") { event.preventDefault(); setCommandQuery(null); return; } if (event.key === "Enter" && visibleCommands[commandIndex]) { event.preventDefault(); selectCommand(visibleCommands[commandIndex].id); return; } } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} className={cn("w-full min-h-[38px] resize-none bg-transparent px-3 pt-2.5 text-[13px] leading-[1.45] tracking-[-0.008em] text-[#202124] outline-none placeholder:text-[#999B9F]", welcome && "min-h-[59px] px-4 pt-4 text-[14px]")} />
        <div className={cn("flex h-8 items-center gap-1 px-2 pb-1.5", welcome && "h-9 px-3 pb-2")}>
          <div className="relative">
            <button type="button" aria-label="Add attachment" onClick={() => setAttachmentMenu((open) => !open)} className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[#77797E] transition-colors hover:bg-black/[0.045] hover:text-[#34363A]"><Plus className="h-4 w-4" strokeWidth={1.7} /></button>
            <AnimatePresence>{attachmentMenu ? <motion.div initial={{ opacity: 0, y: 4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: 0.98 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="absolute bottom-8 left-0 z-30 w-[176px] rounded-[10px] border border-black/[0.08] bg-white p-1 shadow-[0_10px_24px_rgba(15,23,42,0.11)]">
              {[["Image", Image, () => imageInputRef.current?.click()], ["File", FileIcon, () => fileInputRef.current?.click()], ["Folder", Folder, () => folderInputRef.current?.click()], ["Paste from clipboard", Clipboard, pasteClipboard]].map(([label, Icon, action]) => { const IconComponent = Icon as typeof Image; return <button key={label as string} type="button" onClick={action as () => void} className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[11.5px] text-[#4C4E53] transition-colors hover:bg-black/[0.035]"><IconComponent className="h-3.5 w-3.5 text-[#77797E]" strokeWidth={1.65} />{label as string}</button>; })}
            </motion.div> : null}</AnimatePresence>
          </div>
          <span className="text-[10.5px] font-medium text-[#9A9CA0]">Clyra</span><span className="flex-1" />
          <button type="button" aria-label="Voice input" onClick={() => textareaRef.current?.focus()} className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[#85878C] transition-colors hover:bg-black/[0.045] hover:text-[#34363A]"><Mic className="h-3.5 w-3.5" strokeWidth={1.65} /></button>
          {running ? <button type="button" onClick={onStop} aria-label="Stop" className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#242528] text-white transition-colors duration-150 hover:bg-[#17181A] active:scale-[0.96]"><Square className="h-[10px] w-[10px]" fill="currentColor" /></button> : <button type="button" onClick={submit} disabled={!value.trim() && attachments.length === 0 && contexts.length === 0} aria-label="Send" className={cn("flex h-[30px] w-[30px] items-center justify-center rounded-full transition-all duration-150 active:scale-[0.96]", value.trim() || attachments.length || contexts.length ? "bg-[#3977F6] text-white hover:bg-[#2E68E5]" : "bg-[#F0F0EF] text-[#B7B8BA]")}><ArrowUp className="h-3.5 w-3.5" strokeWidth={2.15} /></button>}
        </div>
        <AnimatePresence>{commandQuery !== null && visibleCommands.length ? <motion.div initial={{ opacity: 0, y: 4, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: 0.985 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="clyra-command-palette absolute bottom-[calc(100%+7px)] left-0 z-40 w-full overflow-hidden rounded-[10px] border border-black/[0.08] bg-white p-1 shadow-[0_10px_24px_rgba(15,23,42,0.11)]">{visibleCommands.map((item, index) => { const Icon = item.icon; return <button key={item.id} type="button" onMouseEnter={() => setCommandIndex(index)} onClick={() => selectCommand(item.id)} className={cn("flex h-9 w-full items-center gap-2 rounded-[6px] px-2.5 text-left transition-colors", index === commandIndex ? "bg-black/[0.035]" : "hover:bg-black/[0.035]")}><Icon className="h-3.5 w-3.5 text-[#5F6368]" strokeWidth={1.65} /><span className="min-w-0 flex-1"><span className="block text-[11.5px] font-medium text-[#4B4D52]">/{item.id}</span></span><span className="truncate text-[10.5px] text-[#96989D]">{item.description}</span></button>; })}</motion.div> : null}</AnimatePresence>
      </div>
      <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { if (event.currentTarget.files) addFiles(event.currentTarget.files, "image"); event.currentTarget.value = ""; }} />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
      <input ref={folderInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.currentTarget.files) addFiles(event.currentTarget.files, "folder"); event.currentTarget.value = ""; }} />
    </div>
  );
}
