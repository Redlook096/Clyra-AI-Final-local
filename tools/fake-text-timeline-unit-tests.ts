import assert from "node:assert/strict";
import {
  IMESSAGE_CANVAS,
  IMESSAGE_TOKENS,
  buildIMessageTimeline,
  estimateIMessageBubbleHeight,
  estimateIMessageLines,
  getIMessageFloatingPanelGeometry,
  getIMessageFrame,
  getIMessageGroupPosition,
  getIMessagePanelLayout,
  getTypingDotPhase,
  type IMessageScriptMessage,
} from "../src/lib/fakeTextTimeline";

let assertions = 0;

function equal<T>(actual: T, expected: T, message?: string) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  assertions += 1;
}

const fixture: IMessageScriptMessage[] = [
  { id: "incoming-one", side: "left", text: "Hey — are you still coming tonight?", typingSeconds: 0.42, pauseSeconds: 0.16, narration: true },
  { id: "incoming-two", side: "left", text: "I found something you need to see first.", typingSeconds: 0.34, pauseSeconds: 0.12, narration: true },
  { id: "outgoing-one", side: "right", text: "Send it over. I am on my way. ✨", typingSeconds: 0.55, pauseSeconds: 0.18, narration: true },
  {
    id: "incoming-long",
    side: "left",
    text: "It is a long message designed to wrap across several lines without changing the layout halfway through the bubble entrance animation.",
    typingSeconds: 0.7,
    pauseSeconds: 0.24,
    narration: true,
  },
  { id: "outgoing-silent", side: "right", text: "I am listening.", typingSeconds: 0.3, pauseSeconds: 0.1, narration: false },
];

const first = buildIMessageTimeline(fixture);
const second = buildIMessageTimeline(fixture);

equal(IMESSAGE_CANVAS.width, 1080, "The logical iMessage canvas must remain 1080px wide");
equal(IMESSAGE_CANVAS.height, 1920, "The logical iMessage canvas must remain 1920px high");
equal(IMESSAGE_TOKENS.floatingPanelSideInset, 126, "The floating card must remain 76.7% wide on a 1080px export");
equal(IMESSAGE_TOKENS.floatingPanelTopInset, 211, "The floating card must sit approximately 11% down the gameplay frame");
equal(IMESSAGE_TOKENS.headerHeight, 152, "The header must use the compact iMessage export height");
check(IMESSAGE_TOKENS.bubbleEntranceMs > 0, "Messages must enter with a brief, precise iOS-style pop");
equal(JSON.stringify(first), JSON.stringify(second), "The timeline must be deterministic for the same script");
equal(first.events.length, fixture.length, "Each script message needs exactly one event");
check(first.durationMs > first.events.at(-1)!.bubbleEndMs, "Timeline duration must include the final hold");

for (const [index, event] of first.events.entries()) {
  check(event.typingStartMs <= event.typingEndMs, `Event ${index} typing must be ordered`);
  check(event.typingEndMs - event.typingStartMs >= IMESSAGE_TOKENS.typingMinimumMs, `Event ${index} typing must respect the minimum beat`);
  check(event.typingEndMs - event.typingStartMs <= IMESSAGE_TOKENS.typingMaximumMs, `Event ${index} typing must never stall past the maximum beat`);
  check(event.typingEndMs === event.bubbleStartMs, `Event ${index} bubble must start after typing`);
  check(event.bubbleStartMs <= event.bubbleEndMs, `Event ${index} bubble entrance must be ordered`);
  check(event.voiceStartMs > event.bubbleStartMs, `Event ${index} voice must begin slightly after its bubble commits`);
  check(event.voiceEndMs >= event.voiceStartMs, `Event ${index} voice must be ordered`);
  check(event.endMs >= event.bubbleEndMs, `Event ${index} must remain visible after entering`);
  if (index) check(event.typingStartMs >= first.events[index - 1]!.endMs, `Event ${index} must begin after the previous event ends`);
}

const beforeFirst = getIMessageFrame(first, 0);
equal(beforeFirst.visibleCount, 0, "The first bubble must not appear before its typing beat finishes");
equal(beforeFirst.typingSide, "left", "The first message's typing indicator must show its sender's side");

const midTyping = getIMessageFrame(first, first.events[0]!.typingStartMs + 1);
equal(midTyping.typingSide, "left", "The typing indicator must persist for the full typing window");
equal(midTyping.typingStartMs, first.events[0]!.typingStartMs, "The frame must report which event's typing beat is active");
check(getTypingDotPhase(first.events[0]!.typingStartMs + 50, first.events[0]!.typingStartMs).every((value) => value >= 0 && value <= 1), "Typing dot phases must stay within a normalized 0..1 range");

const firstBubble = getIMessageFrame(first, first.events[0]!.bubbleStartMs + 1);
equal(firstBubble.visibleCount, 1, "The first bubble should appear exactly at its bubble start");
equal(firstBubble.enteringMessageId, fixture[0]!.id, "A freshly committed bubble must report itself as entering");
check(firstBubble.entranceProgress < 1, "The entrance animation must be mid-flight one millisecond after it starts");

const settledBubble = getIMessageFrame(first, first.events[0]!.bubbleEndMs + 1);
equal(settledBubble.enteringMessageId, null, "A bubble stops entering once its animation window elapses");
equal(settledBubble.entranceProgress, 1, "A settled bubble must report full entrance progress");

const grouped = [
  getIMessageGroupPosition(fixture, 0),
  getIMessageGroupPosition(fixture, 1),
  getIMessageGroupPosition(fixture, 2),
  getIMessageGroupPosition(fixture, 3),
  getIMessageGroupPosition(fixture, 4),
];
equal(JSON.stringify(grouped), JSON.stringify(["start", "end", "single", "single", "single"]), "Adjacent same-sender messages must form a deterministic group");

const finalFrame = getIMessageFrame(first, first.durationMs);
equal(finalFrame.visibleCount, fixture.length, "Every bubble should be visible at the end of the conversation");
equal(finalFrame.typingSide, null, "No typing indicator should remain after completion");

const receiptFixture: IMessageScriptMessage[] = [
  { id: "them-1", side: "left", text: "you there?", pauseSeconds: 0.2 },
  { id: "me-1", side: "right", text: "yeah what's up", pauseSeconds: 3 },
];
const receiptTimeline = buildIMessageTimeline(receiptFixture);
const meEvent = receiptTimeline.events[1]!;
const beforeDelivered = getIMessageFrame(receiptTimeline, meEvent.voiceEndMs + IMESSAGE_TOKENS.readReceiptDelayMs - 20);
equal(beforeDelivered.showReadReceipt, false, "A receipt must not appear before its delay elapses");
const delivered = getIMessageFrame(receiptTimeline, meEvent.voiceEndMs + IMESSAGE_TOKENS.readReceiptDelayMs + 20);
equal(delivered.readReceiptLabel, "delivered", "A fresh outgoing bubble should read Delivered first");
equal(delivered.readReceiptMessageId, "me-1", "The receipt must anchor to the newest outgoing bubble");
const read = getIMessageFrame(receiptTimeline, meEvent.voiceEndMs + IMESSAGE_TOKENS.readReceiptDelayMs * 2 + 20);
equal(read.readReceiptLabel, "read", "A receipt should advance from Delivered to Read after a longer pause");

equal(estimateIMessageLines("Short message"), 1, "Short messages should occupy one estimated line");
check(estimateIMessageLines(fixture[3]!.text) > 1, "Long messages should wrap predictably before layout animation");
check(estimateIMessageBubbleHeight(fixture[3]!.text) > estimateIMessageBubbleHeight("Short message"), "Long messages must reserve more bubble height before entering");
check(estimateIMessageLines("https://example.com/this-is-a-deliberately-unbroken-token-that-must-not-overflow-the-bubble", 18) >= 4, "Long unbroken text must reserve wrapped lines before animation");

const singleMessageLayout = getIMessagePanelLayout([fixture[0]!]);
check(singleMessageLayout.panelHeight < IMESSAGE_TOKENS.floatingPanelMaxHeight, "A short conversation must fit its content rather than reserve a giant fixed sheet");
equal(
  singleMessageLayout.naturalHeight,
  IMESSAGE_TOKENS.headerHeight
    + IMESSAGE_TOKENS.messageTopInset
    + estimateIMessageBubbleHeight(fixture[0]!.text)
    + IMESSAGE_TOKENS.messageBottomInset,
  "The sheet footer must sit immediately after a short final message",
);
const singleMessageGeometry = getIMessageFloatingPanelGeometry(singleMessageLayout);
check(singleMessageGeometry.x > 0, "A floating iMessage sheet must reveal gameplay at its left edge");
check(singleMessageGeometry.width < IMESSAGE_CANVAS.width, "A floating iMessage sheet must never cover the entire gameplay canvas");
equal(singleMessageGeometry.width, 828, "The floating card must occupy approximately 76.7% of a 1080px export");
equal(singleMessageGeometry.x, IMESSAGE_CANVAS.width - singleMessageGeometry.x - singleMessageGeometry.width, "Floating sheet gutters must remain balanced on both sides");
equal(singleMessageGeometry.y, IMESSAGE_TOKENS.floatingPanelTopInset, "Floating sheet top inset must come from shared geometry");
equal(singleMessageGeometry.height, singleMessageLayout.panelHeight, "A short sheet geometry must preserve the content-fit panel height");
check(
  singleMessageGeometry.y + singleMessageGeometry.height < IMESSAGE_CANVAS.height - IMESSAGE_TOKENS.latestMessageBottomGap,
  "The content-fit sheet must leave gameplay visible below its divider",
);
const settledLayout = getIMessagePanelLayout([fixture[0]!], { enteringProgress: 0.5 });
equal(settledLayout.panelHeight, singleMessageLayout.panelHeight, "The lower edge must not animate separately from the new bubble");
const overflowingLayout = getIMessagePanelLayout(Array.from({ length: 30 }, (_, index) => ({ id: `overflow-${index}`, side: index % 2 ? "right" as const : "left" as const, text: "A deliberately complete sentence that must remain readable while the panel scrolls." })));
equal(overflowingLayout.panelHeight, overflowingLayout.maxPanelHeight, "A genuinely long conversation must cap the sheet and use scroll instead of covering gameplay");
check(overflowingLayout.isOverflowing, "The layout must explicitly report when scrolling is required");

const noNarrationTimeline = buildIMessageTimeline([{ id: "silent", side: "left", text: "No voice", typingSeconds: 0.2, pauseSeconds: 0, narration: false }]);
equal(noNarrationTimeline.events[0]!.voiceEndMs, noNarrationTimeline.events[0]!.voiceStartMs, "Non-narrated messages must not reserve synthetic voice duration");

console.log(`fake-text-timeline-unit-tests: ${assertions} assertions passed`);
