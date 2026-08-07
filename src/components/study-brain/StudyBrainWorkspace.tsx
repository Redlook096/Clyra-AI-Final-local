/**
 * Clyra Study Brain — XYFlow canvas workspace.
 * Reuses chat YouTube analysis + Google desktop execute + /api/study/*.
 */
import {
  BookOpen,
  FilePlus2,
  FileText,
  Film,
  Globe,
  GraduationCap,
  Image as ImageIcon,
  Link2,
  Loader2,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Presentation,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn, formatApiError } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "../ShiningText";
import { GoogleProductIcon, YouTubeBrandIcon } from "../brand/ProductIcons";
import { getElectronDesktop } from "../../lib/electron-runtime";
import {
  connectedSources,
  emptyBrain,
  findSourceByCitation,
  hasDuplicateOrigin,
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
import { BrainCanvas } from "./BrainCanvas";

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
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"source" | "chat" | "materials">("chat");
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHint, setLinkHint] = useState("Paste a YouTube, website, or Google link");
  const [linkTitle, setLinkTitle] = useState("Add link");
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const updateBrain = useCallback(
    (nextBrain: StudyBrain) => {
      persist({
        ...store,
        brains: store.brains.map((item) => (item.id === nextBrain.id ? nextBrain : item)),
        activeBrainId: nextBrain.id,
      });
    },
    [persist, store],
  );

  const storeRef = useRef(store);
  storeRef.current = store;
  const brainRef = useRef(brain);
  brainRef.current = brain;

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
    [ensureBrain, persist],
  );

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
    if (!addOpen) return;
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
    async (question: string, mode: "answer" | "summary" | "plan" | "explain" = "answer") => {
      if (!brain) return;
      const sources = connectedSources(brain);
      if (!sources.length) {
        setError("Connect at least one ready source to the Brain first.");
        return;
      }
      const clean = question.trim();
      if (!clean) return;
      setError(null);
      setBusy(true);
      setInspectorTab("chat");
      const userMessage: StudyChatMessage = {
        id: uid(),
        role: "user",
        content: clean,
        at: Date.now(),
      };
      const prior = brain.messages;
      updateBrain({ ...brain, messages: [...prior, userMessage], updatedAt: Date.now() });
      try {
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
        updateBrain({
          ...brain,
          messages: [...prior, userMessage, assistant],
          updatedAt: Date.now(),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Ask failed");
      } finally {
        setBusy(false);
      }
    },
    [brain, updateBrain],
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
        setInspectorTab("chat");
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

  if (!brain) {
    return (
      <div className="grid h-full place-items-center bg-[#fbfbfa] text-[13px] text-[#8b939e]">
        Preparing Study Brain…
      </div>
    );
  }

  return (
    <div className="study-brain-shell flex h-full min-h-0 bg-[color:var(--clyra-canvas)] text-[color:var(--clyra-text)]">
      {/* Left rail */}
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface)]">
        <div className="flex items-center gap-2.5 border-b border-[color:var(--clyra-border)] px-3.5 py-3">
          <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-[color:var(--clyra-accent-soft)] text-[color:var(--clyra-accent)]">
            <GraduationCap className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium tracking-[-0.015em]">Clyra Study</p>
            <p className="text-[11px] text-[color:var(--clyra-text-tertiary)]">Study spaces</p>
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
          }}
          className="mx-3 mt-3 flex h-8 items-center justify-center gap-1.5 rounded-[8px] border border-[color:var(--clyra-border)] text-[12.5px] font-medium text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> New study space
        </button>
        <div className="mt-3 px-3">
          <p className="px-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[color:var(--clyra-text-tertiary)]">
            Recent
          </p>
        </div>
        <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
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
        </div>
      </aside>

      {/* Canvas column */}
      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface)] px-4">
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
                className="h-8 w-[220px] rounded-[8px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)] px-2 text-[14px] font-medium outline-none focus:border-[color:var(--clyra-accent)]/35"
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
              <button
                type="button"
                onClick={() => setAddOpen((open) => !open)}
                className="flex h-8 items-center gap-1.5 rounded-[8px] bg-[color:var(--clyra-accent)] px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-95"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} /> Add resource
              </button>
              {addOpen ? (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-[280px] overflow-hidden rounded-[12px] border border-[color:var(--clyra-border)] bg-white py-1.5 shadow-[var(--clyra-shadow-popover)]">
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
                  ).map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        setAddOpen(false);
                        item.run();
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                    >
                      <span className="grid h-6 w-6 place-items-center rounded-[7px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)]">
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
                  ).map((item) => (
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
                      <span className="grid h-6 w-6 place-items-center rounded-[7px] border border-[color:var(--clyra-border)] bg-white">
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
                    <span className="grid h-6 w-6 place-items-center rounded-[7px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)]">
                      <NotebookPen className="h-[14px] w-[14px] text-[color:var(--clyra-text-secondary)]" strokeWidth={1.75} />
                    </span>
                    Paste text
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddOpen(false);
                      void addSource(async () =>
                        ingestPaste("Blank study note — replace with your own notes.", "Blank note"),
                      );
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-[color:var(--clyra-text)] transition-colors hover:bg-[color:var(--clyra-hover)]"
                  >
                    <span className="grid h-6 w-6 place-items-center rounded-[7px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)]">
                      <FilePlus2 className="h-[14px] w-[14px] text-[color:var(--clyra-text-secondary)]" strokeWidth={1.75} />
                    </span>
                    Blank note
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setInspectorOpen((open) => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[color:var(--clyra-text-secondary)] transition-colors hover:bg-[color:var(--clyra-hover)]"
              aria-label="Toggle inspector"
            >
              {inspectorOpen ? <PanelRightClose className="h-4 w-4" strokeWidth={1.75} /> : <PanelRightOpen className="h-4 w-4" strokeWidth={1.75} />}
            </button>
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
          <BrainCanvas
            brain={brain}
            processing={busy}
            onBrainChange={updateBrain}
            onAction={onBrainAction}
            onSelectSource={setSelectedSourceId}
          />
          {dragging ? (
            <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-[12px] border border-dashed border-[color:var(--clyra-accent)]/40 bg-[color:var(--clyra-accent-soft)]/70 backdrop-blur-[1px]">
              <div className="text-center">
                <p className="text-[14px] font-medium text-[color:var(--clyra-text)]">Drop resources anywhere</p>
                <p className="mt-1 text-[12px] text-[color:var(--clyra-text-secondary)]">
                  PDF · Slides · Documents · Images · Audio · Links
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-[color:var(--clyra-border)] bg-[color:var(--clyra-canvas)] px-4 py-3">
          <form
            className="mx-auto flex max-w-[760px] items-end gap-2 rounded-[14px] border border-[color:var(--clyra-border)] bg-white px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = composer.trim();
              if (!value) return;
              setComposer("");
              void askBrain(value);
            }}
          >
            <textarea
              value={composer}
              rows={2}
              placeholder="Ask about connected resources…"
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="min-h-[40px] flex-1 resize-none bg-transparent text-[13.5px] leading-[1.45] outline-none placeholder:text-[color:var(--clyra-text-tertiary)]"
            />
            <button
              type="submit"
              disabled={busy || !composer.trim()}
              className="mb-0.5 flex h-7 w-7 items-center justify-center rounded-[8px] bg-[color:var(--clyra-accent)] text-white disabled:bg-[color:var(--clyra-surface-muted)] disabled:text-[color:var(--clyra-text-tertiary)]"
              aria-label="Ask"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "↑"}
            </button>
          </form>
        </div>
      </section>

      {/* Right inspector */}
      {inspectorOpen ? (
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface)]">
          <div className="flex items-center gap-1 border-b border-[color:var(--clyra-border)] px-2 py-2">
            {(["chat", "source", "materials"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setInspectorTab(tab)}
                className={cn(
                  "h-8 rounded-[8px] px-2.5 text-[12px] font-medium capitalize transition-colors",
                  inspectorTab === tab
                    ? "bg-[color:var(--clyra-selected)] text-[color:var(--clyra-text)]"
                    : "text-[color:var(--clyra-text-secondary)] hover:bg-[color:var(--clyra-hover)]",
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
                          className="block w-full rounded-[10px] px-2.5 py-2 text-left text-[12px] font-medium text-[color:var(--clyra-text-secondary)] transition-colors hover:bg-[color:var(--clyra-hover)] hover:text-[color:var(--clyra-text)]"
                        >
                          {prompt}
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
                <div className="grid grid-cols-2 gap-2">
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
                      className="flex h-10 items-center justify-center rounded-[12px] border border-[color:var(--clyra-border)] bg-white text-[12px] font-medium text-[color:var(--clyra-text)] shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-colors hover:bg-[color:var(--clyra-hover)]"
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
