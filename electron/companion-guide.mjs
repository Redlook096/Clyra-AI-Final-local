/**
 * Pure helpers for Guide-mode pointing (no Electron imports).
 */

function scoreLine(text, query) {
  const hay = String(text || "").toLowerCase();
  const tokens = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
  if (!hay) return 0;
  if (!tokens.length) return 0.1;
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += token.length >= 5 ? 3 : 1.5;
  }
  if (/(click|button|press|select|open|submit|apply|search|login|settings)/i.test(hay)) score += 0.5;
  return score;
}

export function pickGuideTarget(vision, capture, question = "") {
  const lines = Array.isArray(vision?.ocr?.lines) ? vision.ocr.lines : [];
  if (!lines.length || !capture?.bounds || !capture?.dimensions) return null;
  let best = null;
  let bestScore = 0;
  for (const line of lines) {
    const score = scoreLine(line.text, question);
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  if (!best && lines[0]) {
    best = lines[0];
    bestScore = 0.5;
  }
  if (!best?.bbox) return null;
  const scaleX = capture.bounds.width / Math.max(1, capture.dimensions.width);
  const scaleY = capture.bounds.height / Math.max(1, capture.dimensions.height);
  const x = capture.bounds.x + Math.round((best.bbox.x + best.bbox.w / 2) * scaleX);
  const y = capture.bounds.y + Math.round((best.bbox.y + best.bbox.h / 2) * scaleY);
  return {
    x,
    y,
    label: String(best.text || "Look here").slice(0, 48),
    score: bestScore,
    text: best.text,
  };
}

export function wantsGuide(question = "") {
  return /\b(where|point|show me|click here|how do i|how to|press|tap|highlight|guide)\b/i.test(question);
}
