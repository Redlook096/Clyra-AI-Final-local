import type { Express, Request, Response } from "express";
import { buildVoiceSystemPrompt } from "../../lib/clyraVoicePrompt";
import { resolveDeepseekModel } from "../../lib/deepseek-models";
import { loadVoiceConfig, voiceConfigPublic } from "./config";
import { voiceMetrics } from "./metrics/voice-metrics";
import {
  voiceSessions,
  type VoiceChatMessage,
} from "./session/voice-session-manager";

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

    if (mode === "dictation") {
      const host = req.get("host") || "localhost:3000";
      const protocol = req.protocol === "https" ? "wss" : "ws";
      res.json({
        ok: true,
        sessionId: session.id,
        transport: "websocket",
        websocketUrl: `${protocol}://${host}/voice/stream?sessionId=${encodeURIComponent(session.id)}`,
        config: voiceConfigPublic(config),
      });
      return;
    }

    res.json({
      ok: true,
      sessionId: session.id,
      conversationId: session.conversationId,
      transport: "webrtc",
      offerUrl: "/voice/offer",
      config: voiceConfigPublic(config),
    });
  });

  // Proxies the browser's WebRTC SDP offer to the local Pipecat worker.
  // `@pipecat-ai/small-webrtc-transport` builds this request itself as
  // `{ sdp, type, pc_id, requestData }` (pc_id is set on a reconnect /
  // renegotiation) -- Node's job is to enrich `requestData` with the
  // session's system prompt/history/model server-side, so the Python
  // process never needs LLM credentials from the client and Node stays the
  // source of truth for conversation state.
  app.post("/voice/offer", async (req: Request, res: Response) => {
    if (!config.enabled) {
      res.status(503).json({ ok: false, error: "Voice calling is disabled." });
      return;
    }
    const sdp = String(req.body?.sdp ?? "");
    const type = String(req.body?.type ?? "offer");
    const pcId = typeof req.body?.pc_id === "string" ? req.body.pc_id : null;
    const requestData = req.body?.requestData ?? {};
    const sessionId = String(requestData?.sessionId ?? "").trim();
    const session = sessionId ? voiceSessions.get(sessionId) : null;
    if (!sdp || !session) {
      res.status(sdp ? 404 : 400).json({
        ok: false,
        error: sdp ? "Unknown voice session." : "sdp required",
      });
      return;
    }
    const testMode = Boolean(requestData?.testMode);
    const { model: llmModel } = resolveDeepseekModel(config.llmModel);

    try {
      const upstream = await fetch(`${config.pipelineUrl.replace(/\/$/, "")}/api/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp,
          type,
          pc_id: pcId,
          requestData: {
            sessionId,
            systemPrompt: session.systemPrompt,
            history: session.messages,
            testMode,
            llmModel,
          },
        }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        res.status(502).json({ ok: false, error: `Voice worker offer failed: ${detail.slice(0, 200)}` });
        return;
      }
      const answer = await upstream.json();
      voiceSessions.update(sessionId, { status: "listening" });
      res.json(answer);
    } catch (error) {
      res.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : "Voice worker unreachable (offer)",
      });
    }
  });

  // Trickle-ICE candidates the client discovers after the initial
  // offer/answer -- best-effort, same endpoint shape as the POST above.
  app.patch("/voice/offer", async (req: Request, res: Response) => {
    try {
      const upstream = await fetch(`${config.pipelineUrl.replace(/\/$/, "")}/api/offer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      });
      res.status(upstream.status).json(await upstream.json().catch(() => ({ ok: upstream.ok })));
    } catch {
      res.status(502).json({ ok: false });
    }
  });

  app.post("/voice/end", (req: Request, res: Response) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "sessionId required" });
      return;
    }
    if (Array.isArray(req.body?.history)) {
      for (const msg of parseHistory(req.body.history)) {
        voiceSessions.appendMessage(sessionId, msg.role, msg.content);
      }
    }
    if (typeof req.body?.bargeIns === "number") {
      voiceMetrics.record(sessionId, "barge_in", req.body.bargeIns);
    }
    if (typeof req.body?.reconnects === "number") {
      voiceMetrics.record(sessionId, "reconnect", req.body.reconnects);
    }
    const ended = voiceSessions.end(sessionId);
    const metrics = voiceMetrics.summary(sessionId);
    voiceSessions.delete(sessionId);
    voiceMetrics.clear(sessionId);
    res.json({ ok: true, session: ended, metrics });
  });
}
