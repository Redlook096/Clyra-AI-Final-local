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
  /** Set false to skip the typing-dots beat before this bubble commits. */
  showTyping?: boolean;
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
  typingStartMs: number | null;
  enteringMessageId: string | null;
  entranceProgress: number;
  activeMessageId: string | null;
  showReadReceipt: boolean;
  readReceiptMessageId: string | null;
  readReceiptLabel: "delivered" | "read" | null;
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
  floatingPanelTopInset: 211,
  floatingPanelSideInset: 126,
  floatingPanelRadius: 36,
  headerHeight: 152,
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
  bubbleMaxWidth: 530,
  bubbleMinimumHeight: 48,
  bubbleHorizontalPadding: 16,
  bubbleVerticalPadding: 11,
  bubbleRadius: 27,
  sameSenderGap: 12,
  senderSwitchGap: 13,
  messageLineHeight: 27,
  messageFontSize: 24,
  // A short reply types fast; a long dramatic line lingers a little longer.
  // Both bounds keep pacing fast enough for short-form video (see spec: never
  // stall on typing dots for more than ~1.5s).
  typingMinimumMs: 350,
  typingMaximumMs: 1500,
  typingBaseMs: 260,
  typingPerCharacterMs: 22,
  // Every bubble commits with a brief, precise iOS-style pop: opacity/scale/
  // translateY interpolated from a pure function of time (see
  // getIMessageFrame), so a scrub or an exported frame reproduces the exact
  // same mid-entrance state as continuous playback.
  bubbleEntranceMs: 220,
  bubbleEntranceRiseDistance: 8,
  bubbleEntranceStartScale: 0.93,
  readReceiptDelayMs: 400,
  // Small rounded notch on the last bubble of a consecutive-sender group.
  tailSize: 8,
  latestMessageBottomGap: 14,
  // Keep a generous playable area below the sheet.  Once content crosses this
  // limit the message list scrolls rather than covering the gameplay layer.
  floatingPanelMaxHeight: 900,
  emptyPanelBodyHeight: 52,
  typingIndicatorHeight: 44,
  readReceiptHeight: 22,
  estimatedCharactersPerLine: 38,
} as const);

function speechDurationMs(message: IMessageScriptMessage) {
  if (message.narration === false) return 0;
  const measured = Number(message.voiceDurationMs);
  if (Number.isFinite(measured) && measured > 0) return measured;
  return Math.max(850, message.text.trim().split(/\s+/).filter(Boolean).length * 310);
}

/** Short replies type fast, long dramatic lines linger a little — clamped so the
 * viewer never stares at typing dots for more than ~1.5s. */
function typingDurationMs(message: IMessageScriptMessage) {
  if (message.showTyping === false) return 0;
  const characters = message.text.trim().length;
  return Math.min(
    IMESSAGE_TOKENS.typingMaximumMs,
    Math.max(IMESSAGE_TOKENS.typingMinimumMs, IMESSAGE_TOKENS.typingBaseMs + characters * IMESSAGE_TOKENS.typingPerCharacterMs),
  );
}

function easeOutCubic(t: number) {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** Build a deterministic sequential timeline; no CSS timer is needed to infer state. */
export function buildIMessageTimeline(
  messages: IMessageScriptMessage[],
  playbackRate = 1,
  options: { showTypingIndicator?: boolean } = {},
): IMessageTimeline {
  const rate = Math.max(0.6, Math.min(1.8, Number.isFinite(playbackRate) ? playbackRate : 1));
  let cursor = 0;
  const events = messages.map((message, index) => {
    const typingStartMs = cursor;
    const typingEndMs = typingStartMs + (options.showTypingIndicator === false ? 0 : typingDurationMs(message)) / rate;
    const bubbleStartMs = typingEndMs;
    const bubbleEndMs = bubbleStartMs + IMESSAGE_TOKENS.bubbleEntranceMs / rate;
    // The bubble is on screen fractionally before its narration starts, so the
    // viewer can begin reading as the voice begins (spec: 30-90ms lead).
    const voiceStartMs = bubbleStartMs + 60 / rate;
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
  const typing = timeline.events.find((event) => safeTime >= event.typingStartMs && safeTime < event.typingEndMs) || null;
  const entering = timeline.events.find((event) => safeTime >= event.bubbleStartMs && safeTime < event.bubbleEndMs) || null;
  const entranceProgress = entering
    ? easeOutCubic((safeTime - entering.bubbleStartMs) / Math.max(1, entering.bubbleEndMs - entering.bubbleStartMs))
    : 1;

  // The read receipt belongs to the newest outgoing bubble, and only while it
  // remains the newest message on screen (a following typing beat retires it).
  const lastVisible = visible[visible.length - 1] || null;
  let readReceiptMessageId: string | null = null;
  let readReceiptLabel: "delivered" | "read" | null = null;
  if (lastVisible && lastVisible.side === "right") {
    const nextEvent = timeline.events[lastVisible.index + 1];
    const stillNewest = !nextEvent || safeTime < nextEvent.typingStartMs;
    if (stillNewest) {
      const sinceVoiceEnd = safeTime - lastVisible.voiceEndMs;
      if (sinceVoiceEnd >= IMESSAGE_TOKENS.readReceiptDelayMs * 2) readReceiptLabel = "read";
      else if (sinceVoiceEnd >= IMESSAGE_TOKENS.readReceiptDelayMs) readReceiptLabel = "delivered";
      if (readReceiptLabel) readReceiptMessageId = lastVisible.id;
    }
  }

  return {
    visibleCount: visible.length,
    typingSide: typing?.side ?? null,
    typingStartMs: typing?.typingStartMs ?? null,
    enteringMessageId: entering?.id || null,
    entranceProgress,
    activeMessageId: active?.id || null,
    showReadReceipt: readReceiptLabel !== null,
    readReceiptMessageId,
    readReceiptLabel,
  };
}

/** Deterministic, tiny vertical bounce for each of the three typing dots — a
 * pure function of time so the DOM preview and the canvas export always agree. */
export function getTypingDotPhase(timeMs: number, typingStartMs: number): [number, number, number] {
  const elapsed = Math.max(0, timeMs - typingStartMs);
  const cycleMs = 900;
  const staggerMs = 140;
  return [0, 1, 2].map((dot) => {
    const phase = ((elapsed - dot * staggerMs) % cycleMs + cycleMs) % cycleMs;
    return Math.max(0, Math.sin((phase / cycleMs) * Math.PI * 2));
  }) as [number, number, number];
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
    /** A visible typing-dots row reserves space like a trailing bubble. */
    typingSide?: IMessageSide | null;
    /** A visible "Delivered"/"Read" caption reserves a thin trailing row. */
    showReadReceipt?: boolean;
  } = {},
): IMessagePanelLayout {
  // Keep this one-to-one with the render list. A temporarily blank message is
  // still an editable timeline item and therefore reserves a minimal bubble;
  // filtering it here would make the preview and export disagree while the
  // user edits text.
  const shown = messages;
  let messageHeight = shown.reduce((total, message, index) => {
    const contribution = estimateIMessageBubbleHeight(message.text);
    if (!index) return total + contribution;
    const previous = shown[index - 1]!;
    const gap = previous.side === message.side
      ? IMESSAGE_TOKENS.sameSenderGap
      : IMESSAGE_TOKENS.senderSwitchGap;
    return total + gap + contribution;
  }, 0);
  if (options.typingSide) {
    messageHeight += (shown.length ? IMESSAGE_TOKENS.senderSwitchGap : 0) + IMESSAGE_TOKENS.typingIndicatorHeight;
  } else if (options.showReadReceipt) {
    messageHeight += IMESSAGE_TOKENS.readReceiptHeight;
  }
  const bodyHeight = shown.length || options.typingSide
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
