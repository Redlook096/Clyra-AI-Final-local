/**
 * Clyra Study Brain — XYFlow canvas workspace.
 * Reuses chat YouTube analysis + Google desktop execute + /api/study/*.
 */
import {
  BookOpen,
  FilePlus2,
  GraduationCap,
  Link2,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn, formatApiError } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "../ShiningText";
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
  const fileRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (!store.brains.length) {
      const created = emptyBrain(agentPrompt.trim() ? agentPrompt.trim().slice(0, 60) : "Biology Exam");
      persist({ version: 4, brains: [created], activeBrainId: created.id });
    } else if (!store.activeBrainId && store.brains[0]) {
      persist({ ...store, activeBrainId: store.brains[0].id });
    }
  }, [agentPrompt, persist, store]);

  const ensureBrain = useCallback(() => {
    if (brain) return brain;
    const created = emptyBrain("New Study Brain");
    persist({ version: 4, brains: [created, ...store.brains], activeBrainId: created.id });
    return created;
  }, [brain, persist, store.brains]);

  const addSource = useCallback(
    async (factory: () => Promise<StudySourceNode> | StudySourceNode) => {
      const current = ensureBrain();
      setError(null);
      setBusy(true);
      setStatus("Uploading…");
      try {
        setStatus("Extracting…");
        const source = await factory();
        if (hasDuplicateOrigin(current, source.origin)) {
          throw new Error("That source is already on this Brain. Connect or rename the existing node instead.");
        }
        setStatus("Indexing…");
        const brainPos = current.positions.brain || { x: 420, y: 280 };
        const index = current.sources.length;
        const positioned: StudyBrain = {
          ...current,
          sources: [...current.sources, source],
          positions: {
            ...current.positions,
            [source.id]: positionAroundBrain(brainPos, index),
          },
          connections: [...current.connections, source.id],
          updatedAt: Date.now(),
        };
        positioned.sources = positioned.sources.map((item) =>
          item.id === source.id ? { ...item, connected: true, status: "ready", statusDetail: "Connected" } : item,
        );
        updateBrain(positioned);
        setSelectedSourceId(source.id);
        setInspectorTab("source");
        setStatus("Ready");
      } catch (cause) {
        setError(cause instanceof Error ? softenStudyError(cause.message) : "Could not add source");
        setStatus(null);
      } finally {
        setBusy(false);
        window.setTimeout(() => setStatus(null), 1200);
      }
    },
    [ensureBrain, updateBrain],
  );

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
    <div
      className="flex h-full min-h-0 bg-[#fbfbfa] text-[#18212f]"
      style={{ fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif" }}
    >
      {/* Left rail */}
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-[#e7e7e4] bg-white">
        <div className="flex items-center gap-2 border-b border-[#e7e7e4] px-3 py-3">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-[#eef4ff] text-[#0052fb]">
            <GraduationCap className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold tracking-[-0.01em]">Study Brain</p>
            <p className="text-[10.5px] text-[#8b939e]">Sources → Brain → materials</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            const created = emptyBrain("New Study Brain");
            persist({
              version: 4,
              brains: [created, ...store.brains],
              activeBrainId: created.id,
            });
          }}
          className="mx-3 mt-3 flex h-8 items-center justify-center gap-1.5 rounded-[10px] border border-[#e7e7e4] text-[12px] font-medium text-[#18212f] hover:bg-[#f7f8fa]"
        >
          <Plus className="h-3.5 w-3.5" /> New Brain
        </button>
        <div className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {store.brains.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => persist({ ...store, activeBrainId: item.id })}
              className={cn(
                "flex w-full items-center justify-between rounded-[10px] px-2.5 py-2 text-left text-[12px]",
                item.id === brain.id ? "bg-[#f1f3f7] font-medium text-[#18212f]" : "text-[#697386] hover:bg-[#f7f8fa]",
              )}
            >
              <span className="truncate">{item.title}</span>
              <span className="text-[10px] text-[#8b939e]">{item.sources.length}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Canvas column */}
      <section className="relative flex min-w-0 flex-1 flex-col">
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1 rounded-[12px] border border-[#e7e7e4] bg-white/95 p-1 shadow-[0_8px_24px_rgba(24,33,47,0.05)] backdrop-blur">
          <div className="pointer-events-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium text-[#18212f] hover:bg-[#f1f3f7]"
            >
              <Upload className="h-3.5 w-3.5" /> File
            </button>
            <button
              type="button"
              onClick={() => setPasteOpen(true)}
              className="flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium text-[#18212f] hover:bg-[#f1f3f7]"
            >
              <FilePlus2 className="h-3.5 w-3.5" /> Paste
            </button>
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const value = urlDraft.trim();
                if (!value) return;
                void addSource(() =>
                  ingestAnyUrl(value, desktop?.google?.execute
                    ? (payload) => desktop.google.execute(payload as any)
                    : undefined),
                );
                setUrlDraft("");
              }}
            >
              <div className="flex h-8 items-center gap-1 rounded-[8px] border border-[#e7e7e4] bg-[#fbfbfa] px-2">
                <Link2 className="h-3.5 w-3.5 text-[#8b939e]" />
                <input
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder="YouTube, web, or Google link"
                  className="w-[220px] bg-transparent text-[11.5px] outline-none placeholder:text-[#8b939e]"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !urlDraft.trim()}
                className="flex h-8 items-center rounded-[8px] bg-[#0052fb] px-2.5 text-[11.5px] font-medium text-white disabled:bg-[#e8eaef] disabled:text-[#b0b5bf]"
              >
                Add
              </button>
            </form>
            <button
              type="button"
              onClick={() => setInspectorOpen((open) => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#697386] hover:bg-[#f1f3f7]"
              aria-label="Toggle inspector"
            >
              {inspectorOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {(status || error) && (
          <div className="pointer-events-none absolute left-4 top-14 z-20">
            <div
              className={cn(
                "rounded-[10px] border px-2.5 py-1.5 text-[11px] font-medium",
                error
                  ? "border-rose-200 bg-white text-rose-600"
                  : "border-[#e7e7e4] bg-white text-[#496a95]",
              )}
            >
              {error || status}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1">
          <BrainCanvas
            brain={brain}
            processing={busy}
            onBrainChange={updateBrain}
            onAction={onBrainAction}
            onSelectSource={setSelectedSourceId}
          />
        </div>

        {/* Bottom ask composer — chat parity */}
        <div className="border-t border-[#e7e7e4] bg-[#fbfbfa] px-4 py-3">
          <form
            className="mx-auto flex max-w-[760px] items-end gap-2 rounded-[18px] border border-[#dfe7f1] bg-white px-3 py-2"
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
              placeholder="Ask the Brain about connected sources…"
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] leading-[1.45] outline-none placeholder:text-[#8b939e]"
            />
            <button
              type="submit"
              disabled={busy || !composer.trim()}
              className="mb-0.5 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#0052fb] text-white disabled:bg-[#e8eaef] disabled:text-[#b0b5bf]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "↑"}
            </button>
          </form>
        </div>
      </section>

      {/* Right inspector */}
      {inspectorOpen ? (
        <aside className="flex w-[320px] shrink-0 flex-col border-l border-[#e7e7e4] bg-white">
          <div className="flex items-center gap-1 border-b border-[#e7e7e4] px-2 py-2">
            {(["chat", "source", "materials"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setInspectorTab(tab)}
                className={cn(
                  "h-8 rounded-[8px] px-2.5 text-[11.5px] font-medium capitalize",
                  inspectorTab === tab ? "bg-[#f1f3f7] text-[#18212f]" : "text-[#697386] hover:bg-[#f7f8fa]",
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {inspectorTab === "chat" ? (
              <div className="space-y-3">
                {!brain.messages.length ? (
                  <p className="text-[12.5px] leading-5 text-[#8b939e]">
                    Connect sources, then ask grounded questions. Citations appear as source titles.
                  </p>
                ) : null}
                {brain.messages.map((message) => (
                  <div key={message.id} className={cn("flex", message.role === "user" && "justify-end")}>
                    <div
                      className={cn(
                        "max-w-[95%] text-[13.5px] leading-[1.55] tracking-[-0.01em]",
                        message.role === "user"
                          ? "rounded-[14px] bg-[#aec7f1] px-3 py-2 text-[#18212f]"
                          : "text-[#18212f]",
                      )}
                    >
                      {message.role === "assistant" ? (
                        <MarkdownMessageContent content={message.content} />
                      ) : (
                        message.content
                      )}
                      {message.citations?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {message.citations.map((citation) => (
                            <button
                              key={citation}
                              type="button"
                              onClick={() => openCitation(citation)}
                              className="rounded-full border border-[#e7e7e4] bg-[#fbfbfa] px-2 py-0.5 text-[10px] text-[#697386] transition-colors hover:border-[#0052fb]/35 hover:text-[#0052fb]"
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
                    <ShiningText text="Thinking" play className="text-[13px] font-medium" />
                    <ThinkingDots />
                  </div>
                ) : null}
              </div>
            ) : null}

            {inspectorTab === "source" ? (
              selectedSource ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-[13px] font-semibold tracking-[-0.01em]">{selectedSource.title}</p>
                    <p className="mt-1 text-[11px] text-[#8b939e]">{selectedSource.origin}</p>
                  </div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-[#8b939e]">
                    {selectedSource.statusDetail || selectedSource.status}
                  </p>
                  <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[12px] border border-[#e7e7e4] bg-[#fbfbfa] p-3 text-[11.5px] leading-5 text-[#697386]">
                    {selectedSource.body.slice(0, 6000)}
                  </pre>
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
                    className="flex h-8 items-center gap-1.5 rounded-[8px] border border-[#e7e7e4] px-2.5 text-[11.5px] text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove from canvas
                  </button>
                </div>
              ) : (
                <p className="text-[12.5px] text-[#8b939e]">Select a source node to inspect its text.</p>
              )
            ) : null}

            {inspectorTab === "materials" ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-1.5">
                  {(["quiz", "flashcards", "guide"] as const).map((action) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => void generateMaterial(action)}
                      className="h-8 rounded-[8px] border border-[#e7e7e4] px-2.5 text-[11.5px] font-medium capitalize hover:bg-[#f7f8fa]"
                    >
                      {action}
                    </button>
                  ))}
                </div>
                {brain.materials.quiz ? (
                  <div className="rounded-[12px] border border-[#e7e7e4] p-3">
                    <p className="text-[12px] font-semibold">{brain.materials.quiz.topic}</p>
                    <p className="mt-1 text-[11px] text-[#8b939e]">
                      {brain.materials.quiz.questions.length} questions
                    </p>
                    <ol className="mt-2 list-decimal space-y-2 pl-4 text-[12px] text-[#697386]">
                      {brain.materials.quiz.questions.slice(0, 4).map((q) => (
                        <li key={q.id}>{q.question}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                {brain.materials.flashcards ? (
                  <div className="rounded-[12px] border border-[#e7e7e4] p-3">
                    <p className="text-[12px] font-semibold">{brain.materials.flashcards.topic}</p>
                    <p className="mt-1 text-[11px] text-[#8b939e]">
                      {brain.materials.flashcards.cards.length} cards · rate confidence to schedule review
                    </p>
                    <div className="mt-2 space-y-2">
                      {brain.materials.flashcards.cards.slice(0, 5).map((card) => (
                        <div key={card.id} className="rounded-[8px] bg-[#fbfbfa] px-2.5 py-2 text-[12px]">
                          <p className="font-medium text-[#18212f]">{card.front}</p>
                          <p className="mt-1 text-[#697386]">{card.back}</p>
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
                                    ? "border-[#0052fb]/40 bg-[#eef4ff] text-[#0052fb]"
                                    : "border-[#e7e7e4] text-[#8b939e] hover:bg-white",
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
                  <div className="rounded-[12px] border border-[#e7e7e4] p-3">
                    <div className="flex items-center gap-1.5">
                      <BookOpen className="h-3.5 w-3.5 text-[#0052fb]" />
                      <p className="text-[12px] font-semibold">{brain.materials.guide.title}</p>
                    </div>
                    <p className="mt-2 text-[12px] leading-5 text-[#697386]">{brain.materials.guide.summary}</p>
                  </div>
                ) : null}
                {!brain.materials.quiz && !brain.materials.flashcards && !brain.materials.guide ? (
                  <p className="text-[12.5px] text-[#8b939e]">
                    Drag out from the Brain node or use the buttons above to generate materials.
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
        accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void addSource(() => ingestTextFile(file));
        }}
      />

      {pasteOpen ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-[#18212f]/20 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-lg rounded-[16px] border border-[#e7e7e4] bg-white p-4 shadow-[0_20px_50px_rgba(24,33,47,0.12)]">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-semibold">Paste notes</p>
              <button type="button" onClick={() => setPasteOpen(false)} className="grid h-7 w-7 place-items-center rounded-full hover:bg-[#f1f3f7]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={8}
              placeholder="Paste lecture notes or extracted PDF text…"
              className="w-full resize-none rounded-[12px] border border-[#e7e7e4] bg-[#fbfbfa] px-3 py-2 text-[13px] outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setPasteOpen(false)} className="h-8 rounded-[8px] px-3 text-[12px] text-[#697386]">
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
                className="h-8 rounded-[8px] bg-[#0052fb] px-3 text-[12px] font-medium text-white"
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
