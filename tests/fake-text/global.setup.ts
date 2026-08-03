import { chromium, type FullConfig } from "@playwright/test";

/**
 * Source-mode Clyra lazily compiles a large desktop workspace on its first
 * embedded-tool navigation. Warm that real route before fixture assertions so
 * the first visual test does not race Vite's module graph while later tests
 * are already testing rendered UI.
 */
export default async function warmFakeTextWorkspace(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Fake Text visual tests require a base URL.");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(`${baseURL}/?embedTool=fake-text`, { waitUntil: "commit", timeout: 120_000 });
    await page.getByTestId("fake-text-preview").waitFor({ state: "visible", timeout: 120_000 });
  } finally {
    await browser.close();
  }
}
