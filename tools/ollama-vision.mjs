/**
 * Shared OpenCluely-style Ollama vision helper for Clyra server + voice calls.
 * Uses OPENCLUELY_VISION_MODEL / OLLAMA_VISION_MODEL (default llava-phi3).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export function visionModelName() {
  return (
    process.env.OPENCLUELY_VISION_MODEL ||
    process.env.OLLAMA_VISION_MODEL ||
    "llava-phi3"
  );
}

export function ollamaBaseUrl() {
  return String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
}

async function resizeImageBuffer(buffer, maxEdge = 1024) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clyra-ollama-vision-"));
  const input = path.join(dir, "in.png");
  const output = path.join(dir, "out.jpg");
  try {
    await fs.writeFile(input, buffer);
    try {
      await execFileAsync(
        "convert",
        [input, "-resize", `${maxEdge}x${maxEdge}>`, "-quality", "90", output],
        { timeout: 15_000 },
      );
      return await fs.readFile(output);
    } catch {
      return buffer;
    }
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} [prompt]
 * @param {{ model?: string, timeoutMs?: number }} [opts]
 */
export async function callOllamaVision(imageBuffer, prompt, opts = {}) {
  if (!imageBuffer?.length) throw new Error("Image buffer is required");
  const model = opts.model || visionModelName();
  const resized = await resizeImageBuffer(imageBuffer);
  const base64 = resized.toString("base64");
  const question =
    prompt ||
    "Look at this image carefully. Describe what is visible and answer any clear question on screen. Be concise and literal.";

  const generate = await fetch(`${ollamaBaseUrl()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: question,
      images: [base64],
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 120_000),
  });
  const generateJson = await generate.json().catch(() => ({}));
  let text = String(generateJson?.response || "").trim();
  if (!text) {
    const chat = await fetch(`${ollamaBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: question, images: [base64] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 120_000),
    });
    const chatJson = await chat.json().catch(() => ({}));
    text = String(chatJson?.message?.content || "").trim();
  }
  if (!text) throw new Error(`Vision model ${model} returned an empty reply`);
  return { ok: true, summary: text, text, model, source: "ollama-vision" };
}

/**
 * Analyse a data-URL frame with OpenCluely vision, falling back to RapidOCR script.
 */
export async function analyseVisionFrame(dataUrl, question = "") {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new Error("A data-URL image is required.");
  const ext = match[1].toLowerCase() === "png" ? "png" : "jpg";
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.byteLength > 8 * 1024 * 1024) throw new Error("Frame too large.");

  const prompt =
    question ||
    "What is visible in this camera or screen share? Answer any question the user is asking about it. Be concise and helpful.";

  try {
    const vlm = await callOllamaVision(buffer, prompt);
    return {
      ok: true,
      summary: vlm.summary,
      text: vlm.summary,
      ocrText: vlm.summary,
      model: vlm.model,
      source: "opencluely-ollama",
      engine: "ollama",
    };
  } catch (vlmError) {
    // Fallback: RapidOCR companion-vision.py
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clyra-vision-frame-"));
    const filePath = path.join(dir, `frame.${ext}`);
    try {
      await fs.writeFile(filePath, buffer);
      const script = path.join(process.cwd(), "tools", "companion-vision.py");
      const { stdout } = await execFileAsync(
        "python3",
        [script, filePath, "--question", prompt],
        { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env: process.env },
      );
      const payload = JSON.parse(String(stdout || "{}"));
      return {
        ...payload,
        ok: payload.ok !== false,
        summary: payload.summary || payload.text || "",
        source: payload.source || "rapidocr-fallback",
        engine: "rapidocr",
        vlmError: vlmError instanceof Error ? vlmError.message : String(vlmError),
      };
    } finally {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
