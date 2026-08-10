/**
 * Gemini-only vision for Clyra server, voice calls, and OpenCluely bridge.
 * Requires GEMINI_API_KEY in the server environment (.env.local).
 */
import { callGeminiVision, geminiApiKey, geminiVisionModel } from "./gemini-vision.mjs";

export function visionModelName() {
  return geminiVisionModel();
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} [prompt]
 * @param {{ model?: string, timeoutMs?: number, mimeType?: string }} [opts]
 */
export async function analyseVisionBuffer(imageBuffer, prompt, opts = {}) {
  if (!geminiApiKey()) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add it to .env.local and restart the Clyra server.",
    );
  }
  if (!imageBuffer?.length) throw new Error("Image buffer is required");
  if (imageBuffer.byteLength > 12 * 1024 * 1024) {
    throw new Error("Frame too large.");
  }
  const gemini = await callGeminiVision(imageBuffer, prompt, opts);
  return {
    ok: true,
    summary: gemini.summary,
    text: gemini.summary,
    ocrText: gemini.summary,
    model: gemini.model,
    source: "gemini",
    engine: "gemini",
  };
}

/**
 * Analyse a data-URL camera / screen frame with Gemini.
 */
export async function analyseVisionFrame(dataUrl, question = "") {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new Error("A data-URL image is required.");
  const mimeType =
    match[1].toLowerCase() === "png"
      ? "image/png"
      : match[1].toLowerCase() === "webp"
        ? "image/webp"
        : "image/jpeg";
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.byteLength > 12 * 1024 * 1024) throw new Error("Frame too large.");

  const prompt =
    question ||
    "What is visible in this camera or screen share? Answer any question the user is asking about it. Be concise and helpful.";

  return analyseVisionBuffer(buffer, prompt, { mimeType });
}
