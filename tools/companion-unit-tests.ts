/**
 * Screen Companion unit checks — vision script + /api/companion routes.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BASE = process.env.CLYRA_SERVICE_URL || "http://127.0.0.1:3000";

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clyra-companion-test-"));
  const file = path.join(dir, "screen.png");
  // Use Python/Pillow so we don't pull a canvas dependency for a one-off fixture.
  await execFileAsync(
    "python3",
    [
      "-c",
      [
        "from PIL import Image, ImageDraw",
        `im=Image.new('RGB',(960,540),(244,245,248))`,
        "d=ImageDraw.Draw(im)",
        "d.rectangle((48,48,520,180),fill=(255,255,255))",
        "d.text((64,72),'Clyra Companion Test',fill=(20,24,32))",
        "d.text((64,110),'Take control · Stop',fill=(43,110,242))",
        `im.save(${JSON.stringify(file)})`,
      ].join("; "),
    ],
    { timeout: 10_000 },
  );
  return file;
}

async function main() {
  const failures: string[] = [];
  const image = await makeFixture();

  try {
    const { pickGuideTarget } = await import("../electron/companion-guide.mjs");
    const vision = {
      ocr: {
        lines: [
          { text: "Search products", bbox: { x: 40, y: 80, w: 120, h: 24 }, score: 0.9 },
          { text: "Apply filters", bbox: { x: 400, y: 80, w: 100, h: 28 }, score: 0.95 },
          { text: "Cookie preferences", bbox: { x: 700, y: 400, w: 140, h: 20 }, score: 0.8 },
        ],
      },
    };
    const capture = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      dimensions: { width: 960, height: 540 },
    };
    const target = pickGuideTarget(vision, capture, "where do I click Apply filters");
    if (!target || !/apply filters/i.test(target.label)) {
      failures.push(`guide target missed Apply filters: ${JSON.stringify(target)}`);
    } else {
      console.log("guide-target:", target.label, target.x, target.y);
    }
  } catch (error) {
    failures.push(`guide target failed: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const { stdout } = await execFileAsync(
      "python3",
      [path.join(ROOT, "tools", "companion-vision.py"), image, "--question", "What is on screen?"],
      { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const vision = JSON.parse(String(stdout || "{}"));
    if (!vision.ok) failures.push(`vision not ok: ${vision.error || "unknown"}`);
    if (!String(vision.summary || "").toLowerCase().includes("companion")) {
      failures.push(`vision summary missing expected OCR text: ${vision.summary}`);
    }
    if (Number(vision.elapsedMs || 99999) > 8000) {
      failures.push(`vision too slow for 8GB target: ${vision.elapsedMs}ms`);
    }
    console.log("vision:", vision.model, `${vision.elapsedMs}ms`, vision.summary?.slice(0, 120));
  } catch (error) {
    failures.push(`vision script failed: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const askRes = await fetch(`${BASE}/api/companion/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What am I looking at?",
        visionSummary: "Screen shows Clyra Companion Test with Take control · Stop.",
        ocrText: "Clyra Companion Test\nTake control · Stop",
      }),
    });
    const ask = await askRes.json();
    if (!askRes.ok && !ask?.text) failures.push(`ask HTTP ${askRes.status}`);
    if (!String(ask?.text || ask?.choices?.[0]?.message?.content || "").trim()) {
      failures.push("ask returned empty text");
    }
    console.log("ask:", ask?.source || "unknown", String(ask?.text || "").slice(0, 140));
  } catch (error) {
    failures.push(`ask route failed: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const visionRes = await fetch(`${BASE}/api/companion/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: image, question: "Summarise the UI" }),
    });
    const payload = await visionRes.json();
    if (!visionRes.ok || !payload?.ok) failures.push(`vision route failed: ${JSON.stringify(payload).slice(0, 200)}`);
    else console.log("vision-route:", payload.model, payload.summary?.slice(0, 120));
  } catch (error) {
    failures.push(`vision route failed: ${error instanceof Error ? error.message : error}`);
  }

  if (failures.length) {
    console.error("FAIL", failures);
    process.exit(1);
  }
  console.log("PASS companion unit tests");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
