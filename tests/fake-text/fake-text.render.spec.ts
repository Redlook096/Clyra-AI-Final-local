import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

type GeneratedStory = {
  title: string;
  contactName: string;
  messages: Array<{ side: "left" | "right"; text: string }>;
};

/**
 * Real browser-to-backend smoke test for the Fake Text product.  It exercises
 * the deployed creator prompt endpoint, async TTS, 60fps canvas capture, and
 * the final FFmpeg transcode—not a mocked DOM preview.
 */
test("AI-written Fake Text story renders a 1080p 60fps MP4", async ({ page, request }, testInfo) => {
  test.setTimeout(360_000);
  const prompt = process.env.CLYRA_FAKE_TEXT_PROMPT || "A quick, witty two-message exchange about a surprise birthday entrance";
  const count = Math.max(2, Math.min(8, Number(process.env.CLYRA_FAKE_TEXT_MESSAGE_COUNT) || 2));
  const tone = process.env.CLYRA_FAKE_TEXT_TONE || "funny";
  const leftVoice = process.env.CLYRA_FAKE_TEXT_LEFT_VOICE || "Evelyn";
  const rightVoice = process.env.CLYRA_FAKE_TEXT_RIGHT_VOICE || "Archer";
  const outputTag = (process.env.CLYRA_FAKE_TEXT_OUTPUT_TAG || "ai-panel-growth").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const gameplayCategory = process.env.CLYRA_FAKE_TEXT_GAMEPLAY_CATEGORY || "subway";
  const gameplayId = process.env.CLYRA_FAKE_TEXT_GAMEPLAY_ID || `${gameplayCategory}-01`;
  const forceAlternatingSides = process.env.CLYRA_FAKE_TEXT_FORCE_ALTERNATING_SIDES === "true";

  const generatedResponse = await request.post("/api/creator/generate", {
    data: {
      kind: "fake_text_story",
      prompt,
      count,
      tone,
    },
  });
  expect(generatedResponse.ok()).toBeTruthy();
  const generatedPayload = await generatedResponse.json() as { ok?: boolean; data?: GeneratedStory };
  expect(generatedPayload.ok).toBe(true);
  expect(generatedPayload.data?.messages).toHaveLength(count);
  const story = generatedPayload.data!;

  const fixture = {
    version: 4,
    id: "fake-text-ai-render-smoke",
    type: "fake_text_story",
    name: story.title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canvas: { width: 1080, height: 1920, fps: 60 },
    audio: { musicVolume: 0, sfxVolume: 0, ducking: 0.62, muted: false },
    participants: [
      { id: "left", name: story.contactName || "Unknown", voice: leftVoice, color: "#2c2c2e" },
      { id: "right", name: "You", voice: rightVoice, color: "#0a84ff" },
    ],
    theme: "ios_dark",
    layout: "floating_phone",
    playbackRate: 1,
    gameplay: {
      clipId: gameplayId,
      category: gameplayCategory,
      src: `/media/fake-text/gameplay/${gameplayCategory}/${gameplayId}.mp4`,
      poster: `/media/fake-text/gameplay/${gameplayCategory}/${gameplayId}.jpg`,
      durationSeconds: 30,
      sourceUrl: "local-test-fixture",
    },
    messages: story.messages.map((message, index) => ({
      id: `ai-message-${index + 1}`,
      // A product-generated story can legitimately put messages from one
      // narrator in sequence.  The optional coverage mode exercises both
      // sides and both configured TTS voices without altering normal use.
      side: forceAlternatingSides ? (index % 2 === 0 ? "left" : "right") : message.side,
      text: message.text,
      typingSeconds: 0.45,
      pauseSeconds: 0.15,
      narration: true,
    })),
  };

  await page.addInitScript((project) => {
    localStorage.setItem("clyra.creator.fake_text_story", JSON.stringify(project));
  }, fixture);
  await page.goto("/?embedTool=fake-text", { waitUntil: "commit" });
  await expect(page.getByTestId("fake-text-preview")).toBeVisible({ timeout: 90_000 });

  // The shipped Fake Text template is deliberately a short four-step flow.
  // Advance its real controls rather than bypassing the UI with a page eval.
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Render video" }).click();
  await expect(page.getByText("Rendered locally", { exact: true })).toBeVisible({ timeout: 240_000 });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download MP4" }).click();
  const video = await download;
  const outputPath = testInfo.outputPath(`ai-fake-text-story-${outputTag}.mp4`);
  await video.saveAs(outputPath);
  expect(existsSync(outputPath)).toBe(true);

  // The desktop bundle is allowed to ship FFmpeg without ffprobe.  Inspect
  // the actual finished MP4 through the same trusted FFmpeg binary used by
  // the transcode route rather than making this test environment-dependent.
  const bundledFfmpeg = path.join(homedir(), ".local", "bin", "ffmpeg");
  const ffmpeg = process.env.FFMPEG_PATH || (existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");
  let mediaInfo = "";
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", outputPath], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    mediaInfo = String((error as { stderr?: string | Buffer }).stderr || "");
  }
  expect(mediaInfo).toMatch(/Video: h264 \(High\).*1080x1920.*60 fps/s);

  // Persist a reviewed artifact outside Playwright's transient output so it
  // can be inspected from the Clyra workspace after this smoke test.
  const reviewedDir = path.resolve(process.cwd(), "output");
  mkdirSync(reviewedDir, { recursive: true });
  const reviewedPath = path.join(reviewedDir, `fake-text-${outputTag}-60fps.mp4`);
  await video.saveAs(reviewedPath);
  await testInfo.attach("rendered-fake-text-story", { path: reviewedPath, contentType: "video/mp4" });
});
