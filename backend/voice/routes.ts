import type { Express, Request, Response } from "express";
import { buildVoiceSystemPrompt } from "../../lib/clyraVoicePrompt";
import { loadVoiceConfig, voiceConfigPublic } from "./config";
import { voiceMetrics } from "./metrics/voice-metrics";
import {
  voiceSessions,
  type VoiceChatMessage,
} from "./session/voice-session-manager";
import { createLiveKitSession } from "./transport/livekit";
import { closeVoiceSocket } from "./websocket/voice-stream-handler";

function parseHistory(body: unknown): VoiceChatMessage[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const role = (entry as { role?: string }).role;
      const content = (entry as { content?: string }).content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
        return null;
      }
      return { role, content: content.trim() };
    })
    .filter((msg): msg is VoiceChatMessage => Boolean(msg?.content));
}

export function registerVoiceRoutes(app: Express) {
  const config = loadVoiceConfig();

  app.get("/api/voice/config", (_req, res) => {
    res.json(voiceConfigPublic(config));
  });

  app.post("/voice/session", async (req: Request, res: Response) => {
    if (!config.enabled) {
      res.status(503).json({ ok: false, error: "Voice calling is disabled." });
      return;
    }
    const conversationId =
      typeof req.body?.conversationId === "string"
        ? req.body.conversationId
        : typeof req.body?.chatId === "string"
          ? req.body.chatId
          : null;

    const history = parseHistory(req.body?.history ?? req.body?.messages);
    const customPrompt =
      typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : "";
    const temperature =
      typeof req.body?.temperature === "number" ? req.body.temperature : undefined;
    const mode = req.body?.mode === "dictation" ? "dictation" : "conversation";

    const session = voiceSessions.create({
      conversationId,
      history,
      systemPrompt: buildVoiceSystemPrompt(customPrompt),
      temperature,
      mode,
    });
    const livekit = createLiveKitSession(config, session.id);
    const host = req.get("host") || "localhost:3000";
    const protocol = req.protocol === "https" ? "wss" : "ws";
    const websocketUrl = `${protocol}://${host}/voice/stream?sessionId=${encodeURIComponent(session.id)}`;

    res.json({
      ok: true,
      sessionId: session.id,
      conversationId: session.conversationId,
      transport: livekit ? "livekit" : "websocket",
      websocketUrl,
      livekit,
      config: voiceConfigPublic(config),
    });
  });

  app.post("/voice/end", (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "sessionId required" });
      return;
    }
    closeVoiceSocket(sessionId);
    const ended = voiceSessions.end(sessionId);
    const metrics = voiceMetrics.summary(sessionId);
    voiceSessions.delete(sessionId);
    res.json({ ok: true, session: ended, metrics });
  });
}
