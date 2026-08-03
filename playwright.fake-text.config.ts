import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const port = Number(new URL(baseURL).port || 31415);

/**
 * This deliberately keeps the test isolated from live TTS, rendering, and
 * gameplay video. It opens Clyra's real embedded Fake Text workspace with a
 * localStorage fixture and captures stable DOM-preview evidence instead.
 */
export default defineConfig({
  testDir: "./tests/fake-text",
  testMatch: /.*\.visual\.spec\.ts/,
  // Source-mode Clyra intentionally loads the full desktop tool registry on
  // first visit. Give the real app a bounded cold-start window rather than
  // treating a still-loading Vite graph as a visual assertion failure.
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/fake-text/global.setup.ts",
  outputDir: "test-results/fake-text",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
  },
  expect: {
    timeout: 60_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  // A caller can point CLYRA_URL at an already-running desktop/web dev server.
  // Otherwise the normal source server is started solely for these visual tests.
  webServer: process.env.CLYRA_URL
    ? undefined
    : {
        command: `PORT=${port} HMR_PORT=${port + 1000} npm run dev:source`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 45_000,
      },
});
