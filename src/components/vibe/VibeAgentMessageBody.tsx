"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  parseVibeAgentContent,
  sanitizeVibeAgentContent,
  type VibeParsedSegment,
} from "@/lib/parseVibeAgentContent";
import { extractCodeOutline } from "@/lib/extractCodeOutline";
import { MarkdownMessageContent } from "@/components/MarkdownMessageContent";
import { VibeThoughtPanel } from "./VibeThoughtPanel";
import { VibeAnalysingBanner } from "./VibeAnalysingBanner";
import { VibeMiniCodeBox } from "./VibeMiniCodeBox";
import { VibeRunBlock } from "./VibeRunBlock";
import { VibeTextLine } from "./VibeTextLine";
import { VibeFinalSummary, type SummaryFile } from "./VibeFinalSummary";
import { cn } from "@/lib/utils";

type StoredVibeFlowState = {
  activeStep: number;
  hadLiveStream: boolean;
};

const vibeFlowStateByMessage = new Map<string, StoredVibeFlowState>();

function getStoredFlowState(
  messageId?: string,
): StoredVibeFlowState | undefined {
  return messageId ? vibeFlowStateByMessage.get(messageId) : undefined;
}

function patchStoredFlowState(
  messageId: string | undefined,
  patch: Partial<StoredVibeFlowState>,
) {
  if (!messageId) return;
  const prev = vibeFlowStateByMessage.get(messageId) ?? {
    activeStep: 0,
    hadLiveStream: false,
  };
  vibeFlowStateByMessage.set(messageId, { ...prev, ...patch });
}

function findLastSegmentIndex(
  segments: VibeParsedSegment[],
  type: VibeParsedSegment["type"],
) {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.type === type) return i;
  }
  return -1;
}

/**
 * Orchestrates the visible Cursor-style agent stream.
 *
 * - Parses streamed content into ordered segments.
 * - Plays them strictly one-by-one.
 * - After the full timeline, shows the Summary (typed for the latest assistant reply), then
 *   notifies the parent so the live preview panel can open with the parsed file map.
 */
export function VibeAgentMessageBody({
  messageId,
  content,
  isStreaming,
  fontSizeClass,
  isLastAssistant,
  onVibePreviewReady,
}: {
  messageId?: string;
  content: string;
  isStreaming: boolean;
  fontSizeClass?: string;
  isLastAssistant?: boolean;
  onVibePreviewReady?: (
    messageId: string,
    filesByPath: Record<string, string>,
  ) => void;
}) {
  const safeContent = useMemo(
    () => sanitizeVibeAgentContent(content),
    [content],
  );
  const hasDelims = safeContent.includes("<<<VIBE_");
  const segments = useMemo(
    () => parseVibeAgentContent(safeContent),
    [safeContent],
  );
  const fallbackMarkdown = !hasDelims && content.length > 0;

  const isPlanMd = (seg: VibeParsedSegment) =>
    seg.type === "code" && /\bplan\.md\b/i.test(seg.file);

  const isTerminalThinking = (seg: VibeParsedSegment) => {
    if (seg.type !== "thinking") return false;
    const body = seg.body.trim().toUpperCase();
    return (
      body.startsWith("SHIPPED") ||
      body.startsWith("SELF-CRITIQUE") ||
      body.includes("PLAN.MD: COMPLETE")
    );
  };

  const blocks: VibeParsedSegment[] = useMemo(() => {
    const filtered = segments.filter((s) => {
      if (s.type === "text") {
        const text = s.body.trim();
        if (!text) return false;
        if (/^Done!\s+Here's what I built/i.test(text)) return false;
        return true;
      }
      if (isPlanMd(s)) return false;
      if (isTerminalThinking(s)) return false;
      return true;
    });
    const lastCodeIndex = findLastSegmentIndex(filtered, "code");
    const lastRunIndex = findLastSegmentIndex(filtered, "run");
    const timeline =
      !isStreaming && lastRunIndex > lastCodeIndex
        ? filtered.filter(
            (seg, i) => !(seg.type === "thinking" && i > lastRunIndex),
          )
        : filtered;
    if (isStreaming || timeline.length === 0) return timeline;
    return timeline.map((seg, i) => {
      if (i !== timeline.length - 1) return seg;
      if (seg.type === "text") return seg;
      return { ...seg, complete: true } as VibeParsedSegment;
    });
  }, [segments, isStreaming]);

  const storedAtMount = getStoredFlowState(messageId);
  const [activeStep, setActiveStep] = useState(
    () => storedAtMount?.activeStep ?? 0,
  );
  const advanceTimeoutRef = useRef<number | null>(null);
  const previewSentRef = useRef(false);
  /** True once this message has ever streamed; false for history/hydrated bubbles → show full timeline instantly. */
  const streamStartedRef = useRef(
    isStreaming || !!storedAtMount?.hadLiveStream,
  );

  useLayoutEffect(() => {
    if (!isStreaming) return;
    streamStartedRef.current = true;
    patchStoredFlowState(messageId, { hadLiveStream: true });
  }, [isStreaming, messageId]);

  useEffect(() => {
    const stored = getStoredFlowState(messageId);
    setActiveStep(stored?.activeStep ?? 0);
    streamStartedRef.current = isStreaming || !!stored?.hadLiveStream;
    previewSentRef.current = false;
    if (advanceTimeoutRef.current != null) {
      window.clearTimeout(advanceTimeoutRef.current);
      advanceTimeoutRef.current = null;
    }
  }, [messageId, isStreaming]);

  useEffect(() => {
    patchStoredFlowState(messageId, {
      activeStep,
      hadLiveStream: streamStartedRef.current,
    });
  }, [activeStep, messageId]);

  useEffect(
    () => () => {
      if (advanceTimeoutRef.current != null) {
        window.clearTimeout(advanceTimeoutRef.current);
        advanceTimeoutRef.current = null;
      }
    },
    [],
  );

  const summaryFiles = useMemo<SummaryFile[]>(() => {
    if (isStreaming) return [];
    const byPath = new Map<string, SummaryFile>();
    for (const seg of blocks) {
      if (seg.type !== "code" || !seg.complete) continue;
      if (!seg.body.trim()) continue;
      if (isPlanMd(seg)) continue;
      byPath.set(seg.file, {
        path: seg.file,
        added: seg.added,
        removed: seg.removed,
        exports: extractCodeOutline(seg.body),
      });
    }
    return Array.from(byPath.values());
  }, [blocks, isStreaming]);

  const filesByPath = useMemo(() => {
    const m: Record<string, string> = {};
    for (const seg of blocks) {
      if (
        seg.type === "code" &&
        seg.complete &&
        seg.body.trim() &&
        !isPlanMd(seg)
      ) {
        m[seg.file] = seg.body;
      }
    }
    return m;
  }, [blocks]);

  const handleSummaryPrinted = useCallback(() => {
    if (!isLastAssistant || !onVibePreviewReady || !messageId) return;
    if (Object.keys(filesByPath).length === 0) return;
    if (previewSentRef.current) return;
    previewSentRef.current = true;
    onVibePreviewReady(messageId, filesByPath);
  }, [isLastAssistant, onVibePreviewReady, messageId, filesByPath]);

  const allStepsDone = activeStep >= blocks.length;
  const isStaticHistory = !isStreaming && !streamStartedRef.current;
  const archived = isStaticHistory || allStepsDone;
  const showSummary =
    summaryFiles.length > 0 &&
    ((!isStreaming && allStepsDone) || isStaticHistory);

  useEffect(() => {
    if (!showSummary || isStaticHistory) return;
    const id = window.setTimeout(handleSummaryPrinted, 420);
    return () => window.clearTimeout(id);
  }, [handleSummaryPrinted, isStaticHistory, showSummary]);

  if (fallbackMarkdown) {
    return (
      <div className={cn("space-y-3", fontSizeClass)}>
        {isStreaming ? (
          <div
            className={cn(
              "whitespace-pre-wrap font-medium leading-relaxed",
              fontSizeClass,
            )}
          >
            {safeContent}
          </div>
        ) : (
          <MarkdownMessageContent
            content={safeContent}
            codeHighlighting
            codePresentation="soft"
            suppressCodeBlocks
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid w-full max-w-[940px] gap-4 lg:grid-cols-[minmax(0,640px)]",
        fontSizeClass,
      )}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {blocks.map((seg, i) => {
          if (!archived && i > activeStep) return null;
          const isActive = !archived && i === activeStep;
          const isLastSegment = i === blocks.length - 1;

          const advance = () => {
            if (advanceTimeoutRef.current != null) {
              window.clearTimeout(advanceTimeoutRef.current);
              advanceTimeoutRef.current = null;
            }
            const next = i + 1;
            const prevType = blocks[i]?.type;
            const prevSeg = blocks[i];
            const nextSeg = blocks[next];
            const pauseBeforeNarration =
              nextSeg?.type === "text" &&
              (prevType === "thinking" ||
                prevType === "code" ||
                prevType === "run" ||
                prevType === "analyze");

            const go = () => {
              setActiveStep((s) => (s === i ? next : s));
            };

            // Code blocks: when segmentComplete flips true, dwell at least 800ms
            const codeJustFinished =
              prevSeg?.type === "code" &&
              prevSeg?.complete &&
              next < blocks.length;

            if (pauseBeforeNarration && next < blocks.length) {
              advanceTimeoutRef.current = window.setTimeout(() => {
                advanceTimeoutRef.current = null;
                go();
              }, 120);
            } else if (codeJustFinished) {
              // Code block collapsed — dwell before next step
              advanceTimeoutRef.current = window.setTimeout(() => {
                advanceTimeoutRef.current = null;
                go();
              }, 1000);
            } else {
              go();
            }
          };

          const key = `step-${i}-${seg.type}`;
          switch (seg.type) {
            case "thinking":
              return (
                <VibeThoughtPanel
                  key={key}
                  body={seg.body}
                  complete={seg.complete}
                  active={isActive}
                  archived={archived}
                  onCollapsed={archived ? undefined : advance}
                />
              );
            case "analyze": {
              return (
                <VibeAnalysingBanner
                  key={key}
                  path={seg.path}
                  active={isActive}
                  archived={archived}
                  onCompleted={archived ? undefined : advance}
                />
              );
            }
            case "code":
              return (
                <VibeMiniCodeBox
                  key={key}
                  file={seg.file}
                  added={seg.added}
                  removed={seg.removed}
                  code={seg.body}
                  segmentComplete={seg.complete}
                  active={isActive}
                  archived={archived}
                  onCollapsed={archived ? undefined : advance}
                />
              );
            case "run":
              return (
                <VibeRunBlock
                  key={key}
                  body={seg.body}
                  segmentComplete={seg.complete}
                  active={isActive}
                  archived={archived}
                  onCollapsed={archived ? undefined : advance}
                />
              );
            case "text": {
              const textComplete = !isLastSegment || !isStreaming;
              return (
                <VibeTextLine
                  key={key}
                  body={seg.body.trim()}
                  complete={textComplete}
                  active={isActive}
                  archived={archived}
                  onCompleted={archived ? undefined : advance}
                />
              );
            }
            default:
              return null;
          }
        })}

        {showSummary ? (
          <VibeFinalSummary
            files={summaryFiles}
            skipTyping={isStaticHistory}
            onFullyPrinted={isLastAssistant ? handleSummaryPrinted : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}
