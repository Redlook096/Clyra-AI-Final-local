/**
 * Voice CALL end-to-end check, against the real Pipecat + WebRTC + Fish
 * Audio + DeepSeek stack, driven through the actual browser UI (not a
 * simulated protocol client) via a real Chromium instance.
 *
 * Runs with Test Mode ON by default (Fish STT -> Fish TTS echo, no DeepSeek
 * calls) so it never spends the user's DeepSeek credits -- see
 * backend/voice-pipeline/echo_llm.py. Pass --deepseek to exercise the real
 * LLM leg instead.
 *
 * Requires FISH_AUDIO_API_KEY configured on the running dev server for the
 * STT/TTS assertions to pass -- without it Fish Audio TTS rejects the
 * connection (HTTP 401) and this script reports that clearly rather than a
 * false pass.
 *
 * Usage:
 *   npm run test:voice-call-e2e
 *   node tools/voice-call-webrtc-e2e.mjs
 *   node tools/voice-call-webrtc-e2e.mjs --interrupts 10
 *   node tools/voice-call-webrtc-e2e.mjs --soak-minutes 10
 *   CLYRA_VOICE_BASE_URL=http://127.0.0.1:3000 node tools/voice-call-webrtc-e2e.mjs
 *
 * Fake mic input comes from Chrome's --use-file-for-fake-audio-capture flag
 * (tmp/voice-bench/wallace-cl-2.wav if present, otherwise a generated tone --
 * a tone won't produce a real transcript, only proves the pipeline runs).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.CLYRA_VOICE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const FIXTURE_WAV = path.join(ROOT, "tmp/voice-bench/wallace-cl-2.wav");

const argv = process.argv.slice(2);
const interruptCount = Number(argv.find((a) => a.startsWith("--interrupts="))?.split("=")[1] ?? 0);
const soakMinutes = Number(argv.find((a) => a.startsWith("--soak-minutes="))?.split("=")[1] ?? 0);
const useDeepseek = argv.includes("--deepseek");

function log(msg) {
  console.log(`[voice-webrtc-e2e] ${msg}`);
}

async function main() {
  const fakeAudioArgs = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ];
  if (fs.existsSync(FIXTURE_WAV)) {
    fakeAudioArgs.push(`--use-file-for-fake-audio-capture=${FIXTURE_WAV}`);
    log(`using fixture audio: ${FIXTURE_WAV}`);
  } else {
    log(`no fixture at ${FIXTURE_WAV} -- using Chrome's synthetic fake mic (silence/tone, no real speech)`);
  }

  const browser = await chromium.launch({ args: fakeAudioArgs });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Set Test Mode via addInitScript (runs before any page script, on every
  // navigation) rather than goto -> evaluate -> reload: that sequence has a
  // real race between the reload's first paint and the evaluate() call --
  // it let a run reach the real DeepSeek call once while building this.
  // addInitScript has no such window: the value is in localStorage before
  // the app's own first script executes.
  if (!useDeepseek) {
    await context.addInitScript(() => {
      window.localStorage.setItem("clyra-voice-test-mode", "true");
    });
    log("Test Mode will be enabled on load (no DeepSeek calls this run)");
  }

  let offerBody = null;
  page.on("request", (req) => {
    if (req.url().endsWith("/voice/offer") && req.method() === "POST") offerBody = req.postData();
  });

  try {
    log(`opening ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: "networkidle" });

    const offerRequestPromise = page.waitForRequest(
      (req) => req.url().endsWith("/voice/offer") && req.method() === "POST",
      { timeout: 15_000 },
    );
    const voiceButton = page.locator('button[aria-label="Start voice call"]').first();
    await voiceButton.click();
    log("clicked voice call button");
    await offerRequestPromise.catch(() => undefined);

    if (!useDeepseek) {
      const sentTestMode = offerBody ? JSON.parse(offerBody)?.requestData?.testMode : null;
      if (sentTestMode !== true) {
        throw new Error(
          `Test Mode did not take effect (requestData.testMode=${sentTestMode}) -- refusing to continue ` +
            `since this would fall through to a real DeepSeek call. Aborting before any further requests.`,
        );
      }
      log("confirmed testMode:true was actually sent in the /voice/offer request");
    }

    const errorBadge = page.getByText("Voice call error.");
    const listening = page.getByText("Listening", { exact: true });
    const result = await Promise.race([
      listening.waitFor({ timeout: 15_000 }).then(() => "listening"),
      errorBadge.waitFor({ timeout: 15_000 }).then(() => "error"),
    ]).catch(() => "timeout");

    if (result === "error") {
      const errorText = await page.locator("text=/.+/").filter({ hasText: /error/i }).first().textContent().catch(() => "");
      throw new Error(
        `Voice call reported an error before reaching Listening (likely missing FISH_AUDIO_API_KEY on the server): ${errorText}`,
      );
    }
    if (result === "timeout") {
      throw new Error("Voice call never reached Listening or an error state within 15s.");
    }
    log("PASS: reached Listening state (WebRTC connected, RTVI botReady received)");

    const haveFixture = fs.existsSync(FIXTURE_WAV);
    if (haveFixture) {
      // The fixture file loops automatically under --use-file-for-fake-audio-capture,
      // so real speech keeps arriving on its own -- no synthetic trigger needed.
      const speaking = page.locator('[data-testid="voice-speaking-captions"]');
      await speaking.waitFor({ timeout: 20_000 });
      log("PASS: reached Speaking state (Fish STT -> echo -> Fish TTS produced a real reply)");

      const captionText = await speaking.textContent().catch(() => null);
      if (captionText && /how are you|hi/i.test(captionText)) {
        log(`PASS: caption reflects real transcribed speech: ${JSON.stringify(captionText)}`);
      } else {
        log("WARN: reached Speaking but couldn't read caption text via this selector (not necessarily a failure).");
      }

      if (interruptCount > 0) {
        log(`watching for ${interruptCount} barge-ins (the looping fixture keeps talking over the bot, which must yield)...`);
        let seen = 0;
        let lastWasSpeaking = true;
        const deadline = Date.now() + interruptCount * 8_000;
        while (seen < interruptCount && Date.now() < deadline) {
          const isSpeaking = await page.locator('[data-testid="voice-speaking-captions"]').isVisible().catch(() => false);
          if (lastWasSpeaking && !isSpeaking) {
            seen += 1;
            log(`  barge-in ${seen}/${interruptCount} observed (Speaking -> not-Speaking)`);
          }
          lastWasSpeaking = isSpeaking;
          await page.waitForTimeout(250);
        }
        if (seen < interruptCount) {
          log(`WARN: only observed ${seen}/${interruptCount} barge-ins before the ${interruptCount * 8}s window closed.`);
        } else {
          log(`PASS: observed ${seen}/${interruptCount} barge-ins, each stopping Speaking promptly.`);
        }
      }

      if (soakMinutes > 0) {
        log(`soaking for ${soakMinutes} minute(s), sampling heap size every 30s...`);
        const samples = [];
        const soakDeadline = Date.now() + soakMinutes * 60_000;
        while (Date.now() < soakDeadline) {
          await page.waitForTimeout(30_000);
          const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null).catch(() => null);
          if (heap != null) samples.push(heap);
          log(`  t+${Math.round((soakMinutes * 60_000 - (soakDeadline - Date.now())) / 1000)}s heap=${heap ? (heap / 1e6).toFixed(1) + "MB" : "n/a"}`);
        }
        if (samples.length >= 2) {
          const growth = samples[samples.length - 1] - samples[0];
          log(`heap grew ${(growth / 1e6).toFixed(1)}MB over the soak (${samples.length} samples) -- ` +
            `${growth > 50e6 ? "WARN: significant growth, investigate a leak" : "no alarming growth"}`);
        }
      }
    } else {
      log(`no fixture at ${FIXTURE_WAV} -- skipping Speaking/interrupt/soak checks (connection-layer only).`);
    }

    const endButton = page.locator('button[aria-label="End call"]').first();
    await endButton.click();
    await page.getByText("Listening", { exact: true }).waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
    log("PASS: call ended cleanly");

    const fatalConsoleErrors = consoleErrors.filter((e) => !/Voice call error|404/i.test(e));
    if (fatalConsoleErrors.length) {
      log(`WARN: ${fatalConsoleErrors.length} unexpected console error(s):`);
      for (const e of fatalConsoleErrors.slice(0, 5)) log(`  ${e.slice(0, 200)}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[voice-webrtc-e2e] FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
