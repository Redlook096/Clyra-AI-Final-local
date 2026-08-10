/**
 * Gemini vision for camera / screen frames (preferred when GEMINI_API_KEY is set).
 */
const DEFAULT_MODEL =
  process.env.GEMINI_VISION_MODEL ||
  process.env.GOOGLE_VISION_MODEL ||
  "gemini-3.1-flash-lite";

export function geminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    ""
  ).trim();
}

export function geminiVisionModel() {
  return DEFAULT_MODEL;
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} [prompt]
 * @param {{ model?: string, timeoutMs?: number, mimeType?: string }} [opts]
 */
export async function callGeminiVision(imageBuffer, prompt, opts = {}) {
  const apiKey = geminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!imageBuffer?.length) throw new Error("Image buffer is required");

  const model = opts.model || geminiVisionModel();
  const mimeType = opts.mimeType || "image/jpeg";
  const question =
    prompt ||
    "Look at this image carefully. Describe what is visible. Be concise and literal.";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: question },
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBuffer.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
      },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 45_000),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      json?.error?.message ||
      json?.error?.status ||
      `Gemini vision failed (${response.status})`;
    throw new Error(String(detail));
  }

  const parts = json?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((part) => String(part?.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .trim()
    : "";
  if (!text) throw new Error(`Gemini model ${model} returned an empty reply`);
  return { ok: true, summary: text, text, model, source: "gemini-vision" };
}
