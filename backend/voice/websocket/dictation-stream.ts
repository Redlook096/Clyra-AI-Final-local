import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { loadVoiceConfig } from "../config";
import { voiceSessions } from "../session/voice-session-manager";

/**
 * Dictation (Cmd+Shift+K global dictation + the in-composer mic button) only
 * ever needs speech-to-text -- no LLM, no TTS, no turn management -- so it
 * gets its own small WS bridge to Fish's batch `/v1/asr` REST endpoint
 * instead of going through the Pipecat/WebRTC voice-call pipeline. The wire
 * protocol here matches what `DictationController.tsx` and the composer's
 * `useComposerVoiceCapture` already speak.
 */

type DictationSocket = {
  ws: WebSocket;
  sessionId: string;
  chunks: Buffer[];
};

const sockets = new Map<string, DictationSocket>();

function send(ws: WebSocket, message: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function transcribe(wav: Buffer, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
  form.append("language", "en");
  form.append("ignore_timestamps", "true");
  const response = await fetch("https://api.fish.audio/v1/asr", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Fish ASR failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await response.json()) as { text?: string };
  return String(data.text || "").trim();
}

function attachSocketHandlers(sessionId: string, ws: WebSocket) {
  const config = loadVoiceConfig();
  const active: DictationSocket = { ws, sessionId, chunks: [] };
  sockets.set(sessionId, active);

  send(ws, {
    type: "pipeline_mode",
    sessionId,
    mode: config.fishApiKey ? "pipeline" : "browser",
    sampleRate: config.sampleRate,
  });

  ws.on("message", async (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.sessionId !== sessionId) return;

    if (message.type === "audio" && typeof message.data === "string") {
      active.chunks.push(Buffer.from(message.data, "base64"));
      return;
    }

    if (message.type === "flush") {
      const pcm = Buffer.concat(active.chunks.splice(0));
      if (!pcm.length || !config.fishApiKey) {
        send(ws, { type: "dictation_final", sessionId, text: "" });
        return;
      }
      try {
        const wav = pcmToWav(pcm, config.sampleRate);
        const text = await transcribe(wav, config.fishApiKey);
        voiceSessions.appendMessage(sessionId, "user", text);
        send(ws, { type: "dictation_final", sessionId, text });
      } catch (error) {
        send(ws, {
          type: "error",
          sessionId,
          message: error instanceof Error ? error.message : "Dictation transcription failed.",
        });
      }
      return;
    }

    if (message.type === "ping") {
      send(ws, { type: "pong", sessionId });
    }
  });

  ws.on("close", () => {
    sockets.delete(sessionId);
    voiceSessions.end(sessionId);
  });
}

export function attachDictationWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/voice/stream") return;
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? voiceSessions.get(sessionId) : null;
    if (!sessionId || !session || session.mode !== "dictation") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (upgraded) => {
      attachSocketHandlers(sessionId, upgraded);
    });
  });
}
