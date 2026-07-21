import { spawn } from "node:child_process";
import path from "node:path";
import { webSearch, fetchUrl } from "../agent/research-tools";
import { clyraResourcePath, clyraResourceRoot } from "../runtime-paths";

export type YoutubeAnalyzeRequest = {
  url: string;
  preferredLanguages?: string[];
  translateTo?: string;
  question?: string;
};

export type WebSearchRequest = {
  query: string;
  maxResults?: number;
  fetchTop?: number;
};

function runPythonJson(args: string[], timeoutMs = 45000): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", args, {
      cwd: clyraResourceRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Transcript retrieval timed out"));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(stderr.trim() || `Transcript engine exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(trimmed.split("\n").filter(Boolean).pop() || trimmed));
      } catch (err) {
        reject(new Error(`Invalid transcript JSON: ${stderr || String(err)}`));
      }
    });
  });
}

export async function retrieveYoutubeTranscript(input: YoutubeAnalyzeRequest) {
  const args = [
    "-m",
    "youtube_transcript_engine",
    input.url,
  ];
  for (const lang of input.preferredLanguages || ["en"]) {
    args.push("--lang", lang);
  }
  if (input.translateTo) {
    args.push("--translate", input.translateTo);
  }
  return runPythonJson(args);
}

export async function runWebSearchResearch(input: WebSearchRequest) {
  const query = input.query.trim();
  if (!query) {
    return { ok: false, error: { code: "invalid_query", message: "Search query required" } };
  }
  const maxResults = Math.min(Math.max(input.maxResults ?? 6, 1), 10);
  const fetchTop = Math.min(Math.max(input.fetchTop ?? 3, 0), 5);
  const urls = await webSearch(query, maxResults);
  const pages: Array<{ url: string; text: string; blocked: boolean }> = [];
  for (const url of urls.slice(0, fetchTop)) {
    pages.push(await fetchUrl(url));
  }
  return {
    ok: true,
    query,
    urls,
    pages: pages.map((page) => ({
      url: page.url,
      blocked: page.blocked,
      excerpt: page.text.slice(0, 3500),
    })),
  };
}

export function buildYoutubeAnalysisPrompt(params: {
  url: string;
  question?: string;
  transcript: any;
}) {
  const meta = params.transcript?.metadata || {};
  const cues: Array<{ start: number; text: string }> = params.transcript?.cues || [];
  const clipped = cues.slice(0, 400);
  const timed = clipped
    .map((cue) => {
      const m = Math.floor(Number(cue.start || 0) / 60);
      const s = Math.floor(Number(cue.start || 0) % 60)
        .toString()
        .padStart(2, "0");
      return `[${m}:${s}] ${cue.text}`;
    })
    .join("\n");
  const question = params.question?.trim() || "";
  const hasQuestion = question.length > 0;

  return `You are Clyra analyzing a YouTube video from its transcript.

Video URL: ${params.url}
Title: ${meta.title || "(unknown)"}
Uploader: ${meta.uploader || "(unknown)"}
Language: ${meta.language || "(unknown)"}
Transcript type: ${meta.transcript_type || "(unknown)"}
Provider: ${meta.provider_used || "(unknown)"}

User request:
${hasQuestion ? question : "(no specific question — give a concise overview)"}

Timestamped transcript:
${timed || params.transcript?.full_text || "(empty)"}

Reply rules:
${
  hasQuestion
    ? `- Answer the user's question directly and briefly (a few short sentences or a tight bullet list).
- Only include timestamps if they help answer the question.`
    : `- Write a 2–3 sentence overview.
- Then list key points with timestamps in this format: \`[m:ss] short point\`
- Keep every point to one short line.`
}
- Be accurate to the transcript. If something is unclear from captions, say so.
- Keep the whole reply short and scannable. No long essays.`;
}

export function buildWebSearchPrompt(params: {
  query: string;
  research: Awaited<ReturnType<typeof runWebSearchResearch>>;
}) {
  const sources =
    params.research.ok && "urls" in params.research
      ? (params.research.urls || [])
          .map((url: string, i: number) => `${i + 1}. ${url}`)
          .join("\n")
      : "(none)";
  const excerpts =
    params.research.ok && "pages" in params.research
      ? (params.research.pages || [])
          .map(
            (page: { url: string; excerpt: string; blocked: boolean }, i: number) =>
              `### Source ${i + 1}: ${page.url}\n${page.blocked ? "(blocked)" : page.excerpt}`,
          )
          .join("\n\n")
      : "";

  return `You are Clyra performing a web research answer.

User query: ${params.query}

Sources found:
${sources}

Fetched excerpts:
${excerpts || "(no page text fetched)"}

Write a concise Markdown answer with:
- Direct answer first (short)
- A few supporting bullets if needed
Do not invent sources. If evidence is thin, say what is uncertain.
Do NOT include a Sources section — sources are shown separately in the UI.`;
}

export function researchModulePath() {
  return clyraResourcePath("lib", "research", "research-handlers.ts");
}
