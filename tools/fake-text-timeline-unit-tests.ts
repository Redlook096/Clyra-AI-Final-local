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
equal(IMESSAGE_TOKENS.floatingPanelSideInset, 135, "The floating card must remain 810px wide on a 1080px export");
equal(IMESSAGE_TOKENS.floatingPanelTopInset, 205, "The floating card must retain the compact upper-video placement");
equal(IMESSAGE_TOKENS.headerHeight, 155, "The header must use the compact iMessage export height");
equal(IMESSAGE_TOKENS.bubbleEntranceMs, 0, "Messages must enter as settled bubbles without flicker");
equal(JSON.stringify(first), JSON.stringify(second), "The timeline must be deterministic for the same script");
equal(first.events.length, fixture.length, "Each script message needs exactly one event");
check(first.durationMs > first.events.at(-1)!.bubbleEndMs, "Timeline duration must include the final hold");

for (const [index, event] of first.events.entries()) {
  check(event.typingStartMs <= event.typingEndMs, `Event ${index} typing must be ordered`);
  check(event.typingEndMs === event.bubbleStartMs, `Event ${index} bubble must start after typing`);
  check(event.bubbleStartMs <= event.bubbleEndMs, `Event ${index} bubble entrance must be ordered`);
  check(event.voiceStartMs === event.bubbleStartMs, `Event ${index} voice must begin with its bubble`);
  check(event.voiceEndMs >= event.voiceStartMs, `Event ${index} voice must be ordered`);
  check(event.endMs >= event.bubbleEndMs, `Event ${index} must remain visible after entering`);
  if (index) check(event.typingStartMs >= first.events[index - 1]!.endMs, `Event ${index} must begin after the previous event ends`);
}

const beforeFirst = getIMessageFrame(first, 0);
equal(beforeFirst.visibleCount, 1, "The first bubble should start immediately without a typing animation");
equal(beforeFirst.typingSide, null, "Typing indicators are intentionally disabled for fake-text stories");

const firstBubble = getIMessageFrame(first, first.events[0]!.bubbleStartMs + 1);
equal(firstBubble.visibleCount, 1, "The first bubble should appear exactly at its bubble start");
equal(firstBubble.enteringMessageId, null, "The settled bubble must not run an entrance animation");
equal(firstBubble.entranceProgress, 1, "The card height must commit in the same frame as the new message");

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
equal(finalFrame.showReadReceipt, false, "Read receipts are intentionally disabled for fake-text stories");

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
equal(singleMessageGeometry.width, 810, "The floating card must occupy 75% of a 1080px export");
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
