const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
] as const;

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

const SPOKEN_ABBREVIATIONS: Record<string, string> = {
  "e.g.": "for example",
  "i.e.": "that is",
  "etc.": "and so on",
  "approx.": "approximately",
  "dept.": "department",
  "vs.": "versus",
  "mr.": "Mister",
  "mrs.": "Missus",
  "dr.": "Doctor",
  "st.": "Saint",
};

function integerToWords(value: number): string {
  const number = Math.trunc(Math.abs(value));
  if (number < 20) return SMALL_NUMBERS[number] ?? String(number);
  if (number < 100) {
    const ones = number % 10;
    return `${TENS[Math.floor(number / 10)]}${ones ? ` ${SMALL_NUMBERS[ones]}` : ""}`;
  }
  if (number < 1_000) {
    const rest = number % 100;
    return `${SMALL_NUMBERS[Math.floor(number / 100)]} hundred${rest ? ` and ${integerToWords(rest)}` : ""}`;
  }
  if (number < 1_000_000) {
    const rest = number % 1_000;
    return `${integerToWords(Math.floor(number / 1_000))} thousand${rest ? ` ${integerToWords(rest)}` : ""}`;
  }
  return new Intl.NumberFormat("en-AU", { useGrouping: false }).format(number);
}

function decimalToWords(raw: string): string {
  const [wholeRaw, decimal] = raw.replace(/,/g, "").split(".");
  const whole = Number(wholeRaw);
  if (!Number.isFinite(whole)) return raw;
  const prefix = whole < 0 ? "minus " : "";
  const base = `${prefix}${integerToWords(whole)}`;
  if (!decimal) return base;
  return `${base} point ${decimal.split("").map((digit) => SMALL_NUMBERS[Number(digit)]).join(" ")}`;
}

function speakUrl(raw: string): string {
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname
      .replace(/^www\./i, "")
      .replace(/\./g, " dot ")
      .replace(/-/g, " ");
  } catch {
    return raw.replace(/[:/.?&=_-]+/g, " ");
  }
}

/** Removes visual formatting and converts common written forms into speakable English. */
export function normalizeSpokenText(text: string) {
  let spoken = text
    .replace(/```[\s\S]*?```/g, " code example omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~|]/g, " ")
    .replace(/\bhttps?:\/\/[^\s)]+/gi, (value) => speakUrl(value))
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, (value) =>
      value.replace(/@/g, " at ").replace(/\./g, " dot ").replace(/_/g, " underscore "),
    );

  for (const [written, natural] of Object.entries(SPOKEN_ABBREVIATIONS)) {
    spoken = spoken.replace(new RegExp(written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), natural);
  }

  spoken = spoken
    .replace(/\b(AUD|USD|CAD|NZD)\s*\$\s*([\d,]+(?:\.\d{1,2})?)/gi, (_, currency, amount) =>
      `${decimalToWords(amount)} ${String(currency).toUpperCase() === "AUD" ? "Australian dollars" : String(currency).toUpperCase()}`,
    )
    .replace(/\$\s*([\d,]+(?:\.\d{1,2})?)/g, (_, amount) => `${decimalToWords(amount)} dollars`)
    .replace(/£\s*([\d,]+(?:\.\d{1,2})?)/g, (_, amount) => `${decimalToWords(amount)} pounds`)
    .replace(/€\s*([\d,]+(?:\.\d{1,2})?)/g, (_, amount) => `${decimalToWords(amount)} euros`)
    .replace(/\b([\d,]+(?:\.\d+)?)\s*%/g, (_, amount) => `${decimalToWords(amount)} percent`)
    .replace(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi, (_, hour, minute, meridiem) => {
      const minutes = Number(minute) === 0 ? "o'clock" : decimalToWords(minute);
      return `${decimalToWords(hour)} ${minutes}${meridiem ? ` ${String(meridiem).split("").join(" ")}` : ""}`;
    })
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d+\.\d+|\d{1,4})\b/g, (value) => decimalToWords(value))
    .replace(/\b(AI|API|UI|URL|CPU|GPU|RAM|HTML|CSS|JSON|PDF|FAQ|TTS|STT|LLM)\b/g, (value) =>
      value.split("").join(" "),
    )
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/\s*([,;:])\s*/g, "$1 ")
    .replace(/\s*([.!?…])\s*/g, "$1 ")
    .replace(/([!?])\1+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  return spoken;
}

/** Backwards-compatible name used by the voice gateway. */
export function stripMarkdownForSpeech(text: string) {
  return normalizeSpokenText(text);
}

export function shapeTextForSpeech(text: string) {
  return normalizeSpokenText(text);
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function isUnsafePeriodBoundary(value: string, index: number) {
  const prefix = value.slice(Math.max(0, index - 8), index + 1);
  const suffix = value.slice(index + 1, index + 5);
  return /(?:\b[A-Z]|\b(?:Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e))\.$/i.test(prefix) || /^\d/.test(suffix) && /\d\.$/.test(prefix);
}

export type SemanticPhrase = { text: string; nextIndex: number };

/**
 * Finds a stable, naturally speakable clause in a growing LLM response.
 * Indexes refer to the original string so token streaming remains lossless.
 */
export function nextSemanticPhrase(
  fullText: string,
  from = 0,
  options: { final?: boolean; minWords?: number; preferredWords?: number; maxWords?: number } = {},
): SemanticPhrase | null {
  const remaining = fullText.slice(from);
  const leading = remaining.match(/^\s*/)?.[0].length ?? 0;
  const body = remaining.slice(leading);
  if (!body.trim()) return null;

  const minWords = options.minWords ?? 8;
  const preferredWords = options.preferredWords ?? 14;
  const maxWords = options.maxWords ?? 28;
  const boundaries: Array<{ end: number; hard: boolean; words: number }> = [];

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (!".!?…,:;".includes(char)) continue;
    if (char === "." && isUnsafePeriodBoundary(body, index)) continue;
    const candidate = body.slice(0, index + 1);
    const words = wordCount(candidate);
    if (words >= minWords) boundaries.push({ end: index + 1, hard: ".!?…".includes(char), words });
  }

  const chosen =
    boundaries.find(
      (item) =>
        item.words <= maxWords &&
        (item.hard || item.words >= Math.min(preferredWords, 10)),
    ) ?? boundaries.find((item) => item.words <= maxWords);
  if (chosen) {
    return {
      text: body.slice(0, chosen.end).trim(),
      nextIndex: from + leading + chosen.end,
    };
  }

  const matches = Array.from(body.matchAll(/\S+/g));
  if (matches.length >= maxWords) {
    const last = matches[maxWords - 1];
    const end = (last?.index ?? 0) + (last?.[0].length ?? 0);
    return { text: body.slice(0, end).trim(), nextIndex: from + leading + end };
  }
  if (options.final && body.trim()) {
    return { text: body.trim(), nextIndex: fullText.length };
  }
  return null;
}

export function splitSpeakablePhrases(text: string) {
  const phrases: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const phrase = nextSemanticPhrase(text, cursor, { final: true });
    if (!phrase) break;
    const spoken = normalizeSpokenText(phrase.text);
    if (spoken) phrases.push(spoken);
    if (phrase.nextIndex <= cursor) break;
    cursor = phrase.nextIndex;
  }
  return phrases;
}

/** Chrome often returns [] until voiceschanged fires. */
export function ensureSpeechVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const existing = synth.getVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener("voiceschanged", finish);
    window.setTimeout(finish, 600);
  });
}

export function pickEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  return voices.find((voice) => /^en\b/i.test(voice.lang) && /Samantha|Karen|Moira|Ava|Zoe|Nicky|Serena|Natural|Premium|Enhanced/i.test(voice.name))
    ?? voices.find((voice) => /^en-AU\b/i.test(voice.lang))
    ?? voices.find((voice) => /^en\b/i.test(voice.lang))
    ?? voices[0]
    ?? null;
}

export function startSpeechResumeWatch(): () => void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return () => undefined;
  const id = window.setInterval(() => {
    try {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) window.speechSynthesis.resume();
    } catch {
      // Browser speech is only an explicit degraded fallback.
    }
  }, 200);
  return () => window.clearInterval(id);
}

export function cancelSpeechSynthesis(): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve();
  try {
    window.speechSynthesis.cancel();
  } catch {
    // The engine may already be torn down.
  }
  return new Promise((resolve) => window.setTimeout(resolve, 40));
}
