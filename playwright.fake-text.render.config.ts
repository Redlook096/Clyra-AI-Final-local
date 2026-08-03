import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const port = Number(new URL(baseURL).port || 31415);

// The regular visual suite deliberately remains local and deterministic. This
// separate configuration is the opt-in browser + API + TTS + FFmpeg smoke
// path, so contributors do not need Creator intelligence credentials merely
// to check card geometry.
export default defineConfig({
  testDir: "./tests/fake-text",
  testMatch: /.*\.render\.spec\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  reporter: "list",
  globalSetup: "./tests/fake-text/global.setup.ts",
  outputDir: "test-results/fake-text-render",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    video: "off",
    trace: "retain-on-failure",
  },
  webServer: process.env.CLYRA_URL
    ? undefined
    : {
        command: `PORT=${port} HMR_PORT=${port + 1000} npm run dev:source`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
