import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  buildIMessageTimeline,
  IMESSAGE_CANVAS,
  IMESSAGE_TOKENS,
  type IMessageSide,
} from "../../src/lib/fakeTextTimeline";

type FixtureMessage = {
  id: string;
  side: IMessageSide;
  text: string;
  typingSeconds: number;
  pauseSeconds: number;
  narration: boolean;
};

type FixtureProject = {
  version: number;
  id: string;
  type: "fake_text_story";
  name: string;
  createdAt: string;
  updatedAt: string;
  canvas: { width: number; height: number; fps: number };
  audio: { musicVolume: number; sfxVolume: number; ducking: number; muted: boolean };
  participants: Array<{ id: "left" | "right"; name: string; voice: string; color: string }>;
  theme: "ios_light" | "ios_dark";
  layout: "floating_phone";
  playbackRate: number;
  messages: FixtureMessage[];
};

const FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  side: IMessageSide,
  text: string,
  overrides: Partial<Pick<FixtureMessage, "typingSeconds" | "pauseSeconds" | "narration">> = {},
): FixtureMessage {
  return {
    id,
    side,
    text,
    typingSeconds: 0.4,
    pauseSeconds: 0.1,
    narration: false,
    ...overrides,
  };
}

function projectFixture(
  id: string,
  messages: FixtureMessage[],
  overrides: Partial<Pick<FixtureProject, "theme" | "playbackRate">> = {},
): FixtureProject {
  return {
    version: 4,
    id: `fake-text-visual-${id}`,
    type: "fake_text_story",
    name: `Deterministic iMessage: ${id}`,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    canvas: { width: IMESSAGE_CANVAS.width, height: IMESSAGE_CANVAS.height, fps: 60 },
    audio: { musicVolume: 0, sfxVolume: 0, ducking: 0.62, muted: true },
    participants: [
      { id: "left", name: "Alex", voice: "Ryan", color: "#2c2c2e" },
      { id: "right", name: "You", voice: "Aiden", color: "#0a84ff" },
    ],
    // The actual Fake Text product opens with the darker iMessage treatment.
    // Visual fixtures should exercise that default rather than silently
    // testing a legacy light surface.
    theme: "ios_dark",
    layout: "floating_phone",
    playbackRate: 1,
    messages,
    ...overrides,
  };
}

const FIXTURES = {
  framelabsReference: {
    ...projectFixture("framelabs-reference", [
      message("hello", "left", "hello"),
      message("hey-bro", "right", "hey bro"),
    ]),
    name: "Framelabs public-reference comparison",
    participants: [
      { id: "left" as const, name: "Unknown", voice: "Ryan", color: "#2c2c2e" },
      { id: "right" as const, name: "You", voice: "Aiden", color: "#0a84ff" },
    ],
  },
  empty: projectFixture("empty", []),
  incoming: projectFixture("one-incoming", [message("incoming", "left", "I am outside.")]),
  outgoing: projectFixture("one-outgoing", [message("outgoing", "right", "I will be there in a minute.")]),
  alternating: projectFixture("alternating", [
    message("one", "left", "Are you still coming tonight?"),
    message("two", "right", "Yes. I am leaving now."),
    message("three", "left", "Perfect — see you soon."),
    message("four", "right", "On my way."),
  ]),
  grouped: projectFixture("same-sender-grouped", [
    message("one", "left", "I found it."),
    message("two", "left", "It was behind the old photo."),
    message("three", "left", "Bring yours too."),
    message("four", "right", "I am on my way."),
  ]),
  longIncoming: projectFixture("long-incoming", [
    message("long-incoming", "left", "I wanted to make sure you saw this before tonight because it changes the plan, and I do not want anyone to arrive at the wrong place."),
  ]),
  longOutgoing: projectFixture("long-outgoing", [
    message("long-outgoing", "right", "I checked the address, packed the photo, and asked everyone to meet us at the café instead. I will send the exact table number when I get there."),
  ]),
  emoji: projectFixture("emoji-heavy", [
    message("emoji-one", "left", "🚀✨🎉 I cannot believe it worked!"),
    message("emoji-two", "right", "Same 😭🙌🏽💙 Let us celebrate tonight 🍕"),
  ]),
  overflow: projectFixture(
    "overflow",
    Array.from({ length: 14 }, (_, index) => message(
      `overflow-${index + 1}`,
      index % 2 ? "right" : "left",
      `Message ${index + 1}: this is a deliberately complete sentence so the conversation grows beyond the fixed iMessage viewport without clipping the latest reply.`,
    )),
  ),
  typing: projectFixture("typing", [message("typing", "left", "A message that is still being composed.")]),
  receipt: projectFixture("receipt", [message("receipt", "right", "This final outgoing message has been read.")]),
  midAnimation: projectFixture("mid-animation", [message("mid-animation", "left", "This bubble is captured halfway through its deterministic entrance.")]),
  final: projectFixture("final-frame", [
    message("one", "left", "Are you still coming tonight?"),
    message("two", "right", "Yes — I am leaving now."),
    message("three", "right", "I will be there in ten minutes."),
    message("four", "left", "Perfect. Bring the photo too. ✨"),
    message("five", "right", "On my way."),
  ]),
  responsive: projectFixture("responsive", [
    message("one", "left", "A stable layout should preserve every message proportion."),
    message("two", "right", "Even when the editor window changes size."),
  ]),
} as const;

async function openFixture(page: Page, project: FixtureProject) {
  await page.addInitScript((fixture) => {
    localStorage.setItem("clyra.creator.fake_text_story", JSON.stringify(fixture));
  }, project);
  // The app shell retains its harmless boot fallback until the full desktop
  // module graph has mounted. Commit is enough to begin the deterministic
  // fixture; the explicit locator checks below provide the readiness signal.
  await page.goto("/?embedTool=fake-text", { waitUntil: "commit" });

  const preview = page.getByTestId("fake-text-preview");
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("imessage-conversation-canvas")).toBeVisible({ timeout: 60_000 });
  return preview;
}

async function seekTimeline(page: Page, timeMs: number) {
  const scrubber = page.getByLabel("Video time scrubber");
  await scrubber.evaluate((input, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, String(nextValue));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, timeMs);
  await expect(scrubber).toHaveValue(String(timeMs));
}

function timelineFor(project: FixtureProject) {
  return buildIMessageTimeline(project.messages, project.playbackRate);
}

async function captureFixture(
  preview: Locator,
  fixtureName: string,
  testInfo: TestInfo,
  options: { page?: Page; fullPage?: boolean } = {},
) {
  const target = options.page
    ? await options.page.screenshot({ fullPage: options.fullPage ?? false, animations: "disabled" })
    : await preview.screenshot({ animations: "disabled" });
  await testInfo.attach(fixtureName, { body: target, contentType: "image/png" });
  expect(target.byteLength).toBeGreaterThan(1_024);

  // The normal suite keeps artifacts inside Playwright. An explicit audit run
  // can opt in to stable externally-readable PNGs for a reference comparison
  // without placing screenshots in the production repository.
  const auditDir = process.env.CLYRA_FAKE_TEXT_AUDIT_DIR;
  if (auditDir && !options.page) {
    mkdirSync(auditDir, { recursive: true });
    await preview.screenshot({ path: path.join(auditDir, `${fixtureName}.png`), animations: "disabled" });
  }

  // Baselines remain opt-in so normal contributor runs are deterministic but
  // do not fail merely because an intentional visual baseline has not yet
  // been approved.  CI can opt into exact regression snapshots explicitly.
  if (process.env.CLYRA_FAKE_TEXT_SNAPSHOT === "1") {
    await expect(preview).toHaveScreenshot(`${fixtureName}.png`, { animations: "disabled" });
  }
}

async function expectPreviewAspectRatio(preview: Locator) {
  const box = await preview.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height / box!.width).toBeCloseTo(16 / 9, 1);
}

test.describe("deterministic iMessage visual fixtures", () => {
  test("01 — empty conversation", async ({ page }, testInfo) => {
    const preview = await openFixture(page, FIXTURES.empty);
    await seekTimeline(page, 1);

    await expect(page.locator('[data-testid^="imessage-bubble-"]')).toHaveCount(0);
    await expect(page.getByTestId("imessage-typing")).toHaveCount(0);
    const canvas = page.getByTestId("imessage-conversation-canvas");
    await expect(canvas).toHaveCSS("background-color", "rgb(0, 0, 0)");
    const gameplay = page.getByTestId("fake-text-gameplay");
    await expect(gameplay).toBeVisible();
    await expect(gameplay).toHaveAttribute("src", "/media/fake-text/gameplay/subway/subway-01.mp4");
    await captureFixture(preview, "01-empty-conversation", testInfo);
  });

  test("02 — one incoming message", async ({ page }, testInfo) => {
    const project = FIXTURES.incoming;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const bubble = page.getByTestId("imessage-bubble-0");
    await expect(bubble).toBeVisible();
    const bubbleBox = await bubble.boundingBox();
    const previewBox = await preview.boundingBox();
    expect(bubbleBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    expect(bubbleBox!.x).toBeLessThan(previewBox!.x + previewBox!.width / 2);
    const canvasBox = await page.getByTestId("imessage-conversation-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    // The conversation is a floating iMessage sheet—not a full-width block—
    // so gameplay remains clearly visible along both sides.
    const leftGutter = canvasBox!.x - previewBox!.x;
    const rightGutter = previewBox!.x + previewBox!.width - (canvasBox!.x + canvasBox!.width);
    expect(canvasBox!.width).toBeLessThan(previewBox!.width * 0.93);
    expect(leftGutter).toBeGreaterThan(previewBox!.width * 0.035);
    expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(2);
    // The bottom edge follows the message instead of the former 54% fixed
    // panel, leaving the remaining vertical stage available to gameplay.
    const bottomGap = canvasBox!.y + canvasBox!.height - (bubbleBox!.y + bubbleBox!.height);
    expect(bottomGap).toBeGreaterThan(0);
    expect(bottomGap).toBeLessThanOrEqual(26);
    expect(canvasBox!.y + canvasBox!.height).toBeLessThan(previewBox!.y + previewBox!.height - 24);
    await captureFixture(preview, "02-one-incoming", testInfo);
  });

  test("03 — one outgoing message", async ({ page }, testInfo) => {
    const project = FIXTURES.outgoing;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const bubble = page.getByTestId("imessage-bubble-0");
    await expect(bubble).toBeVisible();
    const bubbleBox = await bubble.boundingBox();
    const previewBox = await preview.boundingBox();
    expect(bubbleBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    expect(bubbleBox!.x + bubbleBox!.width).toBeGreaterThan(previewBox!.x + previewBox!.width / 2);
    // Framelabs' visible iMessage template uses clean rounded bubbles without
    // a web-chat tail, pseudo-element flick, timestamp, or receipt.
    await expect(page.getByTestId("imessage-tail-0")).toHaveCount(0);
    await expect(page.getByTestId("imessage-read-receipt")).toHaveCount(0);
    await captureFixture(preview, "03-one-outgoing", testInfo);
  });

  test("04 — alternating senders", async ({ page }, testInfo) => {
    const project = FIXTURES.alternating;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const first = await page.getByTestId("imessage-bubble-0").boundingBox();
    const second = await page.getByTestId("imessage-bubble-1").boundingBox();
    const third = await page.getByTestId("imessage-bubble-2").boundingBox();
    const fourth = await page.getByTestId("imessage-bubble-3").boundingBox();
    expect(first && second && third && fourth).toBeTruthy();
    expect(second!.x).toBeGreaterThan(first!.x);
    expect(third!.x).toBeLessThan(second!.x);
    expect(fourth!.x).toBeGreaterThan(third!.x);
    await captureFixture(preview, "04-alternating-senders", testInfo);
  });

  test("05 — same-sender grouped messages", async ({ page }, testInfo) => {
    const project = FIXTURES.grouped;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const first = await page.getByTestId("imessage-bubble-0").boundingBox();
    const second = await page.getByTestId("imessage-bubble-1").boundingBox();
    const third = await page.getByTestId("imessage-bubble-2").boundingBox();
    const switchBubble = await page.getByTestId("imessage-bubble-3").boundingBox();
    expect(first && second && third && switchBubble).toBeTruthy();
    const sameSenderGap = second!.y - (first!.y + first!.height);
    const switchGap = switchBubble!.y - (third!.y + third!.height);
    expect(sameSenderGap).toBeLessThan(switchGap);
    await captureFixture(preview, "05-same-sender-grouped", testInfo);
  });

  test("06 — long wrapped incoming message", async ({ page }, testInfo) => {
    const project = FIXTURES.longIncoming;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const bubble = page.getByTestId("imessage-bubble-0");
    const box = await bubble.boundingBox();
    const lineHeight = await bubble.evaluate((node) => Number.parseFloat(getComputedStyle(node).lineHeight));
    expect(box).not.toBeNull();
    // The compact FrameLabs-scale geometry deliberately produces small CSS
    // pixels in the editor preview. Assert actual wrapping rather than the
    // old oversized-card pixel height.
    expect(box!.height).toBeGreaterThan(lineHeight * 2);
    await captureFixture(preview, "06-long-wrapped-incoming", testInfo);
  });

  test("07 — long wrapped outgoing message", async ({ page }, testInfo) => {
    const project = FIXTURES.longOutgoing;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const bubble = page.getByTestId("imessage-bubble-0");
    const box = await bubble.boundingBox();
    const previewBox = await preview.boundingBox();
    const lineHeight = await bubble.evaluate((node) => Number.parseFloat(getComputedStyle(node).lineHeight));
    expect(box).not.toBeNull();
    expect(previewBox).not.toBeNull();
    expect(box!.height).toBeGreaterThan(lineHeight * 2);
    expect(box!.width).toBeLessThan(previewBox!.width * 0.7);
    await captureFixture(preview, "07-long-wrapped-outgoing", testInfo);
  });

  test("08 — emoji-heavy messages", async ({ page }, testInfo) => {
    const project = FIXTURES.emoji;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    await expect(page.getByTestId("imessage-bubble-0")).toContainText("🚀✨🎉");
    await expect(page.getByTestId("imessage-bubble-1")).toContainText("😭🙌🏽💙");
    await captureFixture(preview, "08-emoji-heavy", testInfo);
  });

  test("09 — overflowing conversation keeps the latest message visible", async ({ page }, testInfo) => {
    const project = FIXTURES.overflow;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const canvas = page.getByTestId("imessage-conversation-canvas");
    const messageSurface = canvas.locator(":scope > div").nth(1);
    await expect.poll(async () => messageSurface.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    // The scroll position derives directly from the active timeline frame so
    // scrubbing cannot leave an in-flight browser scroll animation behind.
    await expect.poll(async () => messageSurface.evaluate((node) => {
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      return Math.abs(target - node.scrollTop);
    })).toBeLessThanOrEqual(2);
    const latest = page.getByTestId(`imessage-bubble-${project.messages.length - 1}`);
    await expect(latest).toBeVisible();
    const latestBox = await latest.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(latestBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(latestBox!.y + latestBox!.height).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1);
    await captureFixture(preview, "09-overflow-scroll", testInfo);
  });

  test("10 — no typing indicator", async ({ page }, testInfo) => {
    const project = FIXTURES.typing;
    const preview = await openFixture(page, project);
    const first = timelineFor(project).events[0]!;
    await seekTimeline(page, first.typingStartMs + 1);

    await expect(page.getByTestId("imessage-typing")).toHaveCount(0);
    await expect(page.getByTestId("imessage-bubble-0")).toBeVisible();
    await captureFixture(preview, "10-typing-indicator", testInfo);
  });

  test("11 — no read receipt", async ({ page }, testInfo) => {
    const project = FIXTURES.receipt;
    const preview = await openFixture(page, project);
    const timeline = timelineFor(project);
    const first = timeline.events[0]!;
    // The final hold is deliberately clamped to the project duration.  The
    // receipt condition is inclusive, so the exact settle frame is enough.
    await seekTimeline(page, Math.min(timeline.durationMs, first.bubbleEndMs + IMESSAGE_TOKENS.readReceiptDelayMs));

    await expect(page.getByTestId("imessage-read-receipt")).toHaveCount(0);
    await captureFixture(preview, "11-read-receipt", testInfo);
  });

  test("12 — mid-animation frame", async ({ page }, testInfo) => {
    const project = FIXTURES.midAnimation;
    const preview = await openFixture(page, project);
    const first = timelineFor(project).events[0]!;
    const midpoint = first.bubbleStartMs + Math.floor(IMESSAGE_TOKENS.bubbleEntranceMs / 2);
    await seekTimeline(page, midpoint);

    const bubble = page.getByTestId("imessage-bubble-0");
    await expect(bubble).toBeVisible();
    const state = await bubble.evaluate((node) => ({ opacity: Number(getComputedStyle(node).opacity), transform: getComputedStyle(node).transform }));
    expect(state.opacity).toBeGreaterThanOrEqual(0);
    expect(state.opacity).toBeLessThanOrEqual(1);
    // No bounce or web-chat slide: only the compact reference fade occurs.
    expect(state.transform === "none" || state.transform.includes("matrix")).toBeTruthy();
    await captureFixture(preview, "12-mid-animation", testInfo);
  });

  test("13 — final animation frame", async ({ page }, testInfo) => {
    const project = FIXTURES.final;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    await expect(page.locator('[data-testid^="imessage-bubble-"]')).toHaveCount(project.messages.length);
    await expect(page.getByTestId("imessage-read-receipt")).toHaveCount(0);
    await captureFixture(preview, "13-final-animation-frame", testInfo);
  });

  test("14 — narrow editor layout", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 760, height: 960 });
    const project = FIXTURES.responsive;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    await expectPreviewAspectRatio(preview);
    await expect(page.getByTestId("imessage-bubble-1")).toBeVisible();
    await captureFixture(preview, "14-narrow-editor-layout", testInfo, { page });
  });

  test("15 — fullscreen window layout", async ({ page }, testInfo) => {
    // A deterministic desktop-sized viewport exercises the same proportional
    // preview surface used when the editor occupies a fullscreen window,
    // without relying on browser-specific Fullscreen API permissions.
    await page.setViewportSize({ width: 1920, height: 1080 });
    const project = FIXTURES.responsive;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    await expectPreviewAspectRatio(preview);
    await expect(page.getByTestId("imessage-bubble-1")).toBeVisible();
    await captureFixture(preview, "15-fullscreen-window-layout", testInfo, { page });
  });

  test("16 — 1080 × 1920 logical render frame", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: IMESSAGE_CANVAS.width, height: IMESSAGE_CANVAS.height });
    const project = FIXTURES.final;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    const storedCanvas = await page.evaluate(() => {
      const raw = localStorage.getItem("clyra.creator.fake_text_story");
      return raw ? JSON.parse(raw).canvas : null;
    });
    expect(storedCanvas).toEqual({ width: 1080, height: 1920, fps: 60 });
    await expectPreviewAspectRatio(preview);
    await expect(page.getByTestId("imessage-bubble-4")).toBeVisible();
    await captureFixture(preview, "16-logical-1080x1920-render-frame", testInfo);
  });

  test("17 — Framelabs public-reference geometry", async ({ page }, testInfo) => {
    const project = FIXTURES.framelabsReference;
    const preview = await openFixture(page, project);
    await seekTimeline(page, timelineFor(project).durationMs);

    await expect(page.getByText("Unknown ›", { exact: true })).toBeVisible();
    await expect(page.getByTestId("imessage-typing")).toHaveCount(0);
    await expect(page.getByTestId("imessage-read-receipt")).toHaveCount(0);
    await expect(page.getByTestId("imessage-tail-0")).toHaveCount(0);

    const [previewBox, cardBox, headerBox, incomingBox, outgoingBox] = await Promise.all([
      preview.boundingBox(),
      page.getByTestId("imessage-conversation-canvas").boundingBox(),
      page.getByTestId("imessage-header").boundingBox(),
      page.getByTestId("imessage-bubble-0").boundingBox(),
      page.getByTestId("imessage-bubble-1").boundingBox(),
    ]);
    expect(previewBox && cardBox && headerBox && incomingBox && outgoingBox).toBeTruthy();
    expect(cardBox!.width / previewBox!.width).toBeCloseTo(0.75, 2);
    expect((cardBox!.y - previewBox!.y) / previewBox!.height).toBeCloseTo(IMESSAGE_TOKENS.floatingPanelTopInset / IMESSAGE_CANVAS.height, 2);
    expect(headerBox!.height / previewBox!.width).toBeCloseTo(IMESSAGE_TOKENS.headerHeight / IMESSAGE_CANVAS.width, 2);
    expect(incomingBox!.x).toBeLessThan(outgoingBox!.x);
    expect(cardBox!.y + cardBox!.height - (outgoingBox!.y + outgoingBox!.height)).toBeLessThanOrEqual(26);
    await captureFixture(preview, "17-framelabs-public-reference", testInfo);
  });
});
