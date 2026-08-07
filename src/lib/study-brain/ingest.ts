import type { SourceKind, StudySourceNode } from "./types";
import { emptySource, uid } from "./storage";

export type GoogleExecute = (payload: {
  tool?: "docs" | "slides" | "sheets" | "drive" | "gmail" | "calendar";
  prompt?: string;
}) => Promise<{ ok: boolean; text: string; needsAuth?: boolean }>;

export function classifyUrl(raw: string): SourceKind | "unknown" {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube.com") || host === "youtu.be") return "youtube";
    if (host === "docs.google.com" && url.pathname.includes("/document")) return "gdoc";
    if (host === "docs.google.com" && url.pathname.includes("/presentation")) return "gslides";
    if (host === "docs.google.com" && url.pathname.includes("/spreadsheets")) return "gsheet";
    if (host === "drive.google.com") return "gdrive";
    return "web";
  } catch {
    return "unknown";
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(String(payload?.error || `Request failed (${response.status})`));
  }
  return payload as T;
}

export async function ingestWebsite(url: string): Promise<StudySourceNode> {
  const data = await postJson<{ title: string; text: string; url: string }>("/api/study/fetch", { url });
  return emptySource({
    kind: "web",
    title: data.title || url,
    origin: data.url || url,
    body: data.text,
    status: "ready",
    statusDetail: "Ready",
  });
}

export async function ingestYoutube(url: string, question?: string): Promise<StudySourceNode> {
  const data = await postJson<{
    ok: boolean;
    title?: string;
    videoId?: string;
    transcript?: { full_text?: string; language?: string };
    full_text?: string;
    analysisPrompt?: string;
    error?: string;
  }>("/api/research/youtube", {
    url,
    preferredLanguages: ["en"],
    question: question || undefined,
  });
  const body =
    String(data.transcript?.full_text || data.full_text || "").trim() ||
    String(data.analysisPrompt || "").trim();
  if (!body) throw new Error(data.error || "No captions were available for this video.");
  return emptySource({
    kind: "youtube",
    title: data.title || "YouTube lecture",
    origin: url,
    body: body.slice(0, 120_000),
    locator: data.videoId ? `video ${data.videoId}` : undefined,
    status: "ready",
    statusDetail: "Captions indexed",
    meta: {
      videoId: String(data.videoId || ""),
      language: String(data.transcript?.language || "en"),
    },
  });
}

export async function ingestGoogleLink(
  url: string,
  kind: SourceKind,
  execute: GoogleExecute,
): Promise<StudySourceNode> {
  const tool =
    kind === "gdoc" || kind === "doc"
      ? "docs"
      : kind === "gslides" || kind === "slides"
        ? "slides"
        : kind === "gsheet" || kind === "sheet"
          ? "sheets"
          : "drive";
  const result = await execute({
    tool,
    prompt: `Read the accessible content of this Google ${tool} link and return a plain-text study extraction with title and body only. Preserve headings. Link: ${url}`,
  });
  if (result.needsAuth) throw new Error("Connect Google in Clyra chat first, then retry.");
  if (!result.ok) throw new Error(result.text || "Google could not read that file.");
  const text = String(result.text || "").trim();
  if (text.length < 40) throw new Error("Google returned too little readable text for this file.");
  const titleLine = text.split("\n").map((l) => l.trim()).find(Boolean) || "Google file";
  return emptySource({
    kind,
    title: titleLine.slice(0, 120),
    origin: url,
    body: text.slice(0, 120_000),
    status: "ready",
    statusDetail: "Fetched via Clyra Google",
  });
}

export async function ingestTextFile(file: File): Promise<StudySourceNode> {
  const name = file.name || "Note";
  const lower = name.toLowerCase();
  const kind: SourceKind = lower.endsWith(".md") || lower.endsWith(".markdown")
    ? "markdown"
    : lower.endsWith(".pdf")
      ? "pdf"
      : lower.endsWith(".ppt") || lower.endsWith(".pptx")
        ? "slides"
        : lower.endsWith(".doc") || lower.endsWith(".docx")
          ? "doc"
          : file.type.startsWith("image/")
            ? "image"
            : file.type.startsWith("audio/")
              ? "audio"
              : "text";

  if (kind === "pdf" || kind === "slides" || kind === "doc" || kind === "image" || kind === "audio") {
    // Binary formats: create a ready node with metadata so the canvas stays usable.
    // Text extraction can be filled later via paste / Ask Clyra.
    return emptySource({
      kind,
      title: name.replace(/\.[^.]+$/, ""),
      origin: name,
      body: `[${kind.toUpperCase()} resource: ${name}]\n\nFile attached to Study Brain (${Math.max(1, Math.round(file.size / 1024))} KB). Paste extracted text or ask Clyra once OCR/transcript support is connected.`,
      status: "ready",
      statusDetail: kind === "pdf" || kind === "slides" || kind === "doc" ? "Attached · paste text to deepen" : "Attached",
      meta: { bytes: String(file.size), mime: file.type || "" },
    });
  }

  const body = await file.text();
  if (body.trim().length < 20) throw new Error("That file did not contain enough readable text.");
  return emptySource({
    kind,
    title: name.replace(/\.[^.]+$/, ""),
    origin: name,
    body: body.slice(0, 120_000),
    status: "ready",
    statusDetail: "Ready",
  });
}

export function ingestPaste(text: string, title = "Pasted notes"): StudySourceNode {
  const body = text.trim();
  if (body.length < 20) throw new Error("Paste a longer note to study.");
  return emptySource({
    id: uid(),
    kind: "note",
    title,
    origin: "Pasted note",
    body: body.slice(0, 120_000),
    status: "ready",
    statusDetail: "Ready",
  });
}

export async function ingestAnyUrl(url: string, googleExecute?: GoogleExecute): Promise<StudySourceNode> {
  const kind = classifyUrl(url);
  if (kind === "unknown") throw new Error("Enter a valid http(s) URL.");
  if (kind === "youtube") return ingestYoutube(url);
  if (kind === "gdoc" || kind === "gslides" || kind === "gsheet" || kind === "gdrive") {
    if (!googleExecute) throw new Error("Google sources require the Clyra desktop app with Google signed in.");
    return ingestGoogleLink(url, kind, googleExecute);
  }
  return ingestWebsite(url);
}
