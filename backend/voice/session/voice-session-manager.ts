import crypto from "node:crypto";

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
  /** Dictation uses the same STT pipeline but never invokes the conversation LLM. */
  mode: "conversation" | "dictation";
};

export class VoiceSessionManager {
  private sessions = new Map<string, VoiceSession>();

  create(options?: {
    conversationId?: string | null;
    history?: VoiceChatMessage[];
    systemPrompt?: string;
    temperature?: number;
    mode?: "conversation" | "dictation";
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
      mode: options?.mode === "dictation" ? "dictation" : "conversation",
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
}

export const voiceSessions = new VoiceSessionManager();
