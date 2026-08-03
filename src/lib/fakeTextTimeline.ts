/**
 * The fake-text preview and renderer both use this module as their source of
 * truth. Keeping timing and grouping here makes a paused preview, a seek, and
 * an exported frame describe the exact same conversation state.
 */

export type IMessageSide = "left" | "right";

export type IMessageScriptMessage = {
  id: string;
  side: IMessageSide;
  text: string;
  typingSeconds?: number;
  pauseSeconds?: number;
  narration?: boolean;
  /** Actual duration returned by Clyra TTS during export, when available. */
  voiceDurationMs?: number;
};

export type IMessageGroupPosition = "single" | "start" | "middle" | "end";

export type IMessageTimelineEvent = {
  id: string;
  index: number;
  side: IMessageSide;
  typingStartMs: number;
  typingEndMs: number;
  bubbleStartMs: number;
  bubbleEndMs: number;
  voiceStartMs: number;
  voiceEndMs: number;
  endMs: number;
};

export type IMessageTimeline = {
  events: IMessageTimelineEvent[];
  durationMs: number;
};

export type IMessageFrame = {
  visibleCount: number;
  typingSide: IMessageSide | null;
  enteringMessageId: string | null;
  entranceProgress: number;
  activeMessageId: string | null;
  showReadReceipt: boolean;
};

/**
 * A compact, deterministic description of the visible iMessage sheet.  Both
 * the DOM preview and the export renderer consume this instead of deciding a
 * panel height independently.  That is important for the Fake Text layout:
 * the bottom edge should follow the latest message, revealing gameplay below,
 * until the conversation genuinely needs a scrolling surface.
 */
export type IMessagePanelLayout = {
  /** Natural content height before the conversation is capped for overflow. */
  naturalHeight: number;
  /** Final iMessage sheet height on the shared 1080 × 1920 logical canvas. */
  panelHeight: number;
  /** The maximum floating-sheet height before the timeline scrolls. */
  maxPanelHeight: number;
  isOverflowing: boolean;
};

/**
 * The floating sheet is deliberately narrower than the 9:16 story canvas.
 * Keeping this geometry here means the browser preview and exported movie
 * reveal exactly the same gameplay margin on either side of the iMessage
 * surface.
 */
export type IMessageFloatingPanelGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

// Logical 9:16 canvas dimensions. Preview surfaces scale this uniformly instead
// of independently reflowing bubbles, text, icons, and safe areas.
export const IMESSAGE_CANVAS = Object.freeze({ width: 1080, height: 1920 });

export const IMESSAGE_TOKENS = Object.freeze({
  topInset: 205,
  // The floating conversation is an overlay on top of gameplay, not a full
  // screen phone mock-up. These gutters make that relationship obvious while
  // leaving enough room for a natural iMessage bubble width.
  floatingPanelTopInset: 205,
  floatingPanelSideInset: 135,
  floatingPanelRadius: 28,
  headerHeight: 155,
  sideInset: 20,
  headerSideInset: 26,
  messageTopInset: 16,
  messageBottomInset: 14,
  // These values intentionally describe a 1080px logical iMessage canvas.
  // The DOM preview and the 720px canvas renderer both scale them as a whole,
  // which keeps the small, dense FrameLabs-style message geometry intact.
  // Around 60% of the compact floating surface. This keeps long text
  // recognisably iMessage-sized instead of turning the overlay into a web
  // chat panel.
  bubbleMaxWidth: 490,
  bubbleMinimumHeight: 64,
  bubbleHorizontalPadding: 16,
  bubbleVerticalPadding: 9,
  bubbleRadius: 18,
  sameSenderGap: 9,
  senderSwitchGap: 10,
  messageLineHeight: 30,
  messageFontSize: 25,
  typingMinimumMs: 0,
  typingMaximumMs: 0,
  // The iMessage card is deliberately a stable recording surface.  A new
  // message appears as a settled bubble and the card's lower edge advances in
  // the same frame.  There is no opacity/scale/list reflow animation to
  // flicker during export or after a scrub.
  bubbleEntranceMs: 0,
  readReceiptDelayMs: 0,
  // The reference uses clean rounded bubbles. Keep the former token for
  // older consumers, but it deliberately produces no tail geometry.
  tailSize: 0,
  latestMessageBottomGap: 14,
  // Keep a generous playable area below the sheet.  Once content crosses this
  // limit the message list scrolls rather than covering the gameplay layer.
  floatingPanelMaxHeight: 900,
  emptyPanelBodyHeight: 52,
  typingIndicatorHeight: 0,
  readReceiptHeight: 0,
  estimatedCharactersPerLine: 38,
} as const);

function speechDurationMs(message: IMessageScriptMessage) {
  if (message.narration === false) return 0;
  const measured = Number(message.voiceDurationMs);
  if (Number.isFinite(measured) && measured > 0) return measured;
  return Math.max(850, message.text.trim().split(/\s+/).filter(Boolean).length * 310);
}

/** Build a deterministic sequential timeline; no CSS timer is needed to infer state. */
export function buildIMessageTimeline(messages: IMessageScriptMessage[], playbackRate = 1): IMessageTimeline {
  const rate = Math.max(0.6, Math.min(1.8, Number.isFinite(playbackRate) ? playbackRate : 1));
  let cursor = 0;
  const events = messages.map((message, index) => {
    // Messages enter directly. The exported fake-text format intentionally has
    // no typing bubbles or read receipts, so audio, bubble, and layout all use
    // the same deterministic start time.
    const typingStartMs = cursor;
    const typingEndMs = typingStartMs;
    const bubbleStartMs = cursor;
    const bubbleEndMs = bubbleStartMs + IMESSAGE_TOKENS.bubbleEntranceMs;
    const voiceStartMs = bubbleStartMs;
    const voiceEndMs = voiceStartMs + speechDurationMs(message) / rate;
    // A message stays on screen for its narration (when any), then its authored pause.
    const endMs = Math.max(bubbleEndMs, voiceEndMs) + Math.max(0, Number(message.pauseSeconds ?? 0.25) * 1_000) / rate;
    cursor = endMs;
    return { id: message.id, index, side: message.side, typingStartMs, typingEndMs, bubbleStartMs, bubbleEndMs, voiceStartMs, voiceEndMs, endMs };
  });
  return { events, durationMs: Math.max(1_000, cursor) };
}

export function getIMessageFrame(timeline: IMessageTimeline, timeMs: number): IMessageFrame {
  const safeTime = Math.max(0, Math.min(timeline.durationMs, Number.isFinite(timeMs) ? timeMs : 0));
  const visible = timeline.events.filter((event) => safeTime >= event.bubbleStartMs);
  const active = timeline.events.find((event) => safeTime >= event.typingStartMs && safeTime < event.endMs) || null;
  const entering = IMESSAGE_TOKENS.bubbleEntranceMs > 0
    ? timeline.events.find((event) => safeTime >= event.bubbleStartMs && safeTime < event.bubbleEndMs) || null
    : null;
  // iMessage states are discrete: the new bubble and its compact body height
  // commit at one media timestamp.  This keeps all existing bubbles fixed and
  // prevents a CSS/canvas transition from producing visible flicker.
  const entranceProgress = 1;
  return {
    visibleCount: visible.length,
    typingSide: null,
    enteringMessageId: entering?.id || null,
    entranceProgress,
    activeMessageId: active?.id || null,
    showReadReceipt: false,
  };
}

export function getIMessageGroupPosition(messages: IMessageScriptMessage[], index: number): IMessageGroupPosition {
  const current = messages[index];
  if (!current) return "single";
  const sameBefore = messages[index - 1]?.side === current.side;
  const sameAfter = messages[index + 1]?.side === current.side;
  if (!sameBefore && !sameAfter) return "single";
  if (!sameBefore) return "start";
  if (!sameAfter) return "end";
  return "middle";
}

/**
 * Computes a content-fit floating conversation sheet for the visible message
 * window.  The caller supplies only messages currently eligible to render so
 * a seek, an entrance frame, and an exported frame always agree on where the
 * bottom divider belongs.
 */
export function getIMessagePanelLayout(
  messages: IMessageScriptMessage[],
  options: {
    /**
     * Retained for callers compiled against an older renderer.  The iMessage
     * story intentionally commits new messages atomically, so this value has
     * no effect on geometry.
     */
    enteringProgress?: number;
    maxPanelHeight?: number;
  } = {},
): IMessagePanelLayout {
  // Keep this one-to-one with the render list. A temporarily blank message is
  // still an editable timeline item and therefore reserves a minimal bubble;
  // filtering it here would make the preview and export disagree while the
  // user edits text.
  const shown = messages;
  const messageHeight = shown.reduce((total, message, index) => {
    const contribution = estimateIMessageBubbleHeight(message.text);
    if (!index) return total + contribution;
    const previous = shown[index - 1]!;
    const gap = previous.side === message.side
      ? IMESSAGE_TOKENS.sameSenderGap
      : IMESSAGE_TOKENS.senderSwitchGap;
    return total + gap + contribution;
  }, 0);
  const bodyHeight = shown.length
    ? IMESSAGE_TOKENS.messageTopInset + messageHeight + IMESSAGE_TOKENS.messageBottomInset
    : IMESSAGE_TOKENS.emptyPanelBodyHeight;
  const naturalHeight = IMESSAGE_TOKENS.headerHeight + bodyHeight;
  const maxPanelHeight = Math.max(
    IMESSAGE_TOKENS.headerHeight + IMESSAGE_TOKENS.emptyPanelBodyHeight,
    Math.min(
      IMESSAGE_CANVAS.height - IMESSAGE_TOKENS.floatingPanelTopInset - IMESSAGE_TOKENS.latestMessageBottomGap,
      options.maxPanelHeight ?? IMESSAGE_TOKENS.floatingPanelMaxHeight,
    ),
  );
  const panelHeight = Math.min(naturalHeight, maxPanelHeight);
  return {
    naturalHeight,
    panelHeight,
    maxPanelHeight,
    isOverflowing: naturalHeight > maxPanelHeight,
  };
}

/**
 * Convert a content-fit sheet height into the one shared logical geometry.
 * Its bottom edge is driven exclusively by the latest visible message while
 * its horizontal gutters keep gameplay visible.
 */
export function getIMessageFloatingPanelGeometry(
  layout: Pick<IMessagePanelLayout, "panelHeight"> | number,
): IMessageFloatingPanelGeometry {
  const requestedHeight = typeof layout === "number" ? layout : layout.panelHeight;
  const x = IMESSAGE_TOKENS.floatingPanelSideInset;
  const y = IMESSAGE_TOKENS.floatingPanelTopInset;
  const width = IMESSAGE_CANVAS.width - x * 2;
  const minimumHeight = IMESSAGE_TOKENS.headerHeight + IMESSAGE_TOKENS.emptyPanelBodyHeight;
  const maximumHeight = IMESSAGE_CANVAS.height - y - IMESSAGE_TOKENS.latestMessageBottomGap;

  return {
    x,
    y,
    width,
    height: Math.max(minimumHeight, Math.min(maximumHeight, requestedHeight)),
    radius: IMESSAGE_TOKENS.floatingPanelRadius,
  };
}

/** A stable, content-only estimate used before DOM/canvas text measurement is available. */
export function estimateIMessageLines(text: string, maxCharactersPerLine = IMESSAGE_TOKENS.estimatedCharactersPerLine) {
  const safeWidth = Math.max(1, Math.floor(maxCharactersPerLine));
  const paragraphs = String(text ?? "").split(/\r?\n/);
  let lines = 0;

  for (const paragraph of paragraphs) {
    let remaining = paragraph.trim();
    if (!remaining) {
      lines += 1;
      continue;
    }

    // Prefer word boundaries, but split an unbroken URL, identifier, or emoji
    // sequence predictably as well.  The DOM preview uses overflow-wrap and
    // the canvas renderer uses the same fallback, so measurement cannot claim
    // a one-line bubble that later overflows the viewport.
    while (remaining.length > safeWidth) {
      const boundary = remaining.lastIndexOf(" ", safeWidth);
      const cutAt = boundary > 0 ? boundary : safeWidth;
      lines += 1;
      remaining = remaining.slice(cutAt).trimStart();
    }
    lines += 1;
  }

  return Math.max(1, lines);
}

export function estimateIMessageBubbleHeight(text: string) {
  return Math.max(
    IMESSAGE_TOKENS.bubbleMinimumHeight,
    IMESSAGE_TOKENS.bubbleVerticalPadding * 2 + estimateIMessageLines(text) * IMESSAGE_TOKENS.messageLineHeight,
  );
}
