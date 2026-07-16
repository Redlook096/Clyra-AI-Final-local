import crypto from "node:crypto";
import type { VoiceConfig } from "../config";

export type VoiceChatMessage = { role: "user" | "assistant"; content: string };

export type VoiceSession = {
  id: string;
  conversationId: string | null;
  createdAt: number;
  endedAt: number | null;
  muted: boolean;
  status: "idle" | "listening" | "thinking" | "speaking" | "ended";
  messages: VoiceChatMessage[];
  systemPrompt: string;
  temperature: number;
};

export class VoiceSessionManager {
  private sessions = new Map<string, VoiceSession>();

  create(options?: {
    conversationId?: string | null;
    history?: VoiceChatMessage[];
    systemPrompt?: string;
    temperature?: number;
  }): VoiceSession {
    const history = (options?.history ?? [])
      .filter((msg) => msg.content.trim())
      .slice(-24)
      .map((msg) => ({
        role: msg.role,
        content: msg.content.trim(),
      }));

    const session: VoiceSession = {
      id: crypto.randomUUID(),
      conversationId: options?.conversationId ?? null,
      createdAt: Date.now(),
      endedAt: null,
      muted: false,
      status: "idle",
      messages: [...history],
      systemPrompt: options?.systemPrompt?.trim() || "",
      temperature:
        typeof options?.temperature === "number" && Number.isFinite(options.temperature)
          ? options.temperature
          : 0.7,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string) {
    return this.sessions.get(id) ?? null;
  }

  update(id: string, patch: Partial<VoiceSession>) {
    const current = this.sessions.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.sessions.set(id, next);
    return next;
  }

  appendMessage(id: string, role: "user" | "assistant", content: string) {
    const current = this.sessions.get(id);
    if (!current) return null;
    current.messages.push({ role, content });
    return current;
  }

  end(id: string) {
    const current = this.sessions.get(id);
    if (!current) return null;
    current.endedAt = Date.now();
    current.status = "ended";
    return current;
  }

  delete(id: string) {
    this.sessions.delete(id);
  }

  buildPipelinePayload(session: VoiceSession, config: VoiceConfig) {
    return {
      sessionId: session.id,
      conversationId: session.conversationId,
      messages: session.messages,
      llm: {
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      },
      audio: {
        sampleRate: config.sampleRate,
        chunkMs: config.chunkMs,
        silenceThreshold: config.silenceThreshold,
        vadSensitivity: config.vadSensitivity,
      },
      stt: { model: config.sttModel },
      tts: { voice: config.ttsVoice },
    };
  }
}

export const voiceSessions = new VoiceSessionManager();
